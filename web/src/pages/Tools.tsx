import { useState, type ReactElement, type ReactNode } from 'react';
import { formatPostcode, identify, normaliseCli } from '@sw/shared';
import type {
  AddressMatch,
  AddressRegistration,
  CallRecord,
  EstateUsageReport,
  EstateUsageRow,
  EthernetQuoteSet,
  FootfallInsight,
  ImeiLookup,
  NetworkConfiguration,
  NetworkConnectivityCheck,
  NumberPortCheck,
  RdnsRecord,
} from '@sw/shared';
import { ApiClientError, api } from '../lib/api';
import {
  Alert,
  Card,
  Cell,
  Chip,
  ExportButtons,
  Label,
  Spinner,
  formatBytes,
  formatDateTime,
  formatDuration,
} from '../components/ui';
import type { CsvColumn } from '../lib/csv';
import { Modal } from '../components/overlay';
import { BulkLookup } from '../components/BulkLookup';

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

/**
 * Splits "12 High Street, M1 1AE" into a premises and a postcode.
 *
 * The postcode is taken from the end because that is where it always is in a
 * written UK address, and everything before it is the premises. Returns null
 * when there is no recognisable postcode, which is what the validator uses.
 */
function addressQuery(
  value: string,
): { postcode: string; premiseName?: string; thoroughfareNumber?: string } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Try the whole thing as a postcode first — the common case is just that.
  if (identify(trimmed).kind === 'postcode') return { postcode: formatPostcode(trimmed) };

  const parts = trimmed.split(',').map((p) => p.trim()).filter(Boolean);
  const tail = parts[parts.length - 1];
  if (!tail || identify(tail).kind !== 'postcode') return null;

  const premises = parts.slice(0, -1).join(', ');
  // A leading number is the thoroughfare number; anything else is a name.
  const numbered = /^(\d+[A-Za-z]?)\s+(.*)$/.exec(premises);
  return {
    postcode: formatPostcode(tail),
    ...(numbered ? { thoroughfareNumber: numbered[1]!, premiseName: numbered[2]! } : premises ? { premiseName: premises } : {}),
  };
}

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
      id: 'address-match',
      name: 'Openreach / BT Wholesale address reference',
      description: 'Both wholesale references for one premises, and whether the two databases agree.',
      vendor: 'Zen',
      accent: 2,
      input: {
        label: 'Premises and postcode',
        placeholder: '12 High Street, M1 1AE',
        hint: 'Postcode alone works. Put the building first if you have it — the postcode is read from the end.',
      },
      validate: (value) => (addressQuery(value) ? null : 'Include a full UK postcode, e.g. 12 High Street, M1 1AE.'),
      run: async (value) => {
        const query = addressQuery(value)!;
        return <AddressMatchResult data={await api.addressMatch(query)} query={query} />;
      },
    },
    {
      id: 'network-config',
      name: 'Realms and IP configuration',
      description: 'The service selection names on offer, and how one service is actually configured.',
      vendor: 'Zen',
      accent: 4,
      input: {
        label: 'Zen reference (optional)',
        placeholder: 'ZEN1234567',
        hint: 'Leave blank for the catalogue of options. This is the answer to “why will this line not authenticate”.',
      },
      run: async (value) => <NetworkConfigResult data={await api.networkConfig(value.trim() || undefined)} />,
    },
    {
      id: 'estate-usage',
      name: 'Usage across the base',
      description: 'Every service’s data use for a month, heaviest first, with over-allowance flagged.',
      vendor: 'Zen',
      accent: 1,
      input: {
        label: 'Month (optional)',
        placeholder: '2026-09',
        hint: 'Leave blank for the current month.',
      },
      validate: (value) => (!value.trim() || /^\d{4}-\d{2}$/.test(value.trim()) ? null : 'A month looks like 2026-09.'),
      run: async (value) => <EstateUsageResult data={await api.estateUsage(value.trim() || undefined)} />,
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
          Bulk lookup below takes a whole list at once. The rest are lookups that are not about a single
          site — anything site-specific lives under Lookup instead.
        </p>
      </Card>

      <BulkLookup />

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
function ModeBadge({ mode, providerError }: { mode: 'live'; providerError?: string }): ReactElement {
  return (
    <div className="row" style={{ gap: 8 }}>
      <Chip tone="ok" dot>Live result</Chip>
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

function PortResult({ data }: { data: NumberPortCheck & { mode: 'live'; providerError?: string } }): ReactElement {
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
  data: NetworkConnectivityCheck & { mode: 'live'; providerError?: string };
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

function ImeiResult({ data }: { data: ImeiLookup & { mode: 'live'; providerError?: string } }): ReactElement {
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

function EthernetResult({ data }: { data: EthernetQuoteSet & { mode: 'live'; providerError?: string } }): ReactElement {
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
  data: FootfallInsight & { outOfArea?: boolean; mode: 'live'; providerError?: string };
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

/**
 * Call records are the export people actually ask for — a bill query means
 * reconciling a month of calls against an invoice, which is spreadsheet work.
 * Cost stays in pounds at full precision rather than being rounded for
 * display, because the rounding is what the argument is usually about.
 */
const CDR_COLUMNS: Array<CsvColumn<CallRecord>> = [
  { header: 'Started', value: (r) => r.startedAt },
  { header: 'From', value: (r) => r.sourceNumber },
  { header: 'Presented', value: (r) => r.presentationNumber },
  { header: 'To', value: (r) => r.destinationNumber },
  { header: 'Duration (seconds)', value: (r) => r.durationSeconds },
  { header: 'Classification', value: (r) => r.classification },
  { header: 'Destination', value: (r) => r.destinationDescription },
  { header: 'Dial code', value: (r) => r.dialCode },
  { header: 'Cost (GBP)', value: (r) => r.costPounds },
];

function CdrResult({
  data,
}: {
  data: { records: CallRecord[]; from: string; to: string; mode: 'live'; providerError?: string };
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
        <>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
            <ExportButtons
              rows={data.records}
              columns={CDR_COLUMNS}
              filenamePrefix="call-records"
              label="these call records"
            />
          </div>
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
        </>
      )}
    </>
  );
}

function RdnsResult({
  data,
}: {
  data: { records: RdnsRecord[]; mode: 'live'; providerError?: string };
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

/* ------------------------------------------------------------------ *
 * Address references
 * ------------------------------------------------------------------ */

/**
 * The two wholesale references, and the registration form when neither
 * database knows the premises.
 *
 * This is the one tool that can write, so the form is deliberately a second
 * step rather than something that submits from the same button as the search.
 */
function AddressMatchResult({
  data,
  query,
}: {
  data: AddressMatch & { mode: 'live'; providerError?: string };
  query: { postcode: string; premiseName?: string; thoroughfareNumber?: string };
}): ReactElement {
  const [registering, setRegistering] = useState(false);
  const [registration, setRegistration] = useState<AddressRegistration | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState({
    buildingNumber: query.thoroughfareNumber ?? '',
    buildingName: '',
    thoroughfare: query.premiseName ?? '',
    postTown: '',
    county: '',
  });

  const found = Boolean(data.btoAddressReference || data.btwAddressReference);
  const disagrees = Boolean(data.btoAddressReference && data.btwAddressReference && data.messages.length > 0);

  const submit = async () => {
    setBusy(true);
    setFormError(null);
    try {
      const result = await api.registerAddress({
        postcode: query.postcode,
        ...(form.buildingName.trim() ? { buildingName: form.buildingName.trim() } : {}),
        ...(form.buildingNumber.trim() ? { buildingNumber: form.buildingNumber.trim() } : {}),
        thoroughfare: form.thoroughfare.trim(),
        postTown: form.postTown.trim(),
        ...(form.county.trim() ? { county: form.county.trim() } : {}),
      });
      setRegistration(result);
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : 'The address could not be registered.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ModeBadge mode={data.mode} {...(data.providerError ? { providerError: data.providerError } : {})} />

      <div className={found ? (disagrees ? 'flag flag--warn' : 'flag flag--ok') : 'flag flag--critical'}>
        <span className="flag__marker" aria-hidden="true" />
        <span>
          <strong>
            {!found
              ? 'Neither database knows this premises'
              : disagrees
                ? 'The two databases disagree'
                : 'Both references found'}
          </strong>
          <span className="flag__detail">
            {!found
              ? 'A provide will be rejected until the premises is registered with Openreach.'
              : disagrees
                ? data.messages[0]
                : 'Order against the Openreach reference.'}
          </span>
        </span>
      </div>

      <div className="kv">
        <Cell label="Searched postcode" value={data.query.postcode} mono />
        <Cell label="Premises" value={data.query.premiseName} />
        <Cell label="Number" value={data.query.thoroughfareNumber} mono />
        <Cell label="Openreach reference" value={data.btoAddressReference} mono copy />
        <Cell label="BT Wholesale reference" value={data.btwAddressReference} mono copy />
        <Cell label="District code" value={data.districtCode} mono />
        <Cell label="UPRN" value={data.uprn} mono copy />
      </div>

      {data.messages.length > 1 && (
        <ul style={{ margin: '4px 0 0', paddingLeft: 17, fontSize: 13, lineHeight: 1.65 }}>
          {data.messages.slice(1).map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      )}

      {registration ? (
        <div className={registration.created ? 'flag flag--ok' : 'flag flag--warn'}>
          <span className="flag__marker" aria-hidden="true" />
          <span>
            <strong>{registration.created ? `Registered as ${registration.addressReference}` : 'Nothing was registered'}</strong>
            <span className="flag__detail">
              {registration.messages.join(' ')}
              {registration.technologyRestrictions.length > 0 && (
                <>
                  {' '}
                  Restrictions:{' '}
                  {registration.technologyRestrictions
                    .map((r) => `${r.technology}${r.reason ? ` (${r.reason})` : ''}`)
                    .join(', ')}
                  .
                </>
              )}
            </span>
          </span>
        </div>
      ) : registering ? (
        <div
          style={{
            border: '1px solid var(--sw-hairline)',
            borderRadius: 4,
            background: 'var(--sw-panel)',
            padding: 16,
            marginTop: 10,
          }}
        >
          <Label>Register this premises with Openreach</Label>
          <p className="muted" style={{ fontSize: 12, margin: '4px 0 12px' }}>
            This writes to the national address database. Get it right first time — a duplicate or wrong entry is
            somebody else&rsquo;s support call later.
          </p>
          {formError && <Alert tone="error">{formError}</Alert>}
          <div className="two-col">
            <label className="field">
              <Label>Building number</Label>
              <input
                className="field__input"
                value={form.buildingNumber}
                onChange={(e) => setForm({ ...form, buildingNumber: e.target.value })}
                placeholder="12"
              />
            </label>
            <label className="field">
              <Label>Building name</Label>
              <input
                className="field__input"
                value={form.buildingName}
                onChange={(e) => setForm({ ...form, buildingName: e.target.value })}
                placeholder="Rose Cottage"
              />
            </label>
            <label className="field">
              <Label>Street</Label>
              <input
                className="field__input"
                value={form.thoroughfare}
                onChange={(e) => setForm({ ...form, thoroughfare: e.target.value })}
                placeholder="High Street"
              />
            </label>
            <label className="field">
              <Label>Post town</Label>
              <input
                className="field__input"
                value={form.postTown}
                onChange={(e) => setForm({ ...form, postTown: e.target.value })}
                placeholder="Manchester"
              />
            </label>
            <label className="field">
              <Label>County (optional)</Label>
              <input
                className="field__input"
                value={form.county}
                onChange={(e) => setForm({ ...form, county: e.target.value })}
              />
            </label>
            <label className="field">
              <Label>Postcode</Label>
              <input className="field__input" value={query.postcode} readOnly disabled />
            </label>
          </div>
          <div className="row" style={{ gap: 8, marginTop: 6 }}>
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || !form.thoroughfare.trim() || !form.postTown.trim() || !(form.buildingName.trim() || form.buildingNumber.trim())}
              onClick={() => void submit()}
            >
              {busy ? 'Registering…' : 'Register with Openreach'}
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setRegistering(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        !found && (
          <button type="button" className="btn btn--primary btn--small" onClick={() => setRegistering(true)}>
            Register this premises
          </button>
        )
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Network configuration
 * ------------------------------------------------------------------ */

function NetworkConfigResult({
  data,
}: {
  data: NetworkConfiguration & { mode: 'live'; providerError?: string };
}): ReactElement {
  return (
    <>
      <ModeBadge mode={data.mode} {...(data.providerError ? { providerError: data.providerError } : {})} />

      {data.details.length > 0 && (
        <div>
          <Label>How {data.zenReference} is configured</Label>
          <div className="kv" style={{ marginTop: 5 }}>
            {data.details.map((d) => (
              <Cell key={d.label} label={d.label} value={d.value} mono copy />
            ))}
          </div>
        </div>
      )}

      <div>
        <Label>Service selection names available</Label>
        {data.serviceSelectionNames.length === 0 ? (
          <Alert tone="info">The provider returned no options for this account.</Alert>
        ) : (
          <div className="table-wrap" style={{ marginTop: 5 }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Realm</th>
                  <th>IP</th>
                  <th>Static block</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {data.serviceSelectionNames.map((o) => (
                  <tr key={o.name}>
                    <td className="sw-mono">
                      {o.name}
                      {o.default && (
                        <span style={{ marginLeft: 6 }}>
                          <Chip tone="idle" title="Applied when nothing else is chosen">
                            default
                          </Chip>
                        </span>
                      )}
                    </td>
                    <td className="sw-mono" style={{ fontSize: 12 }}>{o.realm ?? '—'}</td>
                    <td style={{ fontSize: 12 }}>{o.ipVersion ?? '—'}</td>
                    <td className="sw-mono" style={{ fontSize: 12 }}>{o.staticBlock ?? '—'}</td>
                    <td style={{ fontSize: 12 }}>{o.description ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Estate-wide usage
 * ------------------------------------------------------------------ */

const ESTATE_COLUMNS: Array<CsvColumn<EstateUsageRow>> = [
  { header: 'Zen reference', value: (r) => r.zenReference },
  { header: 'Service ID', value: (r) => r.serviceId },
  { header: 'CLI', value: (r) => r.cli },
  { header: 'Address', value: (r) => r.address },
  { header: 'Download (bytes)', value: (r) => r.downloadBytes },
  { header: 'Upload (bytes)', value: (r) => r.uploadBytes },
  { header: 'Total (bytes)', value: (r) => r.totalBytes },
  { header: 'Over allowance', value: (r) => r.overAllowance },
];

function EstateUsageResult({
  data,
}: {
  data: EstateUsageReport & { mode: 'live'; providerError?: string };
}): ReactElement {
  const over = data.rows.filter((r) => r.overAllowance).length;

  return (
    <>
      <ModeBadge mode={data.mode} {...(data.providerError ? { providerError: data.providerError } : {})} />
      <div className="kv">
        <Cell label="Period" value={data.period} mono />
        <Cell label="Services" value={data.rows.length} mono />
        <Cell label="Total transferred" value={formatBytes(data.totalBytes)} mono />
        <Cell label="Over allowance" value={over} mono />
      </div>

      {data.rows.length === 0 ? (
        <Alert tone="info">No usage was reported for {data.period}.</Alert>
      ) : (
        <>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span className="muted" style={{ fontSize: 11.5 }}>Heaviest first.</span>
            <ExportButtons
              rows={data.rows}
              columns={ESTATE_COLUMNS}
              filenamePrefix={`usage-${data.period}`}
              label="this usage report"
            />
          </div>
          <div className="table-wrap" style={{ maxHeight: 340 }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Service</th>
                  <th>Address</th>
                  <th className="num">Down</th>
                  <th className="num">Up</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.zenReference}>
                    <td className="sw-mono" style={{ fontSize: 12 }}>
                      {r.zenReference}
                      {r.overAllowance && (
                        <span style={{ marginLeft: 6 }}>
                          <Chip tone="warn" title="The provider flags this service as over its allowance">
                            Over
                          </Chip>
                        </span>
                      )}
                      {r.cli && <div className="muted" style={{ fontSize: 11 }}>{r.cli}</div>}
                    </td>
                    <td style={{ fontSize: 12, maxWidth: 220 }}>{r.address ?? '—'}</td>
                    <td className="num">{formatBytes(r.downloadBytes) ?? '—'}</td>
                    <td className="num">{formatBytes(r.uploadBytes) ?? '—'}</td>
                    <td className="num">{formatBytes(r.totalBytes) ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
