/**
 * Webhook de Mercado Pago.
 *
 * Es la única fuente confiable sobre el estado del dinero — tanto del pago
 * del cliente como, ahora, del payout al técnico. Ninguno de los dos cambia
 * de estado solo porque nuestra base lo diga: el antifraude aprueba un pago
 * minutos después, el banco lo rechaza, un payout se confirma o falla del
 * otro lado sin que nadie toque la app.
 *
 * Mercado Pago manda las notificaciones de payout al mismo tipo de webhook,
 * distinguibles por el campo `type` del cuerpo (o el query `topic` en
 * notificaciones más viejas): `payment` para el pago del cliente, `payout`
 * para la transferencia al técnico. Cada una se procesa distinto — ver
 * `handlePaymentUpdate` y `handlePayoutUpdate` más abajo — pero comparten
 * las mismas reglas de entrada:
 *
 *  - Firma verificada antes de mirar el contenido.
 *  - Responder 200 rápido. Mercado Pago reintenta ante cualquier otra cosa, y
 *    un reintento por timeout genera trabajo duplicado.
 *  - Idempotente por id de notificación: la misma notificación puede llegar
 *    más de una vez y no puede procesarse dos veces.
 *  - El cuerpo solo trae el id del recurso, no su estado. El estado se
 *    consulta a la API: confiar en el payload es confiar en quien lo envía.
 */

import { onRequest } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { verifyWebhookSignature } from '../services/payments/mercadopago';
import { gatewayFor } from '../services/payments';
import { confirmPayout } from '../services/escrow';

const db = admin.firestore();

export const mercadoPagoWebhook = onRequest(
  { region: 'southamerica-east1', cors: false, maxInstances: 20 },
  async (req, res) => {
    const signature = req.get('x-signature');
    const requestId = req.get('x-request-id');
    const dataId = String(req.query['data.id'] ?? req.body?.data?.id ?? '');

    if (!signature || !requestId || !dataId) {
      res.status(400).send('missing headers');
      return;
    }

    const valid = verifyWebhookSignature({
      signatureHeader: signature,
      requestId,
      dataId,
      secret: process.env.MP_WEBHOOK_SECRET!,
    });

    if (!valid) {
      console.warn('Webhook con firma inválida', { requestId, dataId });
      res.status(401).send('invalid signature');
      return;
    }

    // Deduplicación: si ya procesamos esta notificación, respondemos 200 y
    // cortamos. `create` falla si el documento existe, que es justo lo que
    // queremos como candado.
    const topic = String(req.body?.type ?? req.query.topic ?? 'unknown');
    const dedupeRef = db.collection('webhook_events').doc(`mp_${requestId}`);
    try {
      await dedupeRef.create({
        psp: 'mercadopago',
        dataId,
        topic,
        receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch {
      res.status(200).send('duplicate');
      return;
    }

    try {
      if (topic === 'payout') {
        await handlePayoutUpdate(dataId);
      } else {
        // 'payment' es el caso normal; cualquier topic no reconocido se trata
        // igual — un pago es lo más probable, y handlePaymentUpdate ya sabe
        // no hacer nada si no encuentra transacción asociada.
        await handlePaymentUpdate(dataId);
      }
      res.status(200).send('ok');
    } catch (err) {
      console.error('Error procesando webhook', { dataId, topic, err });
      // 200 igual: el reintento no va a resolver un error nuestro, y el job de
      // reconciliación levanta lo que quedó inconsistente.
      await dedupeRef.update({ error: String(err) });
      res.status(200).send('logged');
    }
  },
);

/**
 * Sincroniza el estado real del pago contra nuestra transacción.
 * Casos que importan de verdad: aprobación diferida, rechazo posterior a la
 * autorización y contracargo.
 */
async function handlePaymentUpdate(paymentId: string): Promise<void> {
  const gateway = gatewayFor('AR');
  const remote = await gateway.fetchStatus(paymentId);

  const txSnap = await db.collection('transactions')
    .where('paymentIntentId', '==', paymentId)
    .limit(1)
    .get();

  if (txSnap.empty) {
    console.warn('Webhook sin transacción asociada', { paymentId });
    return;
  }

  const txRef = txSnap.docs[0].ref;
  const tx = txSnap.docs[0].data();
  const requestId = tx.requestId;

  const updates: Record<string, unknown> = {
    pspStatus: remote.status,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  switch (remote.status) {
    case 'authorized':
      if (tx.status === 'requires_payment') updates.status = 'held';
      break;

    case 'approved':
      // OJO: esto confirma que la CAPTURA llegó a buen puerto — el dinero
      // está en el balance de la plataforma. No es lo mismo que 'released':
      // eso solo lo confirma el webhook de payout, más abajo. Si por algún
      // motivo la captura se hizo directo (sin pasar por nuestro propio
      // capture()) y todavía figura 'held' acá, se adelanta a 'captured' para
      // que el reintento de payout la levante; nunca se salta a 'released'.
      if (['requires_payment', 'held'].includes(tx.status)) {
        updates.status = 'captured';
        updates['escrow.capturedAt'] = admin.firestore.FieldValue.serverTimestamp();
      }
      break;

    case 'rejected':
    case 'cancelled':
      updates.status = 'failed';
      // Si el pago se cayó después de creada la solicitud, hay que frenarla
      // antes de que un técnico viaje gratis.
      await db.collection('requests').doc(requestId).update({
        status: 'cancelled',
        'cancellation.by': 'system',
        'cancellation.reason': 'payment_failed',
        'timeline.cancelledAt': admin.firestore.FieldValue.serverTimestamp(),
      });
      break;

    case 'refunded':
      updates.status = 'refunded';
      break;

    case 'charged_back':
      // Contracargo: el cliente desconoció el consumo ante su banco. El dinero
      // ya salió de nuestra cuenta. Va a cola humana con prioridad alta y con
      // toda la evidencia que el sistema fue juntando.
      updates.status = 'charged_back';
      await db.collection('disputes').add({
        requestId,
        transactionId: txRef.id,
        type: 'chargeback',
        openedBy: 'system',
        reason: 'El cliente desconoció el pago ante su banco.',
        status: 'open',
        priority: 'p1',
        amountInPlay: tx.amount,
        // Si el técnico ya cobró (tx.status era 'released'), no hay nada que
        // retener del lado nuestro: la plata ya salió por Payouts y
        // recuperarla, si corresponde, es un problema aparte con el técnico,
        // no algo que el escrow pueda revertir solo.
        fundsAlreadyPaidOut: tx.status === 'released',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      break;
  }

  await txRef.update(updates);
  await db.collection('requests').doc(requestId).collection('events').add({
    type: 'psp_webhook',
    actorId: 'system',
    payload: { paymentId, status: remote.status },
    at: new Date(),
  });
}

/**
 * Confirmación de la transferencia al técnico. Es el ÚNICO lugar del sistema
 * que puede marcar una transacción como `released` de verdad — ni la
 * liberación por PIN ni la resolución de disputas lo hacen directamente,
 * ambas dejan la transacción en `payout_pending` y esperan acá.
 *
 * Se busca la transacción por `payoutId`, no por `paymentIntentId`: son dos
 * recursos distintos de Mercado Pago (el pago del cliente y la transferencia
 * al técnico), con dos ids que no tienen por qué parecerse.
 */
async function handlePayoutUpdate(payoutId: string): Promise<void> {
  const gateway = gatewayFor('AR');
  const remote = await gateway.fetchPayoutStatus(payoutId);

  const txSnap = await db.collection('transactions')
    .where('payoutId', '==', payoutId)
    .limit(1)
    .get();

  if (txSnap.empty) {
    console.warn('Webhook de payout sin transacción asociada', { payoutId });
    return;
  }

  const tx = txSnap.docs[0].data();

  // 'pending' de verdad (el proveedor sigue procesando): no hay nada que
  // confirmar todavía. Nunca se asume éxito por descarte.
  if (remote.status === 'pending') return;

  await confirmPayout(tx.requestId, remote.status);
  await db.collection('requests').doc(tx.requestId).collection('events').add({
    type: 'payout_webhook',
    actorId: 'system',
    payload: { payoutId, status: remote.status },
    at: new Date(),
  });
}

