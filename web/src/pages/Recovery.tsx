import { Fragment, useCallback, useEffect, useState, type ReactElement } from 'react';
import {
  ApiClientError,
  api,
  type Check,
  type HealthState,
  type IntegrationHealth,
  type SelfTestReport,
  type SupervisorState,
  type SweepResult,
} from '../lib/api';
import { Alert, Card, Cell, Chip, Label, Spinner, formatDateTime, type ChipTone } from '../components/ui';
import { Tabs, TabPanel, type TabDef } from '../components/Tabs';
import { Modal } from '../components/overlay';

/**
 * Recovery and self-test.
 *
 * The supervisor probes every integration on an interval and tries to fix
 * what it can; this is the window onto what it has been doing. The self-test
 * answers a different question — does this deployment work right now, with
 * these credentials — and is safe to run at any time.
 */

const STATE_TONE: Record<HealthState, ChipTone> = {
  healthy: 'ok',
  degraded: 'warn',
  failing: 'crit',
  circuit_open: 'crit',
  recovering: 'info',
  not_configured: 'idle',
  disabled: 'idle',
};

const STATE_LABEL: Record<HealthState, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  failing: 'Failing',
  circuit_open: 'Paused (circuit open)',
  recovering: 'Recovering',
  not_configured: 'Not connected',
  disabled: 'Switched off',
};

const CHECK_TONE: Record<Check['status'], ChipTone> = { pass: 'ok', fail: 'crit', warn: 'warn', skip: 'idle' };

type Tab = 'supervisor' | 'selftest';

export function RecoveryPage(): ReactElement {
  const [tab, setTab] = useState<Tab>('supervisor');
  const tabs: Array<TabDef<Tab>> = [
    { id: 'supervisor', label: 'Auto recovery' },
    { id: 'selftest', label: 'Self-test' },
  ];

  return (
    <div className="stack">
      <Tabs tabs={tabs} active={tab} onChange={setTab} variant="primary" label="Recovery sections" />
      <TabPanel>
        {tab === 'supervisor' && <SupervisorBoard />}
        {tab === 'selftest' && <SelfTestBoard />}
      </TabPanel>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Supervisor
 * ------------------------------------------------------------------ */

function SupervisorBoard(): ReactElement {
  const [state, setState] = useState<SupervisorState | null>(null);
  const [sweep, setSweep] = useState<SweepResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<IntegrationHealth | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await api.supervisor());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not load recovery state.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // Refresh while the page is open, so a circuit closing is visible without
    // the operator having to reload.
    const timer = setInterval(() => void load(), 20_000);
    return () => clearInterval(timer);
  }, [load]);

  const runSweep = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.sweepNow();
      setSweep(result.sweep);
      setState(result.state);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'The sweep failed.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <Card title="Auto recovery" eyebrow="Supervisor" index="01" accent={1}>
        <Spinner label="Loading recovery state…" />
      </Card>
    );
  }

  const integrations = state?.integrations ?? [];
  const needsAttention = integrations.filter((i) => ['failing', 'circuit_open', 'degraded'].includes(i.state));
  const paused = integrations.filter((i) => i.circuit.open);
  const recoveries = integrations.reduce((n, i) => n + i.recoveries.filter((r) => r.outcome === 'recovered').length, 0);

  return (
    <div className="stack">
      {error && <Alert tone="error">{error}</Alert>}

      {!state?.enabled && (
        <Alert tone="warn">
          <span>
            The supervisor is switched off (<code className="sw-mono">SUPERVISOR_ENABLED=false</code>). Nothing is
            being probed or recovered automatically.
          </span>
        </Alert>
      )}

      {sweep && (
        <Alert tone={sweep.skipped ? 'info' : sweep.recovered.length ? 'ok' : 'info'}>
          <span>
            {sweep.skipped
              ? 'A sweep was already running, so this one stood down.'
              : `Checked ${sweep.checked}: ${sweep.healthy} healthy, ${sweep.failing} failing.` +
                (sweep.recovered.length ? ` Recovered: ${sweep.recovered.join(', ')}.` : '') +
                (sweep.circuitsOpened.length ? ` Paused: ${sweep.circuitsOpened.join(', ')}.` : '') +
                (sweep.circuitsClosed.length ? ` Resumed: ${sweep.circuitsClosed.join(', ')}.` : '')}
          </span>
        </Alert>
      )}

      <section className="card card--accent-1">
        <div className="headline">
          <div className="headline__tile">
            <Label>Needs attention</Label>
            <div
              className="headline__big"
              style={{ color: needsAttention.length ? 'var(--sw-crit-ink)' : 'var(--sw-ok)' }}
            >
              {needsAttention.length}
            </div>
            <div className="headline__sub">of {integrations.length} tracked</div>
          </div>
          <div className="headline__tile">
            <Label>Paused by breaker</Label>
            <div className="headline__big" style={{ color: paused.length ? 'var(--sw-amber-ink)' : 'var(--sw-ink)' }}>
              {paused.length}
            </div>
            <div className="headline__sub">calls skipped, not queued</div>
          </div>
          <div className="headline__tile">
            <Label>Auto recoveries</Label>
            <div className="headline__big" style={{ color: recoveries ? 'var(--sw-ok)' : 'var(--sw-ink)' }}>
              {recoveries}
            </div>
            <div className="headline__sub">fixed without anyone asking</div>
          </div>
          <div className="headline__tile">
            <Label>Last sweep</Label>
            <div className="headline__big" style={{ fontSize: 17 }}>
              {state?.lastSweepAt ? new Date(state.lastSweepAt).toLocaleTimeString('en-GB') : '—'}
            </div>
            <div className="headline__sub">
              every {Math.round((state?.intervalSeconds ?? 300) / 60)} min · {state?.sweeps ?? 0} so far
            </div>
          </div>
        </div>
      </section>

      <Card
        title="Integrations"
        eyebrow="Probed automatically"
        index="01"
        accent={2}
        flush
        meta={
          <button className="btn btn--primary btn--small" onClick={runSweep} disabled={busy}>
            {busy ? 'Sweeping…' : 'Sweep now'}
          </button>
        }
      >
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Integration</th>
                <th>State</th>
                <th>Availability</th>
                <th>Last OK</th>
                <th>Recovery</th>
              </tr>
            </thead>
            <tbody>
              {integrations.map((integration) => (
                <tr key={integration.key} className="clickable" onClick={() => setDetail(integration)}>
                  <td>
                    <strong style={{ color: 'var(--sw-ink)' }}>{integration.name}</strong>
                    <div className="muted sw-mono" style={{ fontSize: 11 }}>{integration.key}</div>
                  </td>
                  <td>
                    <Chip tone={STATE_TONE[integration.state]} dot>
                      {STATE_LABEL[integration.state]}
                    </Chip>
                    {integration.consecutiveFailures > 0 && (
                      <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>
                        {integration.consecutiveFailures} failure{integration.consecutiveFailures === 1 ? '' : 's'} in a row
                      </div>
                    )}
                  </td>
                  <td>
                    {integration.availability != null ? (
                      <>
                        <div className="pool-bar pool-bar--slim" style={{ maxWidth: 100 }}>
                          <span
                            className={`pool-bar__fill${integration.availability < 60 ? ' pool-bar__fill--over' : integration.availability < 95 ? ' pool-bar__fill--warn' : ''}`}
                            style={{ width: `${integration.availability}%` }}
                          />
                        </div>
                        <div className="muted sw-mono" style={{ fontSize: 11, marginTop: 3 }}>
                          {integration.availability}% of {integration.history.length}
                        </div>
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td style={{ whiteSpace: 'nowrap', fontSize: 12.5 }}>
                    {formatDateTime(integration.lastOkAt) ?? <span className="muted">Never</span>}
                  </td>
                  <td style={{ fontSize: 12.5 }}>
                    {integration.recoveries.length === 0 ? (
                      <span className="muted">Not needed</span>
                    ) : integration.recoveries[0]?.outcome === 'recovered' ? (
                      <Chip tone="ok" dot>Recovered</Chip>
                    ) : (
                      <Chip tone="warn">{integration.recoveries.length} attempts</Chip>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Modal
        open={detail !== null}
        onClose={() => setDetail(null)}
        eyebrow={detail?.vendor}
        title={detail?.name ?? ''}
        subtitle={detail ? STATE_LABEL[detail.state] : undefined}
        {...(detail && ['failing', 'circuit_open'].includes(detail.state) ? { tone: 'danger' as const } : {})}
        footer={
          <>
            <span className="grow" />
            <button type="button" className="btn btn--primary" onClick={() => setDetail(null)}>
              Close
            </button>
          </>
        }
      >
        {detail && (
          <div className="stack stack--tight">
            {detail.circuit.open && (
              <div className="flag flag--critical">
                <span className="flag__marker" aria-hidden="true" />
                <span>
                  <strong>Calls to this integration are paused</strong>
                  <span className="flag__detail">
                    After {detail.consecutiveFailures} failures in a row the breaker opened, so lookups go straight to
                    the fallback instead of waiting for a timeout. One probe is allowed through at{' '}
                    {formatDateTime(detail.circuit.nextAttemptAt) ?? 'the next sweep'}; the backoff is currently{' '}
                    {detail.circuit.backoffSeconds}s and doubles while it keeps failing.
                  </span>
                </span>
              </div>
            )}

            {detail.lastError && (
              <div className="flag flag--warn">
                <span className="flag__marker" aria-hidden="true" />
                <span>
                  <strong>Last error</strong>
                  <span className="flag__detail">{detail.lastError}</span>
                </span>
              </div>
            )}

            <div className="kv">
              <Cell label="State" value={STATE_LABEL[detail.state]} />
              <Cell label="Failures in a row" value={detail.consecutiveFailures} mono />
              <Cell label="Successes in a row" value={detail.consecutiveSuccesses} mono />
              <Cell label="Availability" value={detail.availability != null ? `${detail.availability}%` : undefined} mono />
              <Cell label="Last checked" value={formatDateTime(detail.lastCheckedAt)} />
              <Cell label="Last OK" value={formatDateTime(detail.lastOkAt)} />
              <Cell label="Latency" value={detail.latencyMs != null ? `${detail.latencyMs} ms` : undefined} mono />
              <Cell label="Circuit" value={detail.circuit.open ? 'Open' : 'Closed'} />
            </div>

            {detail.history.length > 0 && (
              <div>
                <Label>Probe history — oldest left</Label>
                <div className="probe-strip" style={{ marginTop: 7 }}>
                  {detail.history.map((h, i) => (
                    <span
                      key={i}
                      className={`probe-strip__tick${h.ok ? '' : ' probe-strip__tick--bad'}`}
                      title={`${new Date(h.at).toLocaleString('en-GB')}: ${h.ok ? 'OK' : 'failed'}${h.ms ? ` (${h.ms} ms)` : ''}`}
                    />
                  ))}
                </div>
              </div>
            )}

            {detail.recoveries.length > 0 && (
              <div>
                <Label>Recovery attempts — newest first</Label>
                <div className="timeline" style={{ marginTop: 8 }}>
                  {detail.recoveries.map((attempt, i) => (
                    <div key={i} className="timeline__item">
                      <span
                        className="timeline__dot"
                        style={{
                          background:
                            attempt.outcome === 'recovered'
                              ? 'var(--sw-ok)'
                              : attempt.outcome === 'error'
                                ? 'var(--sw-crimson)'
                                : 'var(--sw-series-6)',
                        }}
                        aria-hidden="true"
                      />
                      <div>
                        <div className="sw-label">
                          {formatDateTime(attempt.at)} · {attempt.outcome.replace(/_/g, ' ')}
                        </div>
                        <div style={{ fontSize: 13, lineHeight: 1.55 }}>{attempt.action}</div>
                        {attempt.detail && (
                          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{attempt.detail}</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Self-test
 * ------------------------------------------------------------------ */

function SelfTestBoard(): ReactElement {
  const [report, setReport] = useState<SelfTestReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await api.selfTest());
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'The self-test could not run.');
    } finally {
      setBusy(false);
    }
  };

  const groups = report
    ? [...new Set(report.checks.map((c) => c.group))].map((group) => ({
        group,
        checks: report.checks.filter((c) => c.group === group),
      }))
    : [];

  return (
    <div className="stack">
      {error && <Alert tone="error">{error}</Alert>}

      {report && (
        <section className={`card card--accent-${report.outcome === 'pass' ? '1' : '3'}`}>
          <div className="headline">
            <div className="headline__tile">
              <Label>Outcome</Label>
              <div
                className="headline__big"
                style={{ color: report.outcome === 'pass' ? 'var(--sw-ok)' : 'var(--sw-crit-ink)' }}
              >
                {report.outcome === 'pass' ? 'Pass' : 'Fail'}
              </div>
              <div className="headline__sub">{report.durationMs} ms</div>
            </div>
            <div className="headline__tile">
              <Label>Passed</Label>
              <div className="headline__big" style={{ color: 'var(--sw-ok)' }}>{report.counts.pass}</div>
              <div className="headline__sub">of {report.checks.length} checks</div>
            </div>
            <div className="headline__tile">
              <Label>Failed</Label>
              <div
                className="headline__big"
                style={{ color: report.counts.fail ? 'var(--sw-crit-ink)' : 'var(--sw-ink)' }}
              >
                {report.counts.fail}
              </div>
              <div className="headline__sub">{report.counts.warn} warnings, {report.counts.skip} skipped</div>
            </div>
            <div className="headline__tile">
              <Label>Environment</Label>
              <div className="headline__big" style={{ fontSize: 19, textTransform: 'capitalize' }}>
                {report.environment.dataMode}
              </div>
              <div className="headline__sub">
                v{report.environment.version} · {report.environment.nodeEnv}
              </div>
            </div>
          </div>
        </section>
      )}

      <Card
        title="Self-test"
        eyebrow="Does this deployment work right now"
        index="02"
        accent={1}
        flush={report !== null}
        meta={
          <button className="btn btn--primary btn--small" onClick={run} disabled={busy}>
            {busy ? 'Running…' : report ? 'Run again' : 'Run self-test'}
          </button>
        }
      >
        {!report && !busy && (
          <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.65 }}>
            Exercises the whole portal against whatever providers are actually configured — identifier classification,
            address and UPRN round-trips, a full site report, every operational endpoint, every tool, and the
            authentication primitives. Read-only: it never raises a fault or places an order, so it is safe to run at
            any time. It also runs automatically at startup.
          </p>
        )}

        {busy && (
          <div style={{ padding: 4 }}>
            <Spinner label="Running every check…" />
          </div>
        )}

        {report && !busy && (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Check</th>
                  <th>Result</th>
                  <th>What it found</th>
                  <th className="num">Time</th>
                </tr>
              </thead>
              <tbody>
                {groups.map(({ group, checks }) => (
                  <Fragment key={group}>
                    <tr>
                      <td colSpan={4} style={{ background: 'var(--sw-panel)', padding: '7px 14px' }}>
                        <span className="sw-label">{group}</span>
                      </td>
                    </tr>
                    {checks.map((check) => (
                      <tr key={check.id}>
                        <td style={{ paddingLeft: 24 }}>{check.name}</td>
                        <td>
                          <Chip tone={CHECK_TONE[check.status]} dot>
                            {check.status}
                          </Chip>
                          {check.mode && (
                            <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>{check.mode}</div>
                          )}
                        </td>
                        <td style={{ maxWidth: 460, fontSize: 12.5, lineHeight: 1.5 }}>{check.detail}</td>
                        <td className="num">{check.durationMs} ms</td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
