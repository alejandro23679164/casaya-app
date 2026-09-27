/**
 * Contrato de pasarela de pagos.
 *
 * El resto del backend (escrow, disputas, panel) habla solo con esta
 * interfaz. Stripe y Mercado Pago son implementaciones intercambiables:
 * cambiar de proveedor o correr los dos en paralelo por país no debería
 * tocar `jobFlow.ts` ni `admin.ts`.
 *
 * Todos los montos son enteros en centavos, incluso en Mercado Pago, que
 * trabaja con decimales. La conversión ocurre dentro del adaptador, nunca
 * afuera: un `/100` suelto en la lógica de negocio es un error de redondeo
 * esperando su turno.
 */

export type Psp = 'stripe' | 'mercadopago';

export interface HoldParams {
  requestId: string;
  amount: number;
  currency: string;
  /** Comisión que retiene la plataforma del total. */
  platformFee: number;
  /** Identificador del pagador en el proveedor. */
  payerRef: string;
  /** Token o id del medio de pago ya tokenizado en el cliente. */
  paymentMethodRef: string;
  payerEmail?: string;
  installments?: number;
  description: string;
}

export interface HoldResult {
  /** Id del pago/autorización en el proveedor. */
  externalId: string;
  /** Cuándo caduca la retención si no se captura. */
  expiresAt: Date | null;
  status: 'held' | 'requires_action' | 'failed';
  /** URL de autenticación adicional (3DS) cuando el proveedor la pide. */
  actionUrl?: string;
}

export interface CaptureParams {
  externalId: string;
  /** Monto final a capturar; puede ser menor al retenido, nunca mayor. */
  amount: number;
  platformFee: number;
  idempotencyKey: string;
}

export interface RefundParams {
  externalId: string;
  /** Omitido = devolución total. */
  amount?: number;
  reason: string;
  idempotencyKey: string;
}

/**
 * Payout: mover dinero ya capturado desde el balance de la PLATAFORMA hacia
 * la cuenta del vendedor.
 *
 * Existe como paso aparte de `capture()` porque no todos los proveedores
 * resuelven el split de la misma forma. En un marketplace "puro" (el pago se
 * crea desde el inicio con el token del vendedor, comisión incluida) el
 * dinero llega directo y este paso no hace falta — es el caso de Stripe
 * Connect con destination charges. En Mercado Pago, cuando el vendedor se
 * conoce recién después de crear el pago —nuestro caso: el técnico se asigna
 * en el despacho, después de que el cliente ya pagó— el pago se captura
 * contra la cuenta de la plataforma y este paso transfiere el neto al
 * vendedor como una operación aparte, con su propia confirmación
 * asincrónica por webhook. Ver el porqué completo en `mercadopago.ts`.
 */
export interface PayoutParams {
  /** Para poder rastrear el movimiento contra la solicitud que lo originó. */
  requestId: string;
  /** Cuenta destino en el proveedor; su forma depende de cada adaptador
   *  (en Mercado Pago, el email de la cuenta vinculada). */
  payeeAccountId: string;
  amount: number;
  currency: string;
  description: string;
  idempotencyKey: string;
}

export interface PayoutResult {
  payoutId: string;
  /** Estado inicial devuelto por la creación; la confirmación real llega por webhook. */
  status: 'pending' | 'completed' | 'failed';
}

export interface PaymentGateway {
  readonly psp: Psp;
  /** Cuántos días tolera el proveedor entre la retención y la captura. */
  readonly holdMaxDays: number;

  hold(params: HoldParams): Promise<HoldResult>;
  capture(params: CaptureParams): Promise<{ externalId: string; capturedAmount: number }>;
  refund(params: RefundParams): Promise<{ refundId: string; refundedAmount: number }>;
  /** Libera la retención sin cobrar (cancelación antes de capturar). */
  voidHold(externalId: string): Promise<void>;
  /** Estado actual según el proveedor; se usa para reconciliar. */
  fetchStatus(externalId: string): Promise<{ status: string; capturedAmount: number; refundedAmount: number }>;

  /**
   * Transfiere dinero ya capturado a la cuenta del vendedor. Todo adaptador
   * lo implementa explícitamente — nunca queda "sin hacer nada" en
   * silencio— aunque un proveedor con split-at-creation puede resolverlo
   * devolviendo `{ payoutId: '', status: 'completed' }` de inmediato, porque
   * el dinero ya llegó dentro de `capture()`.
   */
  payout(params: PayoutParams): Promise<PayoutResult>;
  /** Estado real del payout: para confirmar tras el webhook o para reintentar. */
  fetchPayoutStatus(payoutId: string): Promise<{ status: 'pending' | 'completed' | 'failed' }>;
}

/** Errores de pago normalizados, para que la UI diga algo útil. */
export class PaymentError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'insufficient_funds'
      | 'card_rejected'
      | 'hold_expired'
      | 'already_captured'
      | 'invalid_amount'
      | 'provider_error',
    readonly raw?: unknown,
  ) {
    super(message);
  }

  /** Mensaje apto para mostrarle a una persona. */
  get userMessage(): string {
    switch (this.code) {
      case 'insufficient_funds': return 'La tarjeta no tiene fondos suficientes.';
      case 'card_rejected': return 'El banco rechazó el pago. Probá con otro medio.';
      case 'hold_expired': return 'La reserva del pago venció. Hay que volver a autorizarla.';
      case 'already_captured': return 'Este pago ya fue cobrado.';
      case 'invalid_amount': return 'El monto no es válido.';
      default: return 'No pudimos procesar el pago. Intentá de nuevo en unos minutos.';
    }
  }
}
