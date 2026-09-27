/**
 * Parámetros de negocio en un solo lugar. Cambiar una comisión o un radio de
 * despacho no debería obligar a tocar la lógica.
 */
export const PLATFORM = {
  /** Comisión de la plataforma sobre el subtotal del servicio. */
  feePct: 0.18,
  /** IVA u otro impuesto aplicado sobre el subtotal + comisión. */
  taxPct: 0.21,
  currencyDefault: 'ARS',
} as const;

export const DISPATCH = {
  /** Radios sucesivos de búsqueda. Si nadie acepta, se ensancha el círculo. */
  radiiKm: [3, 6, 10, 18],
  /** Técnicos notificados por ronda. */
  batchSize: 5,
  /** Segundos que el técnico tiene para aceptar antes de pasar al siguiente. */
  offerTtlSeconds: 45,
  /** Antigüedad máxima aceptable de la última posición GPS del técnico. */
  maxLocationAgeMinutes: 10,
} as const;

export const SAFETY = {
  /** Metros de tolerancia entre el GPS del técnico y el domicilio al hacer check-in. */
  checkInRadiusM: 150,
  /** Intentos de PIN antes de bloquear y derivar a soporte. */
  maxPinAttempts: 5,
  /** Horas tras el check-out para liberar el escrow si el cliente no confirma ni disputa. */
  autoReleaseHours: 72,
  /** Precisión del geohash difuminado que ve el técnico antes de aceptar (~±2,4 km). */
  coarseGeohashPrecision: 5,
  /** Segundos entre puntos de la traza GPS. */
  trackingIntervalSeconds: 15,
} as const;

export const NIGHT_WINDOW = { startHour: 22, endHour: 6 } as const;

export const CANCELLATION = {
  /** Minutos tras aceptar durante los cuales el cliente cancela sin costo. */
  graceMinutes: 5,
  /** Porcentaje retenido si cancela después de que el técnico salió. */
  lateFeePct: 0.2,
} as const;
