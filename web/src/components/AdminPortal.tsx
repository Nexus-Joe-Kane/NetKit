import { useCallback, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { useTabRoute } from '../lib/route';
import {
  ApiClientError,
  api,
  type AdminStatus,
  type AuditEntry,
  type OrderingSettings,
  type QuotaSummary,
  type PublicUser,
  type ServiceState,
  type ServiceStatus,
} from '../lib/api';
import {
  Alert,
  Card,
  Cell,
  Chip,
  CopyButton,
  ExportButtons,
  Label,
  Spinner,
  Switch,
  formatDateTime,
  type ChipTone,
} from './ui';
import type { CsvColumn } from '../lib/csv';
import { Tabs, TabPanel, type TabDef } from './Tabs';
import { CredentialVault } from './CredentialVault';
import { Modal, useConfirm } from './overlay';
import { RecoveryPage } from '../pages/Recovery';

/**
 * Admin portal: service status, integration toggles, users and the audit log.
 *
 * Every destructive action goes through a branded confirmation that states
 * the consequence, and every result that carries information the operator
 * needs to keep — a temporary password, a failure reason — is shown in a
 * dialog rather than a toast that can be missed.
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

type Tab = 'status' | 'credentials' | 'ordering' | 'recovery' | 'users' | 'audit';

const TABS = ['status', 'credentials', 'ordering', 'recovery', 'users', 'audit'] as const;

export function AdminPortal({ me }: { me: PublicUser }): ReactElement {
  // The open tab lives in the URL, so a refresh or a pasted link comes back
  // to the same one.
  const [tab, setTab] = useTabRoute<Tab>('admin', TABS, 'status');

  const tabs: Array<TabDef<Tab>> = [
    { id: 'status', label: 'Service status' },
    { id: 'credentials', label: 'Credentials' },
    { id: 'ordering', label: 'Ordering & limits' },
    { id: 'recovery', label: 'Recovery & self-test' },
    { id: 'users', label: 'Users' },
    { id: 'audit', label: 'Audit log' },
  ];

  return (
    <div className="stack">
      <Tabs tabs={tabs} active={tab} onChange={setTab} variant="primary" label="Admin sections" />
      <TabPanel>
        {tab === 'status' && <StatusBoard />}
        {tab === 'credentials' && <CredentialVault />}
        {tab === 'ordering' && <OrderingBoard />}
        {tab === 'recovery' && <RecoveryPage />}
        {tab === 'users' && <UsersBoard me={me} />}
        {tab === 'audit' && <AuditBoard />}
      </TabPanel>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Service status
 * ------------------------------------------------------------------ */

function StatusBoard(): ReactElement {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [vendor, setVendor] = useState<string>('');
  const [detail, setDetail] = useState<ServiceStatus | null>(null);
  const [result, setResult] = useState<{ title: string; body: ReactNode; tone: 'default' | 'danger' } | null>(null);
  const { confirm, dialog } = useConfirm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.adminStatus();
      setStatus(next);
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

  const grouped = useMemo(() => {
    const map = new Map<string, ServiceStatus[]>();
    for (const service of status?.services ?? []) {
      const list = map.get(service.vendor) ?? [];
      list.push(service);
      map.set(service.vendor, list);
    }
    return map;
  }, [status]);

  const vendors = [...grouped.keys()];
  const currentVendor = vendor && grouped.has(vendor) ? vendor : (vendors[0] ?? '');

  const toggle = async (service: ServiceStatus) => {
    if (service.enabled) {
      const ok = await confirm({
        title: `Switch off ${service.name}?`,
        tone: 'danger',
        confirmLabel: 'Switch it off',
        message: (
          <>
            <p>
              Lookups will stop using this integration immediately. Anything it provides falls through to the next
              provider in the chain — and where it is the only provider, that section will say it is unavailable.
            </p>
            <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>
              {service.capability}
            </p>
          </>
        ),
      });
      if (!ok) return;
    }

    setBusyKey(service.key);
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
    try {
      const outcome = await api.testResend();
      setResult({
        title: 'Test email sent',
        tone: 'default',
        body: (
          <>
            <p>
              A test message went to <strong>{outcome.to}</strong>. Check it has arrived — delivery to the inbox is
              what confirms the domain is set up, not just that Resend accepted the request.
            </p>
            <p style={{ marginBottom: 0 }}>
              Email two-factor authentication is now available. Each user can turn it on for their own account.
            </p>
          </>
        ),
      });
      await load();
    } catch (err) {
      setResult({
        title: 'The test failed',
        tone: 'danger',
        body: (
          <p style={{ marginBottom: 0 }}>
            {err instanceof ApiClientError ? err.message : 'Resend rejected the test.'} Two-factor authentication
            stays unavailable until a test succeeds, so nobody can be locked out by a broken key.
          </p>
        ),
      });
    } finally {
      setBusyKey(null);
    }
  };

  if (loading && !status) {
    return (
      <Card title="Service status" eyebrow="Integrations" index="01" accent={1}>
        <Spinner label="Probing every integration…" />
      </Card>
    );
  }

  const services = grouped.get(currentVendor) ?? [];

  const vendorTabs: Array<TabDef<string>> = vendors.map((name) => {
    const list = grouped.get(name) ?? [];
    const broken = list.filter((s) => s.state === 'down').length;
    return {
      id: name,
      label: name,
      count: list.length,
      ...(broken ? { tone: 'crit' as const } : {}),
    };
  });

  return (
    <div className="stack">
      {error && <Alert tone="error">{error}</Alert>}

      {status && (
        <section className="card card--accent-1">
          <div className="headline">
            <div className="headline__tile">
              <Label>Operational</Label>
              <div className="headline__big" style={{ color: 'var(--sw-ok)' }}>
                {status.summary.ok}
                <span className="headline__unit">of {status.summary.total}</span>
              </div>
              <div className="headline__sub">integrations reachable</div>
            </div>
            <div className="headline__tile">
              <Label>Needs attention</Label>
              <div
                className="headline__big"
                style={{ color: status.summary.down ? 'var(--sw-crit-ink)' : 'var(--sw-ink)' }}
              >
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
              <div className="headline__big" style={{ fontSize: 21, textTransform: 'capitalize' }}>
                {status.environment.dataMode}
              </div>
              <div className="headline__sub">
                v{status.environment.version} · {status.environment.nodeEnv}
              </div>
            </div>
          </div>
        </section>
      )}

      {status && !status.environment.sessionSecretSet && (
        <Alert tone="warn">
          <span>
            <strong>SESSION_SECRET is not set.</strong> Everyone will be signed out each time the app restarts.
            Generate one with <code className="sw-mono">openssl rand -base64 48</code> and add it to the environment.
          </span>
        </Alert>
      )}

      {/*
        * Only when there is a key to test.
        *
        * With Resend deliberately unused, this banner was a standing warning
        * about a service nobody wants: unactionable, and on every page of the
        * portal. Notices go to Zendesk now, so an absent mailer costs email
        * two-factor and nothing else.
        */}
      {status && status.resend.configured && !status.resend.verified && (
        <Alert tone="info">
          <span>
            Email two-factor authentication is unavailable until a Resend delivery test passes.
            {status.resend.lastError && <> Last attempt failed: {status.resend.lastError}.</>}{' '}
            <button
              className="btn btn--ghost btn--small"
              onClick={testResend}
              disabled={busyKey === 'resend'}
              style={{ marginLeft: 4 }}
            >
              {busyKey === 'resend' ? 'Sending…' : 'Send test email'}
            </button>
          </span>
        </Alert>
      )}

      <Card
        title="Integrations"
        eyebrow="Live probe"
        index="01"
        accent={2}
        flush
        meta={
          <button className="btn btn--ghost btn--small" onClick={load} disabled={loading}>
            {loading ? 'Re-checking…' : 'Re-check all'}
          </button>
        }
        tabs={<Tabs tabs={vendorTabs} active={currentVendor} onChange={setVendor} variant="sub" label="Vendors" />}
      >
        <TabPanel>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Integration</th>
                  <th>What it provides</th>
                  <th>State</th>
                  <th style={{ textAlign: 'right' }}>Enabled</th>
                </tr>
              </thead>
              <tbody>
                {services.map((service) => (
                  <tr key={service.key} className="clickable" onClick={() => setDetail(service)}>
                    <td>
                      <strong style={{ color: 'var(--sw-ink)' }}>{service.name}</strong>
                      <div className="muted sw-mono" style={{ fontSize: 11 }}>{service.key}</div>
                    </td>
                    <td style={{ maxWidth: 380, fontSize: 12.5, lineHeight: 1.5 }}>{service.capability}</td>
                    <td>
                      <Chip tone={TONE_BY_STATE[service.state]} dot>
                        {STATE_LABEL[service.state]}
                      </Chip>
                      {service.latencyMs != null && (
                        <div className="muted sw-mono" style={{ fontSize: 11, marginTop: 3 }}>
                          {service.latencyMs} ms
                        </div>
                      )}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <Switch
                        checked={service.enabled}
                        busy={busyKey === service.key}
                        label={`${service.name} enabled`}
                        onChange={() => void toggle(service)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabPanel>
      </Card>

      {/* ---- Integration detail ---------------------------------------- */}
      <Modal
        open={detail !== null}
        onClose={() => setDetail(null)}
        eyebrow={detail?.vendor}
        title={detail?.name ?? ''}
        subtitle={detail?.capability}
        footer={
          <>
            {detail?.docsUrl && (
              <a className="btn btn--ghost grow" href={detail.docsUrl} target="_blank" rel="noreferrer noopener" style={{ flex: 'none' }}>
                Open documentation
              </a>
            )}
            <span className="grow" />
            <button type="button" className="btn btn--primary" onClick={() => setDetail(null)}>
              Close
            </button>
          </>
        }
      >
        {detail && (
          <div className="stack stack--tight">
            <div className="kv">
              <Cell label="Key" value={detail.key} mono copy />
              <Cell label="State" value={STATE_LABEL[detail.state]} />
              <Cell label="Credentials present" value={detail.configured} />
              <Cell label="Enabled" value={detail.enabled} />
              <Cell label="Latency" value={detail.latencyMs != null ? `${detail.latencyMs} ms` : undefined} mono />
              <Cell label="Last checked" value={formatDateTime(detail.checkedAt)} />
            </div>

            <div className={`flag flag--${detail.state === 'down' ? 'critical' : detail.state === 'ok' ? 'info' : 'warn'}`}>
              <span className="flag__marker" aria-hidden="true" />
              <span>
                <strong>Probe result</strong>
                <span className="flag__detail">{detail.detail}</span>
              </span>
            </div>

            {detail.meta && Object.keys(detail.meta).length > 0 && (
              <div>
                <Label>Reported by the provider</Label>
                <pre className="raw" style={{ marginTop: 6 }}>{JSON.stringify(detail.meta, null, 2)}</pre>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* ---- Result of an action --------------------------------------- */}
      <Modal
        open={result !== null}
        onClose={() => setResult(null)}
        title={result?.title ?? ''}
        tone={result?.tone ?? 'default'}
        width="narrow"
        footer={
          <button type="button" className="btn btn--primary" onClick={() => setResult(null)}>
            Done
          </button>
        }
      >
        {result?.body}
      </Modal>

      {dialog}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Ordering and limits
 * ------------------------------------------------------------------ */

/**
 * The ordering lock, the daily order cap and today's fair-use counters.
 *
 * Two switches guard ordering and only one of them is here — the other is an
 * environment variable that needs a deploy. That is on purpose, and the panel
 * says so rather than leaving someone to wonder why "On" did not take effect.
 */
function OrderingBoard(): ReactElement {
  const [ordering, setOrdering] = useState<OrderingSettings | null>(null);
  const [quotas, setQuotas] = useState<QuotaSummary | null>(null);
  const [cap, setCap] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const { confirm, dialog } = useConfirm();

  const load = useCallback(async () => {
    try {
      const [status, quota] = await Promise.all([api.adminStatus(), api.quotas()]);
      setOrdering(status.ordering);
      setQuotas(quota);
      setCap(String(status.ordering.dailyCapPerUser));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not load the ordering settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (next: boolean) => {
    if (next) {
      const ok = await confirm({
        title: 'Unlock ordering?',
        tone: 'danger',
        confirmLabel: 'Unlock ordering',
        requireTyping: 'UNLOCK ORDERING',
        message: (
          <>
            <p>
              Any signed-in user will be able to place real orders against the Zen account, up to the daily cap. Orders
              spend money and book engineer appointments.
            </p>
            <p style={{ marginBottom: 0 }}>
              Each order still needs the address retyped, and every attempt is written to the audit log.
            </p>
          </>
        ),
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const result = await api.setOrdering({ enabled: next });
      setOrdering(result.ordering);
      setNote(result.note ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not change the ordering switch.');
    } finally {
      setBusy(false);
    }
  };

  const saveCap = async () => {
    const value = Number.parseInt(cap, 10);
    if (!Number.isFinite(value) || value < 0 || value > 50) {
      setError('The cap must be a whole number between 0 and 50. Use 0 for no cap.');
      return;
    }
    setBusy(true);
    try {
      const result = await api.setOrdering({ dailyCapPerUser: value });
      setOrdering(result.ordering);
      setError(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not change the cap.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Spinner label="Loading ordering settings…" />;

  const live = Boolean(ordering?.enabled && ordering?.environmentAllows);

  return (
    <div className="stack">
      {error && <Alert tone="error">{error}</Alert>}
      {note && <Alert tone="warn">{note}</Alert>}

      <Card title="Placing orders" eyebrow="Two independent locks" index="01" accent={live ? 3 : 1}>
        <div className={live ? 'flag flag--critical' : 'flag flag--info'}>
          <span className="flag__marker" aria-hidden="true" />
          <span>
            <strong>{live ? 'Ordering is UNLOCKED — orders placed here are real' : 'Ordering is locked'}</strong>
            <span className="flag__detail">
              {live
                ? 'Both locks are open. Every order needs the address retyped and is capped per user per day.'
                : 'Both the environment flag and this switch must be on before any order can be sent.'}
            </span>
          </span>
        </div>

        <div className="kv" style={{ marginTop: 12 }}>
          <Cell
            label="Environment (ZEN_ALLOW_ORDERING)"
            value={ordering?.environmentAllows ? 'Allows ordering' : 'Blocks ordering'}
          />
          <Cell label="Admin switch" value={ordering?.enabled ? 'On' : 'Off'} />
          <Cell label="Daily cap per user" value={ordering?.dailyCapPerUser === 0 ? 'No cap' : String(ordering?.dailyCapPerUser)} />
          <Cell label="Last changed" value={formatDateTime(ordering?.updatedAt)} />
          <Cell label="Changed by" value={ordering?.updatedBy} />
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: 18,
            flexWrap: 'wrap',
            marginTop: 16,
            paddingTop: 16,
            borderTop: '1px solid var(--sw-hairline)',
          }}
        >
          <div>
            {/* The row above reports the state; this is the control. Giving
                both the same label made the panel read as a duplicate. */}
            <Label>Change the switch</Label>
            <div style={{ marginTop: 5 }}>
              <Switch
                checked={Boolean(ordering?.enabled)}
                onChange={(next) => void toggle(next)}
                busy={busy}
                label="Allow orders to be placed"
              />
            </div>
            {!ordering?.environmentAllows && (
              <p className="muted" style={{ fontSize: 11.5, margin: '6px 0 0', maxWidth: 320 }}>
                Turning this on will not be enough on its own — the server also needs
                <span className="sw-mono"> ZEN_ALLOW_ORDERING=true</span>.
              </p>
            )}
          </div>

          <label className="field" style={{ maxWidth: 200, marginBottom: 0 }}>
            <Label>Orders per user per day</Label>
            <input
              className="field__input"
              type="number"
              min={0}
              max={50}
              value={cap}
              onChange={(e) => setCap(e.target.value)}
            />
            <span className="field__hint">0 removes the cap. Keep it low.</span>
          </label>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void saveCap()}
            disabled={busy || cap === String(ordering?.dailyCapPerUser ?? '')}
          >
            Save cap
          </button>
        </div>
      </Card>

      <Card
        title="Today's usage"
        eyebrow="Fair use"
        index="02"
        accent={2}
        meta={quotas ? <Chip tone="idle">{quotas.day}</Chip> : undefined}
        flush
      >
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--sw-hairline)' }}>
          <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
            Premises lookups are rationed because the provider's availability quota is per account, not per user — one
            person working through a list can spend everyone's allowance. Repeat looks at a premises already checked
            today are free. Counts reset at midnight UTC.
          </p>
          <div className="kv" style={{ marginTop: 10 }}>
            <Cell
              label="Lookup budget per user"
              value={quotas?.limits.availability === 0 ? 'No limit' : String(quotas?.limits.availability)}
            />
            <Cell label="Order cap per user" value={quotas?.limits.order === 0 ? 'No cap' : String(quotas?.limits.order)} />
          </div>
        </div>

        {!quotas || quotas.rows.length === 0 ? (
          <div className="empty">
            <h3>Nothing used yet today</h3>
            <p>Counters appear here as soon as someone runs a lookup.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Kind</th>
                  <th style={{ textAlign: 'right' }}>Used</th>
                  <th style={{ textAlign: 'right' }}>Limit</th>
                </tr>
              </thead>
              <tbody>
                {quotas.rows.map((row) => (
                  <tr key={`${row.kind}:${row.userId}`}>
                    <td>{row.email ?? row.userId}</td>
                    <td>{row.kind === 'availability' ? 'Premises lookups' : 'Orders placed'}</td>
                    <td className="sw-mono" style={{ textAlign: 'right' }}>{row.used}</td>
                    <td className="sw-mono" style={{ textAlign: 'right' }}>
                      {row.limit === 0 ? '—' : row.limit}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {dialog}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Users
 * ------------------------------------------------------------------ */


function UsersBoard({ me }: { me: PublicUser }): ReactElement {
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ email: '', name: '', role: 'user' as 'admin' | 'user' });
  const [created, setCreated] = useState<{ email: string; invited: boolean; password?: string; inviteError?: string } | null>(
    null,
  );
  const [detail, setDetail] = useState<PublicUser | null>(null);
  const { confirm, dialog } = useConfirm();

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

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      setDetail(null);
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
    try {
      const outcome = await api.createUser(form);
      setCreated({
        email: outcome.user.email,
        invited: outcome.invited,
        ...(outcome.temporaryPassword ? { password: outcome.temporaryPassword } : {}),
        ...(outcome.inviteError ? { inviteError: outcome.inviteError } : {}),
      });
      setForm({ email: '', name: '', role: 'user' });
      setAdding(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not create that user.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (user: PublicUser) => {
    const ok = await confirm({
      title: `Remove ${user.name}?`,
      tone: 'danger',
      confirmLabel: 'Remove permanently',
      requireTyping: user.email,
      message: (
        <>
          <p>
            <strong>{user.email}</strong> will be deleted and signed out everywhere. Their entries in the audit log
            stay, but the account cannot be recovered — you would have to create it again.
          </p>
        </>
      ),
    });
    if (ok) await act(() => api.deleteUser(user.id));
  };

  const setRole = async (user: PublicUser) => {
    const promoting = user.role === 'user';
    const ok = await confirm({
      title: promoting ? `Make ${user.name} an administrator?` : `Demote ${user.name} to user?`,
      ...(promoting ? {} : { tone: 'danger' as const }),
      confirmLabel: promoting ? 'Promote' : 'Demote',
      message: promoting ? (
        <p style={{ marginBottom: 0 }}>
          They will be able to see and change every integration, add and remove users, and read the audit log.
        </p>
      ) : (
        <p style={{ marginBottom: 0 }}>
          They will lose access to the admin portal and keep lookup access only. This signs them out of their current
          session.
        </p>
      ),
    });
    if (ok) await act(() => api.patchUser(user.id, { role: promoting ? 'admin' : 'user' }));
  };

  const setDisabled = async (user: PublicUser) => {
    if (!user.disabled) {
      const ok = await confirm({
        title: `Disable ${user.name}?`,
        tone: 'danger',
        confirmLabel: 'Disable',
        message: (
          <p style={{ marginBottom: 0 }}>
            They will be signed out immediately and will not be able to sign back in. The account is kept, so this can
            be undone.
          </p>
        ),
      });
      if (!ok) return;
    }
    await act(() => api.patchUser(user.id, { disabled: !user.disabled }));
  };

  return (
    <div className="stack">
      {error && <Alert tone="error">{error}</Alert>}

      <Card
        title="Users"
        eyebrow={`${users.length} ${users.length === 1 ? 'account' : 'accounts'}`}
        index="02"
        accent={1}
        flush
        meta={
          <button className="btn btn--primary btn--small" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Cancel' : 'Add user'}
          </button>
        }
      >
        {adding && (
          <form
            onSubmit={create}
            style={{ padding: 18, borderBottom: '1px solid var(--sw-hairline)', background: 'var(--sw-panel)' }}
          >
            <div className="two-col">
              <label className="field">
                <Label>Email address</Label>
                <input
                  className="field__input"
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  required
                  autoFocus
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
            <label className="field" style={{ maxWidth: 260 }}>
              <Label>Role</Label>
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as 'admin' | 'user' })}>
                <option value="user">User — lookups only</option>
                <option value="admin">Administrator — full access</option>
              </select>
            </label>
            {/* True either way, so it needs no knowledge of the mailer:
                saying "emailed to them" flat out sent people looking for a
                message that, with Resend switched off, was never sent. */}
            <p className="field__hint" style={{ marginBottom: 12 }}>
              A temporary password is generated. It is emailed to them where a mailer is configured, and shown to
              you here otherwise. Either way they must change it at first sign-in.
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
                <th style={{ textAlign: 'right' }}>Manage</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className="clickable" onClick={() => setDetail(user)}>
                  <td>
                    <strong style={{ color: 'var(--sw-ink)' }}>{user.name}</strong>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {user.email}
                      {user.id === me.id && <span className="muted"> · you</span>}
                    </div>
                  </td>
                  <td>
                    <Chip tone={user.role === 'admin' ? 'slate' : 'idle'}>
                      {user.role === 'admin' ? 'Administrator' : 'User'}
                    </Chip>
                  </td>
                  <td>{user.twoFactorEnabled ? <Chip tone="ok">On</Chip> : <Chip tone="idle">Off</Chip>}</td>
                  <td style={{ fontSize: 12.5 }}>
                    {formatDateTime(user.lastLoginAt) ?? <span className="muted">Never</span>}
                  </td>
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
                  <td style={{ textAlign: 'right' }}>
                    <button
                      className="btn btn--ghost btn--small"
                      onClick={(event) => {
                        event.stopPropagation();
                        setDetail(user);
                      }}
                    >
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* ---- Manage one user ------------------------------------------- */}
      <Modal
        open={detail !== null}
        onClose={() => setDetail(null)}
        eyebrow={detail?.role === 'admin' ? 'Administrator' : 'User'}
        title={detail?.name ?? ''}
        subtitle={detail?.email}
        footer={
          <>
            <span className="grow" />
            <button type="button" className="btn btn--ghost" onClick={() => setDetail(null)}>
              Close
            </button>
          </>
        }
      >
        {detail && (
          <div className="stack stack--tight">
            <div className="kv">
              <Cell label="Role" value={detail.role === 'admin' ? 'Administrator' : 'User'} />
              <Cell label="Two-factor" value={detail.twoFactorEnabled} />
              <Cell label="Disabled" value={detail.disabled} />
              <Cell label="Must change password" value={detail.mustChangePassword} />
              <Cell label="Created" value={formatDateTime(detail.createdAt)} />
              <Cell label="Last signed in" value={formatDateTime(detail.lastLoginAt)} />
              <Cell label="Locked until" value={formatDateTime(detail.lockedUntil)} />
            </div>

            <div>
              <Label>Actions</Label>
              <div className="row" style={{ gap: 6, marginTop: 7 }}>
                <button
                  className="btn btn--ghost btn--small"
                  disabled={busy || detail.id === me.id}
                  onClick={() => void setRole(detail)}
                  title={detail.id === me.id ? 'You cannot change your own role' : undefined}
                >
                  {detail.role === 'admin' ? 'Demote to user' : 'Promote to administrator'}
                </button>
                <button
                  className="btn btn--ghost btn--small"
                  disabled={busy}
                  onClick={() => void act(() => api.revokeSessions(detail.id))}
                  title="Invalidate every active session for this user"
                >
                  Sign out everywhere
                </button>
                <button
                  className="btn btn--ghost btn--small"
                  disabled={busy || detail.id === me.id}
                  onClick={() => void setDisabled(detail)}
                >
                  {detail.disabled ? 'Enable account' : 'Disable account'}
                </button>
                <button
                  className="btn btn--danger btn--small"
                  disabled={busy || detail.id === me.id}
                  onClick={() => void remove(detail)}
                >
                  Remove
                </button>
              </div>
              {detail.id === me.id && (
                <p className="field__hint" style={{ marginTop: 8 }}>
                  Some actions are unavailable on your own account, so you cannot lock yourself out.
                </p>
              )}
            </div>
          </div>
        )}
      </Modal>

      {/* ---- New user created ------------------------------------------ */}
      <Modal
        open={created !== null}
        onClose={() => setCreated(null)}
        title="Account created"
        subtitle={created?.email}
        width="narrow"
        footer={
          <button type="button" className="btn btn--primary" onClick={() => setCreated(null)}>
            Done
          </button>
        }
      >
        {created && (
          <div className="stack stack--tight">
            {created.invited ? (
              <p style={{ margin: 0 }}>
                Their temporary password has been emailed to them. They will be asked to set their own the first time
                they sign in.
              </p>
            ) : (
              <>
                <Alert tone="warn">
                  <span>
                    {created.inviteError
                      ? `The invitation email failed: ${created.inviteError}`
                      : 'Email is not configured, so no invitation was sent.'}
                  </span>
                </Alert>
                {created.password && (
                  <div>
                    <Label>Temporary password — pass this on securely</Label>
                    <div
                      className="sw-mono"
                      style={{
                        marginTop: 6,
                        padding: '11px 13px',
                        background: 'var(--sw-panel)',
                        border: '1px solid var(--sw-hairline)',
                        borderRadius: 7,
                        fontSize: 15,
                        letterSpacing: '0.02em',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                      }}
                    >
                      <span className="grow">{created.password}</span>
                      <CopyButton value={created.password} />
                    </div>
                    <p className="field__hint">
                      This is shown once. It must be changed at first sign-in.
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </Modal>

      {dialog}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Audit log
 * ------------------------------------------------------------------ */

/** The audit log is evidence, so the export keeps the detail verbatim. */
const AUDIT_COLUMNS: Array<CsvColumn<AuditEntry>> = [
  { header: 'When', value: (e) => e.at },
  { header: 'Who', value: (e) => (e.automatic ? 'NetKit (automatic)' : e.actorEmail) },
  { header: 'User id', value: (e) => e.actorId },
  { header: 'Automatic', value: (e) => (e.automatic ? 'yes' : 'no') },
  { header: 'Action', value: (e) => e.action },
  { header: 'Detail', value: (e) => (e.detail ? JSON.stringify(e.detail) : '') },
  { header: 'IP', value: (e) => e.ip },
];

function AuditBoard(): ReactElement {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<AuditEntry | null>(null);

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
    <>
      <Card
        title="Audit log"
        eyebrow="Newest first · append only"
        index="03"
        accent={3}
        flush
        meta={<ExportButtons rows={entries} columns={AUDIT_COLUMNS} filenamePrefix="audit" label="the audit log" />}
      >
        {error && (
          <div style={{ padding: 18 }}>
            <Alert tone="error">{error}</Alert>
          </div>
        )}
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
                  <tr key={i} className="clickable" onClick={() => setDetail(entry)}>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 12.5 }}>{formatDateTime(entry.at)}</td>
                    <td style={{ fontSize: 12.5 }}>
                      {entry.automatic ? (
                        // Flagged rather than left blank. A row with no name
                        // against it reads as missing data; this one reads as
                        // work nobody asked for, which is what it is.
                        <span className="chip chip--auto" title="Nobody triggered this — the portal did it on its own">
                          Automatic
                        </span>
                      ) : (
                        entry.actorEmail ?? <span className="muted">—</span>
                      )}
                    </td>
                    <td className="sw-mono" style={{ fontSize: 12 }}>{entry.action}</td>
                    <td className="sw-mono muted" style={{ fontSize: 11.5, maxWidth: 300, wordBreak: 'break-word' }}>
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

      <Modal
        open={detail !== null}
        onClose={() => setDetail(null)}
        eyebrow="Audit entry"
        title={detail?.action ?? ''}
        subtitle={detail ? formatDateTime(detail.at) : undefined}
        footer={
          <button type="button" className="btn btn--primary" onClick={() => setDetail(null)}>
            Close
          </button>
        }
      >
        {detail && (
          <div className="stack stack--tight">
            <div className="kv">
              <Cell label="Action" value={detail.action} mono />
              <Cell label="When" value={formatDateTime(detail.at)} />
              <Cell label="Who" value={detail.automatic ? 'NetKit, automatically' : detail.actorEmail} />
              <Cell label="IP address" value={detail.ip} mono />
            </div>
            {detail.detail && (
              <div>
                <Label>Detail</Label>
                <pre className="raw" style={{ marginTop: 6 }}>{JSON.stringify(detail.detail, null, 2)}</pre>
              </div>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}
