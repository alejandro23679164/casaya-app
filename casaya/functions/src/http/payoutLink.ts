/**
 * Vinculación de la cuenta de cobro del técnico (OAuth de Mercado Pago).
 *
 * Sin esto el técnico no puede cobrar: aunque el dinero se retiene y se
 * captura contra la cuenta de la PLATAFORMA (ver el comentario grande en
 * `mercadopago.ts` sobre por qué), el payout final necesita saber a qué
 * cuenta transferir — y eso es exactamente lo que esta vinculación resuelve.
 * Es, junto con el KYC, uno de los dos requisitos para que un técnico pueda
 * recibir trabajos.
 *
 * El flujo es el estándar de OAuth con un detalle que importa: el parámetro
 * `state` no es decorativo. Se genera acá, se guarda con vencimiento corto y
 * se verifica al volver. Sin esa verificación, alguien puede hacer que un
 * técnico vincule sin querer una cuenta ajena y termine cobrando en el
 * bolsillo del atacante.
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import * as crypto from 'crypto';
import { exchangeOAuthCode, fetchAccountEmail } from '../services/payments/mercadopago';

const db = admin.firestore();
const STATE_TTL_MINUTES = 15;

// ---------------------------------------------------------------------------
// Paso 1: la app pide la URL de autorización.
// ---------------------------------------------------------------------------
export const startPayoutLink = onCall(async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const uid = req.auth.uid;

  const userSnap = await db.collection('users').doc(uid).get();
  if (userSnap.get('role') !== 'technician') {
    throw new HttpsError('permission-denied', 'Solo los técnicos vinculan cuenta de cobro.');
  }

  const state = crypto.randomBytes(24).toString('base64url');

  await db.collection('oauth_states').doc(state).set({
    uid,
    psp: 'mercadopago',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + STATE_TTL_MINUTES * 60_000),
    used: false,
  });

  const url = new URL('https://auth.mercadopago.com.ar/authorization');
  url.searchParams.set('client_id', process.env.MP_CLIENT_ID!);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('platform_id', 'mp');
  url.searchParams.set('redirect_uri', process.env.MP_OAUTH_REDIRECT_URI!);
  url.searchParams.set('state', state);

  return { authorizationUrl: url.toString(), state, expiresInMinutes: STATE_TTL_MINUTES };
});

// ---------------------------------------------------------------------------
// Paso 2: la app devuelve el código que trajo el redirect.
// ---------------------------------------------------------------------------
export const completePayoutLink = onCall(async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const uid = req.auth.uid;
  const { code, state } = req.data as { code: string; state: string };

  if (!code || !state) throw new HttpsError('invalid-argument', 'Faltan datos de la vinculación.');

  // El state se consume dentro de una transacción: un código interceptado no
  // puede canjearse dos veces ni usarse en otra sesión.
  const stateRef = db.collection('oauth_states').doc(state);
  await db.runTransaction(async (t) => {
    const snap = await t.get(stateRef);
    if (!snap.exists) throw new HttpsError('permission-denied', 'La vinculación no es válida.');
    const s = snap.data()!;

    if (s.used) throw new HttpsError('permission-denied', 'Esta vinculación ya se usó.');
    if (s.uid !== uid) throw new HttpsError('permission-denied', 'La vinculación no es tuya.');
    if (s.expiresAt.toMillis() < Date.now()) {
      throw new HttpsError('deadline-exceeded', 'La vinculación venció. Empezá de nuevo.');
    }

    t.update(stateRef, { used: true, usedAt: admin.firestore.FieldValue.serverTimestamp() });
  });

  const tokens = await exchangeOAuthCode({
    code,
    redirectUri: process.env.MP_OAUTH_REDIRECT_URI!,
    clientId: process.env.MP_CLIENT_ID!,
    clientSecret: process.env.MP_CLIENT_SECRET!,
  });

  // Payouts identifica el destino por email de cuenta Mercado Pago, no por el
  // id de OAuth — se consulta una sola vez, con el token recién obtenido, así
  // el resto del sistema no vuelve a tocar el token del técnico para esto.
  const email = await fetchAccountEmail(tokens.accessToken);

  // Una cuenta de Mercado Pago no puede quedar vinculada a dos técnicos: sería
  // la vía directa para desviar cobros ajenos.
  const existing = await db.collection('payout_accounts')
    .where('mpUserId', '==', tokens.userId)
    .limit(1).get();

  if (!existing.empty && existing.docs[0].get('ownerId') !== uid) {
    throw new HttpsError('already-exists', 'Esa cuenta de Mercado Pago ya está vinculada a otro técnico.');
  }

  // Los tokens viven en una colección cerrada a cal y canto en las reglas:
  // son credenciales de cobro, no datos de perfil. El email se guarda acá
  // también — Payouts lo necesita para identificar el destino del dinero, y
  // así no hay que volver a pedirlo en cada liberación de pago.
  const accountId = `mp_${tokens.userId}`;
  await db.collection('payout_accounts').doc(accountId).set({
    ownerId: uid,
    psp: 'mercadopago',
    mpUserId: tokens.userId,
    email,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + tokens.expiresIn * 1000),
    linkedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await db.collection('users').doc(uid).update({
    'technician.payoutAccountId': accountId,
    'technician.payoutLinkedAt': admin.firestore.FieldValue.serverTimestamp(),
  });

  return { linked: true, accountId, mpUserId: tokens.userId };
});

// ---------------------------------------------------------------------------
// Estado de la vinculación, para que la pantalla sepa qué mostrar.
// ---------------------------------------------------------------------------
export const getPayoutLinkStatus = onCall(async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');

  const userSnap = await db.collection('users').doc(req.auth.uid).get();
  const accountId = userSnap.get('technician.payoutAccountId');

  if (!accountId) {
    return { linked: false, canReceiveJobs: false, kycStatus: userSnap.get('technician.status') };
  }

  const account = await db.collection('payout_accounts').doc(accountId).get();
  const kycStatus = userSnap.get('technician.status');

  return {
    linked: true,
    // Nunca se devuelven tokens al cliente. El email sí, para que la persona
    // confirme que es SU cuenta la que quedó conectada — enmascarado, porque
    // no hace falta mostrarlo entero para eso.
    mpUserId: account.get('mpUserId'),
    email: maskEmail(account.get('email') as string | undefined),
    linkedAt: account.get('linkedAt')?.toDate()?.toISOString() ?? null,
    kycStatus,
    // Las dos condiciones para recibir trabajos, juntas: si falta una, la
    // pantalla puede decir exactamente cuál.
    canReceiveJobs: kycStatus === 'approved',
  };
});

function maskEmail(email: string | undefined): string | null {
  if (!email) return null;
  const [user, domain] = email.split('@');
  if (!domain) return email;
  const visible = user.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(user.length - 2, 1))}@${domain}`;
}

/** Desvincular. No se puede si hay dinero retenido esperando liquidación. */
export const unlinkPayoutAccount = onCall(async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const uid = req.auth.uid;

  const pending = await db.collection('transactions')
    .where('technicianId', '==', uid)
    .where('status', '==', 'held')
    .limit(1).get();

  if (!pending.empty) {
    throw new HttpsError(
      'failed-precondition',
      'Tenés pagos pendientes de liberar. Podés desvincular cuando se acrediten.',
    );
  }

  const accountId = (await db.collection('users').doc(uid).get()).get('technician.payoutAccountId');
  if (accountId) await db.collection('payout_accounts').doc(accountId).delete();

  await db.collection('users').doc(uid).update({
    'technician.payoutAccountId': null,
    'technician.isOnline': false,
  });

  return { unlinked: true };
});
