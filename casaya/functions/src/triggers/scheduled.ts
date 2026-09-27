/**
 * Tareas periódicas. Todo lo que debe ocurrir sin que nadie toque un botón.
 */

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import * as admin from 'firebase-admin';
import { dispatchRequest } from '../http/dispatch';
import { releaseFunds } from '../services/escrow';

const db = admin.firestore();

/**
 * Ofertas vencidas: si nadie aceptó en la ronda actual, se ensancha el radio.
 * Corre cada minuto; el TTL de la oferta es de 45 segundos.
 */
export const expireDispatchOffers = onSchedule('every 1 minutes', async () => {
  const now = admin.firestore.Timestamp.now();

  const stale = await db.collection('requests')
    .where('status', '==', 'pending')
    .where('dispatch.expiresAt', '<', now)
    .limit(50)
    .get();

  for (const doc of stale.docs) {
    const offers = await db.collection('dispatch_offers')
      .where('requestId', '==', doc.id).where('status', '==', 'sent').get();
    const batch = db.batch();
    offers.docs.forEach((o) => batch.update(o.ref, { status: 'expired' }));
    await batch.commit();

    await dispatchRequest(doc.id);
  }
});

/**
 * Liberación automática a las 72 h del check-out.
 *
 * Sin esto, un cliente que se olvida de ingresar el PIN dejaría al técnico sin
 * cobrar de forma indefinida. Abrir una disputa detiene el reloj (ver
 * openDispute), así que solo se libera lo que nadie cuestionó.
 */
export const autoReleaseEscrow = onSchedule('every 60 minutes', async () => {
  const now = admin.firestore.Timestamp.now();

  const due = await db.collection('transactions')
    .where('status', '==', 'held')
    .where('escrow.autoReleaseAt', '<', now)
    .limit(100)
    .get();

  for (const tx of due.docs) {
    const requestId = tx.get('requestId');
    const reqSnap = await db.collection('requests').doc(requestId).get();
    if (reqSnap.get('status') === 'disputed') continue;

    try {
      await releaseFunds({ requestId, technicianId: tx.get('technicianId'), method: 'auto_timeout' });
      await reqSnap.ref.update({
        status: 'completed',
        'timeline.completedAt': admin.firestore.FieldValue.serverTimestamp(),
      });
      await reqSnap.ref.collection('events').add({
        type: 'escrow_auto_released', actorId: 'system', payload: {}, at: new Date(),
      });
    } catch (err) {
      console.error(`autoReleaseEscrow falló para ${requestId}`, err);
      // Queda 'held': el próximo ciclo reintenta. releaseFunds es idempotente.
    }
  }
});

/**
 * Técnicos "online" que dejaron de reportar posición. Si la app se cerró o el
 * teléfono se quedó sin batería, no puede seguir apareciendo como disponible.
 */
export const pruneStaleTechnicians = onSchedule('every 15 minutes', async () => {
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 20 * 60_000);

  const stale = await db.collection('users')
    .where('role', '==', 'technician')
    .where('technician.isOnline', '==', true)
    .where('technician.currentGeo.updatedAt', '<', cutoff)
    .limit(200)
    .get();

  const batch = db.batch();
  stale.docs.forEach((d) => batch.update(d.ref, { 'technician.isOnline': false }));
  await batch.commit();
});

/**
 * Recalcula el promedio de calificaciones cuando se escribe una reseña.
 * Se hace con increments para no leer todas las reseñas en cada cambio.
 */
export const onReviewWritten = onDocumentUpdated('requests/{requestId}', async (event) => {
  const before = event.data?.before.data();
  const after = event.data?.after.data();
  if (!before || !after) return;

  const pairs: Array<[string, string]> = [
    ['clientToTech', 'technicianId'],
    ['techToClient', 'clientId'],
  ];

  for (const [key, subjectField] of pairs) {
    const prev = before.review?.[key];
    const next = after.review?.[key];
    if (prev || !next) continue;                         // solo la primera vez

    const subjectId = after[subjectField];
    if (!subjectId) continue;
    const roleKey = key === 'clientToTech' ? 'technician' : 'client';

    await db.runTransaction(async (t) => {
      const ref = db.collection('users').doc(subjectId);
      const snap = await t.get(ref);
      const count = snap.get(`${roleKey}.ratingCount`) ?? 0;
      const avg = snap.get(`${roleKey}.ratingAvg`) ?? 0;
      const newCount = count + 1;
      const newAvg = (avg * count + next.rating) / newCount;

      t.update(ref, {
        [`${roleKey}.ratingCount`]: newCount,
        [`${roleKey}.ratingAvg`]: Math.round(newAvg * 100) / 100,
      });
    });
  }
});
