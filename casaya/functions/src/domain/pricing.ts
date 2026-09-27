/**
 * Motor de cotización. Es una función pura: mismos datos de entrada, misma
 * salida, sin tocar red ni base de datos. Eso lo hace trivial de testear y
 * permite reutilizarlo tal cual en el frontend para mostrar el precio en vivo.
 *
 * Todos los montos son enteros en centavos. Nunca usar float para dinero.
 */

import { PLATFORM, NIGHT_WINDOW } from '../config/constants';

export type PricingModel = 'fixed' | 'hourly' | 'visit_fee_then_quote';
export type Urgency = 'standard' | 'same_day' | 'express_2h';

export interface ServicePricing {
  pricingModel: PricingModel;
  basePrice: number;
  hourlyRate: number;
  minimumBillableMinutes: number;
  visitFee: number;
  currency: string;
  estimatedMinutes: number;
  nightSurchargePct: number;
  urgencyMultipliers: Record<Urgency, number>;
}

export interface QuoteInput {
  service: ServicePricing;
  urgency: Urgency;
  /** Momento en que se ejecutará el trabajo, en hora local del cliente. */
  scheduledFor: Date;
  /** Minutos estimados por el cliente; si falta, se usa el estimado del servicio. */
  estimatedMinutes?: number;
  /** Cargos extra ya aprobados (materiales, repuestos). */
  extraCharges?: number;
}

export interface Quote {
  currency: string;
  basePrice: number;
  urgencyMultiplier: number;
  nightSurcharge: number;
  extraCharges: number;
  subtotal: number;
  serviceFee: number;
  taxes: number;
  total: number;
  technicianPayout: number;
  estimatedLaborMinutes: number;
  /** true cuando el precio final depende de lo que el técnico vea en el lugar. */
  isEstimate: boolean;
}

const round = (n: number) => Math.round(n);

function isNightTime(date: Date): boolean {
  const h = date.getHours();
  return h >= NIGHT_WINDOW.startHour || h < NIGHT_WINDOW.endHour;
}

/** Mano de obra según el modelo de precio del servicio. */
function laborCost(service: ServicePricing, minutes: number): number {
  switch (service.pricingModel) {
    case 'fixed':
      return service.basePrice;

    case 'hourly': {
      const billable = Math.max(minutes, service.minimumBillableMinutes);
      const extraMinutes = Math.max(0, billable - service.minimumBillableMinutes);
      // Las horas adicionales se facturan en bloques de 30 minutos.
      const extraBlocks = Math.ceil(extraMinutes / 30);
      return service.basePrice + extraBlocks * round(service.hourlyRate / 2);
    }

    case 'visit_fee_then_quote':
      // Solo se compromete la visita; el resto se cotiza en el domicilio.
      return service.visitFee;
  }
}

export function calculateQuote(input: QuoteInput): Quote {
  const { service, urgency, scheduledFor } = input;
  const minutes = input.estimatedMinutes ?? service.estimatedMinutes;
  const extraCharges = input.extraCharges ?? 0;

  const labor = laborCost(service, minutes);
  const urgencyMultiplier = service.urgencyMultipliers[urgency] ?? 1;
  const afterUrgency = round(labor * urgencyMultiplier);

  const nightSurcharge = isNightTime(scheduledFor)
    ? round(afterUrgency * service.nightSurchargePct)
    : 0;

  // El adicional por visita se suma cuando el modelo no lo incluye ya.
  const visitFee = service.pricingModel === 'visit_fee_then_quote' ? 0 : service.visitFee;

  const subtotal = afterUrgency + nightSurcharge + visitFee + extraCharges;
  const serviceFee = round(subtotal * PLATFORM.feePct);
  const taxes = round((subtotal + serviceFee) * PLATFORM.taxPct);
  const total = subtotal + serviceFee + taxes;

  return {
    currency: service.currency ?? PLATFORM.currencyDefault,
    basePrice: labor,
    urgencyMultiplier,
    nightSurcharge,
    extraCharges,
    subtotal,
    serviceFee,
    taxes,
    total,
    // El técnico cobra el subtotal menos la comisión; los impuestos no son suyos.
    technicianPayout: subtotal - serviceFee,
    estimatedLaborMinutes: minutes,
    isEstimate: service.pricingModel !== 'fixed',
  };
}

/**
 * Penalidad por cancelación. Devuelve el monto a retener del cliente y el
 * monto a compensar al técnico (viaje perdido).
 */
export function calculateCancellationFee(params: {
  quoteTotal: number;
  minutesSinceAccepted: number;
  technicianDeparted: boolean;
  graceMinutes: number;
  lateFeePct: number;
}): { clientCharge: number; technicianCompensation: number } {
  const withinGrace = params.minutesSinceAccepted <= params.graceMinutes;
  if (withinGrace || !params.technicianDeparted) {
    return { clientCharge: 0, technicianCompensation: 0 };
  }
  const charge = round(params.quoteTotal * params.lateFeePct);
  // La compensación al técnico es el cargo menos la comisión de la plataforma.
  return { clientCharge: charge, technicianCompensation: round(charge * (1 - PLATFORM.feePct)) };
}
