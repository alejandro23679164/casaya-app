import * as crypto from 'crypto';

/**
 * PIN de finalización de 4 dígitos.
 *
 * Solo el cliente lo ve, y recién cuando el técnico marca el check-out. Se
 * guarda como hash con sal: aunque alguien lea la base, no obtiene el código
 * que libera el dinero. La comparación es en tiempo constante para no filtrar
 * información por la duración de la respuesta.
 */

const ITERATIONS = 120_000;
const KEY_LEN = 32;
const DIGEST = 'sha256';

/** Genera un PIN de 4 dígitos con entropía criptográfica (no Math.random). */
export function generatePin(): string {
  // rejection sampling para que los 10.000 valores sean equiprobables
  let value: number;
  do {
    value = crypto.randomBytes(2).readUInt16BE(0);
  } while (value >= 60_000);
  return String(value % 10_000).padStart(4, '0');
}

export function hashPin(pin: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(pin, salt, ITERATIONS, KEY_LEN, DIGEST);
  return `pbkdf2$${ITERATIONS}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [scheme, iterations, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'pbkdf2') return false;

  const candidate = crypto.pbkdf2Sync(pin, Buffer.from(saltHex, 'hex'), Number(iterations), KEY_LEN, DIGEST);
  const expected = Buffer.from(hashHex, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}
