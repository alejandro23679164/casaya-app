/**
 * Ejecución del trabajo: salir, llegar, trabajar, terminar y cobrar.
 *
 * Cada transición deja rastro verificable (hora, GPS, foto). Eso es lo que
 * convierte un reclamo en un hecho comprobable en vez de la palabra de uno
 * contra la del otro.
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { distanceKm, LatLng } from '../domain/geo';
import { verifyPin } from '../domain/pin';
import { releaseFunds } from '../services/escrow';
import { SAFETY } from '../config/constants';

const db = admin.firestore();

/** Carga la solicitud y comprueba que quien llama es el técnico asignado. */
async function loadAsTechnician(requestId: string, uid: string) {
  const ref = db.collection('requests').doc(requestId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No encontramos esa solicitud.');
  if (snap.get('technicianId') !== uid) {
    throw new HttpsError('permission-denied', 'No sos el técnico asignado a este trabajo.');
  }
  return { ref, data: snap.data()! };
}

// ---------------------------------------------------------------------------
// En camino: habilita la traza GPS que el cliente ve en el mapa.
// ---------------------------------------------------------------------------
export const startTrip = onCall(async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const { requestId } = req.data as { requestId: string };
  const { ref, data } = await loadAsTechnician(requestId, req.auth.uid);

  if (data.status !== 'accepted') {
    throw new HttpsError('failed-precondition', 'El trabajo no está en estado de salida.');
  }

  await ref.update({
    status: 'en_route',
    'timeline.enRouteAt': admin.firestore.FieldValue.serverTimestamp(),
  });
  return { status: 'en_route', trackingIntervalSeconds: SAFETY.trackingIntervalSeconds };
});

// ---------------------------------------------------------------------------
// Check-in: se valida contra el GPS. Marcar "llegué" desde otro barrio no es
// posible; la distancia al domicilio queda registrada.
// ---------------------------------------------------------------------------
export const checkIn = onCall(async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const { requestId, geo, photoPath } = req.data as { requestId: string; geo: LatLng; photoPath?: string };
  const { ref, data } = await loadAsTechnician(requestId, req.auth.uid);

  if (!['accepted', 'en_route'].includes(data.status)) {
    throw new HttpsError('failed-precondition', 'Este trabajo no está listo para el check-in.');
  }

  const meters = distanceKm(geo, data.address.geo) * 1000;
  if (meters > SAFETY.checkInRadiusM) {
    throw new HttpsError(
      'out-of-range',
      `Estás a ${Math.round(meters)} m del domicilio. Acercate para registrar la llegada.`,
    );
  }

  await ref.update({
    status: 'in_progress',
    'timeline.checkInAt': admin.firestore.FieldValue.serverTimestamp(),
    checkIn: { geo, distanceToSiteM: Math.round(meters), photoPath: photoPath ?? null },
  });
  await ref.collection('events').add({
    type: 'check_in', actorId: req.auth.uid, payload: { distanceToSiteM: Math.round(meters) }, at: new Date(),
  });

  return { status: 'in_progress' };
});

// ---------------------------------------------------------------------------
// Check-out: exige al menos una foto del trabajo terminado. Recién con el
// check-out hecho, la app del cliente le muestra el PIN.
// ---------------------------------------------------------------------------
export const checkOut = onCall(async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const { requestId, geo, photoPaths, notes, extraCharges = [] } = req.data as {
    requestId: string; geo: LatLng; photoPaths: string[]; notes?: string;
    extraCharges?: Array<{ concept: string; amount: number; approvedByClient: boolean }>;
  };
  const { ref, data } = await loadAsTechnician(requestId, req.auth.uid);

  if (data.status !== 'in_progress') {
    throw new HttpsError('failed-precondition', 'El trabajo todavía no está en ejecución.');
  }
  if (!photoPaths?.length) {
    throw new HttpsError('invalid-argument', 'Subí al menos una foto del trabajo terminado.');
  }

  // Un cargo extra sin aprobación del cliente no puede cobrarse: se guarda
  // como pendiente y queda fuera del total hasta que el cliente lo acepte.
  const approved = extraCharges.filter((c) => c.approvedByClient);
  const extraTotal = approved.reduce((sum, c) => sum + c.amount, 0);

  await ref.update({
    'timeline.checkOutAt': admin.firestore.FieldValue.serverTimestamp(),
    checkOut: { geo, photoPaths, technicianNotes: notes ?? '', extraCharges },
  });
  await db.collection('transactions').doc(requestId).update({
    'escrow.autoReleaseAt': admin.firestore.Timestamp.fromMillis(
      Date.now() + SAFETY.autoReleaseHours * 3600_000,
    ),
  });
  await ref.collection('events').add({
    type: 'check_out', actorId: req.auth.uid, payload: { photos: photoPaths.length, extraTotal }, at: new Date(),
  });

  return { status: 'awaiting_pin', extraChargesApproved: extraTotal };
});

// ---------------------------------------------------------------------------
// Liberación del pago con PIN. Es el único camino por el que el dinero pasa
// del escrow al técnico por acción del cliente.
// ---------------------------------------------------------------------------
export const releasePaymentWithPin = onCall(async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const clientId = req.auth.uid;
  const { requestId, pin } = req.data as { requestId: string; pin: string };

  if (!/^\d{4}$/.test(pin ?? '')) {
    throw new HttpsError('invalid-argument', 'El código tiene 4 dígitos.');
  }

  const ref = db.collection('requests').doc(requestId);

  // La verificación y el conteo de intentos van dentro de una transacción:
  // así no se puede probar 10.000 PINs en paralelo esquivando el contador.
  const outcome = await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'No encontramos esa solicitud.');
    const r = snap.data()!;

    if (r.clientId !== clientId) throw new HttpsError('permission-denied', 'Esta solicitud no es tuya.');
    if (r.status === 'completed') return { alreadyDone: true, technicianId: r.technicianId, extra: 0 };
    if (!r.timeline?.checkOutAt) {
      throw new HttpsError('failed-precondition', 'El técnico todavía no marcó el trabajo como terminado.');
    }
    if ((r.pinAttempts ?? 0) >= SAFETY.maxPinAttempts) {
      throw new HttpsError('resource-exhausted', 'Demasiados intentos. Escribinos para liberar el pago.');
    }

    if (!verifyPin(pin, r.completionPin)) {
      const attempts = (r.pinAttempts ?? 0) + 1;
      t.update(ref, { pinAttempts: attempts });
      t.create(ref.collection('events').doc(), {
        type: 'pin_failed', actorId: clientId, payload: { attempts }, at: new Date(),
      });
      return { ok: false, attemptsLeft: SAFETY.maxPinAttempts - attempts };
    }

    const extra = (r.checkOut?.extraCharges ?? [])
      .filter((c: any) => c.approvedByClient)
      .reduce((s: number, c: any) => s + c.amount, 0);

    t.update(ref, {
      status: 'completed',
      'timeline.completedAt': admin.firestore.FieldValue.serverTimestamp(),
    });
    t.create(ref.collection('events').doc(), {
      type: 'pin_verified', actorId: clientId, payload: {}, at: new Date(),
    });

    return { ok: true, technicianId: r.technicianId, extra };
  });

  if ('alreadyDone' in outcome) return { released: true, alreadyReleased: true };
  if (!outcome.ok) {
    throw new HttpsError('permission-denied', `Código incorrecto. Te quedan ${outcome.attemptsLeft} intentos.`);
  }

  // La solicitud queda 'completed' para el cliente apenas el PIN es correcto:
  // desde su lado el servicio terminó, y eso no debería depender de cuánto
  // tarde el técnico en cobrar. La plata sigue su propio camino en paralelo
  // (capturar → transferir), con su propio estado en `transactions.status`
  // — 'held' → 'captured' → 'payout_pending' → 'released' — confirmado recién
  // por el webhook de payout, nunca por esta respuesta. Si capturar o
  // iniciar el payout falla acá, el dinero queda 'captured' (nunca se
  // pierde) y el job de reintento en `reconciliation.ts` lo retoma.
  await releaseFunds({
    requestId,
    technicianId: outcome.technicianId!,
    method: 'client_pin',
    extraCharges: outcome.extra,
  });

  // Contadores de reputación.
  await db.collection('users').doc(outcome.technicianId!).update({
    'technician.jobsCompleted': admin.firestore.FieldValue.increment(1),
  });

  return { released: true };
});

// ---------------------------------------------------------------------------
// Disputa: congela el escrow antes de la liberación automática.
// ---------------------------------------------------------------------------
export const openDispute = onCall(async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const { requestId, reason, type = 'work_not_done', evidencePaths = [] } = req.data as {
    requestId: string; reason: string; type?: string; evidencePaths?: string[];
  };

  if (!reason || reason.trim().length < 10) {
    throw new HttpsError('invalid-argument', 'Contanos qué pasó para poder revisarlo.');
  }

  const ref = db.collection('requests').doc(requestId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No encontramos esa solicitud.');
  const r = snap.data()!;

  if (![r.clientId, r.technicianId].includes(req.auth.uid)) {
    throw new HttpsError('permission-denied', 'No participás de esta solicitud.');
  }
  if (r.status === 'completed') {
    throw new HttpsError('failed-precondition', 'El pago ya se liberó. Escribinos para revisar el caso.');
  }

  await ref.update({ status: 'disputed' });
  // autoReleaseAt en null detiene el reloj: sin intervención humana, el dinero
  // no se mueve.
  await db.collection('transactions').doc(requestId).update({ 'escrow.autoReleaseAt': null });

  // El documento en `disputes` es lo que ve el panel de operaciones. Sin esto,
  // marcar la solicitud como 'disputed' congela el dinero pero nadie se entera:
  // el reclamo queda invisible hasta que la persona llama por teléfono.
  const isClient = r.clientId === req.auth.uid;
  const disputeRef = await db.collection('disputes').add({
    requestId,
    transactionId: requestId,
    clientId: r.clientId,
    technicianId: r.technicianId ?? null,
    type,
    openedBy: isClient ? 'client' : 'technician',
    openedById: req.auth.uid,
    reason: reason.trim(),
    evidencePaths,
    status: 'open',
    // El dinero retenido define la urgencia real: cuanto más grande, antes hay
    // que mirarlo. Un reclamo de conducta insegura entra siempre como p0.
    priority: type === 'unsafe_behavior' ? 'p0'
            : r.quote.total >= 5_000_000 ? 'p1'
            : 'p2',
    amountInPlay: r.quote.total,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await ref.collection('events').add({
    type: 'dispute_opened',
    actorId: req.auth.uid,
    payload: { reason, evidencePaths, disputeId: disputeRef.id, type },
    at: new Date(),
  });

  return { disputed: true, disputeId: disputeRef.id };
});
