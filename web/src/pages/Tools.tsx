import { useState, type ReactElement, type ReactNode } from 'react';
import { formatPostcode, identify, normaliseCli } from '@sw/shared';
import type {
  CallRecord,
  EthernetQuoteSet,
  FootfallInsight,
  ImeiLookup,
  NetworkConnectivityCheck,
  NumberPortCheck,
  RdnsRecord,
} from '@sw/shared';
import { ApiClientError, api } from '../lib/api';
import { Alert, Card, Cell, Chip, Label, Spinner, formatBytes, formatDateTime, formatDuration } from '../components/ui';
import { Modal } from '../components/overlay';

/**
 * Tools — the standalone lookups that are not about one site.
 *
 * Each tool is a card that opens into a dialog with one input and its
 * result. They share a runner so adding a tool is a definition, not a
 * component.
 */

interface ToolDef {
  id: string;
  name: string;
  description: string;
  /** Vendor label, so it is obvious which credential a tool needs. */
  vendor: string;
  accent: 1 | 2 | 3 | 4;
  input: { label: string; placeholder: string; hint?: string };
  /** Validates and normalises before the call, so bad input never round-trips. */
  validate?: (value: string) => string | null;
  run: (value: string) => Promise<ReactNode>;
}

const cliValidator = (value: string): string | null =>
  normaliseCli(value) ? null : 'Enter a valid UK phone number, e.g. 01614969790 or +44 7700 900123.';

const postcodeValidator = (value: string): string | null =>
  identify(value).kind === 'postcode' ? null : 'Enter a full UK postcode, e.g. M1 1AE.';

export function ToolsPage(): ReactElement {
  const [active, setActive] = useState<ToolDef | null>(null);

  const tools: ToolDef[] = [
    {
      id: 'number-port',
      name: 'Number porting checker',
      description: 'Whether a number can be ported to us, and who currently holds it.',
      vendor: 'Zen',
      accent: 1,
      input: { label: 'Phone number to port', placeholder: '01614969790', hint: 'The number the customer wants to keep.' },
      validate: cliValidator,
      run: async (value) => <PortResult data={await api.numberPort(value)} />,
    },
    {
      id: 'connectivity',
      name: 'Is this phone on the network?',
      description: 'Whether a mobile number is currently attached to EE, and whether it is roaming.',
      vendor: 'BT — Home Network',
      accent: 2,
      input: { label: 'Mobile number', placeholder: '07700900123', hint: 'Checks live attach state, not just whether the SIM exists.' },
      validate: cliValidator,
      run: async (value) => <ConnectivityResult data={await api.connectivity(value)} />,
    },
    {
      id: 'imei',
      name: 'IMEI and handset lookup',
      description: 'The handset behind a number — make, model and whether it supports Wi-Fi calling.',
      vendor: 'BT — IMEI Lookup',
      accent: 2,
      input: { label: 'Mobile number', placeholder: '07700900123' },
      validate: cliValidator,
      run: async (value) => <ImeiResult data={await api.imei(value)} />,
    },
    {
      id: 'ethernet',
      name: 'Ethernet / leased line quote',
      description: 'Indicative EAD and EoFTTC pricing at a postcode, including excess construction risk.',
      vendor: 'Zen',
      accent: 3,
      input: { label: 'Postcode', placeholder: 'M1 1AE', hint: 'Indicative only — a firm price needs a survey.' },
      validate: postcodeValidator,
      run: async (value) => <EthernetResult data={await api.ethernet({ postcode: formatPostcode(value) })} />,
    },
    {
      id: 'footfall',
      name: 'Footfall and catchment',
      description: 'Visitor numbers and where they travel from. London only on the live product.',
      vendor: 'BT — Location Insights',
      accent: 4,
      input: { label: 'Postcode', placeholder: 'W8 5TT', hint: 'BT covers Greater London only.' },
      validate: postcodeValidator,
      run: async (value) => <FootfallResult data={await api.footfall(value)} />,
    },
    {
      id: 'cdrs',
      name: 'Call records',
      description: 'Calls made in the last 24 hours, with duration, destination and cost.',
      vendor: 'Zen',
      accent: 1,
      input: { label: 'Nothing needed', placeholder: 'Press Run', hint: 'Zen limits the window to two days; this fetches the last 24 hours.' },
      run: async () => <CdrResult data={await api.callRecords()} />,
    },
    {
      id: 'rdns',
      name: 'Reverse DNS',
      description: 'PTR records on our IP allocations. Useful when a customer’s mail is being rejected.',
      vendor: 'Zen',
      accent: 3,
      input: { label: 'Zen reference (optional)', placeholder: 'ZEN1234567', hint: 'Leave blank to list everything.' },
      run: async (value) => <RdnsResult data={await api.rdns(value.trim() || undefined)} />,
    },
  ];

  return (
    <div className="stack">
      <Card title="Tools" eyebrow="Standalone lookups" index="01" accent={1}>
        <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
          Lookups that are not about a single site. Anything site-specific — availability, coverage, lines,
          diagnostics — lives under Lookup instead.
        </p>
      </Card>

      <div className="tool-grid">
        {tools.map((tool) => (
          <button key={tool.id} type="button" className={`tool tool--accent-${tool.accent}`} onClick={() => setActive(tool)}>
            <span className="sw-label">{tool.vendor}</span>
            <span className="tool__name">{tool.name}</span>
            <span className="tool__description">{tool.description}</span>
            <span className="tool__cta">
              Open
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </span>
          </button>
        ))}
      </div>

      {active && <ToolRunner tool={active} onClose={() => setActive(null)} />}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The runner
 * ------------------------------------------------------------------ */

function ToolRunner({ tool, onClose }: { tool: ToolDef; onClose: () => void }): ReactElement {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReactNode | null>(null);

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    const problem = tool.validate?.(value);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await tool.run(value));
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'That lookup failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={tool.vendor}
      title={tool.name}
      subtitle={tool.description}
      width="wide"
      footer={
        <>
          <span className="grow" />
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Running…' : result ? 'Run again' : 'Run'}
          </button>
        </>
      }
    >
      <form onSubmit={submit}>
        <label className="field">
          <Label>{tool.input.label}</Label>
          <input
            className="field__input"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={tool.input.placeholder}
            autoFocus
            spellCheck={false}
          />
          {tool.input.hint && <span className="field__hint">{tool.input.hint}</span>}
        </label>
      </form>

      {error && <Alert tone="error">{error}</Alert>}
      {busy && <Spinner label="Running the lookup…" />}
      {result && <div className="stack stack--tight">{result}</div>}
    </Modal>
  );
}

/** Every result leads with whether it came from a live API. */
function ModeBadge({ mode, providerError }: { mode: 'live' | 'mock'; providerError?: string }): ReactElement {
  return (
    <div className="row" style={{ gap: 8 }}>
      {mode === 'live' ? <Chip tone="ok" dot>Live result</Chip> : <Chip tone="warn" dot>Demo data</Chip>}
      {providerError && (
        <span className="muted" style={{ fontSize: 11.5 }}>
          live call failed: {providerError}
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Result renderers
 * ------------------------------------------------------------------ */

function PortResult({ data }: { data: NumberPortCheck & { mode: 'live' | 'mock'; providerError?: string } }): ReactElement {
  return (
    <>
      <ModeBadge mode={data.mode} {...(data.providerError ? { providerError: data.providerError } : {})} />
      <div className={`flag flag--${data.pending ? 'info' : data.canBePorted ? 'info' : 'critical'}`}>
        <span className="flag__marker" aria-hidden="true" />
        <span>
          <strong>
            {data.pending ? 'Still checking' : data.canBePorted ? 'Number can be ported' : 'Number cannot be ported'}
          </strong>
          <span className="flag__detail">
            {data.messages.length ? data.messages.join(' ') : 'No further detail was returned.'}
          </span>
        </span>
      </div>
      <div className="kv">
        <Cell label="Number" value={data.phoneNumber} mono copy />
        <Cell label="Portable" value={data.pending ? undefined : data.canBePorted} />
        <Cell label="Current provider" value={data.currentProvider} />
        <Cell label="Exchange prefix" value={data.exchangePrefix} mono />
        <Cell label="CUPID" value={data.cupid} mono />
        <Cell label="Reference" value={data.reference} mono copy />
      </div>
    </>
  );
}

function ConnectivityResult({
  data,
}: {
  data: NetworkConnectivityCheck & { mode: 'live' | 'mock'; providerError?: string };
}): ReactElement {
  return (
    <>
      <ModeBadge mode={data.mode} {...(data.providerError ? { providerError: data.providerError } : {})} />
      <div className={`flag flag--${data.connected ? 'info' : 'critical'}`}>
        <span className="flag__marker" aria-hidden="true" />
        <span>
          <strong>{data.connected ? 'Attached to the network' : 'Not attached'}</strong>
          <span className="flag__detail">{data.messages.join(' ')}</span>
        </span>
      </div>
      <div className="kv">
        <Cell label="Number" value={data.msisdn} mono copy />
        <Cell label="Connected" value={data.connected} />
        <Cell label="Reachable" value={data.reachable} />
        <Cell label="Network" value={data.network} />
        <Cell label="Roaming" value={data.roaming} />
        <Cell label="Country" value={data.country} />
        <Cell label="Last seen" value={formatDateTime(data.lastSeenAt)} />
      </div>
    </>
  );
}

function ImeiResult({ data }: { data: ImeiLookup & { mode: 'live' | 'mock'; providerError?: string } }): ReactElement {
  return (
    <>
      <ModeBadge mode={data.mode} {...(data.providerError ? { providerError: data.providerError } : {})} />
      {data.blacklisted && (
        <div className="flag flag--critical">
          <span className="flag__marker" aria-hidden="true" />
          <span>
            <strong>Handset is blacklisted</strong>
            <span className="flag__detail">
              This IMEI is reported as blocked. It will not register on a UK network.
            </span>
          </span>
        </div>
      )}
      <div className="kv">
        <Cell label="Number" value={data.msisdn} mono copy />
        <Cell label="IMEI" value={data.imei} mono copy />
        <Cell label="TAC" value={data.tac} mono />
        <Cell label="Manufacturer" value={data.manufacturer} />
        <Cell label="Model" value={data.model} />
        <Cell label="Blacklisted" value={data.blacklisted} />
      </div>
      {data.capabilities?.length ? (
        <div>
          <Label>Capabilities</Label>
          <div className="row" style={{ gap: 5, marginTop: 6 }}>
            {data.capabilities.map((cap) => (
              <Chip key={cap} tone="info">
                {cap}
              </Chip>
            ))}
          </div>
        </div>
      ) : null}
      {data.messages.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 17, fontSize: 13, lineHeight: 1.6 }}>
          {data.messages.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function EthernetResult({ data }: { data: EthernetQuoteSet & { mode: 'live' | 'mock'; providerError?: string } }): ReactElement {
  return (
    <>
      <ModeBadge mode={data.mode} {...(data.providerError ? { providerError: data.providerError } : {})} />
      <div>
        <Label>Address</Label>
        <div style={{ marginTop: 3, fontSize: 14, color: 'var(--sw-ink)', fontWeight: 500 }}>{data.address.singleLine}</div>
      </div>
      {data.quotes.length === 0 ? (
        <Alert tone="info">No Ethernet products were returned for this address.</Alert>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Product</th>
                <th className="num">Bearer / CIR</th>
                <th className="num">Monthly</th>
                <th className="num">Install</th>
                <th className="num">Lead time</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {data.quotes.map((quote) => (
                <tr key={quote.id}>
                  <td>
                    <strong style={{ color: 'var(--sw-ink)' }}>{quote.productName}</strong>
                    {quote.indicative && (
                      <div style={{ marginTop: 3 }}>
                        <Chip tone="warn">Indicative</Chip>
                      </div>
                    )}
                  </td>
                  <td className="num">
                    {quote.bearerMbps ?? '—'} / {quote.committedMbps ?? '—'}
                  </td>
                  <td className="num">{quote.monthlyCharge != null ? `£${quote.monthlyCharge.toLocaleString('en-GB')}` : '—'}</td>
                  <td className="num">
                    {quote.installCharge != null ? `£${quote.installCharge.toLocaleString('en-GB')}` : '—'}
                    {quote.excessConstruction ? (
                      <div style={{ color: 'var(--sw-amber-ink)', fontSize: 11 }}>
                        +£{quote.excessConstruction.toLocaleString('en-GB')} ECC
                      </div>
                    ) : null}
                  </td>
                  <td className="num">{quote.leadTimeDays != null ? `${quote.leadTimeDays} d` : '—'}</td>
                  <td style={{ maxWidth: 240, fontSize: 12 }}>
                    {quote.notes.length ? (
                      <ul style={{ margin: 0, paddingLeft: 15, lineHeight: 1.5 }}>
                        {quote.notes.map((n, i) => (
                          <li key={i}>{n}</li>
                        ))}
                      </ul>
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
    </>
  );
}

function FootfallResult({
  data,
}: {
  data: FootfallInsight & { outOfArea?: boolean; mode: 'live' | 'mock'; providerError?: string };
}): ReactElement {
  const peak = data.series.reduce((max, d) => (d.visitors > max ? d.visitors : max), 0);
  const total = data.series.reduce((sum, d) => sum + d.visitors, 0);

  return (
    <>
      <ModeBadge mode={data.mode} {...(data.providerError ? { providerError: data.providerError } : {})} />
      {data.outOfArea && (
        <div className="flag flag--warn">
          <span className="flag__marker" aria-hidden="true" />
          <span>
            <strong>Outside the covered area</strong>
            <span className="flag__detail">{data.coverageNote}</span>
          </span>
        </div>
      )}

      <div className="kv">
        <Cell label="Area" value={data.areaName} />
        <Cell label="Granularity" value={data.granularity} />
        <Cell label="Period" value={data.from && data.to ? `${data.from} to ${data.to}` : undefined} />
        <Cell label="Total visitors" value={total.toLocaleString('en-GB')} mono />
        <Cell label="Busiest day" value={peak.toLocaleString('en-GB')} mono />
      </div>

      {data.series.length > 0 && (
        <div>
          <Label>Visitors per day</Label>
          <div className="bars" style={{ marginTop: 8 }}>
            {data.series.map((d) => (
              <span
                key={d.date}
                className="bars__bar"
                style={{ height: `${Math.max(3, (d.visitors / peak) * 100)}%` }}
                title={`${d.date}: ${d.visitors.toLocaleString('en-GB')} visitors`}
              />
            ))}
          </div>
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 4 }}>
            <span className="muted" style={{ fontSize: 11 }}>{data.series[0]?.date}</span>
            <span className="muted" style={{ fontSize: 11 }}>{data.series[data.series.length - 1]?.date}</span>
          </div>
        </div>
      )}

      {data.catchment?.length ? (
        <div>
          <Label>Where visitors travel from</Label>
          <div className="table-wrap" style={{ marginTop: 6 }}>
            <table className="data">
              <tbody>
                {data.catchment.map((c) => (
                  <tr key={c.area}>
                    <td style={{ width: 160 }}>{c.area}</td>
                    <td>
                      <div className="pool-bar pool-bar--slim" style={{ maxWidth: 220 }}>
                        <span className="pool-bar__fill" style={{ width: `${Math.min(100, c.share * 100)}%` }} />
                      </div>
                    </td>
                    <td className="num" style={{ width: 70 }}>{Math.round(c.share * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </>
  );
}

function CdrResult({
  data,
}: {
  data: { records: CallRecord[]; from: string; to: string; mode: 'live' | 'mock'; providerError?: string };
}): ReactElement {
  const totalCost = data.records.reduce((sum, r) => sum + (r.costPounds ?? 0), 0);
  const totalSeconds = data.records.reduce((sum, r) => sum + (r.durationSeconds ?? 0), 0);

  return (
    <>
      <ModeBadge mode={data.mode} {...(data.providerError ? { providerError: data.providerError } : {})} />
      <div className="kv">
        <Cell label="Calls" value={data.records.length} mono />
        <Cell label="Total duration" value={formatDuration(totalSeconds)} />
        <Cell label="Total cost" value={`£${totalCost.toFixed(2)}`} mono />
        <Cell label="From" value={formatDateTime(data.from)} />
        <Cell label="To" value={formatDateTime(data.to)} />
      </div>
      {data.records.length === 0 ? (
        <Alert tone="info">No calls in this window.</Alert>
      ) : (
        <div className="table-wrap" style={{ maxHeight: 340 }}>
          <table className="data">
            <thead>
              <tr>
                <th>Started</th>
                <th>From</th>
                <th>To</th>
                <th className="num">Duration</th>
                <th>Classification</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {data.records.map((r) => (
                <tr key={r.id}>
                  <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{formatDateTime(r.startedAt)}</td>
                  <td className="sw-mono" style={{ fontSize: 12 }}>{r.sourceNumber ?? '—'}</td>
                  <td className="sw-mono" style={{ fontSize: 12 }}>{r.destinationNumber ?? '—'}</td>
                  <td className="num">{formatDuration(r.durationSeconds) ?? '—'}</td>
                  <td style={{ fontSize: 12 }}>
                    {r.classification ?? '—'}
                    {r.destinationDescription && (
                      <div className="muted" style={{ fontSize: 11 }}>{r.destinationDescription}</div>
                    )}
                  </td>
                  <td className="num">{r.costPounds != null ? `£${r.costPounds.toFixed(3)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function RdnsResult({
  data,
}: {
  data: { records: RdnsRecord[]; mode: 'live' | 'mock'; providerError?: string };
}): ReactElement {
  const missing = data.records.filter((r) => !r.hostname).length;

  return (
    <>
      <ModeBadge mode={data.mode} {...(data.providerError ? { providerError: data.providerError } : {})} />
      {missing > 0 && (
        <div className="flag flag--warn">
          <span className="flag__marker" aria-hidden="true" />
          <span>
            <strong>
              {missing} address{missing === 1 ? '' : 'es'} without a PTR record
            </strong>
            <span className="flag__detail">
              Mail servers on these addresses will fail reverse-DNS checks, which is a common cause of rejected email.
            </span>
          </span>
        </div>
      )}
      {data.records.length === 0 ? (
        <Alert tone="info">No reverse DNS records were returned.</Alert>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>IP address</th>
                <th>Hostname (PTR)</th>
                <th>Zen reference</th>
              </tr>
            </thead>
            <tbody>
              {data.records.map((r) => (
                <tr key={r.ipAddress}>
                  <td className="sw-mono">{r.ipAddress}</td>
                  <td className="sw-mono" style={{ fontSize: 12 }}>
                    {r.hostname ?? <Chip tone="warn">Not set</Chip>}
                  </td>
                  <td className="sw-mono" style={{ fontSize: 12 }}>{r.zenReference ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
