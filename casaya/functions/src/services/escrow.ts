/**
 * Escrow: retener → capturar → transferir.
 *
 * Tres pasos, cada uno con su propio estado en `transactions.status`, porque
 * son tres operaciones de red separadas y cualquiera puede fallar sin que
 * las otras se enteren:
 *
 *   held → captured → payout_pending → released
 *                                    ↘ payout_failed (necesita ops)
 *
 * El paso de la transferencia (`payout`) es asincrónico del lado de Mercado
 * Pago — responde 202 y confirma por webhook — así que `captureAndPayout`
 * deja la transacción en `payout_pending` con el id del payout, y es
 * `confirmPayout` (llamado desde `webhooks.ts` cuando llega la notificación)
 * quien la mueve a `released`. Ver el porqué completo en `mercadopago.ts`.
 *
 * Regla que no se negocia en este archivo: una vez que `capture()` tuvo
 * éxito, el dinero YA es responsabilidad de la plataforma — si el paso de
 * payout falla después, nunca se revierte la captura silenciosamente. Queda
 * en `captured` (o `payout_failed` si se llegó a intentar) y va a la cola de
 * operaciones. El dinero de alguien no desaparece por un error de red.
 */

import * as admin from 'firebase-admin';
import { HttpsError } from 'firebase-functions/v2/https';
import { gatewayFor, gatewayByPsp } from './payments';
import { PaymentError } from './payments/gateway';

const db = admin.firestore();

export interface HoldFundsParams {
  requestId: string;
  clientId: string;
  /** País del cliente; decide qué pasarela procesa (ver `payments/index.ts`). */
  countryCode: string;
  /** Identificador del pagador ante el proveedor (uid o id de cliente en el PSP). */
  payerRef: string;
  /** Token del medio de pago ya tokenizado del lado del cliente. */
  paymentMethodRef: string;
  payerEmail?: string;
  amount: number;
  platformFee: number;
  technicianPayout: number;
  currency: string;
}

function rethrow(err: unknown): never {
  if (err instanceof PaymentError) {
    throw new HttpsError('failed-precondition', err.userMessage, err.code);
  }
  throw err;
}

// ---------------------------------------------------------------- retener
export async function holdFunds(p: HoldFundsParams): Promise<string> {
  const gateway = gatewayFor(p.countryCode);

  let result;
  try {
    result = await gateway.hold({
      requestId: p.requestId,
      amount: p.amount,
      currency: p.currency,
      platformFee: p.platformFee,
      payerRef: p.payerRef,
      paymentMethodRef: p.paymentMethodRef,
      payerEmail: p.payerEmail,
      description: `CasaYa · solicitud ${p.requestId}`,
    });
  } catch (err) {
    rethrow(err);
  }

  if (result.status === 'failed') {
    throw new HttpsError('failed-precondition', 'No se pudo retener el importe con ese medio de pago.');
  }

  const txRef = db.collection('transactions').doc(p.requestId);
  await txRef.set({
    requestId: p.requestId,
    clientId: p.clientId,
    technicianId: null,
    currency: p.currency,
    amount: p.amount,
    platformFee: p.platformFee,
    technicianPayout: p.technicianPayout,
    // 'requires_action' es un pago en revisión de antifraude: no es un
    // fracaso, hay que esperar la confirmación del webhook.
    status: result.status === 'held' ? 'held' : 'requires_payment',
    psp: gateway.psp,
    paymentIntentId: result.externalId,
    payoutId: null,
    refundId: null,
    escrow: {
      heldAt: result.status === 'held' ? admin.firestore.FieldValue.serverTimestamp() : null,
      capturedAt: null,
      releasedAt: null,
      releaseMethod: null,
      autoReleaseAt: null,             // se fija al hacer check-out
    },
    ledger: [{ at: new Date(), from: 'client', to: 'escrow', amount: p.amount, reason: 'hold' }],
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return txRef.id;
}

// ------------------------------------------------------ capturar + pagar
/**
 * El corazón del escrow. La usan tanto la liberación normal por PIN
 * (`releaseFunds`, más abajo) como la resolución de disputas en
 * `admin.ts` — un solo lugar para la secuencia capturar→pagar evita que
 * ambos caminos hagan la transferencia de forma distinta.
 */
export async function captureAndPayout(params: {
  requestId: string;
  technicianId: string;
  /** Monto total a capturar del pago retenido (lo del técnico + lo que se queda la plataforma). */
  captureAmount: number;
  /** Lo que efectivamente se transfiere al técnico — siempre ≤ captureAmount. */
  payoutAmount: number;
  method: 'client_pin' | 'auto_timeout' | 'admin_resolution';
}): Promise<void> {
  const txRef = db.collection('transactions').doc(params.requestId);
  const snap = await txRef.get();
  if (!snap.exists) throw new HttpsError('not-found', 'No existe el pago de esta solicitud.');

  let tx = snap.data()!;
  if (tx.status === 'released') return;   // idempotente: ya se pagó del todo

  const gateway = gatewayByPsp(tx.psp);

  // --- paso 1: capturar, si todavía no se hizo ---------------------------
  if (tx.status === 'held') {
    let capture;
    try {
      capture = await gateway.capture({
        externalId: tx.paymentIntentId,
        amount: params.captureAmount,
        platformFee: tx.platformFee,
        idempotencyKey: `capture_${params.requestId}`,
      });
    } catch (err) {
      rethrow(err);
    }

    await txRef.update({
      status: 'captured',
      amount: capture.capturedAmount,
      'escrow.capturedAt': admin.firestore.FieldValue.serverTimestamp(),
      ledger: admin.firestore.FieldValue.arrayUnion({
        at: new Date(), from: 'client', to: 'platform',
        amount: capture.capturedAmount, reason: `capture:${params.method}`,
      }),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx = { ...tx, status: 'captured', amount: capture.capturedAmount };
  }

  if (!['captured', 'payout_pending', 'payout_failed'].includes(tx.status)) {
    throw new HttpsError(
      'failed-precondition',
      `El pago está en estado "${tx.status}" — no se puede continuar con la transferencia al técnico.`,
    );
  }

  // Si ya hay un payout en curso (reintento del mismo caso), no se dispara
  // uno nuevo: se deja que el webhook o el job de reintento lo resuelvan.
  if (tx.status === 'payout_pending') return;

  // --- paso 2: iniciar la transferencia -----------------------------------
  const techSnap = await db.collection('users').doc(params.technicianId).get();
  const payoutAccountId = techSnap.get('technician.payoutAccountId');
  if (!payoutAccountId) {
    // El dinero queda 'captured' — seguro, solo falta a dónde mandarlo. No
    // se pierde: apenas el técnico vincule su cuenta, un reintento lo resuelve.
    throw new HttpsError('failed-precondition', 'El técnico todavía no tiene cuenta de cobro habilitada.');
  }

  const payoutEmail = (await db.collection('payout_accounts').doc(payoutAccountId).get()).get('email');
  if (!payoutEmail) {
    throw new HttpsError('failed-precondition', 'La cuenta de cobro del técnico no tiene email registrado.');
  }

  let payout;
  try {
    payout = await gateway.payout({
      requestId: params.requestId,
      payeeAccountId: payoutEmail,
      amount: params.payoutAmount,
      currency: tx.currency,
      description: `CasaYa · pago por solicitud ${params.requestId}`,
      idempotencyKey: `payout_${params.requestId}`,
    });
  } catch (err) {
    // La captura ya ocurrió — el dinero está seguro del lado de la
    // plataforma. No se revierte por un fallo acá; queda 'captured' para que
    // el job de reintento lo retome.
    rethrow(err);
  }

  await txRef.update({
    status: 'payout_pending',
    technicianId: params.technicianId,
    payoutId: payout.payoutId,
    technicianPayout: params.payoutAmount,
    'escrow.releaseMethod': params.method,
    ledger: admin.firestore.FieldValue.arrayUnion({
      at: new Date(), from: 'platform', to: 'technician',
      amount: params.payoutAmount, reason: `payout:${params.method}`,
    }),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/**
 * Confirmación real del payout — la llama el webhook cuando Mercado Pago
 * avisa que la transferencia se completó o falló. Es el único lugar que
 * marca una transacción como `released` de verdad.
 */
export async function confirmPayout(requestId: string, outcome: 'completed' | 'failed'): Promise<void> {
  const txRef = db.collection('transactions').doc(requestId);
  const snap = await txRef.get();
  if (!snap.exists || snap.get('status') !== 'payout_pending') return;   // nada que confirmar, o ya resuelto

  if (outcome === 'completed') {
    await txRef.update({
      status: 'released',
      'escrow.releasedAt': admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await db.collection('users').doc(snap.get('technicianId')).update({
      'technician.jobsCompleted': admin.firestore.FieldValue.increment(1),
    });
  } else {
    await txRef.update({ status: 'payout_failed', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    // El dinero está capturado y no llegó a destino: es exactamente el tipo
    // de cosa que no puede quedar esperando a que alguien la note por
    // casualidad.
    await db.collection('ops_queue').add({
      type: 'payout_failed',
      requestId,
      priority: 'p0',
      summary: 'La transferencia al técnico falló después de capturar el pago. Dinero retenido en la plataforma.',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
}

/**
 * Wrapper con la firma que ya usan `jobFlow.ts` (liberación por PIN) y
 * `scheduled.ts` (liberación automática a las 72 h) — ambos solo conocen
 * "liberar la plata de esta solicitud", no el detalle de captura+payout.
 */
export async function releaseFunds(params: {
  requestId: string;
  technicianId: string;
  method: 'client_pin' | 'auto_timeout' | 'admin_resolution';
  extraCharges?: number;
}): Promise<void> {
  const tx = (await db.collection('transactions').doc(params.requestId).get()).data();
  if (!tx) throw new HttpsError('not-found', 'No existe el pago de esta solicitud.');

  // Ya en curso o resuelto: no se relanza un segundo payout por encima.
  if (['payout_pending', 'released'].includes(tx.status)) return;

  const captureAmount = tx.amount + (params.extraCharges ?? 0);
  const payoutAmount = tx.technicianPayout + (params.extraCharges ?? 0);

  await captureAndPayout({
    requestId: params.requestId,
    technicianId: params.technicianId,
    captureAmount,
    payoutAmount,
    method: params.method,
  });
}

// -------------------------------------------------------------- devolver
/**
 * Devolución total o parcial. Antes de capturar es una anulación (el cliente
 * nunca ve el cargo); después de capturar, una devolución real. Nunca
 * involucra un payout: el dinero vuelve a la tarjeta del cliente, no sale
 * por Payouts.
 */
export async function refundFunds(params: {
  requestId: string;
  amount?: number;
  reason: string;
}): Promise<void> {
  const txRef = db.collection('transactions').doc(params.requestId);
  const tx = (await txRef.get()).data();
  if (!tx) throw new HttpsError('not-found', 'No existe el pago de esta solicitud.');

  const gateway = gatewayByPsp(tx.psp);

  if (tx.status === 'held') {
    try {
      await gateway.voidHold(tx.paymentIntentId);
    } catch (err) {
      rethrow(err);
    }
    await txRef.update({
      status: 'refunded',
      ledger: admin.firestore.FieldValue.arrayUnion({
        at: new Date(), from: 'escrow', to: 'client', amount: tx.amount, reason: `void:${params.reason}`,
      }),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return;
  }

  let refund;
  try {
    refund = await gateway.refund({
      externalId: tx.paymentIntentId,
      amount: params.amount,
      reason: params.reason,
      idempotencyKey: `refund_${params.requestId}_${params.amount ?? 'full'}`,
    });
  } catch (err) {
    rethrow(err);
  }

  await txRef.update({
    status: params.amount && params.amount < tx.amount ? 'partially_refunded' : 'refunded',
    refundId: refund.refundId,
    ledger: admin.firestore.FieldValue.arrayUnion({
      at: new Date(), from: 'platform', to: 'client', amount: params.amount ?? tx.amount, reason: `refund:${params.reason}`,
    }),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}
