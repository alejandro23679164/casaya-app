/**
 * Conciliación diaria contra Mercado Pago.
 *
 * Por qué existe: los webhooks se pierden. Una función fría que agota el
 * tiempo, un despliegue en el momento justo, una caída de red del lado del
 * proveedor. Cuando eso pasa, nuestra base dice una cosa y el dinero hizo
 * otra, y nadie se entera hasta que alguien reclama por teléfono, semanas
 * después, cuando ya no hay forma de reconstruir qué pasó.
 *
 * Qué hace: trae todos los pagos del período desde la API del proveedor, los
 * cruza contra `transactions` y anota cada diferencia. No corrige sola salvo
 * en los casos evidentes y de una sola dirección; el resto va a revisión
 * humana. Una conciliación que "arregla" automáticamente es una conciliación
 * que puede duplicar un cobro por su cuenta.
 *
 * Nota sobre las dos fuentes de Mercado Pago:
 *  - `/v1/payments/search` devuelve el estado de cada pago. Es lo que usamos
 *    acá: responde al instante y alcanza para detectar desalineaciones.
 *  - El reporte de liquidaciones (`/v1/account/settlement_report`) muestra el
 *    dinero efectivamente acreditado, con comisiones e impuestos. Es lo que
 *    hay que cruzar contra la contabilidad, y se genera de forma asincrónica.
 *    Está implementado abajo como job semanal.
 */

import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';
import { gatewayByPsp } from '../services/payments';
import { captureAndPayout, confirmPayout } from '../services/escrow';

const db = admin.firestore();
const API = 'https://api.mercadopago.com';

type Severity = 'info' | 'warn' | 'critical';

interface Discrepancy {
  requestId: string;
  transactionId: string | null;
  paymentId: string | null;
  kind:
    | 'missing_locally'        // el proveedor tiene un pago que no conocemos
    | 'missing_remotely'       // tenemos una transacción sin pago en el proveedor
    | 'status_mismatch'        // los dos lo conocen, en estados distintos
    | 'amount_mismatch'        // el monto no coincide
    | 'stale_hold';            // retención a punto de vencer sin capturar
  localStatus: string | null;
  remoteStatus: string | null;
  localAmount: number | null;
  remoteAmount: number | null;
  severity: Severity;
  note: string;
}

/** Mapa entre los estados del proveedor y los nuestros. */
const EXPECTED_LOCAL: Record<string, string[]> = {
  authorized: ['held'],
  approved: ['released'],
  refunded: ['refunded', 'partially_refunded'],
  cancelled: ['failed', 'refunded'],
  rejected: ['failed'],
  in_process: ['requires_payment', 'held'],
  charged_back: ['charged_back'],
};

async function searchPayments(params: {
  token: string;
  beginDate: Date;
  endDate: Date;
}): Promise<any[]> {
  const results: any[] = [];
  let offset = 0;
  const limit = 100;

  // Paginado explícito: un día de operación puede superar largamente el tope
  // de una sola respuesta, y quedarse con la primera página daría un reporte
  // de conciliación limpio y falso.
  while (true) {
    const url = new URL(`${API}/v1/payments/search`);
    url.searchParams.set('sort', 'date_created');
    url.searchParams.set('criteria', 'asc');
    url.searchParams.set('range', 'date_created');
    url.searchParams.set('begin_date', params.beginDate.toISOString());
    url.searchParams.set('end_date', params.endDate.toISOString());
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${params.token}` },
    });
    if (!res.ok) throw new Error(`payments/search ${res.status}: ${await res.text()}`);

    const json: any = await res.json();
    results.push(...(json.results ?? []));

    const total = json.paging?.total ?? results.length;
    offset += limit;
    if (offset >= total || (json.results ?? []).length === 0) break;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Conciliación diaria. Corre de madrugada sobre el día anterior completo, con
// 6 horas de solapamiento: un pago creado a las 23:58 puede acreditarse
// después de medianoche.
// ---------------------------------------------------------------------------
export const reconcilePayments = onSchedule(
  { schedule: '0 5 * * *', timeZone: 'America/Argentina/Buenos_Aires', timeoutSeconds: 540, memory: '1GiB' },
  async () => {
    const endDate = new Date();
    const beginDate = new Date(Date.now() - 30 * 3600_000);   // 24 h + 6 de margen

    const runRef = db.collection('reconciliation_runs').doc();
    await runRef.set({
      startedAt: admin.firestore.FieldValue.serverTimestamp(),
      periodStart: beginDate,
      periodEnd: endDate,
      status: 'running',
    });

    try {
      const remotePayments = await searchPayments({
        token: process.env.MP_ACCESS_TOKEN!,
        beginDate,
        endDate,
      });

      // Índice por referencia externa, que es nuestro requestId.
      const remoteByRequest = new Map<string, any>();
      for (const p of remotePayments) {
        if (p.external_reference) remoteByRequest.set(String(p.external_reference), p);
      }

      const localSnap = await db.collection('transactions')
        .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(beginDate))
        .get();

      const discrepancies: Discrepancy[] = [];
      const seen = new Set<string>();

      // --- recorrido por lo que tenemos nosotros -------------------------
      for (const doc of localSnap.docs) {
        const tx = doc.data();
        const requestId: string = tx.requestId;
        seen.add(requestId);

        const remote = remoteByRequest.get(requestId);

        if (!remote) {
          // Una transacción en 'requires_payment' sin contraparte suele ser un
          // intento abandonado, no un problema.
          const severity: Severity = tx.status === 'requires_payment' ? 'info' : 'critical';
          discrepancies.push({
            requestId,
            transactionId: doc.id,
            paymentId: tx.paymentIntentId ?? null,
            kind: 'missing_remotely',
            localStatus: tx.status,
            remoteStatus: null,
            localAmount: tx.amount,
            remoteAmount: null,
            severity,
            note: severity === 'critical'
              ? 'Tenemos una transacción activa sin pago correspondiente en el proveedor.'
              : 'Intento de pago sin concretar.',
          });
          continue;
        }

        const remoteAmount = Math.round((remote.transaction_amount ?? 0) * 100);
        const expected = EXPECTED_LOCAL[remote.status] ?? [];

        if (expected.length > 0 && !expected.includes(tx.status)) {
          discrepancies.push({
            requestId,
            transactionId: doc.id,
            paymentId: String(remote.id),
            kind: 'status_mismatch',
            localStatus: tx.status,
            remoteStatus: remote.status,
            localAmount: tx.amount,
            remoteAmount,
            severity: remote.status === 'charged_back' ? 'critical' : 'warn',
            note: `El proveedor dice "${remote.status}" y nosotros "${tx.status}".`,
          });
        }

        // El monto solo se compara cuando el pago ya se capturó: sobre una
        // autorización puede diferir legítimamente si se capturó menos.
        if (remote.status === 'approved' && remoteAmount !== tx.amount) {
          discrepancies.push({
            requestId,
            transactionId: doc.id,
            paymentId: String(remote.id),
            kind: 'amount_mismatch',
            localStatus: tx.status,
            remoteStatus: remote.status,
            localAmount: tx.amount,
            remoteAmount,
            severity: 'critical',
            note: `Cobrado ${remoteAmount} contra ${tx.amount} registrado.`,
          });
        }

        // Retención próxima a vencer sin capturar: si nadie actúa, el dinero se
        // suelta solo y el técnico trabajó gratis.
        if (tx.status === 'held') {
          const heldMs = tx.escrow?.heldAt?.toMillis?.() ?? 0;
          const ageDays = (Date.now() - heldMs) / 86_400_000;
          if (heldMs && ageDays > 5) {
            discrepancies.push({
              requestId,
              transactionId: doc.id,
              paymentId: String(remote.id),
              kind: 'stale_hold',
              localStatus: tx.status,
              remoteStatus: remote.status,
              localAmount: tx.amount,
              remoteAmount,
              severity: 'critical',
              note: `Retención de ${Math.floor(ageDays)} días. Vence pronto y todavía no se capturó.`,
            });
          }
        }

        // Capturado pero sin llegar a la cuenta del técnico. Es plata ya
        // cobrada al cliente y quieta en la cuenta de la plataforma — el
        // técnico hizo el trabajo y todavía no ve un peso. Dos horas es
        // margen de sobra para que un payout normal confirme o falle;
        // `retryStuckPayouts`, más abajo, es quien realmente lo reintenta —
        // esto solo dejar constancia de que algo quedó pisado.
        if (['captured', 'payout_pending'].includes(tx.status)) {
          const updatedMs = tx.updatedAt?.toMillis?.() ?? 0;
          const ageHours = (Date.now() - updatedMs) / 3600_000;
          if (updatedMs && ageHours > 2) {
            discrepancies.push({
              requestId,
              transactionId: doc.id,
              paymentId: String(remote.id),
              kind: 'stale_hold',
              localStatus: tx.status,
              remoteStatus: remote.status,
              localAmount: tx.amount,
              remoteAmount,
              severity: 'critical',
              note: tx.status === 'captured'
                ? `Capturado hace ${Math.floor(ageHours)} horas, la transferencia al técnico nunca se inició.`
                : `Transferencia iniciada hace ${Math.floor(ageHours)} horas, sin confirmación del webhook.`,
            });
          }
        }
      }

      // --- recorrido inverso: pagos que el proveedor tiene y nosotros no ---
      for (const [requestId, remote] of remoteByRequest) {
        if (seen.has(requestId)) continue;
        discrepancies.push({
          requestId,
          transactionId: null,
          paymentId: String(remote.id),
          kind: 'missing_locally',
          localStatus: null,
          remoteStatus: remote.status,
          localAmount: null,
          remoteAmount: Math.round((remote.transaction_amount ?? 0) * 100),
          severity: 'critical',
          note: 'Hay un cobro en el proveedor sin transacción registrada. Puede ser un cobro huérfano.',
        });
      }

      // --- persistencia -------------------------------------------------
      // Las diferencias se guardan, no se corrigen. La única excepción está
      // abajo: alinear un estado local que quedó atrás de un webhook perdido,
      // que es un cambio de una sola dirección y sin movimiento de dinero.
      const batch = db.batch();
      for (const d of discrepancies) {
        batch.create(db.collection('reconciliation_issues').doc(), {
          ...d,
          runId: runRef.id,
          status: 'open',
          detectedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      await batch.commit();

      const autoFixed = await autoAlignStatuses(discrepancies, remoteByRequest);

      const critical = discrepancies.filter((d) => d.severity === 'critical').length;

      await runRef.update({
        status: 'done',
        finishedAt: admin.firestore.FieldValue.serverTimestamp(),
        remoteCount: remotePayments.length,
        localCount: localSnap.size,
        discrepancyCount: discrepancies.length,
        criticalCount: critical,
        autoFixedCount: autoFixed,
      });

      if (critical > 0) {
        // Cola de operaciones con prioridad alta: una diferencia de dinero sin
        // nadie mirándola no se resuelve sola.
        await db.collection('ops_queue').add({
          type: 'reconciliation',
          runId: runRef.id,
          priority: 'p1',
          summary: `${critical} diferencias críticas en la conciliación del día.`,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      console.log(`Conciliación ${runRef.id}: ${discrepancies.length} diferencias, ${critical} críticas.`);
    } catch (err) {
      await runRef.update({
        status: 'failed',
        error: String(err),
        finishedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      // Relanzar deja el fallo visible en los logs y en las alertas del
      // programador, en lugar de un job que "corre bien" todos los días sin
      // hacer nada.
      throw err;
    }
  },
);

/**
 * Corrección automática acotada: solo adelanta el estado local cuando el
 * proveedor ya confirmó un movimiento que nosotros no registramos, y nunca al
 * revés. Alinear en la otra dirección sería reescribir la realidad del dinero
 * desde nuestra base, que es exactamente el error que esta función busca
 * detectar.
 */
async function autoAlignStatuses(
  discrepancies: Discrepancy[],
  remoteByRequest: Map<string, any>,
): Promise<number> {
  const safeTransitions: Record<string, { from: string[]; to: string }> = {
    approved: { from: ['held'], to: 'released' },
    refunded: { from: ['held', 'released'], to: 'refunded' },
    rejected: { from: ['requires_payment'], to: 'failed' },
  };

  let fixed = 0;

  for (const d of discrepancies) {
    if (d.kind !== 'status_mismatch' || !d.remoteStatus || !d.localStatus) continue;

    const rule = safeTransitions[d.remoteStatus];
    if (!rule || !rule.from.includes(d.localStatus)) continue;

    const remote = remoteByRequest.get(d.requestId);
    await db.collection('transactions').doc(d.transactionId!).update({
      status: rule.to,
      pspStatus: d.remoteStatus,
      reconciledAt: admin.firestore.FieldValue.serverTimestamp(),
      ledger: admin.firestore.FieldValue.arrayUnion({
        at: new Date(),
        from: 'reconciliation',
        to: 'ledger',
        amount: Math.round((remote?.transaction_amount ?? 0) * 100),
        reason: `align:${d.localStatus}->${rule.to}`,
      }),
    });

    await db.collection('requests').doc(d.requestId).collection('events').add({
      type: 'reconciliation_aligned',
      actorId: 'system',
      payload: { from: d.localStatus, to: rule.to, remoteStatus: d.remoteStatus },
      at: new Date(),
    });

    fixed++;
  }

  return fixed;
}

// ---------------------------------------------------------------------------
// Reporte de liquidaciones. Semanal, porque es lo que se cruza con la
// contabilidad: muestra el dinero efectivamente acreditado con comisiones,
// impuestos y retenciones descontadas, que nunca coincide exactamente con la
// suma de los pagos.
// ---------------------------------------------------------------------------
export const requestSettlementReport = onSchedule(
  { schedule: '0 6 * * 1', timeZone: 'America/Argentina/Buenos_Aires' },
  async () => {
    const end = new Date();
    const begin = new Date(Date.now() - 7 * 86_400_000);

    const res = await fetch(`${API}/v1/account/settlement_report`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN!}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        begin_date: begin.toISOString(),
        end_date: end.toISOString(),
      }),
    });

    if (!res.ok) throw new Error(`settlement_report ${res.status}: ${await res.text()}`);

    // El reporte se genera de forma asincrónica: el proveedor avisa por
    // webhook cuando está listo y ahí se descarga y se procesa. Guardamos el
    // pedido para poder emparejarlo con esa notificación.
    await db.collection('settlement_reports').add({
      periodStart: begin,
      periodEnd: end,
      status: 'requested',
      requestedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  },
);

// ---------------------------------------------------------------------------
// Reintento de payouts trabados.
//
// Cubre dos formas distintas de quedar pisado, con dos tratamientos
// distintos — nunca se reintenta a ciegas:
//
//  - `captured`: el dinero se cobró y nunca se llegó a disparar el payout
//    (falló la llamada, o el técnico no tenía cuenta vinculada en ese
//    momento). Reintentar es seguro: `captureAndPayout` no vuelve a capturar
//    —el estado ya no es 'held'— solo intenta la transferencia de nuevo.
//  - `payout_pending`: el payout se inició pero nunca llegó el webhook de
//    confirmación. Antes de asumir cualquier cosa, se consulta el estado real
//    contra el proveedor (`fetchPayoutStatus`) y se resuelve con la misma
//    función que usaría el webhook — nunca se marca 'released' sin que el
//    proveedor lo haya confirmado.
//
// Un payout que el webhook ya marcó `payout_failed` NO se reintenta acá: ese
// estado significa que Mercado Pago confirmó el fallo, y reintentar a ciegas
// una falla confirmada (destino inválido, cuenta desvinculada) solo repite
// el mismo error. Ese caso queda en la cola de operaciones para que una
// persona entienda por qué falló antes de disparar un nuevo intento.
// ---------------------------------------------------------------------------
export const retryStuckPayouts = onSchedule(
  { schedule: 'every 30 minutes', timeZone: 'America/Argentina/Buenos_Aires', timeoutSeconds: 300 },
  async () => {
    const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 2 * 3600_000);

    // --- capturado, payout nunca disparado ---------------------------------
    const capturedStuck = await db.collection('transactions')
      .where('status', '==', 'captured')
      .where('updatedAt', '<', cutoff)
      .limit(50)
      .get();

    for (const doc of capturedStuck.docs) {
      const tx = doc.data();
      const reqSnap = await db.collection('requests').doc(tx.requestId).get();
      const technicianId = reqSnap.get('technicianId');
      if (!technicianId) continue;   // no debería pasar a esta altura, pero sin técnico no hay a quién pagarle

      try {
        await captureAndPayout({
          requestId: tx.requestId,
          technicianId,
          captureAmount: tx.amount,          // se ignora: el estado ya no es 'held', no vuelve a capturar
          payoutAmount: tx.technicianPayout,
          method: tx.escrow?.releaseMethod ?? 'auto_timeout',
        });
      } catch (err) {
        // Sigue 'captured' — el dinero está seguro, se reintenta en la
        // próxima corrida. No hace falta escalar todavía: recién a partir
        // de varias corridas fallidas seguidas vale la pena una alerta más
        // fuerte que la que ya deja la conciliación diaria.
        console.error(`retryStuckPayouts: no se pudo reintentar ${tx.requestId}`, err);
      }
    }

    // --- payout iniciado, webhook nunca confirmó ----------------------------
    const pending = await db.collection('transactions')
      .where('status', '==', 'payout_pending')
      .where('updatedAt', '<', cutoff)
      .limit(50)
      .get();

    const gateway = gatewayByPsp('mercadopago');

    for (const doc of pending.docs) {
      const tx = doc.data();
      if (!tx.payoutId) continue;

      try {
        const remote = await gateway.fetchPayoutStatus(tx.payoutId);
        if (remote.status === 'completed') {
          await confirmPayout(tx.requestId, 'completed');
        } else if (remote.status === 'failed') {
          await confirmPayout(tx.requestId, 'failed');
        }
        // 'pending' de verdad: se deja como está, se vuelve a consultar en
        // la próxima corrida.
      } catch (err) {
        console.error(`retryStuckPayouts: no se pudo consultar el payout de ${tx.requestId}`, err);
      }
    }
  },
);
