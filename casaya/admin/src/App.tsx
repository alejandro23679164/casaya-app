import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, useParams } from 'react-router-dom';
import type { User } from 'firebase/auth';

import { api, watchAuth, login, logout, isAdmin } from './api';
import { DisputeQueue } from './DisputeQueue';
import { DisputeDetailView } from './DisputeDetail';
import './styles.css';

/**
 * Consola de operaciones.
 *
 * Quien la usa atiende reclamos uno atrás de otro durante horas. Por eso la
 * pantalla es densa y sin animaciones: la información entra de una, y no hay
 * transiciones que hagan esperar entre caso y caso.
 */
export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => watchAuth(async (u) => {
    setUser(u);
    setAllowed(u ? await isAdmin(u) : null);
  }), []);

  if (!user) return <LoginScreen />;
  if (allowed === null) return <div className="center">Verificando acceso…</div>;
  if (!allowed) {
    return (
      <div className="center">
        <div>
          <h1>Esta cuenta no tiene acceso al panel</h1>
          <p className="muted">Pedile a un administrador que habilite tu usuario.</p>
          <button className="btn" onClick={logout}>Salir</button>
        </div>
      </div>
    );
  }

  return (
    <BrowserRouter>
      <div className="shell">
        <TopBar email={user.email ?? ''} />
        <main className="main">
          <Routes>
            <Route path="/" element={<DisputeQueue />} />
            <Route path="/reclamo/:id" element={<DisputeRoute />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

function DisputeRoute() {
  const { id } = useParams();
  return <DisputeDetailView disputeId={id!} />;
}

/**
 * Barra superior con el pulso de la operación. Los números no decoran: cada
 * uno es una cola de trabajo que alguien tiene que vaciar hoy.
 */
function TopBar({ email }: { email: string }) {
  const [m, setM] = useState<Awaited<ReturnType<typeof api.metrics>> | null>(null);

  useEffect(() => {
    const load = () => api.metrics().then(setM).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  return (
    <header className="topbar">
      <div className="brand">
        <NavLink to="/">CasaYa · Operaciones</NavLink>
      </div>

      {m && (
        <div className="pulse">
          <Metric value={m.openPanicAlerts} label="alertas de pánico" tone={m.openPanicAlerts > 0 ? 'alarm' : 'calm'} />
          <Metric value={m.openDisputes} label="reclamos abiertos" tone={m.openDisputes > 10 ? 'warn' : 'calm'} />
          <Metric value={m.kycPendingReview} label="KYC por revisar" tone="calm" />
          <Metric value={m.stuckRequests} label="pedidos sin asignar" tone={m.stuckRequests > 0 ? 'warn' : 'calm'} />
          <Metric value={m.escrowHeldCount} label="pagos retenidos" tone="calm" />
        </div>
      )}

      <div className="session">
        <span className="muted">{email}</span>
        <button className="btn btn-ghost" onClick={logout}>Salir</button>
      </div>
    </header>
  );
}

function Metric({ value, label, tone }: { value: number; label: string; tone: 'calm' | 'warn' | 'alarm' }) {
  return (
    <div className={`metric metric-${tone}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      await login(email, password);
    } catch {
      setError('No pudimos entrar con esos datos.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center">
      <div className="login">
        <h1>Operaciones</h1>
        <p className="muted">Acceso del equipo de CasaYa.</p>
        <input
          type="email" placeholder="Correo" value={email} autoComplete="username"
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          type="password" placeholder="Contraseña" value={password} autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary" onClick={submit} disabled={busy || !email || !password}>
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
      </div>
    </div>
  );
}
