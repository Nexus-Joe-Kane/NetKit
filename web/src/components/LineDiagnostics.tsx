import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type {
  AvailableTests,
  LineRecord,
  LineTestResult,
  LineTestType,
  ServiceHistory,
  StabilityReport,
  UsageReport,
} from '@sw/shared';
import { ApiClientError, api } from '../lib/api';
import { Alert, Cell, Chip, Label, Spinner, formatBytes, formatDate, formatDateTime, type ChipTone } from './ui';
import { Modal, useConfirm } from './overlay';
import { RaiseFaultModal } from '../pages/Faults';

/**
 * Line diagnostics — run a test, read the last one, see stability and usage.
 *
 * Tests are the thing support reaches for before raising a fault, so the
 * result carries a recommendation and a direct route into the fault form
 * with the reference already filled in.
 */

const OUTCOME_TONE: Record<LineTestResult['outcome'], ChipTone> = {
  pass: 'ok',
  fail: 'crit',
  inconclusive: 'warn',
  in_progress: 'info',
  error: 'crit',
  unknown: 'idle',
};

const METRIC_TONE: Record<string, ChipTone> = { ok: 'ok', warn: 'warn', fail: 'crit', info: 'idle' };

export function LineDiagnostics({ line }: { line: LineRecord }): ReactElement {
  const zenReference = line.orderRef ?? line.id;
  const [tests, setTests] = useState<AvailableTests | null>(null);
  const [result, setResult] = useState<LineTestResult | null>(null);
  const [mode, setMode] = useState<'live'>('live');
  const [busy, setBusy] = useState<LineTestType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [raiseOpen, setRaiseOpen] = useState(false);
  const [raised, setRaised] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  useEffect(() => {
    void (async () => {
      try {
        const available = await api.availableTests(zenReference, line.technology);
        setTests(available);
        setMode(available.mode);
      } catch (err) {
        setError(err instanceof ApiClientError ? err.message : 'Could not load the available tests.');
      } finally {
        setLoading(false);
      }
    })();
  }, [zenReference, line.technology]);

  const showLatest = useCallback(
    async (type: LineTestType) => {
      setBusy(type);
      setError(null);
      try {
        const latest = await api.latestTest(zenReference, type, line.technology);
        setResult(latest.result);
        setMode(latest.mode);
      } catch (err) {
        setError(err instanceof ApiClientError ? err.message : 'No previous result for that test.');
      } finally {
        setBusy(null);
      }
    },
    [zenReference, line.technology],
  );

  const run = async (type: LineTestType, disruptive?: boolean) => {
    if (disruptive) {
      const ok = await confirm({
        title: 'Run a disruptive test?',
        tone: 'danger',
        confirmLabel: 'Run the test',
        message: (
          <>
            <p>
              A copper line test seizes the pair. If the line is in use it will drop, and a voice call in progress will
              be cut off.
            </p>
            <p style={{ marginBottom: 0 }}>Check with the customer before running this during working hours.</p>
          </>
        ),
      });
      if (!ok) return;
    }

    setBusy(type);
    setError(null);
    try {
      const outcome = await api.runTest(zenReference, type, line.technology);
      setResult(outcome.result);
      setMode(outcome.mode);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not run that test.');
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <Spinner label="Checking which tests this service supports…" />;

  return (
    <div className="stack stack--tight">
      {error && <Alert tone="error">{error}</Alert>}

      <div>
        <Label>Available tests</Label>
        <div className="test-grid" style={{ marginTop: 8 }}>
          {(tests?.types ?? []).map((test) => (
            <div key={test.type} className="test-card">
              <div className="test-card__head">
                <span className="test-card__name">{test.label}</span>
                {test.disruptive && <Chip tone="warn">Disruptive</Chip>}
              </div>
              <p className="test-card__description">{test.description}</p>
              <div className="row" style={{ gap: 6 }}>
                <button
                  className="btn btn--primary btn--small"
                  onClick={() => void run(test.type, test.disruptive)}
                  disabled={busy !== null}
                >
                  {busy === test.type ? 'Running…' : 'Run now'}
                </button>
                <button
                  className="btn btn--ghost btn--small"
                  onClick={() => void showLatest(test.type)}
                  disabled={busy !== null}
                >
                  Last result
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {result && (
        <div>
          <Label>Result — {result.type}</Label>
          <div className={`flag flag--${result.outcome === 'fail' ? 'critical' : result.outcome === 'pass' ? 'info' : 'warn'}`} style={{ marginTop: 8 }}>
            <span className="flag__marker" aria-hidden="true" />
            <span>
              <strong>
                {result.summary ?? result.outcome}
                {'  '}
              </strong>
              {result.faultLocation && <span className="flag__detail">Fault indicated: {result.faultLocation}</span>}
            </span>
          </div>

          <div className="row" style={{ gap: 8, marginTop: 8, marginBottom: 8 }}>
            <Chip tone={OUTCOME_TONE[result.outcome]} dot>
              {result.outcome}
            </Chip>
            {result.ranAt && (
              <span className="muted" style={{ fontSize: 11.5 }}>
                run {formatDateTime(result.ranAt)}
                {result.ranBy ? ` by ${result.ranBy}` : ''}
              </span>
            )}
            {result.id && <span className="muted sw-mono" style={{ fontSize: 11.5 }}>{result.id}</span>}
          </div>

          {result.metrics.length > 0 && (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Reading</th>
                    <th>Value</th>
                    <th>Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {result.metrics.map((metric, i) => (
                    <tr key={i}>
                      <td>{metric.label}</td>
                      <td className="sw-mono">{metric.value}</td>
                      <td>
                        {metric.verdict ? (
                          <Chip tone={METRIC_TONE[metric.verdict] ?? 'idle'} dot>
                            {metric.verdict}
                          </Chip>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {result.recommendations?.length ? (
            <div style={{ marginTop: 10 }}>
              <Label>What to do</Label>
              <ul style={{ margin: '6px 0 0', paddingLeft: 17, fontSize: 13, lineHeight: 1.65 }}>
                {result.recommendations.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {result.outcome === 'fail' && (
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn btn--primary btn--small" onClick={() => setRaiseOpen(true)}>
                Raise a fault with this result
              </button>
            </div>
          )}
        </div>
      )}

      <RaiseFaultModal
        open={raiseOpen}
        onClose={() => setRaiseOpen(false)}
        presetZenReference={zenReference}
        onRaised={(fault) => {
          setRaiseOpen(false);
          setRaised(fault.reference);
        }}
      />

      <Modal
        open={raised !== null}
        onClose={() => setRaised(null)}
        title={raised === 'DEMO-NOT-RAISED' ? 'Nothing was raised' : 'Fault raised'}
        width="narrow"
        footer={
          <button type="button" className="btn btn--primary" onClick={() => setRaised(null)}>
            Done
          </button>
        }
      >
        <p style={{ margin: 0 }}>
          {`The fault is with Zen as ${raised}.`}
        </p>
      </Modal>

      {dialog}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Stability
 * ------------------------------------------------------------------ */

export function LineStability({ line }: { line: LineRecord }): ReactElement {
  const zenReference = line.orderRef ?? line.id;
  const [report, setReport] = useState<StabilityReport | null>(null);
  const [mode, setMode] = useState<'live'>('live');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const result = await api.stability(zenReference, 30);
        setReport(result);
        setMode(result.mode);
      } catch (err) {
        setError(err instanceof ApiClientError ? err.message : 'Could not load stability history.');
      } finally {
        setLoading(false);
      }
    })();
  }, [zenReference]);

  if (loading) return <Spinner label="Loading 30 days of connection history…" />;
  if (error) return <Alert tone="error">{error}</Alert>;
  if (!report) return <Alert tone="info">No stability data.</Alert>;

  const peak = report.buckets.reduce((max, b) => (b.drops > max ? b.drops : max), 0);
  const rejects = report.authenticationAttempts?.filter((a) => a.result === 'reject').length ?? 0;
  // More than one drop a day on average is the threshold worth investigating.
  const unstable = report.totalDrops > report.buckets.length;

  return (
    <div className="stack stack--tight">

      <div className="kv">
        <Cell label="Drops in 30 days" value={report.totalDrops} mono />
        <Cell label="Average per day" value={(report.totalDrops / Math.max(1, report.buckets.length)).toFixed(1)} mono />
        <Cell label="Worst day" value={peak} mono />
        <Cell label="Auth rejections" value={rejects} mono />
        <Cell label="Period" value={`${report.from} to ${report.to}`} />
      </div>

      {unstable && (
        <div className="flag flag--warn">
          <span className="flag__marker" aria-hidden="true" />
          <span>
            <strong>This line looks unstable</strong>
            <span className="flag__detail">
              {report.totalDrops} drops over {report.buckets.length} days. That is enough for DLM to band the profile,
              which caps the rate. Worth a line test and, once clean, a profile reset.
            </span>
          </span>
        </div>
      )}

      <div>
        <Label>Drops per day</Label>
        <div className="bars" style={{ marginTop: 8 }}>
          {report.buckets.map((bucket) => (
            <span
              key={bucket.date}
              className={`bars__bar${bucket.drops === 0 ? ' bars__bar--zero' : bucket.drops > 4 ? ' bars__bar--bad' : bucket.drops > 1 ? ' bars__bar--warn' : ''}`}
              style={{ height: peak ? `${Math.max(3, (bucket.drops / peak) * 100)}%` : '3%' }}
              title={`${bucket.date}: ${bucket.drops} drop${bucket.drops === 1 ? '' : 's'}`}
            />
          ))}
        </div>
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 4 }}>
          <span className="muted" style={{ fontSize: 11 }}>{report.from}</span>
          <span className="muted" style={{ fontSize: 11 }}>{report.to}</span>
        </div>
      </div>

      {report.authenticationAttempts?.length ? (
        <div>
          <Label>Recent authentication attempts</Label>
          <div className="table-wrap" style={{ marginTop: 6, maxHeight: 260 }}>
            <table className="data">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Result</th>
                  <th>Reason</th>
                  <th>NAS</th>
                </tr>
              </thead>
              <tbody>
                {report.authenticationAttempts.map((attempt, i) => (
                  <tr key={i}>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{formatDateTime(attempt.at)}</td>
                    <td>
                      <Chip tone={attempt.result === 'accept' ? 'ok' : 'crit'} dot>
                        {attempt.result}
                      </Chip>
                    </td>
                    <td style={{ fontSize: 12 }}>{attempt.reason ?? <span className="muted">—</span>}</td>
                    <td className="sw-mono" style={{ fontSize: 11.5 }}>{attempt.nasIpAddress ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Usage
 * ------------------------------------------------------------------ */

export function LineUsage({ line }: { line: LineRecord }): ReactElement {
  const zenReference = line.orderRef ?? line.id;
  const [report, setReport] = useState<UsageReport | null>(null);
  const [mode, setMode] = useState<'live'>('live');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const result = await api.usage(zenReference, 'current_month');
        setReport(result);
        setMode(result.mode);
      } catch (err) {
        setError(err instanceof ApiClientError ? err.message : 'Could not load usage.');
      } finally {
        setLoading(false);
      }
    })();
  }, [zenReference]);

  if (loading) return <Spinner label="Loading usage…" />;
  if (error) return <Alert tone="error">{error}</Alert>;
  if (!report) return <Alert tone="info">No usage data.</Alert>;

  const peak = (report.buckets ?? []).reduce((max, b) => {
    const total = b.bytesIn + b.bytesOut;
    return total > max ? total : max;
  }, 0);
  const overCap = report.capBytes != null && (report.totalBytes ?? 0) > report.capBytes;

  return (
    <div className="stack stack--tight">

      <div className="kv">
        <Cell label="Downloaded" value={formatBytes(report.bytesIn)} mono />
        <Cell label="Uploaded" value={formatBytes(report.bytesOut)} mono />
        <Cell label="Total" value={formatBytes(report.totalBytes)} mono />
        <Cell label="Cap" value={report.capBytes != null ? formatBytes(report.capBytes) : 'Unlimited'} mono />
        <Cell label="Period" value={report.from && report.to ? `${report.from} to ${report.to}` : undefined} />
      </div>

      {overCap && (
        <div className="flag flag--critical">
          <span className="flag__marker" aria-hidden="true" />
          <span>
            <strong>Over the usage cap</strong>
            <span className="flag__detail">
              {formatBytes(report.totalBytes)} against a {formatBytes(report.capBytes)} cap. Expect an overage charge or
              a shaped service.
            </span>
          </span>
        </div>
      )}

      {report.buckets?.length ? (
        <div>
          <Label>Daily usage</Label>
          <div className="bars" style={{ marginTop: 8 }}>
            {report.buckets.map((bucket) => (
              <span
                key={bucket.date}
                className="bars__bar"
                style={{ height: peak ? `${Math.max(3, ((bucket.bytesIn + bucket.bytesOut) / peak) * 100)}%` : '3%' }}
                title={`${bucket.date}: ${formatBytes(bucket.bytesIn + bucket.bytesOut)}`}
              />
            ))}
          </div>
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 4 }}>
            <span className="muted" style={{ fontSize: 11 }}>{report.buckets[0]?.date}</span>
            <span className="muted" style={{ fontSize: 11 }}>{report.buckets[report.buckets.length - 1]?.date}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Service history
 * ------------------------------------------------------------------ */

/**
 * Every recorded change to this service, newest first.
 *
 * The question this answers is "what changed?", which is the first thing
 * worth asking when a line that worked for two years stops working. A
 * regrade or a care-level change dated the day before the complaint is
 * usually the whole answer.
 */
export function LineHistory({ line }: { line: LineRecord }): ReactElement {
  const zenReference = line.orderRef ?? line.id;
  const [history, setHistory] = useState<ServiceHistory | null>(null);
  const [mode, setMode] = useState<'live'>('live');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const result = await api.serviceHistory(zenReference);
        setHistory(result);
        setMode(result.mode);
      } catch (err) {
        setError(err instanceof ApiClientError ? err.message : 'Could not load the service history.');
      } finally {
        setLoading(false);
      }
    })();
  }, [zenReference]);

  if (loading) return <Spinner label="Loading service history…" />;
  if (error) return <Alert tone="error">{error}</Alert>;
  if (!history || history.events.length === 0) {
    return <Alert tone="info">No changes are recorded against this service.</Alert>;
  }

  return (
    <div className="stack stack--tight">
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>When</th>
              <th>Change</th>
              <th>From</th>
              <th>To</th>
              <th>Reference</th>
            </tr>
          </thead>
          <tbody>
            {history.events.map((event, i) => (
              <tr key={`${event.at}-${i}`}>
                <td style={{ whiteSpace: 'nowrap', fontSize: 12.5 }}>{formatDate(event.at) ?? '—'}</td>
                <td>
                  <strong style={{ color: 'var(--sw-ink)' }}>{event.type}</strong>
                  {event.description && (
                    <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>{event.description}</div>
                  )}
                  {event.actor && (
                    <div className="muted" style={{ fontSize: 11 }}>by {event.actor}</div>
                  )}
                </td>
                <td style={{ fontSize: 12.5 }}>{event.from ?? '—'}</td>
                <td style={{ fontSize: 12.5 }}>{event.to ?? '—'}</td>
                <td className="sw-mono" style={{ fontSize: 12 }}>{event.reference ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
