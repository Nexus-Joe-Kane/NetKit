import { useState, type ReactElement } from 'react';
import type { LineRecord, LineStatus, LineTestResult } from '@sw/shared';
import { Card, Cell, Chip, CopyButton, Label, formatBytes, formatDateTime, formatDate, formatDuration, type ChipTone } from './ui';
import { Tabs, TabPanel, type TabDef } from './Tabs';
import { Modal } from './overlay';
import { ExternalHandover } from './ExternalHandover';
import { LineDiagnostics, LineHistory, LineStability, LineUsage } from './LineDiagnostics';

/**
 * Lines at a premises.
 *
 * Several lines become tabs across the top; the detail of one line becomes
 * tabs within it. Nothing is more than two clicks from the search box, and
 * nothing needs scrolling past to reach.
 */

const TONE_BY_STATUS: Record<LineStatus, ChipTone> = {
  active: 'ok',
  pending_provide: 'info',
  pending_cease: 'warn',
  pending_modify: 'info',
  suspended: 'warn',
  ceased: 'crit',
  unknown: 'idle',
};

const STATUS_LABEL: Record<LineStatus, string> = {
  active: 'Active',
  pending_provide: 'Pending provide',
  pending_cease: 'Pending cease',
  pending_modify: 'Pending modify',
  suspended: 'Suspended',
  ceased: 'Ceased',
  unknown: 'Unknown',
};

function kbpsLabel(kbps?: number): string | undefined {
  if (kbps == null) return undefined;
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(kbps % 1000 === 0 ? 0 : 1)} Mbps` : `${kbps} kbps`;
}

const lineTitle = (line: LineRecord): string =>
  line.cli ?? line.serviceId ?? line.lineAccessId ?? line.orderRef ?? 'Line';

/* ------------------------------------------------------------------ *
 * One line
 * ------------------------------------------------------------------ */

type LineTab =
  | 'identity'
  | 'sync'
  | 'session'
  | 'ip'
  | 'equipment'
  | 'contract'
  | 'faults'
  | 'diagnostics'
  | 'stability'
  | 'usage'
  | 'history';

function LineDetail({ line, latestTest }: { line: LineRecord; latestTest?: LineTestResult }): ReactElement {
  const [tab, setTab] = useState<LineTab>('identity');
  const [raw, setRaw] = useState(false);
  const [handover, setHandover] = useState(false);

  const faultCount = (line.faults?.length ?? 0) + (line.appointments?.length ?? 0);

  const tabs: Array<TabDef<LineTab>> = [
    { id: 'identity', label: 'Identity' },
    { id: 'sync', label: 'Sync', disabled: !line.sync },
    { id: 'session', label: 'Session', disabled: !line.radius },
    { id: 'ip', label: 'IP', count: line.ipAddresses?.length, disabled: !line.ipAddresses?.length },
    { id: 'equipment', label: 'Equipment', disabled: !line.ont && !line.cpe },
    { id: 'contract', label: 'Contract', disabled: !line.contract },
    {
      id: 'faults',
      label: 'Faults & visits',
      count: faultCount,
      ...(line.faults?.length ? { tone: 'crit' as const } : {}),
    },
    { id: 'diagnostics', label: 'Test the line' },
    { id: 'stability', label: 'Stability' },
    { id: 'usage', label: 'Usage' },
    { id: 'history', label: 'What changed' },
  ];

  return (
    <>
      <Card
        title={lineTitle(line)}
        eyebrow={`${line.provider} · ${line.technology}`}
        index="04"
        accent={line.status === 'active' ? 1 : line.status === 'ceased' ? 3 : 2}
        meta={
          <>
            {line.radius?.online != null && (
              <Chip tone={line.radius.online ? 'ok' : 'crit'} dot>
                {line.radius.online ? 'Online' : 'Offline'}
              </Chip>
            )}
            <Chip tone={TONE_BY_STATUS[line.status]} dot>
              {STATUS_LABEL[line.status]}
            </Chip>
            {/* Everything about this line, for when the next step is on
                somebody else's website. */}
            <button
              type="button"
              className="btn btn--ghost btn--small"
              onClick={() => setHandover(true)}
              title="Every identifier, the state of the line, the last test and the site contact — with a copy button on each"
            >
              Take the details with me
            </button>
            <button type="button" className="btn btn--ghost btn--small" onClick={() => setRaw(true)}>
              Raw record
            </button>
          </>
        }
        tabs={<Tabs tabs={tabs} active={tab} onChange={setTab} variant="sub" label={`${lineTitle(line)} sections`} />}
      >
        <TabPanel>
          {tab === 'identity' && (
            <div className="stack stack--tight">
              <div className="kv">
                <Cell label="CLI" value={line.cli} mono copy />
                <Cell label="Access line ID" value={line.lineAccessId} mono copy />
                <Cell label="Service ID" value={line.serviceId} mono copy />
                <Cell label="Order / Zen ref" value={line.orderRef} mono copy />
                <Cell label="Product" value={line.productName} />
                <Cell label="Technology" value={line.technology} />
                <Cell label="Bearer" value={line.bearerSpeed} />
                <Cell label="Found via" value={line.discoveredVia} />
              </div>
              {line.notes.length > 0 && (
                <div>
                  <Label>Notes</Label>
                  <ul style={{ margin: '5px 0 0', paddingLeft: 17, fontSize: 13, lineHeight: 1.6 }}>
                    {line.notes.map((note, i) => (
                      <li key={i}>{note}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {tab === 'sync' && line.sync && (
            <div className="kv">
              <Cell label="Downstream sync" value={kbpsLabel(line.sync.downstreamSyncKbps)} mono />
              <Cell label="Upstream sync" value={kbpsLabel(line.sync.upstreamSyncKbps)} mono />
              <Cell label="Max stable down" value={kbpsLabel(line.sync.maxStableDownKbps)} mono />
              <Cell label="Max stable up" value={kbpsLabel(line.sync.maxStableUpKbps)} mono />
              <Cell label="SNR margin" value={line.sync.snrMarginDb != null ? `${line.sync.snrMarginDb} dB` : undefined} mono />
              <Cell label="Attenuation" value={line.sync.attenuationDb != null ? `${line.sync.attenuationDb} dB` : undefined} mono />
              <Cell label="DLM profile" value={line.sync.profileName} />
              <Cell label="Interleaving" value={line.sync.interleaving} />
              <Cell label="Retrains (24h)" value={line.sync.retrains24h} mono />
              <Cell label="Last resync" value={formatDateTime(line.sync.lastResync)} />
              <Cell label="Uptime" value={formatDuration(line.sync.uptimeSeconds)} />
            </div>
          )}

          {tab === 'session' && line.radius && (
            <div className="kv">
              <Cell label="RADIUS username" value={line.radius.username} mono copy />
              <Cell label="Realm" value={line.radius.realm} />
              <Cell label="Online" value={line.radius.online} />
              <Cell label="Last authentication" value={formatDateTime(line.radius.lastAuthAt)} />
              <Cell label="Online since" value={formatDateTime(line.radius.onlineSince)} />
              <Cell label="NAS / gateway" value={line.radius.nasIpAddress} mono />
              <Cell label="Session ID" value={line.radius.sessionId} mono />
              <Cell label="Data in" value={formatBytes(line.radius.bytesIn)} mono />
              <Cell label="Data out" value={formatBytes(line.radius.bytesOut)} mono />
            </div>
          )}

          {tab === 'ip' && line.ipAddresses?.length ? (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Address</th>
                    <th>Family</th>
                    <th>Assignment</th>
                    <th>Routed</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {line.ipAddresses.map((ip, i) => (
                    <tr key={i}>
                      <td className="sw-mono">
                        {ip.value}
                        {ip.prefixLength != null ? `/${ip.prefixLength}` : ''}
                      </td>
                      <td>{ip.family}</td>
                      <td>{ip.assignment}</td>
                      <td>{ip.routed ? 'Yes' : 'No'}</td>
                      <td style={{ textAlign: 'right' }}>
                        <CopyButton value={`${ip.value}${ip.prefixLength != null ? `/${ip.prefixLength}` : ''}`} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {tab === 'equipment' && (
            <div className="kv">
              <Cell label="ONT serial" value={line.ont?.serial} mono copy />
              <Cell label="ONT model" value={line.ont?.model} />
              <Cell
                label="ONT ports"
                value={line.ont?.portsTotal != null ? `${line.ont.portsUsed ?? 0} of ${line.ont.portsTotal} used` : undefined}
              />
              <Cell label="Router" value={line.cpe ? `${line.cpe.vendor ?? ''} ${line.cpe.model ?? ''}`.trim() : undefined} />
              <Cell label="Router serial" value={line.cpe?.serial} mono copy />
              <Cell label="MAC address" value={line.cpe?.macAddress} mono copy />
              <Cell label="Firmware" value={line.cpe?.firmware} mono />
            </div>
          )}

          {tab === 'contract' && line.contract && (
            <div className="kv">
              <Cell label="Start" value={formatDate(line.contract.startDate)} />
              <Cell label="End" value={formatDate(line.contract.endDate)} />
              <Cell
                label="Minimum term"
                value={line.contract.minimumTermMonths ? `${line.contract.minimumTermMonths} months` : undefined}
              />
              <Cell label="In contract" value={line.contract.inContract} />
              <Cell
                label="Early termination"
                value={
                  line.contract.earlyTerminationCharge != null
                    ? `£${line.contract.earlyTerminationCharge.toLocaleString('en-GB')}`
                    : undefined
                }
              />
            </div>
          )}

          {tab === 'diagnostics' && <LineDiagnostics line={line} />}
          {tab === 'stability' && <LineStability line={line} />}
          {tab === 'usage' && <LineUsage line={line} />}
          {tab === 'history' && <LineHistory line={line} />}

          {tab === 'faults' &&
            (faultCount === 0 ? (
              <div className="empty">
                <h3>Nothing open</h3>
                <p>No faults are raised against this line and no engineer visits are booked.</p>
              </div>
            ) : (
              <div className="stack stack--tight">
                {line.faults?.map((fault) => (
                  <div key={fault.reference} className="flag flag--critical">
                    <span className="flag__marker" aria-hidden="true" />
                    <span>
                      <strong>
                        {fault.reference} — {fault.status}
                      </strong>
                      <span className="flag__detail">
                        {fault.summary}
                        <br />
                        Raised {formatDateTime(fault.raisedAt)}
                        {fault.slaTarget ? ` · ${fault.slaTarget}` : ''}
                        {fault.lastUpdate ? ` · updated ${formatDateTime(fault.lastUpdate)}` : ''}
                      </span>
                    </span>
                  </div>
                ))}
                {line.appointments?.map((appt) => (
                  <div key={appt.reference} className="flag flag--info">
                    <span className="flag__marker" aria-hidden="true" />
                    <span>
                      <strong>
                        {appt.type} — {formatDate(appt.date)}
                        {appt.slot ? `, ${appt.slot}` : ''}
                      </strong>
                      <span className="flag__detail">
                        {appt.reference} · {appt.status}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            ))}
        </TabPanel>
      </Card>

      <ExternalHandover
        line={line}
        {...(latestTest ? { latestTest } : {})}
        open={handover}
        onClose={() => setHandover(false)}
        destination="a supplier's portal"
      />

      <Modal
        open={raw}
        onClose={() => setRaw(false)}
        eyebrow="Diagnostics"
        title={`Raw record — ${lineTitle(line)}`}
        subtitle="Exactly what the provider returned, after normalisation. Useful when a field looks wrong."
        width="wide"
        footer={
          <>
            <span className="grow" />
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void navigator.clipboard?.writeText(JSON.stringify(line, null, 2))}
            >
              Copy JSON
            </button>
            <button type="button" className="btn btn--primary" onClick={() => setRaw(false)}>
              Close
            </button>
          </>
        }
      >
        <pre className="raw">{JSON.stringify(line, null, 2)}</pre>
      </Modal>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * All the lines at a premises
 * ------------------------------------------------------------------ */

export function LinesPanel({
  lines,
  nearbyLines = [],
}: {
  lines: LineRecord[];
  /**
   * Lines at this postcode that could not be tied to this premises.
   *
   * Shown because "no lines found" was wrong often enough to matter: a
   * supplier recording the address differently from AddressBase meant a real
   * circuit was dropped and the panel said the site had nothing. Listed
   * apart from the matched lines, and labelled, so nobody reads one as a
   * line at this address.
   */
  nearbyLines?: LineRecord[];
}): ReactElement {
  const [active, setActive] = useState(0);

  if (!lines.length) {
    return (
      <Card title="Lines at this premises" eyebrow="Services" index="04" accent={1}>
        <div className="empty">
          <h3>No lines found</h3>
          <p>
            Nothing is recorded against this premises in any connected provider. That usually means the site is served
            by another provider, or has never had a fixed line. Availability under Broadband still applies.
          </p>
        </div>
        {nearbyLines.length > 0 && <NearbyLines lines={nearbyLines} />}
      </Card>
    );
  }

  // A single line needs no chooser.
  if (lines.length === 1) return <LineDetail line={lines[0]!} />;

  const tabs: Array<TabDef<string>> = lines.map((line, i) => ({
    id: String(i),
    label: lineTitle(line),
    ...(line.faults?.length ? { tone: 'crit' as const } : {}),
  }));

  return (
    <div className="stack">
      <Tabs
        tabs={tabs}
        active={String(active)}
        onChange={(id) => setActive(Number(id))}
        variant="primary"
        label="Lines at this premises"
      />
      <LineDetail key={lines[active]!.id} line={lines[active]!} />
    </div>
  );
}

/**
 * Lines at the postcode that did not match this premises.
 *
 * Deliberately plain: a table, a caption saying what it is, and the address
 * the supplier gave for each so the discrepancy is visible. If one of these
 * is the customer, the address on the row is what to correct with the
 * supplier.
 */
function NearbyLines({ lines }: { lines: LineRecord[] }): ReactElement {
  return (
    <div style={{ padding: '0 18px 18px' }}>
      <div className="flag flag--warn">
        <span className="flag__marker" aria-hidden="true" />
        <span>
          <strong>
            {lines.length === 1
              ? '1 line at this postcode could not be matched to this premises'
              : `${lines.length} lines at this postcode could not be matched to this premises`}
          </strong>
          <span className="flag__detail">
            Usually a neighbour. Occasionally it is this customer, recorded by the supplier under a different
            address — compare the addresses below.
          </span>
        </span>
      </div>

      <div className="table-wrap" style={{ marginTop: 12 }}>
        <table className="data">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Service</th>
              <th>CLI</th>
              <th>Address the supplier holds</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.serviceId ?? line.lineAccessId ?? line.cli ?? line.id}>
                <td style={{ fontSize: 12.5 }}>{line.provider}</td>
                <td className="sw-mono" style={{ fontSize: 12 }}>
                  {line.serviceId ?? line.lineAccessId ?? '—'}
                </td>
                <td className="sw-mono" style={{ fontSize: 12 }}>{line.cli ?? '—'}</td>
                <td style={{ fontSize: 12 }}>{line.address.singleLine || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
