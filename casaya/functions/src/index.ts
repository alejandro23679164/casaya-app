/**
 * Punto de entrada de Cloud Functions (Firebase, 2ª generación).
 *
 * Solo re-exporta: cada función vive en su módulo y se testea por separado.
 * La inicialización del Admin SDK ocurre una vez, antes de cualquier import
 * que use Firestore.
 */

import * as admin from 'firebase-admin';
import { setGlobalOptions } from 'firebase-functions/v2';

admin.initializeApp();

setGlobalOptions({
  region: 'southamerica-east1',   // cerca de los usuarios: menos latencia en el despacho
  maxInstances: 50,
  memory: '512MiB',
  timeoutSeconds: 60,
});

// --- solicitudes y cotización ---
export { getQuote, createServiceRequest, cancelServiceRequest } from './http/requests';

// --- despacho ---
export { acceptRequest, rejectRequest } from './http/dispatch';

// --- ejecución del trabajo ---
export { startTrip, checkIn, checkOut, releasePaymentWithPin, openDispute } from './http/jobFlow';

// --- verificación (KYC y cliente) ---
export {
  ensureUserProfile,
  submitKycDocument,
  kycWebhook,
  onKycDocumentWritten,
  confirmPaymentMethod,
} from './http/verification';

// --- seguridad en vivo ---
export { pushLocation, triggerPanic, onPanicAlertCreated } from './http/safety';

// --- pagos: webhook del proveedor ---
export { mercadoPagoWebhook } from './http/webhooks';

// --- vinculación de la cuenta de cobro del técnico ---
export {
  startPayoutLink,
  completePayoutLink,
  getPayoutLinkStatus,
  unlinkPayoutAccount,
} from './http/payoutLink';

// --- conciliación ---
export { reconcilePayments, requestSettlementReport, retryStuckPayouts } from './triggers/reconciliation';

// --- panel de administración ---
export {
  listDisputes,
  getDisputeDetail,
  previewSettlement,
  resolveDispute,
  setUserStatus,
  reviewKyc,
  getOpsMetrics,
} from './http/admin';


// --- jobs programados ---
export {
  expireDispatchOffers,
  autoReleaseEscrow,
  pruneStaleTechnicians,
  onReviewWritten,
} from './triggers/scheduled';
