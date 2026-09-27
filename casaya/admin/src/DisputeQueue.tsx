import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api, money, DISPUTE_LABELS, type DisputeRow } from './api';

/**
 * Cola de reclamos.
 *
 * El orden lo manda el reloj del escrow, no la fecha de apertura. Un reclamo
 * cuyo pago se libera solo en cuatro horas es más urgente que uno abierto la
 * semana pasada sobre dinero que ya está quieto: pasado ese plazo, el dinero
 * se fue y resolver bien deja de ser posible.
 */
export function DisputeQueue() {
  const [rows, setRows] = useState<DisputeRow[] | null>(null);
  const [filter, setFilter] = useState<'open' | 'resolved'>('open');
  const navigate = useNavigate();

  useEffect(() => {
    setRows(null);
    api.listDisputes({ status: filter }).then((r) => setRows(r.items)).catch(() => setRows([]));
  }, [filter]);

  return (
    <section>
      <div className="queue-head">
        <h1>Reclamos</h1>
        <div className="tabs">
          <button className={filter === 'open' ? 'tab tab-on' : 'tab'} onClick={() => setFilter('open')}>
            Abiertos
          </button>
          <button className={filter === 'resolved' ? 'tab tab-on' : 'tab'} onClick={() => setFilter('resolved')}>
            Resueltos
          </button>
        </div>
      </div>

      {rows === null && <p className="muted">Cargando…</p>}

      {rows?.length === 0 && (
        <div className="empty">
          <h2>No hay reclamos abiertos</h2>
          <p className="muted">Cuando entre uno nuevo aparece acá, ordenado por urgencia.</p>
        </div>
      )}

      {rows && rows.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Caso</th>
              <th>Motivo</th>
              <th>Servicio</th>
              <th className="num">En juego</th>
              <th className="num">Se libera en</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id} onClick={() => navigate(`/reclamo/${d.id}`)}>
                <td>
                  <code>{d.requestId.slice(0, 8)}</code>
                  <div className="muted small">{relativeTime(d.createdAt)}</div>
                </td>
                <td>
                  <strong>{DISPUTE_LABELS[d.type] ?? d.type}</strong>
                  <div className="muted small clamp">{d.reason}</div>
                </td>
                <td>{d.category}</td>
                <td className="num">{money(d.amountInPlay, d.currency)}</td>
                <td className="num">
                  <Countdown hours={d.hoursUntilAutoRelease} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * Reloj de liberación automática. En rojo cuando quedan menos de 12 horas:
 * es el punto donde el caso deja de poder esperar al día siguiente.
 */
function Countdown({ hours }: { hours: number | null }) {
  if (hours === null) return <span className="muted">retenido</span>;
  if (hours <= 0) return <span className="chip chip-alarm">vencido</span>;
  const tone = hours < 12 ? 'chip-alarm' : hours < 36 ? 'chip-warn' : 'chip-calm';
  return <span className={`chip ${tone}`}>{hours} h</span>;
}

function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(diff / 3600_000);
  if (hours < 1) return 'hace minutos';
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.floor(hours / 24)} d`;
}
