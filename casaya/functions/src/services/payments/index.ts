/**
 * Selección de pasarela. Un solo lugar decide quién procesa cada pago.
 *
 * El criterio es el país del cliente, no una variable global: una plataforma
 * que opere en dos mercados va a necesitar las dos pasarelas vivas al mismo
 * tiempo, y la transacción guarda cuál se usó para que la reconciliación y
 * las devoluciones sepan a quién preguntarle.
 *
 * Desde la corrección del modelo de custodia, `capture()` y `payout()`
 * siempre usan el token de la PLATAFORMA — nunca el del técnico — así que
 * `MercadoPagoGateway` no necesita un resolver de token de vendedor. Lo único
 * que las operaciones de dinero necesitan de la cuenta del técnico es su
 * email vinculado, y eso se pasa directo como `payeeAccountId` en cada
 * llamada (ver `escrow.ts`), no a través del constructor de la pasarela.
 */

import { PaymentGateway, Psp } from './gateway';
import { MercadoPagoGateway } from './mercadopago';

const MP_COUNTRIES = new Set(['AR', 'MX', 'BR', 'CL', 'CO', 'PE', 'UY']);

let mpInstance: MercadoPagoGateway | null = null;

export function gatewayFor(countryCode: string): PaymentGateway {
  if (MP_COUNTRIES.has(countryCode.toUpperCase())) {
    mpInstance ??= new MercadoPagoGateway(process.env.MP_ACCESS_TOKEN!, process.env.MP_SPONSOR_ID!);
    return mpInstance;
  }
  throw new Error(`No hay pasarela configurada para ${countryCode}`);
}

/** Recupera la pasarela que procesó una transacción ya existente. */
export function gatewayByPsp(psp: Psp): PaymentGateway {
  if (psp === 'mercadopago') return gatewayFor('AR');
  throw new Error(`Pasarela no disponible: ${psp}`);
}
