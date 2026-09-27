/**
 * Geolocalización sin dependencias: distancia haversine, geohash y difuminado
 * de coordenadas. El geohash permite consultar Firestore por rango de string
 * (un índice de una sola columna) en lugar de escanear todos los técnicos.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_KM = 6371;
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Distancia en kilómetros entre dos puntos. */
export function distanceKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/** Codifica un punto como geohash. Precisión 9 ≈ 5 m; precisión 5 ≈ 2,4 km. */
export function encodeGeohash(point: LatLng, precision = 9): string {
  let latRange: [number, number] = [-90, 90];
  let lngRange: [number, number] = [-180, 180];
  let hash = '';
  let bits = 0;
  let bitCount = 0;
  let evenBit = true;

  while (hash.length < precision) {
    if (evenBit) {
      const mid = (lngRange[0] + lngRange[1]) / 2;
      if (point.lng > mid) {
        bits = (bits << 1) + 1;
        lngRange = [mid, lngRange[1]];
      } else {
        bits = bits << 1;
        lngRange = [lngRange[0], mid];
      }
    } else {
      const mid = (latRange[0] + latRange[1]) / 2;
      if (point.lat > mid) {
        bits = (bits << 1) + 1;
        latRange = [mid, latRange[1]];
      } else {
        bits = bits << 1;
        latRange = [latRange[0], mid];
      }
    }
    evenBit = !evenBit;
    if (++bitCount === 5) {
      hash += BASE32[bits];
      bits = 0;
      bitCount = 0;
    }
  }
  return hash;
}

/**
 * Rango [inicio, fin) de geohashes que cubre aproximadamente un radio dado.
 * Se usa como prefiltro barato en Firestore; la distancia exacta se verifica
 * después con haversine, porque el geohash sobre-incluye en los bordes.
 */
export function geohashQueryBounds(center: LatLng, radiusKm: number): [string, string] {
  // Cada carácter de geohash divide el error por ~8 (alternando lat/lng).
  const precisionByKm: Array<[number, number]> = [
    [2500, 1], [630, 2], [78, 3], [20, 4], [2.4, 5], [0.61, 6], [0.076, 7], [0.019, 8],
  ];
  const precision = precisionByKm.find(([km]) => radiusKm >= km)?.[1] ?? 9;
  const prefix = encodeGeohash(center, precision);
  return [prefix, prefix + '~']; // '~' supera a cualquier carácter base32
}

/**
 * Difumina una coordenada para mostrarla antes de aceptar el trabajo: el
 * técnico ve la zona, no el domicilio. El desplazamiento es determinístico
 * por solicitud (semilla) para que no se pueda triangular pidiendo el dato
 * varias veces y promediando.
 */
export function coarsenLocation(point: LatLng, seed: string, radiusM = 1000): LatLng & { approxRadiusM: number } {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;

  const angle = ((hash >>> 0) % 360) * (Math.PI / 180);
  const dist = radiusM * 0.6; // desplazamiento fijo dentro del círculo
  const dLat = (dist * Math.cos(angle)) / 111_320;
  const dLng = (dist * Math.sin(angle)) / (111_320 * Math.cos(toRad(point.lat)));

  return {
    lat: +(point.lat + dLat).toFixed(4), // 4 decimales ≈ 11 m de resolución
    lng: +(point.lng + dLng).toFixed(4),
    approxRadiusM: radiusM,
  };
}

/** Tiempo estimado de llegada en minutos, con velocidad urbana promedio. */
export function etaMinutes(from: LatLng, to: LatLng, avgSpeedKmh = 22): number {
  // Factor 1.35: las calles no son líneas rectas.
  const routeKm = distanceKm(from, to) * 1.35;
  return Math.max(5, Math.round((routeKm / avgSpeedKmh) * 60));
}
