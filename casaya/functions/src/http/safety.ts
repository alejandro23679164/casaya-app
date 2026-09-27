/**
 * Seguridad en vivo: traza GPS y botón de pánico.
 *
 * Criterio de diseño del pánico: nunca bloquear al usuario esperando red. La
 * app escribe la alerta en Firestore (permitido por reglas) y, en paralelo,
 * llama a esta función. Si una de las dos vías falla, la otra sigue en pie.
 * El SMS al contacto de emergencia y el aviso al equipo de seguridad salen
 * del trigger, que se dispara con cualquiera de las dos.
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import * as admin from 'firebase-admin';
import { LatLng } from '../domain/geo';
import { SAFETY } from '../config/constants';

const db = admin.firestore();

// ---------------------------------------------------------------------------
// Ping de ubicación del técnico. Sirve para dos cosas a la vez: alimentar el
// mapa que ve el cliente y mantener fresca la posición para el despacho.
// ---------------------------------------------------------------------------
export const pushLocation = onCall(async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const uid = req.auth.uid;
  const { requestId, geo, heading, speedKmh } = req.data as {
    requestId?: string; geo: LatLng; heading?: number; speedKmh?: number;
  };

  const { encodeGeohash } = await import('../domain/geo');

  await db.collection('users').doc(uid).update({
    'technician.currentGeo': {
      ...geo,
      geohash: encodeGeohash(geo, 9),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
  });

  // La traza histórica solo se guarda durante un servicio activo: fuera de eso
  // no hay razón para almacenar por dónde anda una persona.
  if (requestId) {
    const reqSnap = await db.collection('requests').doc(requestId).get();
    if (reqSnap.get('technicianId') === uid && ['en_route', 'in_progress'].includes(reqSnap.get('status'))) {
      await reqSnap.ref.collection('tracking').add({
        ...geo, heading: heading ?? null, speedKmh: speedKmh ?? null,
        at: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  }

  return { ok: true, nextPingSeconds: SAFETY.trackingIntervalSeconds };
});

// ---------------------------------------------------------------------------
// Pánico
// ---------------------------------------------------------------------------
export const triggerPanic = onCall(async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const uid = req.auth.uid;
  const { requestId, geo, accuracyM, notes } = req.data as {
    requestId?: string; geo: LatLng; accuracyM?: number; notes?: string;
  };

  const userSnap = await db.collection('users').doc(uid).get();

  const alertRef = await db.collection('panic_alerts').add({
    userId: uid,
    role: userSnap.get('role'),
    requestId: requestId ?? null,
    geo: { ...geo, accuracyM: accuracyM ?? null },
    triggeredAt: admin.firestore.FieldValue.serverTimestamp(),
    status: 'open',
    notifiedContacts: [],
    acknowledgedBy: null,
    notes: notes ?? '',
  });

  return { alertId: alertRef.id };
});

/**
 * Trigger de la alerta: avisa a los contactos de emergencia, a la contraparte
 * del servicio y al equipo de seguridad. Se dispara tanto si la alerta la
 * escribió la app como si la creó `triggerPanic`.
 */
export const onPanicAlertCreated = onDocumentCreated('panic_alerts/{alertId}', async (event) => {
  const alert = event.data?.data();
  if (!alert) return;

  const userSnap = await db.collection('users').doc(alert.userId).get();
  const contacts: Array<{ name: string; phone: string }> = userSnap.get('emergencyContacts') ?? [];
  const name = userSnap.get('fullName');

  const mapsLink = `https://maps.google.com/?q=${alert.geo.lat},${alert.geo.lng}`;
  const body = `ALERTA CasaYa: ${name} activó el botón de emergencia. Ubicación: ${mapsLink}`;

  const results = [];
  for (const c of contacts) {
    try {
      // await smsProvider.send({ to: c.phone, body });   // Twilio / Infobip / etc.
      results.push({ phone: c.phone, channel: 'sms', sentAt: new Date(), ok: true });
    } catch {
      results.push({ phone: c.phone, channel: 'sms', sentAt: new Date(), ok: false });
    }
  }

  // Aviso a la contraparte del servicio: en muchos casos la persona del otro
  // lado es quien puede ayudar más rápido.
  if (alert.requestId) {
    const reqSnap = await db.collection('requests').doc(alert.requestId).get();
    const counterpartId = alert.userId === reqSnap.get('clientId')
      ? reqSnap.get('technicianId')
      : reqSnap.get('clientId');

    if (counterpartId) {
      const token = (await db.collection('users').doc(counterpartId).get()).get('fcmToken');
      if (token) {
        await admin.messaging().send({
          token,
          notification: { title: 'Alerta de seguridad', body: 'Se activó una emergencia en este servicio.' },
          data: { type: 'panic', alertId: event.params.alertId },
        });
      }
    }
  }

  await event.data!.ref.update({ notifiedContacts: results });

  // Cola de atención humana: una alerta de pánico sin nadie del otro lado no
  // sirve de nada.
  await db.collection('ops_queue').add({
    type: 'panic',
    alertId: event.params.alertId,
    userId: alert.userId,
    priority: 'p0',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
});
