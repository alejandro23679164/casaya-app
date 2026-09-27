/**
 * Adaptador de Mercado Pago.
 *
 * MODELO REAL (corregido tras revisar la documentación vigente, no la
 * memoria de entrenamiento — ver STAGING-READINESS.md, Bloqueante #1):
 *
 *  1. RETENCIÓN. Se crea el pago con `capture: false`, SIEMPRE con el token
 *     de la PLATAFORMA. Mercado Pago fija quién cobra un pago por el token
 *     usado al CREARLO, no por algo reasignable después — y en nuestro flujo
 *     el técnico se conoce recién en el despacho, después de que el cliente
 *     ya pagó. Por eso el split "a la Stripe Connect" (crear el pago ya con
 *     el token del vendedor) no es viable acá: forzaría a saber el técnico
 *     ANTES de cobrar, y eso invertiría todo el orden despacho→pago.
 *
 *  2. CAPTURA. `PUT /v1/payments/{id}` con `capture: true`, con el MISMO
 *     token de plataforma que creó el pago — no con el del técnico. El
 *     dinero queda en el balance de la plataforma, capturado pero todavía
 *     sin llegar al técnico.
 *
 *  3. PAYOUT. `POST /v1/payouts` transfiere el neto desde el balance de la
 *     plataforma a la cuenta vinculada del técnico. Es un producto aparte
 *     ("Payouts"), con su propia alta en el panel de Mercado Pago —
 *     distinta de la app de marketplace usada para el OAuth de vinculación—
 *     y responde 202 de forma asincrónica: la confirmación real llega por
 *     webhook (`type: payout`), nunca en la respuesta del POST. El estado
 *     queda `payout_pending` hasta que ese webhook confirme.
 *
 * Tres límites reales que condicionan el diseño:
 *
 *  - La preautorización dura pocos días (7 como referencia; varía por país y
 *    banco emisor). El job de liberación automática a las 72 h existe para
 *    tener margen antes de que la reserva caduque sola.
 *  - `capture: false` no está disponible para todos los medios de pago. Con
 *    dinero en cuenta, transferencia o efectivo no hay preautorización
 *    posible — para esos casos el pago se cobra directo a la plataforma y
 *    queda en el mismo modo de custodia que se usa acá para todo.
 *  - El payout exige fondos disponibles en el balance de origen. Capturar no
 *    garantiza liquidez instantánea (puede haber un desfase de acreditación),
 *    así que un payout puede fallar por fondos insuficientes incluso segundos
 *    después de una captura exitosa. El job de reintento
 *    (`retryStuckPayouts` en `reconciliation.ts`) existe por eso, no por las
 *    dudas.
 *
 *  Los montos van en unidades decimales, no en centavos. La conversión vive
 *  acá adentro y en ningún otro lado.
 */

import * as crypto from 'crypto';
import {
  PaymentGateway, HoldParams, HoldResult, CaptureParams, RefundParams,
  PayoutParams, PayoutResult, PaymentError,
} from './gateway';

const API = 'https://api.mercadopago.com';

/** Centavos → unidades decimales con 2 decimales exactos. */
const toAmount = (cents: number): number => Math.round(cents) / 100;
/** Unidades decimales → centavos, evitando el error de coma flotante. */
const toCents = (amount: number): number => Math.round(amount * 100);

export class MercadoPagoGateway implements PaymentGateway {
  readonly psp = 'mercadopago' as const;
  readonly holdMaxDays = 7;

  constructor(
    /** Access token de la aplicación marketplace (retiene, captura, hace payout). */
    private readonly platformToken: string,
    /** User id de la aplicación en Mercado Libre (header de sponsor, para el split de comisión). */
    private readonly sponsorId: string,
  ) {}

  // ---------------------------------------------------------------- HTTP
  private async call<T>(
    path: string,
    init: { method: string; body?: unknown; idempotencyKey?: string; extraHeaders?: Record<string, string> },
  ): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      method: init.method,
      headers: {
        'Authorization': `Bearer ${this.platformToken}`,
        'Content-Type': 'application/json',
        ...(init.idempotencyKey ? { 'X-Idempotency-Key': init.idempotencyKey } : {}),
        ...init.extraHeaders,
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw this.normalizeError(json, res.status);
    return json as T;
  }

  private normalizeError(body: any, httpStatus: number): PaymentError {
    const detail: string = body?.status_detail ?? body?.error ?? body?.message ?? 'unknown';

    if (detail.includes('insufficient_amount') || detail.includes('insufficient_funds')) {
      return new PaymentError('Fondos insuficientes', 'insufficient_funds', body);
    }
    if (detail.includes('cc_rejected') || detail.includes('rejected')) {
      return new PaymentError('Pago rechazado', 'card_rejected', body);
    }
    if (detail.includes('expired') || httpStatus === 410) {
      return new PaymentError('Reserva vencida', 'hold_expired', body);
    }
    if (detail.includes('already') || detail.includes('not_allowed_status')) {
      return new PaymentError('El pago ya cambió de estado', 'already_captured', body);
    }
    return new PaymentError(`Mercado Pago: ${detail}`, 'provider_error', body);
  }

  // ------------------------------------------------------------ retención
  async hold(p: HoldParams): Promise<HoldResult> {
    // Siempre con el token de PLATAFORMA: el técnico todavía no existe en
    // este punto del flujo (se asigna recién en el despacho). Ver el
    // comentario grande al principio del archivo.
    const payment = await this.call<any>('/v1/payments', {
      method: 'POST',
      idempotencyKey: `hold_${p.requestId}`,
      extraHeaders: { 'X-Meli-Sponsor-Id': this.sponsorId },
      body: {
        transaction_amount: toAmount(p.amount),
        token: p.paymentMethodRef,
        installments: p.installments ?? 1,
        capture: false,                                  // <- preautorización
        description: p.description,
        external_reference: p.requestId,
        payer: { id: p.payerRef, email: p.payerEmail },
        metadata: { request_id: p.requestId, platform: 'casaya' },
        notification_url: process.env.MP_WEBHOOK_URL,
      },
    });

    if (payment.status === 'rejected') {
      throw this.normalizeError(payment, 400);
    }

    // `in_process` = antifraude revisando. No es un fracaso; se espera el webhook.
    const status: HoldResult['status'] =
      payment.status === 'authorized' ? 'held'
      : payment.status === 'in_process' ? 'requires_action'
      : 'failed';

    return {
      externalId: String(payment.id),
      status,
      expiresAt: payment.date_of_expiration
        ? new Date(payment.date_of_expiration)
        : new Date(Date.now() + this.holdMaxDays * 86_400_000),
      actionUrl: payment.three_ds_info?.external_resource_url,
    };
  }

  // -------------------------------------------------------------- captura
  /**
   * Captura contra la cuenta de la PLATAFORMA — con el mismo token que creó
   * la retención, nunca con el del técnico: Mercado Pago no permite
   * "reasignar" el cobro a otra cuenta al capturar. El dinero llega al
   * técnico después, en `payout()`.
   */
  async capture(p: CaptureParams): Promise<{ externalId: string; capturedAmount: number }> {
    const result = await this.call<any>(`/v1/payments/${p.externalId}`, {
      method: 'PUT',
      idempotencyKey: p.idempotencyKey,
      body: {
        capture: true,
        transaction_amount: toAmount(p.amount),   // puede ser menor al autorizado
      },
    });

    if (result.status !== 'approved') {
      throw this.normalizeError(result, 400);
    }

    return {
      externalId: String(result.id),
      capturedAmount: toCents(result.transaction_amount),
    };
  }

  // ---------------------------------------------------------------- payout
  /**
   * Transferencia efectiva a la cuenta del técnico. Producto "Payouts" de
   * Mercado Pago: requiere su propia habilitación en el panel — separada de
   * la app de marketplace usada para el OAuth — y responde 202 de forma
   * asincrónica. `payeeAccountId` acá es el EMAIL de la cuenta de Mercado
   * Pago del técnico (ver `fetchAccountEmail`, capturado una vez al vincular).
   */
  async payout(p: PayoutParams): Promise<PayoutResult> {
    const result = await this.call<any>('/v1/payouts', {
      method: 'POST',
      idempotencyKey: p.idempotencyKey,
      body: {
        external_reference: p.requestId,
        description: p.description,
        config: { notification_url: process.env.MP_PAYOUT_WEBHOOK_URL ?? process.env.MP_WEBHOOK_URL },
        transactions: [{
          type: 'account',
          description: p.description,
          account: { email: p.payeeAccountId },
          amount: { currency: p.currency, value: toAmount(p.amount) },
          external_reference: p.requestId,
        }],
      },
    });

    return {
      // La respuesta de /v1/payouts no siempre trae un id de nivel superior
      // documentado de forma estable; si no viene, se usa la referencia
      // externa —única por diseño— como clave para el webhook y para
      // `fetchPayoutStatus`.
      payoutId: String(result?.id ?? p.requestId),
      status: 'pending',
    };
  }

  /**
   * ADVERTENCIA: no encontré en la documentación pública un endpoint GET de
   * un solo payout por id confirmado y estable al momento de escribir esto
   * (sí está documentado el POST de creación). Antes de depender de este
   * método en el job de reintento, confirmar contra la referencia vigente
   * de la API cuál es la forma correcta de consultar el estado — puede ser
   * un GET por external_reference en vez de por id. Mientras tanto, el
   * webhook sigue siendo la fuente confiable; este método es el respaldo
   * para el job de reintento, no el camino principal.
   */
  async fetchPayoutStatus(payoutId: string): Promise<{ status: 'pending' | 'completed' | 'failed' }> {
    try {
      const result = await this.call<any>(`/v1/payouts/${payoutId}`, { method: 'GET' });
      const raw = String(result?.status ?? '').toLowerCase();
      if (['completed', 'success', 'processed'].includes(raw)) return { status: 'completed' };
      if (['failed', 'rejected', 'error'].includes(raw)) return { status: 'failed' };
      return { status: 'pending' };
    } catch {
      // Si el GET no existe o falla, no se puede afirmar nada: se trata
      // como pendiente y se deja que el webhook o un reintento posterior
      // resuelvan. Nunca se asume 'completed' por defecto — asumir eso sería
      // el tipo de optimismo que hace desaparecer plata en los reportes.
      return { status: 'pending' };
    }
  }

  // ---------------------------------------------------------- devolución
  async refund(p: RefundParams): Promise<{ refundId: string; refundedAmount: number }> {
    const refund = await this.call<any>(`/v1/payments/${p.externalId}/refunds`, {
      method: 'POST',
      idempotencyKey: p.idempotencyKey,
      body: p.amount ? { amount: toAmount(p.amount) } : {},
    });

    return { refundId: String(refund.id), refundedAmount: toCents(refund.amount) };
  }

  /** Cancelar una autorización no capturada: el cliente nunca ve el cargo. */
  async voidHold(externalId: string): Promise<void> {
    await this.call(`/v1/payments/${externalId}`, {
      method: 'PUT',
      body: { status: 'cancelled' },
    });
  }

  async fetchStatus(externalId: string) {
    const p = await this.call<any>(`/v1/payments/${externalId}`, { method: 'GET' });
    return {
      status: p.status,
      capturedAmount: p.status === 'approved' ? toCents(p.transaction_amount) : 0,
      refundedAmount: toCents(p.transaction_amount_refunded ?? 0),
    };
  }
}

// ---------------------------------------------------------------------------
// OAuth del técnico: sin esto no hay a quién hacerle el payout.
// ---------------------------------------------------------------------------
export async function exchangeOAuthCode(params: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ accessToken: string; refreshToken: string; userId: string; expiresIn: number }> {
  const res = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code: params.code,
      redirect_uri: params.redirectUri,
    }),
  });

  const json: any = await res.json();
  if (!res.ok) throw new PaymentError('No se pudo vincular la cuenta', 'provider_error', json);

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    userId: String(json.user_id),
    expiresIn: json.expires_in,
  };
}

/** Los tokens de vendedor caducan; se renuevan antes de cada uso si hace falta. */
export async function refreshSellerToken(params: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const res = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: params.clientId,
      client_secret: params.clientSecret,
      refresh_token: params.refreshToken,
    }),
  });
  const json: any = await res.json();
  if (!res.ok) throw new PaymentError('No se pudo renovar el acceso', 'provider_error', json);
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresIn: json.expires_in };
}

/**
 * El destino de un payout se identifica por email de cuenta Mercado Pago, no
 * por el id de OAuth. Se consulta una sola vez, con el token recién obtenido
 * del técnico, justo después de vincular — así el resto del sistema no
 * vuelve a tocar su token salvo para renovarlo.
 */
export async function fetchAccountEmail(accessToken: string): Promise<string> {
  const res = await fetch(`${API}/users/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json: any = await res.json();
  if (!res.ok || !json.email) {
    throw new PaymentError('No se pudo leer el email de la cuenta vinculada', 'provider_error', json);
  }
  return json.email as string;
}

// ---------------------------------------------------------------------------
// Verificación de firma del webhook.
//
// Sin esto, cualquiera que conozca la URL puede avisar que un pago (o un
// payout) se aprobó. El manifiesto se arma con el id del recurso, el
// request-id y el timestamp, en ese orden exacto, puntos y comas incluidos.
// ---------------------------------------------------------------------------
export function verifyWebhookSignature(params: {
  signatureHeader: string;   // "ts=1704908010,v1=618c85345248dd820d5fd456117c2ab2ef8eda45a0282ff693eac24131a5e839"
  requestId: string;         // header x-request-id
  dataId: string;            // query param data.id
  secret: string;            // clave secreta del webhook en el panel de MP
  toleranceSeconds?: number;
}): boolean {
  const parts = Object.fromEntries(
    params.signatureHeader.split(',').map((kv) => kv.split('=').map((s) => s.trim()) as [string, string]),
  );
  const ts = parts['ts'];
  const v1 = parts['v1'];
  if (!ts || !v1) return false;

  const tolerance = params.toleranceSeconds ?? 300;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > tolerance) return false;

  const manifest = `id:${params.dataId.toLowerCase()};request-id:${params.requestId};ts:${ts};`;
  const expected = crypto.createHmac('sha256', params.secret).update(manifest).digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(v1, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/*
 * NOTA SOBRE MEDIOS SIN PREAUTORIZACIÓN
 * -------------------------------------
 * Si el cliente paga con dinero en cuenta, transferencia o efectivo, no existe
 * `capture: false`. En esos casos el pago se cobra directo a la cuenta de la
 * PLATAFORMA al crearse (sin preautorización) y de ahí en más sigue el mismo
 * camino que cualquier captura: queda en custodia hasta el payout. No hace
 * falta una rama de código aparte — es el mismo modelo de custodia que ya usa
 * todo el flujo, solo que sin el paso intermedio de "retener sin cobrar".
 */
