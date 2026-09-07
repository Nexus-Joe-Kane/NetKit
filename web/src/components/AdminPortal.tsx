import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import {
  ApiClientError,
  api,
  type AdminStatus,
  type AuditEntry,
  type PublicUser,
  type ServiceState,
  type ServiceStatus,
} from '../lib/api';
import { Alert, Card, Chip, Label, Spinner, formatDateTime, type ChipTone } from './ui';

/**
 * Admin portal: service status, integration toggles, users and the audit log.
 */

const TONE_BY_STATE: Record<ServiceState, ChipTone> = {
  ok: 'ok',
  degraded: 'warn',
  down: 'crit',
  not_configured: 'idle',
  disabled: 'idle',
};

const STATE_LABEL: Record<ServiceState, string> = {
  ok: 'Operational',
  degraded: 'Degraded',
  down: 'Failing',
  not_configured: 'Not connected',
  disabled: 'Switched off',
};

type Tab = 'status' | 'users' | 'audit';

export function AdminPortal({ me }: { me: PublicUser }): ReactElement {
  const [tab, setTab] = useState<Tab>('status');

  return (
    <div className="stack">
      <div className="tabs" role="tablist" aria-label="Admin sections">
        {(
          [
            ['status', 'Service status'],
            ['users', 'Users'],
            ['audit', 'Audit log'],
          ] as Array<[Tab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            className="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'status' && <StatusBoard />}
      {tab === 'users' && <UsersBoard me={me} />}
      {tab === 'audit' && <AuditBoard />}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Service status
 * ------------------------------------------------------------------ */

function StatusBoard(): ReactElement {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await api.adminStatus());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not load service status.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (service: ServiceStatus) => {
    setBusyKey(service.key);
    setNotice(null);
    try {
      await api.toggleService(service.key, !service.enabled);
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not change that setting.');
    } finally {
      setBusyKey(null);
    }
  };

  const testResend = async () => {
    setBusyKey('resend');
    setError(null);
    setNotice(null);
    try {
      const result = await api.testResend();
      setNotice(`Test email sent to ${result.to}. Email two-factor authentication is now available.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'The Resend test failed.');
    } finally {
      setBusyKey(null);
    }
  };

  if (loading && !status) {
    return (
      <Card title="Service status" accent={1}>
        <Spinner label="Probing every integration…" />
      </Card>
    );
  }

  const grouped = (status?.services ?? []).reduce<Record<string, ServiceStatus[]>>((acc, s) => {
    (acc[s.vendor] ??= []).push(s);
    return acc;
  }, {});

  return (
    <div className="stack">
      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="ok">{notice}</Alert>}

      {status && (
        <section className="card card--accent-1">
          <div className="headline">
            <div className="headline__tile">
              <Label>Operational</Label>
              <div className="headline__big" style={{ color: 'var(--sw-ok)' }}>{status.summary.ok}</div>
              <div className="headline__sub">of {status.summary.total} integrations</div>
            </div>
            <div className="headline__tile">
              <Label>Needs attention</Label>
              <div className="headline__big" style={{ color: status.summary.down ? 'var(--sw-crit-ink)' : 'var(--sw-ink)' }}>
                {status.summary.down + status.summary.degraded}
              </div>
              <div className="headline__sub">
                {status.summary.down} failing, {status.summary.degraded} degraded
              </div>
            </div>
            <div className="headline__tile">
              <Label>Awaiting credentials</Label>
              <div className="headline__big">{status.summary.notConfigured}</div>
              <div className="headline__sub">{status.summary.disabled} switched off</div>
            </div>
            <div className="headline__tile">
              <Label>Data mode</Label>
              <div className="headline__big" style={{ fontSize: 20, textTransform: 'capitalize' }}>
                {status.environment.dataMode}
              </div>
              <div className="headline__sub">v{status.environment.version} · {status.environment.nodeEnv}</div>
            </div>
          </div>
        </section>
      )}

      {status && !status.environment.sessionSecretSet && (
        <Alert tone="warn">
          <strong>SESSION_SECRET is not set.</strong> Sessions will be dropped every time the app restarts. Generate one
          with <code className="sw-mono">openssl rand -base64 48</code> and add it to the environment.
        </Alert>
      )}

      {status && !status.resend.verified && (
        <Alert tone="info">
          Email two-factor authentication is unavailable until a Resend delivery test passes.{' '}
          {status.resend.lastError && <>Last attempt failed: {status.resend.lastError}. </>}
          <button className="btn btn--ghost btn--small" onClick={testResend} disabled={busyKey === 'resend'} style={{ marginLeft: 6 }}>
            {busyKey === 'resend' ? 'Sending…' : 'Send test email'}
          </button>
        </Alert>
      )}

      {Object.entries(grouped).map(([vendor, services]) => (
        <Card
          key={vendor}
          title={vendor}
          eyebrow={`${services.filter((s) => s.state === 'ok').length} of ${services.length} operational`}
          accent={2}
          flush
          meta={
            <button className="btn btn--ghost btn--small" onClick={load} disabled={loading}>
              {loading ? 'Refreshing…' : 'Re-check'}
            </button>
          }
        >
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Integration</th>
                  <th>What it provides</th>
                  <th>State</th>
                  <th>Detail</th>
                  <th style={{ textAlign: 'right' }}>Enabled</th>
                </tr>
              </thead>
              <tbody>
                {services.map((service) => (
                  <tr key={service.key}>
                    <td>
                      <strong style={{ color: 'var(--sw-ink)' }}>{service.name}</strong>
                      <div className="muted sw-mono" style={{ fontSize: 11 }}>{service.key}</div>
                    </td>
                    <td style={{ maxWidth: 300, fontSize: 12.5, lineHeight: 1.5 }}>{service.capability}</td>
                    <td>
                      <Chip tone={TONE_BY_STATE[service.state]} dot>
                        {STATE_LABEL[service.state]}
                      </Chip>
                      {service.latencyMs != null && (
                        <div className="muted sw-mono" style={{ fontSize: 11, marginTop: 3 }}>{service.latencyMs} ms</div>
                      )}
                    </td>
                    <td style={{ maxWidth: 320, fontSize: 12.5, lineHeight: 1.5 }}>
                      {service.detail}
                      {service.meta?.remainingAvailabilityChecks != null && (
                        <div style={{ marginTop: 4 }}>
                          <Chip tone="info">
                            Fair-use quota: {String(service.meta.remainingAvailabilityChecks)}
                          </Chip>
                        </div>
                      )}
                      {!service.configured && service.docsUrl && (
                        <div style={{ marginTop: 4 }}>
                          <a href={service.docsUrl} target="_blank" rel="noreferrer noopener">
                            Request access →
                          </a>
                        </div>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        className={`btn btn--small ${service.enabled ? 'btn--ghost' : 'btn--primary'}`}
                        onClick={() => toggle(service)}
                        disabled={busyKey === service.key}
                      >
                        {busyKey === service.key ? '…' : service.enabled ? 'Switch off' : 'Switch on'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Users
 * ------------------------------------------------------------------ */

function UsersBoard({ me }: { me: PublicUser }): ReactElement {
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ email: '', name: '', role: 'user' as 'admin' | 'user' });

  const load = useCallback(async () => {
    try {
      setUsers((await api.users()).users);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not load users.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (success) setNotice(success);
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.createUser(form);
      setNotice(
        result.invited
          ? `${result.user.email} has been created and emailed their temporary password.`
          : `${result.user.email} has been created.${
              result.temporaryPassword ? ` Temporary password: ${result.temporaryPassword}` : ''
            }${result.inviteError ? ` (Invitation email failed: ${result.inviteError})` : ''}`,
      );
      setForm({ email: '', name: '', role: 'user' });
      setAdding(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not create that user.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="ok">{notice}</Alert>}

      <Card
        title="Users"
        eyebrow={`${users.length} ${users.length === 1 ? 'account' : 'accounts'}`}
        accent={1}
        flush
        meta={
          <button className="btn btn--primary btn--small" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Cancel' : 'Add user'}
          </button>
        }
      >
        {adding && (
          <form onSubmit={create} style={{ padding: 18, borderBottom: '1px solid var(--sw-hairline)', background: 'var(--sw-panel)' }}>
            <div className="two-col">
              <label className="field">
                <Label>Email address</Label>
                <input
                  className="field__input"
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  required
                  placeholder="name@supportwizard.net"
                />
              </label>
              <label className="field">
                <Label>Name</Label>
                <input
                  className="field__input"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                />
              </label>
            </div>
            <label className="field" style={{ maxWidth: 220 }}>
              <Label>Role</Label>
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as 'admin' | 'user' })}>
                <option value="user">User — lookups only</option>
                <option value="admin">Administrator — full access</option>
              </select>
            </label>
            <p className="field__hint" style={{ marginBottom: 12 }}>
              A temporary password is generated and emailed to them. They must change it at first sign-in.
            </p>
            <button className="btn btn--primary" type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create user'}
            </button>
          </form>
        )}

        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>2FA</th>
                <th>Last signed in</th>
                <th>State</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>
                    <strong style={{ color: 'var(--sw-ink)' }}>{user.name}</strong>
                    <div className="muted" style={{ fontSize: 12 }}>{user.email}</div>
                  </td>
                  <td>
                    <Chip tone={user.role === 'admin' ? 'slate' : 'idle'}>
                      {user.role === 'admin' ? 'Administrator' : 'User'}
                    </Chip>
                  </td>
                  <td>{user.twoFactorEnabled ? <Chip tone="ok">On</Chip> : <Chip tone="idle">Off</Chip>}</td>
                  <td style={{ fontSize: 12.5 }}>{formatDateTime(user.lastLoginAt) ?? <span className="muted">Never</span>}</td>
                  <td>
                    {user.disabled ? (
                      <Chip tone="crit" dot>Disabled</Chip>
                    ) : user.mustChangePassword ? (
                      <Chip tone="warn" dot>Password reset pending</Chip>
                    ) : user.lockedUntil && new Date(user.lockedUntil) > new Date() ? (
                      <Chip tone="warn" dot>Locked</Chip>
                    ) : (
                      <Chip tone="ok" dot>Active</Chip>
                    )}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <div className="row row--end" style={{ gap: 5 }}>
                      <button
                        className="btn btn--ghost btn--small"
                        disabled={busy || user.id === me.id}
                        onClick={() =>
                          act(
                            () => api.patchUser(user.id, { role: user.role === 'admin' ? 'user' : 'admin' }),
                            `${user.email} is now ${user.role === 'admin' ? 'a user' : 'an administrator'}.`,
                          )
                        }
                        title={user.id === me.id ? 'You cannot change your own role' : 'Change role'}
                      >
                        {user.role === 'admin' ? 'Demote' : 'Promote'}
                      </button>
                      <button
                        className="btn btn--ghost btn--small"
                        disabled={busy}
                        onClick={() => act(() => api.revokeSessions(user.id), `Signed ${user.email} out everywhere.`)}
                        title="Invalidate every active session for this user"
                      >
                        Sign out
                      </button>
                      <button
                        className="btn btn--ghost btn--small"
                        disabled={busy || user.id === me.id}
                        onClick={() =>
                          act(
                            () => api.patchUser(user.id, { disabled: !user.disabled }),
                            `${user.email} has been ${user.disabled ? 'enabled' : 'disabled'}.`,
                          )
                        }
                      >
                        {user.disabled ? 'Enable' : 'Disable'}
                      </button>
                      <button
                        className="btn btn--danger btn--small"
                        disabled={busy || user.id === me.id}
                        onClick={() => {
                          if (!window.confirm(`Permanently remove ${user.email}? This cannot be undone.`)) return;
                          void act(() => api.deleteUser(user.id), `${user.email} has been removed.`);
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Audit log
 * ------------------------------------------------------------------ */

function AuditBoard(): ReactElement {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setEntries((await api.audit(300)).entries);
      } catch (err) {
        setError(err instanceof ApiClientError ? err.message : 'Could not load the audit log.');
      }
    })();
  }, []);

  return (
    <Card title="Audit log" eyebrow="Newest first · append only" accent={3} flush>
      {error && <div style={{ padding: 18 }}><Alert tone="error">{error}</Alert></div>}
      {!error && entries.length === 0 ? (
        <div className="empty">
          <h3>Nothing recorded yet</h3>
          <p>Sign-ins, user changes and integration toggles all appear here.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Action</th>
                <th>Detail</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, i) => (
                <tr key={i}>
                  <td style={{ whiteSpace: 'nowrap', fontSize: 12.5 }}>{formatDateTime(entry.at)}</td>
                  <td style={{ fontSize: 12.5 }}>{entry.actorEmail ?? <span className="muted">—</span>}</td>
                  <td className="sw-mono" style={{ fontSize: 12 }}>{entry.action}</td>
                  <td className="sw-mono muted" style={{ fontSize: 11.5, maxWidth: 340, wordBreak: 'break-word' }}>
                    {entry.detail ? JSON.stringify(entry.detail) : '—'}
                  </td>
                  <td className="sw-mono muted" style={{ fontSize: 11.5 }}>{entry.ip ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
