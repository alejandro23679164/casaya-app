import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  api, money, DISPUTE_LABELS, OUTCOME_LABELS,
  type DisputeDetail, type Outcome, type Settlement,
} from './api';

/**
 * Expediente de un reclamo.
 *
 * Dos columnas: a la izquierda todo lo que el sistema registró, a la derecha la
 * decisión. Nunca hay que scrollear para ver los montos mientras se lee la
 * evidencia, ni al revés. El reparto se calcula en el servidor y se muestra
 * antes de confirmar: nadie debería enterarse de cuánto cobró cada parte
 * después de apretar el botón.
 */
export function DisputeDetailView({ disputeId }: { disputeId: string }) {
  const [data, setData] = useState<DisputeDetail | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.disputeDetail({ disputeId }).then(setData).catch(() => setData(null));
  }, [disputeId]);

  if (!data) return <p className="muted">Cargando expediente…</p>;

  const { request, parties, evidence, transaction, photos, suggestion, events } = data;

  return (
    <div className="detail">
      <div className="detail-main">
        <button className="btn btn-ghost back" onClick={() => navigate('/')}>← Volver a la cola</button>

        <h1>{DISPUTE_LABELS[data.dispute.type] ?? data.dispute.type}</h1>
        <p className="lede">{data.dispute.reason}</p>
        <p className="muted small">
          Abierto por {data.dispute.openedBy === request.id ? 'el sistema' : data.dispute.openedBy} ·
          servicio de {request.category} · {request.addressLine}
        </p>

        <Panel title="Qué dice el registro">
          <div className="facts">
            <Fact
              ok={evidence.hasCheckIn}
              label="Llegada registrada"
              detail={evidence.checkInDistanceM !== null
                ? `${evidence.checkInDistanceM} m del domicilio`
                : 'sin registro de GPS'}
            />
            <Fact
              ok={evidence.hasCheckOutPhotos}
              label="Fotos del trabajo terminado"
              detail={evidence.hasCheckOutPhotos
                ? `${photos.finished.length} foto(s)`
                : 'el técnico no subió ninguna'}
            />
            <Fact
              ok={evidence.minutesOnSite !== null && evidence.minutesOnSite >= 15}
              label="Tiempo en el domicilio"
              detail={evidence.minutesOnSite !== null ? `${evidence.minutesOnSite} minutos` : 'sin datos'}
            />
            <Fact
              ok={request.pinAttempts === 0}
              label="Intentos de PIN"
              detail={request.pinAttempts === 0 ? 'ninguno fallido' : `${request.pinAttempts} fallidos`}
            />
          </div>

          {request.extraCharges.length > 0 && (
            <div className="extras">
              <h3>Cargos extra declarados</h3>
              <ul>
                {request.extraCharges.map((c, i) => (
                  <li key={i}>
                    {c.concept} · {money(c.amount, transaction.currency)}{' '}
                    {c.approvedByClient
                      ? <span className="chip chip-calm">aprobado</span>
                      : <span className="chip chip-warn">sin aprobar</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>

        <Panel title="Fotos">
          <h3>Cómo estaba</h3>
          <PhotoRow urls={photos.problem} empty="El cliente no subió fotos." />
          <h3>Cómo quedó</h3>
          <PhotoRow urls={photos.finished} empty="El técnico no subió fotos del resultado." />
        </Panel>

        <Panel title="Las partes">
          <div className="parties">
            <PartyCard
              role="Cliente" name={parties.client.name} rating={parties.client.rating}
              extra={`${parties.client.completed} servicios`}
              disputes={evidence.clientPreviousDisputes}
              userId={parties.client.id}
            />
            {parties.technician && (
              <PartyCard
                role="Técnico" name={parties.technician.name} rating={parties.technician.rating}
                extra={`${parties.technician.jobs} trabajos · KYC ${parties.technician.kyc}`}
                disputes={evidence.technicianPreviousDisputes}
                userId={parties.technician.id}
              />
            )}
          </div>
        </Panel>

        <Panel title="Línea de tiempo">
          <ol className="timeline">
            {events.map((e, i) => (
              <li key={i}>
                <span className="time">{formatTime(e.at)}</span>
                <span className="what">{eventLabel(e.type)}</span>
              </li>
            ))}
          </ol>
        </Panel>
      </div>

      <aside className="detail-side">
        <ResolutionPanel
          disputeId={disputeId}
          transaction={transaction}
          suggestion={suggestion}
          onResolved={() => navigate('/')}
        />
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ResolutionPanel({
  disputeId, transaction, suggestion, onResolved,
}: {
  disputeId: string;
  transaction: DisputeDetail['transaction'];
  suggestion: DisputeDetail['suggestion'];
  onResolved: () => void;
}) {
  const [outcome, setOutcome] = useState<Outcome>(suggestion.outcome);
  const [share, setShare] = useState(suggestion.technicianShare ?? 0.5);
  const [notes, setNotes] = useState('');
  const [preview, setPreview] = useState<Settlement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // El reparto lo calcula el servidor en cada cambio. Duplicar la fórmula acá
  // sería garantizar que las dos versiones se separen con el tiempo.
  useEffect(() => {
    setError(null);
    api.previewSettlement({ disputeId, outcome, technicianShare: share })
      .then(setPreview)
      .catch((e) => { setPreview(null); setError(readableError(e)); });
  }, [disputeId, outcome, share]);

  const confirm = async () => {
    setBusy(true); setError(null);
    try {
      await api.resolveDispute({ disputeId, outcome, technicianShare: share, notes });
      onResolved();
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="resolution">
      <h2>Resolver</h2>

      <div className="held">
        <span className="muted small">Retenido</span>
        <strong>{money(transaction.amount, transaction.currency)}</strong>
        <span className="muted small">
          {transaction.psp} · {transaction.status}
          {transaction.autoReleaseAt && ` · se libera solo el ${formatDate(transaction.autoReleaseAt)}`}
        </span>
      </div>

      <div className="suggestion">
        <h3>Sugerencia del sistema</h3>
        <p><strong>{OUTCOME_LABELS[suggestion.outcome]}</strong> · confianza {suggestion.confidence}</p>
        <ul>{suggestion.rationale.map((r, i) => <li key={i}>{r}</li>)}</ul>
        {suggestion.reliabilityNote && <p className="warn-note">{suggestion.reliabilityNote}</p>}
        <p className="muted small">Es una propuesta. La decisión la tomás vos.</p>
      </div>

      <label className="field">
        <span>Decisión</span>
        <select value={outcome} onChange={(e) => setOutcome(e.target.value as Outcome)}>
          {Object.entries(OUTCOME_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>

      {outcome === 'split' && (
        <label className="field">
          <span>Le corresponde al técnico: {Math.round(share * 100)}%</span>
          <input
            type="range" min={0} max={1} step={0.05}
            value={share} onChange={(e) => setShare(Number(e.target.value))}
          />
        </label>
      )}

      {preview && (
        <div className="split-view">
          <SplitRow label="Al técnico" amount={preview.toTechnician} currency={transaction.currency} tone="tech" />
          <SplitRow label="Al cliente" amount={preview.toClient} currency={transaction.currency} tone="client" />
          <SplitRow label="A la plataforma" amount={preview.toPlatform} currency={transaction.currency} tone="platform" />
        </div>
      )}

      <label className="field">
        <span>Fundamento</span>
        <textarea
          rows={4} value={notes} onChange={(e) => setNotes(e.target.value)}
          placeholder="Por qué resolvés así. Queda en el expediente y se puede revisar después."
        />
      </label>

      {error && <p className="error">{error}</p>}

      <button
        className="btn btn-primary"
        disabled={busy || notes.trim().length < 15 || (!preview && outcome !== 'redo_service')}
        onClick={confirm}
      >
        {busy ? 'Aplicando…' : 'Aplicar resolución'}
      </button>
      <p className="muted small">
        Esto mueve dinero real en {transaction.psp} y no se deshace desde el panel.
      </p>
    </div>
  );
}

// ------------------------------------------------------------- componentes

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Fact({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div className="fact">
      <span className={ok ? 'dot dot-ok' : 'dot dot-missing'} aria-hidden />
      <div>
        <strong>{label}</strong>
        <div className="muted small">{detail}</div>
      </div>
    </div>
  );
}

function PhotoRow({ urls, empty }: { urls: string[]; empty: string }) {
  if (urls.length === 0) return <p className="muted small">{empty}</p>;
  return (
    <div className="photos">
      {urls.map((u, i) => (
        <a key={i} href={u} target="_blank" rel="noreferrer">
          <img src={u} alt={`Evidencia ${i + 1}`} loading="lazy" />
        </a>
      ))}
    </div>
  );
}

function PartyCard({
  role, name, rating, extra, disputes, userId,
}: {
  role: string; name: string; rating: number; extra: string; disputes: number; userId: string;
}) {
  const [busy, setBusy] = useState(false);

  const suspend = async () => {
    const reason = window.prompt('Motivo de la suspensión (queda registrado):');
    if (!reason || reason.trim().length < 10) return;
    setBusy(true);
    try {
      await api.setUserStatus({ userId, disabled: true, reason });
      window.alert('Cuenta suspendida y sesiones cerradas.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="party">
      <span className="muted small">{role}</span>
      <strong>{name}</strong>
      <div className="muted small">{rating?.toFixed(1) ?? '—'} ★ · {extra}</div>
      {disputes > 0 && <div className="chip chip-warn">{disputes} reclamos previos</div>}
      <button className="btn btn-ghost btn-danger" disabled={busy} onClick={suspend}>
        Suspender cuenta
      </button>
    </div>
  );
}

function SplitRow({
  label, amount, currency, tone,
}: { label: string; amount: number; currency: string; tone: string }) {
  return (
    <div className={`split-row split-${tone}`}>
      <span>{label}</span>
      <strong>{money(amount, currency)}</strong>
    </div>
  );
}

// ------------------------------------------------------------------ utils

const EVENT_LABELS: Record<string, string> = {
  accepted: 'El técnico aceptó el trabajo',
  offer_rejected: 'Un técnico rechazó la oferta',
  check_in: 'Registró la llegada',
  check_out: 'Cerró el trabajo con fotos',
  pin_failed: 'PIN incorrecto',
  pin_verified: 'El cliente confirmó con su PIN',
  escrow_released: 'Se liberó el pago',
  escrow_auto_released: 'El pago se liberó por vencimiento',
  dispute_opened: 'Se abrió el reclamo',
  dispute_resolved: 'Se resolvió el reclamo',
  cancelled: 'Se canceló el servicio',
  psp_webhook: 'Cambio de estado en la pasarela',
};

const eventLabel = (type: string) => EVENT_LABELS[type] ?? type;

const formatTime = (iso: string) =>
  new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    .format(new Date(iso));

const formatDate = (iso: string) =>
  new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    .format(new Date(iso));

/** Los errores del backend ya vienen escritos para leerse; se pasan tal cual. */
function readableError(e: unknown): string {
  const msg = (e as { message?: string })?.message ?? '';
  return msg.replace(/^.*?\/\s*/, '') || 'No pudimos completar la acción.';
}
