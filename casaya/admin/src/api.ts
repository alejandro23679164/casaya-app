import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, User } from 'firebase/auth';
import { getFunctions, httpsCallable } from 'firebase/functions';

/**
 * Acceso al backend desde el panel.
 *
 * El panel no lee Firestore directamente. Todo pasa por las callables de
 * `admin.ts`, que verifican el claim de rol del lado del servidor. Si el panel
 * consultara la base por su cuenta, la seguridad dependería de las reglas de
 * Firestore para un rol que puede leer casi todo, y un bug en una regla sería
 * una filtración de datos de miles de personas.
 */

const app = initializeApp({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
});

export const auth = getAuth(app);
const fns = getFunctions(app, 'southamerica-east1');

export const watchAuth = (cb: (user: User | null) => void) => onAuthStateChanged(auth, cb);
export const login = (email: string, password: string) => signInWithEmailAndPassword(auth, email, password);
export const logout = () => signOut(auth);

/** Confirma que la sesión tiene el claim de administrador antes de mostrar nada. */
export async function isAdmin(user: User): Promise<boolean> {
  const token = await user.getIdTokenResult(true);
  return token.claims.role === 'admin';
}

// ------------------------------------------------------------------ tipos

export type Outcome = 'release_full' | 'refund_full' | 'split' | 'release_minus_fee' | 'redo_service';

export interface DisputeRow {
  id: string;
  requestId: string;
  type: string;
  reason: string;
  priority: string;
  category: string;
  amountInPlay: number;
  currency: string;
  createdAt: string | null;
  hoursUntilAutoRelease: number | null;
}

export interface Settlement {
  toTechnician: number;
  toClient: number;
  toPlatform: number;
  total: number;
}

export interface DisputeDetail {
  dispute: { id: string; type: string; reason: string; openedBy: string; createdAt: string };
  request: {
    id: string; category: string; status: string; description: string;
    addressLine: string; quote: { total: number; currency: string };
    timeline: Record<string, string | null>;
    checkIn: { distanceToSiteM: number } | null;
    checkOutNotes: string | null;
    extraCharges: Array<{ concept: string; amount: number; approvedByClient: boolean }>;
    pinAttempts: number;
  };
  photos: { problem: string[]; finished: string[] };
  transaction: {
    amount: number; platformFee: number; currency: string; status: string;
    psp: string; externalId: string; autoReleaseAt: string | null;
  };
  parties: {
    client: { id: string; name: string; rating: number; completed: number };
    technician: { id: string; name: string; rating: number; jobs: number; kyc: string } | null;
  };
  evidence: {
    hasCheckIn: boolean; hasCheckOutPhotos: boolean;
    checkInDistanceM: number | null; minutesOnSite: number | null;
    clientPreviousDisputes: number; technicianPreviousDisputes: number;
  };
  events: Array<{ type: string; actorId: string; at: string; payload: unknown }>;
  suggestion: {
    outcome: Outcome; technicianShare?: number;
    confidence: string; rationale: string[]; reliabilityNote: string | null;
  };
}

// --------------------------------------------------------------- llamadas

const call = <T,>(name: string) => async (payload?: unknown): Promise<T> => {
  const res = await httpsCallable(fns, name)(payload ?? {});
  return res.data as T;
};

export const api = {
  metrics: call<{
    openDisputes: number; openPanicAlerts: number; escrowHeldCount: number;
    kycPendingReview: number; stuckRequests: number;
  }>('getOpsMetrics'),

  listDisputes: call<{ items: DisputeRow[] }>('listDisputes'),
  disputeDetail: call<DisputeDetail>('getDisputeDetail'),
  previewSettlement: call<Settlement>('previewSettlement'),
  resolveDispute: call<{ resolved: boolean; settlement: Settlement }>('resolveDispute'),
  setUserStatus: call<{ ok: boolean }>('setUserStatus'),
  reviewKyc: call<{ ok: boolean }>('reviewKyc'),
};

/** Centavos a texto. Un solo lugar formatea plata en todo el panel. */
export const money = (cents: number, currency = 'ARS') =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency, maximumFractionDigits: 0 })
    .format(cents / 100);

export const DISPUTE_LABELS: Record<string, string> = {
  work_not_done: 'No hizo el trabajo',
  poor_quality: 'Trabajo mal hecho',
  overcharge: 'Cobro de más',
  no_show: 'No se presentó',
  damage: 'Daño en el domicilio',
  client_unreachable: 'Cliente ausente',
  unsafe_behavior: 'Conducta insegura',
  chargeback: 'Contracargo',
};

export const OUTCOME_LABELS: Record<Outcome, string> = {
  release_full: 'Pagar todo al técnico',
  refund_full: 'Devolver todo al cliente',
  split: 'Repartir',
  release_minus_fee: 'Pagar al técnico, la plataforma no cobra',
  redo_service: 'Agendar revisita',
};
