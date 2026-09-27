/**
 * API del panel de administración.
 *
 * Todo lo que hace una persona de operaciones pasa por acá. Dos invariantes
 * que no se negocian:
 *
 *  1. Toda acción que toca dinero o cuentas deja registro con nombre y apellido
 *     en `admin_audit`. Un panel sin auditoría es una puerta abierta.
 *  2. Ninguna resolución se aplica si el reparto no cierra. `computeSettlement`
 *     falla antes de que se emita una sola orden de pago.
 */

import { onCall, HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import {
  computeSettlement, suggestResolution, reliabilityNote,
  DisputeType, Outcome, EvidenceSnapshot, SettlementError,
} from '../domain/disputes';
import { captureAndPayout, refundFunds } from '../services/escrow';

const db = admin.firestore();

/** Corta si quien llama no es del equipo. El claim lo fija un superadmin. */
function requireAdmin(req: CallableRequest): { uid: string; email: string } {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión.');
  if (req.auth.token.role !== 'admin') {
    throw new HttpsError('permission-denied', 'No tenés acceso al panel.');
  }
  return { uid: req.auth.uid, email: req.auth.token.email ?? 'sin-email' };
}

async function audit(actor: { uid: string; email: string }, action: string, payload: unknown) {
  await db.collection('admin_audit').add({
    actorId: actor.uid,
    actorEmail: actor.email,
    action,
    payload,
    at: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// ---------------------------------------------------------------------------
// Cola de trabajo. Ordena por prioridad y antigüedad: lo urgente primero, y
// dentro de lo urgente, lo que más esperó.
// ---------------------------------------------------------------------------
export const listDisputes = onCall(async (req) => {
  requireAdmin(req);
  const { status = 'open', limit = 50 } = req.data as { status?: string; limit?: number };

  const snap = await db.collection('disputes')
    .where('status', '==', status)
    .orderBy('priority')
    .orderBy('createdAt')
    .limit(limit)
    .get();

  const items = await Promise.all(snap.docs.map(async (d) => {
    const dispute = d.data();
    const reqSnap = await db.collection('requests').doc(dispute.requestId).get();
    const txSnap = await db.collection('transactions').doc(dispute.requestId).get();

    return {
      id: d.id,
      ...dispute,
      createdAt: dispute.createdAt?.toDate()?.toISOString() ?? null,
      // Cuánto falta para que el escrow se libere solo: es lo que define el
      // orden real de trabajo, más que la prioridad nominal.
      hoursUntilAutoRelease: txSnap.get('escrow.autoReleaseAt')
        ? Math.round((txSnap.get('escrow.autoReleaseAt').toMillis() - Date.now()) / 3600_000)
        : null,
      category: reqSnap.get('category'),
      amountInPlay: txSnap.get('amount') ?? 0,
      currency: txSnap.get('currency') ?? 'ARS',
    };
  }));

  return { items };
});

// ---------------------------------------------------------------------------
// Expediente completo: todo lo que el sistema registró, junto, sin tener que
// abrir cinco pantallas.
// ---------------------------------------------------------------------------
export const getDisputeDetail = onCall(async (req) => {
  requireAdmin(req);
  const { disputeId } = req.data as { disputeId: string };

  const dSnap = await db.collection('disputes').doc(disputeId).get();
  if (!dSnap.exists) throw new HttpsError('not-found', 'No existe ese reclamo.');
  const dispute = dSnap.data()!;

  const [reqSnap, txSnap, eventsSnap, trackingSnap] = await Promise.all([
    db.collection('requests').doc(dispute.requestId).get(),
    db.collection('transactions').doc(dispute.requestId).get(),
    db.collection('requests').doc(dispute.requestId).collection('events').orderBy('at').get(),
    db.collection('requests').doc(dispute.requestId).collection('tracking').orderBy('at').limit(200).get(),
  ]);

  const r = reqSnap.data()!;
  const [clientSnap, techSnap] = await Promise.all([
    db.collection('users').doc(r.clientId).get(),
    r.technicianId ? db.collection('users').doc(r.technicianId).get() : Promise.resolve(null),
  ]);

  // Historial de reclamos de cada parte: un patrón repetido cambia la lectura
  // del caso.
  const [clientDisputes, techDisputes] = await Promise.all([
    db.collection('disputes').where('clientId', '==', r.clientId).count().get(),
    r.technicianId
      ? db.collection('disputes').where('technicianId', '==', r.technicianId).count().get()
      : Promise.resolve(null),
  ]);

  const checkIn = r.timeline?.checkInAt?.toMillis();
  const checkOut = r.timeline?.checkOutAt?.toMillis();

  const evidence: EvidenceSnapshot = {
    hasCheckIn: !!r.timeline?.checkInAt,
    hasCheckOutPhotos: (r.checkOut?.photoPaths ?? []).length > 0,
    checkInDistanceM: r.checkIn?.distanceToSiteM ?? null,
    minutesOnSite: checkIn && checkOut ? Math.round((checkOut - checkIn) / 60_000) : null,
    technicianRating: techSnap?.get('technician.ratingAvg') ?? 0,
    clientPreviousDisputes: Math.max(0, clientDisputes.data().count - 1),
    technicianPreviousDisputes: Math.max(0, (techDisputes?.data().count ?? 1) - 1),
  };

  // URLs firmadas de corta vida: las fotos no quedan accesibles para siempre
  // por haber abierto un expediente una vez.
  const signUrls = async (paths: string[]) => Promise.all(
    paths.map(async (p) => {
      const [url] = await admin.storage().bucket().file(p).getSignedUrl({
        action: 'read',
        expires: Date.now() + 30 * 60_000,
      });
      return url;
    }),
  );

  return {
    dispute: { id: dSnap.id, ...dispute, createdAt: dispute.createdAt?.toDate()?.toISOString() },
    request: {
      id: reqSnap.id,
      category: r.category,
      serviceId: r.serviceId,
      status: r.status,
      description: r.description,
      addressLine: r.address?.line1,
      quote: r.quote,
      timeline: Object.fromEntries(
        Object.entries(r.timeline ?? {}).map(([k, v]: [string, any]) => [k, v?.toDate?.()?.toISOString() ?? null]),
      ),
      checkIn: r.checkIn ?? null,
      checkOutNotes: r.checkOut?.technicianNotes ?? null,
      extraCharges: r.checkOut?.extraCharges ?? [],
      pinAttempts: r.pinAttempts ?? 0,
    },
    photos: {
      problem: await signUrls((r.media ?? []).map((m: any) => m.storagePath)),
      finished: await signUrls(r.checkOut?.photoPaths ?? []),
    },
    transaction: {
      amount: txSnap.get('amount'),
      platformFee: txSnap.get('platformFee'),
      currency: txSnap.get('currency'),
      status: txSnap.get('status'),
      psp: txSnap.get('psp'),
      externalId: txSnap.get('paymentIntentId'),
      autoReleaseAt: txSnap.get('escrow.autoReleaseAt')?.toDate()?.toISOString() ?? null,
      ledger: txSnap.get('ledger') ?? [],
    },
    parties: {
      client: {
        id: r.clientId,
        name: clientSnap.get('fullName'),
        rating: clientSnap.get('client.ratingAvg'),
        completed: clientSnap.get('client.completedRequests'),
      },
      technician: techSnap ? {
        id: r.technicianId,
        name: techSnap.get('fullName'),
        rating: techSnap.get('technician.ratingAvg'),
        jobs: techSnap.get('technician.jobsCompleted'),
        kyc: techSnap.get('technician.status'),
      } : null,
    },
    evidence,
    track: trackingSnap.docs.map((d) => ({
      lat: d.get('lat'), lng: d.get('lng'), at: d.get('at')?.toDate()?.toISOString(),
    })),
    events: eventsSnap.docs.map((d) => ({
      type: d.get('type'), actorId: d.get('actorId'),
      payload: d.get('payload'), at: d.get('at')?.toDate?.()?.toISOString(),
    })),
    suggestion: {
      ...suggestResolution(dispute.type as DisputeType, evidence),
      reliabilityNote: reliabilityNote(evidence),
    },
  };
});

// ---------------------------------------------------------------------------
// Previsualización del reparto. La persona ve los números exactos antes de
// confirmar: nadie debería descubrir cuánto cobró cada parte después de
// haber apretado el botón.
// ---------------------------------------------------------------------------
export const previewSettlement = onCall(async (req) => {
  requireAdmin(req);
  const { disputeId, outcome, technicianShare, travelCompensation } = req.data as {
    disputeId: string; outcome: Outcome; technicianShare?: number; travelCompensation?: number;
  };

  const dispute = (await db.collection('disputes').doc(disputeId).get()).data();
  if (!dispute) throw new HttpsError('not-found', 'No existe ese reclamo.');
  const tx = (await db.collection('transactions').doc(dispute.requestId).get()).data()!;

  try {
    return computeSettlement({
      heldAmount: tx.amount,
      platformFee: tx.platformFee,
      outcome,
      technicianShare,
      travelCompensation,
    });
  } catch (e) {
    if (e instanceof SettlementError) throw new HttpsError('invalid-argument', e.message);
    throw e;
  }
});

// ---------------------------------------------------------------------------
// Resolución. El único punto del panel que mueve dinero.
// ---------------------------------------------------------------------------
export const resolveDispute = onCall({ timeoutSeconds: 120 }, async (req) => {
  const actor = requireAdmin(req);
  const { disputeId, outcome, technicianShare, travelCompensation, notes } = req.data as {
    disputeId: string; outcome: Outcome; technicianShare?: number;
    travelCompensation?: number; notes: string;
  };

  if (!notes || notes.trim().length < 15) {
    // Sin fundamento escrito no hay forma de revisar un criterio después, ni
    // de defender la decisión ante un reclamo formal.
    throw new HttpsError('invalid-argument', 'Escribí el fundamento de la resolución.');
  }

  const disputeRef = db.collection('disputes').doc(disputeId);
  const dispute = (await disputeRef.get()).data();
  if (!dispute) throw new HttpsError('not-found', 'No existe ese reclamo.');
  if (dispute.status === 'resolved') {
    throw new HttpsError('failed-precondition', 'Este reclamo ya fue resuelto.');
  }

  const requestId = dispute.requestId;
  const txRef = db.collection('transactions').doc(requestId);
  const tx = (await txRef.get()).data()!;
  const reqSnap = await db.collection('requests').doc(requestId).get();
  const technicianId = reqSnap.get('technicianId');

  let settlement;
  try {
    settlement = computeSettlement({
      heldAmount: tx.amount,
      platformFee: tx.platformFee,
      outcome,
      technicianShare,
      travelCompensation,
    });
  } catch (e) {
    if (e instanceof SettlementError) throw new HttpsError('invalid-argument', e.message);
    throw e;
  }

  // --- movimientos de dinero ----------------------------------------------
  // Todo pasa por escrow.ts, el mismo camino que usa la liberación por PIN:
  // así no hay dos formas distintas de capturar o pagar dando vueltas por el
  // código, y la transacción queda en el estado real — 'payout_pending' hasta
  // que el webhook de Mercado Pago confirme la transferencia, nunca
  // 'released' de forma optimista desde acá.
  if (outcome === 'redo_service') {
    // No se toca el dinero: se extiende la retención y se reabre el trabajo.
    await db.collection('requests').doc(requestId).update({
      status: 'accepted',
      'timeline.checkOutAt': null,
      'timeline.completedAt': null,
    });
  } else if (settlement.toTechnician === 0) {
    // Devolución total o parcial: nunca involucra un payout, el dinero
    // vuelve a la tarjeta del cliente.
    await refundFunds({
      requestId,
      amount: settlement.toClient < tx.amount ? settlement.toClient : undefined,
      reason: `dispute:${disputeId}`,
    });
  } else {
    if (!technicianId) {
      throw new HttpsError('failed-precondition', 'No hay técnico asignado a esta solicitud.');
    }
    // Captura lo que corresponde al técnico más la comisión que retiene la
    // plataforma, y dispara la transferencia — misma secuencia que la
    // liberación por PIN. Si el técnico todavía no vinculó su cuenta de
    // cobro, esto lanza y el dinero queda 'captured' esperando ese paso.
    await captureAndPayout({
      requestId,
      technicianId,
      captureAmount: settlement.toTechnician + settlement.toPlatform,
      payoutAmount: settlement.toTechnician,
      method: 'admin_resolution',
    });

    // Si además hay que devolverle algo al cliente (reparto parcial: ya
    // estaba capturado el total y ahora se le vuelve una porción), eso es
    // una devolución aparte sobre lo ya cobrado.
    if (settlement.toClient > 0 && tx.status !== 'held') {
      await refundFunds({ requestId, amount: settlement.toClient, reason: `dispute:${disputeId}` });
    }
  }

  // --- estado propio -----------------------------------------------------
  const batch = db.batch();

  batch.update(disputeRef, {
    status: 'resolved',
    outcome,
    settlement,
    resolvedBy: actor.uid,
    resolvedByEmail: actor.email,
    resolutionNotes: notes.trim(),
    resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // La transacción ya quedó en su estado real (`payout_pending` o
  // `refunded`/`partially_refunded`) gracias a `captureAndPayout`/
  // `refundFunds` de arriba — este batch no vuelve a tocarla, para no pisar
  // ese estado con un 'released' prematuro. El cierre real del pago llega
  // por el webhook de payout (`confirmPayout`), no por esta respuesta.
  if (outcome !== 'redo_service') {
    batch.update(db.collection('requests').doc(requestId), {
      status: 'completed',
      'timeline.completedAt': admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  batch.create(db.collection('requests').doc(requestId).collection('events').doc(), {
    type: 'dispute_resolved',
    actorId: actor.uid,
    payload: { outcome, settlement, disputeId },
    at: new Date(),
  });

  await batch.commit();
  await audit(actor, 'resolve_dispute', { disputeId, requestId, outcome, settlement, notes });

  return { resolved: true, settlement };
});

// ---------------------------------------------------------------------------
// Acciones sobre cuentas. Separadas de la resolución a propósito: suspender a
// alguien es una decisión distinta de repartir un monto, y a veces corresponde
// una sin la otra.
// ---------------------------------------------------------------------------
export const setUserStatus = onCall(async (req) => {
  const actor = requireAdmin(req);
  const { userId, disabled, reason } = req.data as {
    userId: string; disabled: boolean; reason: string;
  };

  if (!reason || reason.trim().length < 10) {
    throw new HttpsError('invalid-argument', 'Indicá el motivo.');
  }

  await db.collection('users').doc(userId).update({
    disabled,
    ...(disabled ? { 'technician.status': 'suspended', 'technician.isOnline': false } : {}),
  });
  // Revocar los tokens fuerza el cierre de sesión inmediato en todos los
  // dispositivos. Sin esto, un técnico suspendido sigue operando hasta que su
  // token venza por su cuenta.
  await admin.auth().revokeRefreshTokens(userId);
  await admin.auth().updateUser(userId, { disabled });

  await audit(actor, disabled ? 'suspend_user' : 'reinstate_user', { userId, reason });
  return { ok: true };
});

/** Revisión manual de KYC cuando el proveedor automático no resuelve. */
export const reviewKyc = onCall(async (req) => {
  const actor = requireAdmin(req);
  const { userId, docType, verdict, reason } = req.data as {
    userId: string; docType: string; verdict: 'verified' | 'rejected'; reason?: string;
  };

  await db.collection('users').doc(userId).collection('kyc').doc(docType).update({
    status: verdict,
    rejectionReason: verdict === 'rejected' ? (reason ?? 'revisión manual') : null,
    reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
    reviewedBy: actor.uid,
  });

  await audit(actor, 'review_kyc', { userId, docType, verdict, reason });
  return { ok: true };
});

/** Métricas de la operación del día. Lo que se mira apenas se abre el panel. */
export const getOpsMetrics = onCall(async (req) => {
  requireAdmin(req);
  const since = admin.firestore.Timestamp.fromMillis(Date.now() - 24 * 3600_000);

  const [openDisputes, panicOpen, heldTx, pendingKyc, staleRequests] = await Promise.all([
    db.collection('disputes').where('status', '==', 'open').count().get(),
    db.collection('panic_alerts').where('status', '==', 'open').count().get(),
    db.collection('transactions').where('status', '==', 'held').count().get(),
    db.collection('users').where('technician.status', '==', 'in_review').count().get(),
    db.collection('requests').where('status', '==', 'pending')
      .where('timeline.createdAt', '<', since).count().get(),
  ]);

  return {
    openDisputes: openDisputes.data().count,
    openPanicAlerts: panicOpen.data().count,
    escrowHeldCount: heldTx.data().count,
    kycPendingReview: pendingKyc.data().count,
    stuckRequests: staleRequests.data().count,
  };
});
