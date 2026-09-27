/**
 * Asignación de técnico cercano.
 *
 * Estrategia: círculos concéntricos. Se ofrece el trabajo a los N técnicos
 * mejor puntuados dentro de 3 km; si nadie acepta en 45 segundos, se ensancha
 * a 6, 10 y 18 km. Gana el primero que acepta, resuelto con una transacción
 * de Firestore para que dos aceptaciones simultáneas no se pisen.
 *
 * El ranking no es solo distancia: un técnico a 2,5 km con 4,9 estrellas es
 * mejor opción que uno a 1,8 km con 3,2.
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { distanceKm, geohashQueryBounds, etaMinutes, LatLng } from '../domain/geo';
import { DISPATCH } from '../config/constants';

const db = admin.firestore();
const messaging = admin.messaging();

interface Candidate {
  uid: string;
  distanceKm: number;
  rating: number;
  score: number;
  fcmToken?: string;
}

/**
 * Busca candidatos. El geohash prefiltra en la base; la distancia exacta y el
 * resto de las condiciones se verifican en memoria sobre un conjunto chico.
 */
async function findCandidates(params: {
  site: LatLng;
  serviceId: string;
  radiusKm: number;
  exclude: string[];
}): Promise<Candidate[]> {
  const [start, end] = geohashQueryBounds(params.site, params.radiusKm);
  const staleBefore = admin.firestore.Timestamp.fromMillis(
    Date.now() - DISPATCH.maxLocationAgeMinutes * 60_000,
  );

  const snap = await db
    .collection('users')
    .where('role', '==', 'technician')
    .where('technician.status', '==', 'approved')
    .where('technician.isOnline', '==', true)
    .where('technician.skills', 'array-contains', params.serviceId)
    .where('technician.currentGeo.geohash', '>=', start)
    .where('technician.currentGeo.geohash', '<', end)
    .limit(120)
    .get();

  const candidates: Candidate[] = [];

  for (const doc of snap.docs) {
    if (params.exclude.includes(doc.id)) continue;
    if (doc.get('disabled') === true) continue;

    const geo = doc.get('technician.currentGeo');
    if (!geo?.updatedAt || geo.updatedAt < staleBefore) continue;  // posición vieja: no está realmente disponible

    const d = distanceKm(params.site, geo);
    if (d > params.radiusKm) continue;                              // el geohash sobre-incluye en los bordes
    if (d > (doc.get('technician.serviceRadiusKm') ?? 10)) continue; // respeta el radio que el técnico eligió

    const rating = doc.get('technician.ratingAvg') ?? 4.5;
    const jobs = doc.get('technician.jobsCompleted') ?? 0;

    // Score: cercanía pesa 60 %, reputación 30 %, experiencia 10 %.
    // Los novatos arrancan con 4,5 para no quedar fuera del mercado.
    const proximity = 1 - d / params.radiusKm;
    const reputation = rating / 5;
    const experience = Math.min(jobs, 50) / 50;
    const score = proximity * 0.6 + reputation * 0.3 + experience * 0.1;

    candidates.push({ uid: doc.id, distanceKm: +d.toFixed(2), rating, score, fcmToken: doc.get('fcmToken') });
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, DISPATCH.batchSize);
}

/**
 * Ofrece la solicitud a la siguiente tanda. Se llama al crear la solicitud y
 * cada vez que vence una ronda sin respuesta.
 */
export async function dispatchRequest(requestId: string): Promise<{ offered: number }> {
  const ref = db.collection('requests').doc(requestId);
  const snap = await ref.get();
  const r = snap.data();

  if (!r || r.status !== 'pending') return { offered: 0 };

  const attempt: number = r.dispatch?.attempt ?? 0;
  if (attempt >= DISPATCH.radiiKm.length) {
    // Agotamos los radios: se avisa al cliente y se devuelve el dinero.
    await ref.update({
      status: 'cancelled',
      'cancellation.by': 'system',
      'cancellation.reason': 'no_technician_available',
      'timeline.cancelledAt': admin.firestore.FieldValue.serverTimestamp(),
    });
    return { offered: 0 };
  }

  const radiusKm = DISPATCH.radiiKm[attempt];
  const site: LatLng = r.address.geo;
  const alreadyOffered: string[] = r.dispatch?.offeredTo ?? [];

  const candidates = await findCandidates({
    site, serviceId: r.serviceId, radiusKm, exclude: alreadyOffered,
  });

  if (candidates.length === 0) {
    // Nadie en este radio: se salta directo al siguiente círculo.
    await ref.update({ 'dispatch.attempt': attempt + 1, 'dispatch.radiusKm': radiusKm });
    return dispatchRequest(requestId);
  }

  const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + DISPATCH.offerTtlSeconds * 1000);
  const batch = db.batch();

  for (const c of candidates) {
    batch.create(db.collection('dispatch_offers').doc(), {
      requestId,
      technicianId: c.uid,
      status: 'sent',
      distanceKm: c.distanceKm,
      estimatedPayout: r.quote.technicianPayout,
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt,
    });
  }

  batch.update(ref, {
    'dispatch.attempt': attempt + 1,
    'dispatch.radiusKm': radiusKm,
    'dispatch.expiresAt': expiresAt,
    'dispatch.offeredTo': admin.firestore.FieldValue.arrayUnion(...candidates.map((c) => c.uid)),
  });
  await batch.commit();

  // Notificación push. La carga útil es mínima a propósito: ni dirección ni
  // datos del cliente viajan en el push, se leen en la app tras aceptar.
  const tokens = candidates.map((c) => c.fcmToken).filter(Boolean) as string[];
  if (tokens.length) {
    await messaging.sendEachForMulticast({
      tokens,
      notification: {
        title: 'Nuevo trabajo cerca tuyo',
        body: `${r.category} · a ${candidates[0].distanceKm} km · ${(r.quote.technicianPayout / 100).toFixed(0)} ${r.quote.currency}`,
      },
      data: { requestId, type: 'new_offer' },
      android: { priority: 'high' },
      apns: { payload: { aps: { sound: 'default', 'interruption-level': 'time-sensitive' } } },
    });
  }

  return { offered: candidates.length };
}

// ---------------------------------------------------------------------------
// El técnico acepta. Carrera resuelta con transacción: gana el primero.
// ---------------------------------------------------------------------------
export const acceptRequest = onCall(async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const techId = req.auth.uid;
  if (req.auth.token.kyc !== 'approved') {
    throw new HttpsError('permission-denied', 'Tu verificación de identidad todavía no está aprobada.');
  }

  const { requestId } = req.data as { requestId: string };
  const ref = db.collection('requests').doc(requestId);

  const result = await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Esa solicitud ya no existe.');
    const r = snap.data()!;

    if (r.status !== 'pending') {
      throw new HttpsError('aborted', 'Otro técnico tomó este trabajo.');
    }
    if (!(r.dispatch?.offeredTo ?? []).includes(techId)) {
      throw new HttpsError('permission-denied', 'Este trabajo no se te ofreció.');
    }
    if (r.dispatch?.expiresAt && r.dispatch.expiresAt.toMillis() < Date.now()) {
      throw new HttpsError('deadline-exceeded', 'La oferta venció.');
    }

    t.update(ref, {
      technicianId: techId,
      status: 'accepted',
      'timeline.acceptedAt': admin.firestore.FieldValue.serverTimestamp(),
    });
    t.create(ref.collection('events').doc(), {
      type: 'accepted', actorId: techId, payload: {}, at: new Date(),
    });
    t.update(db.collection('transactions').doc(requestId), { technicianId: techId });

    // Recién ahora el técnico puede ver la dirección exacta.
    return { address: r.address, clientId: r.clientId, geo: r.address.geo };
  });

  // Cerrar las ofertas de los demás.
  const others = await db.collection('dispatch_offers')
    .where('requestId', '==', requestId).where('status', '==', 'sent').get();
  const batch = db.batch();
  others.docs.forEach((d) => {
    batch.update(d.ref, { status: d.get('technicianId') === techId ? 'accepted' : 'expired' });
  });
  await batch.commit();

  const techSnap = await db.collection('users').doc(techId).get();
  const techGeo = techSnap.get('technician.currentGeo');

  return {
    accepted: true,
    address: result.address,
    etaMinutes: techGeo ? etaMinutes(techGeo, result.geo) : null,
  };
});

// ---------------------------------------------------------------------------
// Rechazo explícito: no penaliza, pero baja la tasa de aceptación y evita
// que se le vuelva a ofrecer el mismo trabajo.
// ---------------------------------------------------------------------------
export const rejectRequest = onCall(async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const techId = req.auth.uid;
  const { requestId, reason } = req.data as { requestId: string; reason?: string };

  const offers = await db.collection('dispatch_offers')
    .where('requestId', '==', requestId)
    .where('technicianId', '==', techId)
    .limit(1).get();

  if (!offers.empty) await offers.docs[0].ref.update({ status: 'rejected' });

  await db.collection('requests').doc(requestId).collection('events').add({
    type: 'offer_rejected', actorId: techId, payload: { reason: reason ?? '' }, at: new Date(),
  });

  // Si ya no queda ninguna oferta viva, se dispara la siguiente ronda al toque
  // en lugar de esperar a que venza el TTL.
  const alive = await db.collection('dispatch_offers')
    .where('requestId', '==', requestId).where('status', '==', 'sent').limit(1).get();
  if (alive.empty) await dispatchRequest(requestId);

  return { rejected: true };
});
