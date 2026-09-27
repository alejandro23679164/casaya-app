/**
 * Resolución de disputas: la parte que decide a dónde va el dinero.
 *
 * Es lógica pura a propósito. El reparto de un monto entre cliente, técnico y
 * plataforma es lo más sensible del sistema y merece tests que corran en
 * milisegundos, sin emuladores ni red.
 *
 * Principio: la suma siempre cierra. Si el reparto no da exactamente el monto
 * retenido, la función falla en lugar de emitir una orden de pago mal armada.
 * Un centavo perdido en cada disputa es un descuadre contable que aparece seis
 * meses después y no se puede reconstruir.
 */

export type DisputeType =
  | 'work_not_done'        // el técnico no hizo lo acordado
  | 'poor_quality'         // lo hizo, pero mal
  | 'overcharge'           // cobró extras no acordados
  | 'no_show'              // no se presentó
  | 'damage'               // rompió algo
  | 'client_unreachable'   // el cliente no estaba / no abrió
  | 'unsafe_behavior'      // conducta de alguna de las partes
  | 'chargeback';          // contracargo del banco

export type Outcome =
  | 'release_full'         // el técnico cobra todo
  | 'refund_full'          // el cliente recupera todo
  | 'split'                // reparto parcial
  | 'release_minus_fee'    // el técnico cobra, la plataforma no
  | 'redo_service';        // se agenda una revisita sin costo

export interface Settlement {
  toTechnician: number;
  toClient: number;
  toPlatform: number;
  /** Total repartido; debe igualar el monto retenido. */
  total: number;
}

export interface SettlementInput {
  /** Monto retenido en escrow, en centavos. */
  heldAmount: number;
  /** Comisión original de la plataforma. */
  platformFee: number;
  outcome: Outcome;
  /** Para 'split': porcentaje del subtotal que se lleva el técnico (0..1). */
  technicianShare?: number;
  /** Compensación fija al técnico por el viaje, aunque el trabajo no se haya hecho. */
  travelCompensation?: number;
}

export class SettlementError extends Error {}

/**
 * Calcula el reparto. La plataforma renuncia a su comisión en casi todos los
 * escenarios de conflicto: cobrar por intermediar un servicio que salió mal es
 * la forma más rápida de perder a las dos partes.
 */
export function computeSettlement(input: SettlementInput): Settlement {
  const { heldAmount, platformFee, outcome } = input;

  if (heldAmount <= 0) throw new SettlementError('El monto retenido debe ser positivo.');

  const subtotal = heldAmount - platformFee;
  let settlement: Settlement;

  switch (outcome) {
    case 'release_full':
      settlement = { toTechnician: subtotal, toClient: 0, toPlatform: platformFee, total: heldAmount };
      break;

    case 'refund_full':
      settlement = { toTechnician: 0, toClient: heldAmount, toPlatform: 0, total: heldAmount };
      break;

    case 'release_minus_fee':
      // El trabajo se hizo, pero hubo un problema atribuible a la plataforma
      // (mal despacho, cotización equivocada). Paga la plataforma, no el
      // técnico ni el cliente.
      settlement = { toTechnician: subtotal, toClient: platformFee, toPlatform: 0, total: heldAmount };
      break;

    case 'redo_service':
      // El dinero sigue retenido contra la revisita. No se reparte nada todavía.
      settlement = { toTechnician: 0, toClient: 0, toPlatform: 0, total: 0 };
      break;

    case 'split': {
      const share = input.technicianShare;
      if (share === undefined || share < 0 || share > 1) {
        throw new SettlementError('El reparto necesita un porcentaje entre 0 y 1.');
      }
      const travel = input.travelCompensation ?? 0;
      if (travel > subtotal) {
        throw new SettlementError('La compensación por viaje no puede superar el subtotal.');
      }

      const techBase = Math.round((subtotal - travel) * share);
      const toTechnician = techBase + travel;
      // El resto vuelve al cliente, comisión incluida: si el servicio se
      // resolvió a medias, la plataforma no cobra entero.
      const toClient = heldAmount - toTechnician;

      settlement = { toTechnician, toClient, toPlatform: 0, total: heldAmount };
      break;
    }
  }

  // Control de cierre. Redondeos arriba, verificación acá.
  const sum = settlement.toTechnician + settlement.toClient + settlement.toPlatform;
  if (outcome !== 'redo_service' && sum !== heldAmount) {
    throw new SettlementError(
      `El reparto no cierra: ${sum} repartido contra ${heldAmount} retenido.`,
    );
  }

  return settlement;
}

/**
 * Resolución sugerida según el tipo de disputa y la evidencia disponible.
 *
 * No decide: propone. La persona que atiende el caso ve la sugerencia y el
 * porqué, y resuelve. Automatizar esto del todo produce dos cosas malas a la
 * vez: técnicos castigados por reclamos falsos y clientes obligados a pagar
 * trabajos que no se hicieron.
 */
export interface EvidenceSnapshot {
  hasCheckIn: boolean;
  hasCheckOutPhotos: boolean;
  checkInDistanceM: number | null;
  minutesOnSite: number | null;
  technicianRating: number;
  clientPreviousDisputes: number;
  technicianPreviousDisputes: number;
}

export interface Suggestion {
  outcome: Outcome;
  technicianShare?: number;
  confidence: 'alta' | 'media' | 'baja';
  rationale: string[];
}

export function suggestResolution(type: DisputeType, e: EvidenceSnapshot): Suggestion {
  const rationale: string[] = [];

  // Sin check-in no hay prueba de que el técnico haya llegado.
  if (!e.hasCheckIn) {
    rationale.push('No hay registro de llegada al domicilio.');
    if (type === 'client_unreachable') {
      rationale.push('El técnico alega que el cliente no estaba, pero no registró la llegada.');
      return { outcome: 'refund_full', confidence: 'media', rationale };
    }
    return { outcome: 'refund_full', confidence: 'alta', rationale };
  }

  rationale.push(
    e.checkInDistanceM !== null
      ? `Llegada registrada a ${e.checkInDistanceM} m del domicilio.`
      : 'Llegada registrada.',
  );

  switch (type) {
    case 'no_show':
      // Contradice la evidencia: hay check-in.
      rationale.push('El reclamo dice que no se presentó, pero el GPS lo ubica en el domicilio.');
      return { outcome: 'release_full', confidence: 'media', rationale };

    case 'client_unreachable':
      rationale.push('El técnico viajó y no pudo trabajar.');
      return { outcome: 'split', technicianShare: 0, confidence: 'media', rationale };

    case 'work_not_done':
      if (!e.hasCheckOutPhotos) {
        rationale.push('No hay fotos del trabajo terminado.');
        return { outcome: 'split', technicianShare: 0.25, confidence: 'media', rationale };
      }
      rationale.push('Hay fotos del trabajo terminado.');
      return { outcome: 'split', technicianShare: 0.6, confidence: 'baja', rationale };

    case 'poor_quality':
      if (e.minutesOnSite !== null && e.minutesOnSite < 15) {
        rationale.push(`Solo ${e.minutesOnSite} minutos en el domicilio.`);
        return { outcome: 'split', technicianShare: 0.3, confidence: 'media', rationale };
      }
      rationale.push('Conviene ofrecer una revisita antes de repartir el dinero.');
      return { outcome: 'redo_service', confidence: 'media', rationale };

    case 'overcharge':
      rationale.push('Los extras no aprobados no forman parte del monto retenido.');
      return { outcome: 'release_full', confidence: 'alta', rationale };

    case 'damage':
      rationale.push('Un daño se cubre por el seguro, no descontando del trabajo.');
      return { outcome: 'split', technicianShare: 0.5, confidence: 'baja', rationale };

    case 'unsafe_behavior':
      rationale.push('Requiere revisión humana antes de tocar el dinero.');
      return { outcome: 'redo_service', confidence: 'baja', rationale };

    case 'chargeback':
      rationale.push('El dinero ya salió de la cuenta; hay que responder al banco con la evidencia.');
      return { outcome: 'release_minus_fee', confidence: 'baja', rationale };
  }
}

/** Historial que pesa en la decisión, resumido para mostrarlo en el panel. */
export function reliabilityNote(e: EvidenceSnapshot): string | null {
  if (e.clientPreviousDisputes >= 3) {
    return `Este cliente abrió ${e.clientPreviousDisputes} reclamos antes.`;
  }
  if (e.technicianPreviousDisputes >= 3) {
    return `Este técnico acumula ${e.technicianPreviousDisputes} reclamos.`;
  }
  return null;
}
