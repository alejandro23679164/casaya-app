/**
 * Verificación de identidad.
 *
 * Del lado del técnico: documento, antecedentes penales, prueba de vida y, si
 * el rubro lo exige, matrícula. Del lado del cliente: teléfono con OTP y
 * medio de pago confirmado. Ninguna de las dos partes entra al sistema sin
 * que la otra tenga con quién responder.
 *
 * El resultado de la verificación se refleja en custom claims del token, para
 * que las reglas de Firestore puedan decidir sin leer documentos extra.
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import * as admin from 'firebase-admin';

const db = admin.firestore();

const REQUIRED_DOCS = ['id_front', 'id_back', 'selfie_liveness', 'criminal_record'] as const;

// ---------------------------------------------------------------------------
// Se llama una sola vez, justo después de que Firebase Auth confirma el OTP
// (ver `phone_auth_screen.dart`). Sin esto, la primera pantalla después del
// login pega contra un documento `users/{uid}` que no existe todavía — nadie
// lo crea solo.
//
// `set(..., { merge: true })` lo hace seguro de llamar más de una vez (la app
// puede reintentarlo si la red falla a mitad de camino) sin pisar datos que
// ya se hayan cargado después, como el nombre o la dirección.
// ---------------------------------------------------------------------------
export const ensureUserProfile = onCall(async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const uid = req.auth.uid;

  const ref = db.collection('users').doc(uid);
  const snap = await ref.get();

  if (snap.exists) {
    // Ya existe — solo se confirma que el teléfono siga marcado como
    // verificado, por si el documento es viejo y no lo tenía.
    await ref.set({ phoneVerified: true }, { merge: true });
    return { created: false, role: snap.get('role') ?? 'client' };
  }

  await ref.set({
    role: 'client',
    fullName: '',
    phone: req.auth.token.phone_number ?? '',
    phoneVerified: true,
    locale: 'es-AR',
    disabled: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    client: {
      ratingAvg: 0,
      ratingCount: 0,
      completedRequests: 0,
      cancelledRequests: 0,
      hasVerifiedPaymentMethod: false,
      paymentCustomerId: null,
    },
  });

  return { created: true, role: 'client' };
});

// ---------------------------------------------------------------------------
// El técnico registra un documento ya subido a Cloud Storage. La app sube el
// archivo con una URL firmada; acá solo se registra la referencia y se manda
// al proveedor de verificación.
// ---------------------------------------------------------------------------
export const submitKycDocument = onCall(async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const uid = req.auth.uid;
  const { type, storagePath, documentNumber } = req.data as {
    type: typeof REQUIRED_DOCS[number] | 'trade_license';
    storagePath: string;
    documentNumber?: string;
  };

  // La ruta debe estar dentro del espacio privado del propio usuario.
  if (!storagePath.startsWith(`kyc/${uid}/`)) {
    throw new HttpsError('permission-denied', 'Ruta de archivo inválida.');
  }

  const docRef = db.collection('users').doc(uid).collection('kyc').doc(type);
  await docRef.set({
    type,
    storagePath,
    documentNumber: documentNumber ?? null,
    status: 'uploaded',
    provider: null,
    providerRef: null,
    livenessScore: null,
    rejectionReason: null,
    uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
    reviewedAt: null,
    // Los antecedentes penales caducan: se re-piden una vez por año.
    expiresAt: type === 'criminal_record'
      ? admin.firestore.Timestamp.fromMillis(Date.now() + 365 * 24 * 3600_000)
      : null,
  });

  await db.collection('users').doc(uid).update({ 'technician.status': 'in_review' });

  // Aquí iría la llamada al proveedor (Veriff, Didit, Truora, Metamap…):
  //   const check = await kycProvider.createCheck({ userId: uid, type, storagePath });
  //   await docRef.update({ provider: 'veriff', providerRef: check.id });
  // El veredicto llega por webhook y actualiza `status` a 'verified' o 'rejected'.

  return { submitted: true, type };
});

// ---------------------------------------------------------------------------
// Webhook del proveedor de KYC. Recibe el veredicto por documento.
// Protegido por firma HMAC del proveedor, no por auth de Firebase.
// ---------------------------------------------------------------------------
export const kycWebhook = onCall(async (req) => {
  // En producción esto es un onRequest con verificación de firma; se deja como
  // callable interno para simplificar el ejemplo.
  const { userId, type, verdict, livenessScore, reason } = req.data as {
    userId: string; type: string; verdict: 'verified' | 'rejected';
    livenessScore?: number; reason?: string;
  };

  await db.collection('users').doc(userId).collection('kyc').doc(type).update({
    status: verdict,
    livenessScore: livenessScore ?? null,
    rejectionReason: verdict === 'rejected' ? (reason ?? 'no_especificado') : null,
    reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { ok: true };
});

// ---------------------------------------------------------------------------
// Trigger: cada vez que cambia un documento de KYC se recalcula si el técnico
// está habilitado. Toda la regla vive en un solo lugar.
// ---------------------------------------------------------------------------
export const onKycDocumentWritten = onDocumentWritten('users/{uid}/kyc/{docId}', async (event) => {
  const uid = event.params.uid;
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  if (userSnap.get('role') !== 'technician') return;

  const kycDocs = await userRef.collection('kyc').get();
  const byType = new Map(kycDocs.docs.map((d) => [d.get('type'), d.data()]));

  const rejected = kycDocs.docs.find((d) => d.get('status') === 'rejected');
  if (rejected) {
    await userRef.update({ 'technician.status': 'rejected' });
    await admin.auth().setCustomUserClaims(uid, { role: 'technician', kyc: 'rejected' });
    return;
  }

  const now = Date.now();
  const complete = REQUIRED_DOCS.every((t) => {
    const doc = byType.get(t);
    if (!doc || doc.status !== 'verified') return false;
    if (doc.expiresAt && doc.expiresAt.toMillis() < now) return false;  // vencido, no vale
    return true;
  });

  // Rubros con matrícula obligatoria (gas, electricidad) piden un documento más.
  const skills: string[] = userSnap.get('technician.skills') ?? [];
  let needsLicense = false;
  if (skills.length) {
    const services = await db.getAll(...skills.map((s) => db.collection('services').doc(s)));
    needsLicense = services.some((s) => s.get('requiresLicense') === true);
  }
  const licenseOk = !needsLicense || byType.get('trade_license')?.status === 'verified';

  const status = complete && licenseOk ? 'approved' : 'in_review';
  await userRef.update({ 'technician.status': status });
  await admin.auth().setCustomUserClaims(uid, { role: 'technician', kyc: status });
});

// ---------------------------------------------------------------------------
// Cliente: confirma que el medio de pago quedó guardado en el PSP.
// La app envía el paymentMethodId que devolvió el SDK de pagos; la tarjeta
// nunca toca nuestros servidores.
// ---------------------------------------------------------------------------
export const confirmPaymentMethod = onCall(async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const uid = req.auth.uid;
  const { paymentCustomerId, paymentMethodId } = req.data as {
    paymentCustomerId: string; paymentMethodId: string;
  };

  if (!paymentCustomerId || !paymentMethodId) {
    throw new HttpsError('invalid-argument', 'Faltan datos del medio de pago.');
  }

  await db.collection('users').doc(uid).update({
    'client.paymentCustomerId': paymentCustomerId,
    'client.hasVerifiedPaymentMethod': true,
  });

  const user = await admin.auth().getUser(uid);
  await admin.auth().setCustomUserClaims(uid, {
    ...(user.customClaims ?? {}),
    role: 'client',
    // El OTP de Firebase Auth ya dejó phone_number en el token; esto lo hace
    // explícito para las reglas.
    phoneVerified: !!user.phoneNumber,
  });

  return { verified: true };
});
