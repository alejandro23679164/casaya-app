/**
 * Ciclo de vida de la solicitud: cotizar, crear (con escrow) y cancelar.
 *
 * El cliente móvil no escribe la colección `requests` directamente (ver
 * firestore.rules). Toda creación pasa por acá porque hay tres cosas que no
 * pueden quedar en manos del dispositivo: el precio, el PIN y la retención
 * del dinero.
 */

import { onCall, HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { calculateQuote, calculateCancellationFee, ServicePricing, Urgency } from '../domain/pricing';
import { encodeGeohash, coarsenLocation, LatLng } from '../domain/geo';
import { generatePin, hashPin } from '../domain/pin';
import { holdFunds, refundFunds } from '../services/escrow';
import { SAFETY, CANCELLATION } from '../config/constants';
import { dispatchRequest } from './dispatch';

const db = admin.firestore();

/** Corta la ejecución si quien llama no está autenticado con teléfono verificado. */
function requireVerifiedClient(req: CallableRequest): string {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  // El claim phoneVerified lo fija el backend tras el OTP; no es editable desde el cliente.
  if (req.auth.token.phone_number == null && req.auth.token.phoneVerified !== true) {
    throw new HttpsError('permission-denied', 'Verificá tu número de teléfono antes de pedir un servicio.');
  }
  return req.auth.uid;
}

async function loadService(serviceId: string): Promise<ServicePricing & { category: string; requiresLicense: boolean }> {
  const snap = await db.collection('services').doc(serviceId).get();
  if (!snap.exists || snap.get('active') !== true) {
    throw new HttpsError('not-found', 'Ese servicio no está disponible.');
  }
  return snap.data() as any;
}

// ---------------------------------------------------------------------------
// Cotización: solo lectura, sin efectos. La pantalla la llama en cada cambio
// de urgencia u horario para mostrar el precio antes de confirmar.
// ---------------------------------------------------------------------------
export const getQuote = onCall(async (req) => {
  const { serviceId, urgency, scheduledFor, estimatedMinutes } = req.data as {
    serviceId: string; urgency: Urgency; scheduledFor?: string; estimatedMinutes?: number;
  };

  const service = await loadService(serviceId);
  return calculateQuote({
    service,
    urgency: urgency ?? 'standard',
    scheduledFor: scheduledFor ? new Date(scheduledFor) : new Date(),
    estimatedMinutes,
  });
});

// ---------------------------------------------------------------------------
// Crear solicitud: cotiza, retiene el dinero, genera el PIN y despacha.
// ---------------------------------------------------------------------------
export const createServiceRequest = onCall(async (req) => {
  const clientId = requireVerifiedClient(req);
  const {
    serviceId, urgency = 'standard', description, address, geo,
    mediaPaths = [], scheduledFor, paymentMethodId, estimatedMinutes,
  } = req.data as {
    serviceId: string; urgency: Urgency; description: string;
    address: { line1: string; notes?: string }; geo: LatLng;
    mediaPaths: string[]; scheduledFor?: string; paymentMethodId: string; estimatedMinutes?: number;
  };

  // --- validaciones de entrada -------------------------------------------
  if (!description || description.trim().length < 10) {
    throw new HttpsError('invalid-argument', 'Contanos el problema con un poco más de detalle.');
  }
  if (!geo || Math.abs(geo.lat) > 90 || Math.abs(geo.lng) > 180) {
    throw new HttpsError('invalid-argument', 'La ubicación del domicilio no es válida.');
  }
  if (mediaPaths.length === 0) {
    // Las fotos protegen a las dos partes: el técnico sabe a qué va,
    // el cliente tiene evidencia del estado inicial.
    throw new HttpsError('invalid-argument', 'Subí al menos una foto del problema.');
  }

  const clientSnap = await db.collection('users').doc(clientId).get();
  if (clientSnap.get('client.hasVerifiedPaymentMethod') !== true) {
    throw new HttpsError('failed-precondition', 'Agregá un medio de pago verificado para pedir un servicio.');
  }
  if (clientSnap.get('disabled') === true) {
    throw new HttpsError('permission-denied', 'Tu cuenta está suspendida. Escribinos para reactivarla.');
  }

  // --- cotización ---------------------------------------------------------
  const service = await loadService(serviceId);
  const when = scheduledFor ? new Date(scheduledFor) : new Date();
  const quote = calculateQuote({ service, urgency, scheduledFor: when, estimatedMinutes });

  // --- documento + PIN ----------------------------------------------------
  const requestRef = db.collection('requests').doc();
  const pin = generatePin();
  const coarse = coarsenLocation(geo, requestRef.id);

  await requestRef.set({
    clientId,
    technicianId: null,
    serviceId,
    category: service.category,
    status: 'pending',
    urgency,
    description: description.trim(),
    media: mediaPaths.map((p) => ({ storagePath: p, type: 'image', uploadedAt: new Date() })),
    address: {
      line1: address.line1,
      notes: address.notes ?? '',
      geo: { ...geo, geohash: encodeGeohash(geo, 9) },
    },
    coarseGeo: { ...coarse, geohash: encodeGeohash(coarse, SAFETY.coarseGeohashPrecision) },
    scheduledFor: scheduledFor ? admin.firestore.Timestamp.fromDate(when) : null,
    quote: { ...quote, computedAt: admin.firestore.FieldValue.serverTimestamp() },
    dispatch: { attempt: 0, radiusKm: 0, offeredTo: [], expiresAt: null },
    completionPin: hashPin(pin),       // hash, jamás el PIN en claro
    pinAttempts: 0,
    timeline: { createdAt: admin.firestore.FieldValue.serverTimestamp() },
    transactionId: null,
  });

  // --- escrow -------------------------------------------------------------
  // Si la retención falla, la solicitud no debe quedar viva: se cancela.
  try {
    await holdFunds({
      requestId: requestRef.id,
      clientId,
      countryCode: clientSnap.get('address.country') ?? 'AR',
      payerRef: clientSnap.get('client.paymentCustomerId') ?? clientId,
      paymentMethodRef: paymentMethodId,
      payerEmail: clientSnap.get('email') ?? undefined,
      amount: quote.total,
      platformFee: quote.serviceFee,
      technicianPayout: quote.technicianPayout,
      currency: quote.currency,
    });
    await requestRef.update({ transactionId: requestRef.id });
  } catch (err) {
    await requestRef.update({
      status: 'cancelled',
      'cancellation.by': 'system',
      'cancellation.reason': 'payment_hold_failed',
      'timeline.cancelledAt': admin.firestore.FieldValue.serverTimestamp(),
    });
    throw err;
  }

  // --- despacho -----------------------------------------------------------
  await dispatchRequest(requestRef.id);

  // El PIN viaja una sola vez, en esta respuesta, y vive en el dispositivo del
  // cliente. No queda legible en la base ni se le muestra nunca al técnico.
  return { requestId: requestRef.id, quote, completionPin: pin };
});

// ---------------------------------------------------------------------------
// Cancelación
// ---------------------------------------------------------------------------
export const cancelServiceRequest = onCall(async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const uid = req.auth.uid;
  const { requestId, reason } = req.data as { requestId: string; reason: string };

  const ref = db.collection('requests').doc(requestId);

  const fee = await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'No encontramos esa solicitud.');
    const r = snap.data()!;

    const isClient = r.clientId === uid;
    const isTech = r.technicianId === uid;
    if (!isClient && !isTech) throw new HttpsError('permission-denied', 'No podés cancelar esta solicitud.');
    if (['completed', 'cancelled'].includes(r.status)) {
      throw new HttpsError('failed-precondition', 'Esta solicitud ya está cerrada.');
    }
    if (r.status === 'in_progress' && isClient) {
      throw new HttpsError('failed-precondition', 'El trabajo ya empezó. Escribinos para abrir un reclamo.');
    }

    const acceptedAt: admin.firestore.Timestamp | null = r.timeline?.acceptedAt ?? null;
    const minutesSince = acceptedAt ? (Date.now() - acceptedAt.toMillis()) / 60000 : 0;

    // El técnico que cancela nunca cobra penalidad al cliente.
    const { clientCharge } = isTech
      ? { clientCharge: 0 }
      : calculateCancellationFee({
          quoteTotal: r.quote.total,
          minutesSinceAccepted: minutesSince,
          technicianDeparted: !!r.timeline?.enRouteAt,
          graceMinutes: CANCELLATION.graceMinutes,
          lateFeePct: CANCELLATION.lateFeePct,
        });

    t.update(ref, {
      status: 'cancelled',
      'cancellation.by': isClient ? 'client' : 'technician',
      'cancellation.reason': reason ?? '',
      'cancellation.feeCharged': clientCharge,
      'timeline.cancelledAt': admin.firestore.FieldValue.serverTimestamp(),
    });
    t.create(ref.collection('events').doc(), {
      type: 'cancelled', actorId: uid, payload: { reason, clientCharge }, at: new Date(),
    });

    return clientCharge;
  });

  // Sin penalidad se anula la autorización completa; con penalidad se
  // devuelve la diferencia y el resto compensa el viaje del técnico.
  const snap = await ref.get();
  if (fee === 0) {
    await refundFunds({ requestId, reason: 'cancelled_no_fee' });
  } else {
    await refundFunds({ requestId, amount: snap.get('quote.total') - fee, reason: 'cancelled_with_fee' });
  }

  return { cancelled: true, feeCharged: fee };
});
