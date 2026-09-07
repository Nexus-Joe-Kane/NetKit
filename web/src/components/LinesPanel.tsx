import type { ReactElement } from 'react';
import type { LineRecord, LineStatus } from '@sw/shared';
import { Card, Cell, Chip, CopyButton, Label, formatBytes, formatDateTime, formatDate, formatDuration, type ChipTone } from './ui';

/**
 * Lines at a premises.
 *
 * A line is the thing support is usually actually asked about, so everything
 * that identifies it — CLI, access line ID, service ID, ONT serial — is
 * shown together and individually copyable.
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

function LineCard({ line }: { line: LineRecord }): ReactElement {
  const sync = line.sync;
  const radius = line.radius;

  return (
    <Card
      title={line.cli ?? line.serviceId ?? line.lineAccessId ?? 'Line'}
      eyebrow={`${line.provider} · ${line.technology}`}
      accent={line.status === 'active' ? 1 : line.status === 'ceased' ? 3 : 2}
      meta={
        <>
          {radius?.online != null && (
            <Chip tone={radius.online ? 'ok' : 'crit'} dot>
              {radius.online ? 'Online' : 'Offline'}
            </Chip>
          )}
          <Chip tone={TONE_BY_STATUS[line.status]} dot>
            {STATUS_LABEL[line.status]}
          </Chip>
        </>
      }
    >
      <div className="stack stack--tight">
        <div className="kv">
          <Cell label="CLI" value={line.cli} mono copy />
          <Cell label="Access line ID" value={line.lineAccessId} mono copy />
          <Cell label="Service ID" value={line.serviceId} mono copy />
          <Cell label="Order / Zen ref" value={line.orderRef} mono copy />
          <Cell label="Product" value={line.productName} />
          <Cell label="Technology" value={line.technology} />
          <Cell label="Bearer" value={line.bearerSpeed} />
          <Cell label="Found via" value={line.discoveredVia === 'mock' ? 'Demo data' : line.discoveredVia} />
        </div>

        {(sync?.downstreamSyncKbps != null || sync?.snrMarginDb != null) && (
          <div>
            <Label>Sync and line quality</Label>
            <div className="kv" style={{ marginTop: 5 }}>
              <Cell label="Downstream sync" value={kbpsLabel(sync?.downstreamSyncKbps)} mono />
              <Cell label="Upstream sync" value={kbpsLabel(sync?.upstreamSyncKbps)} mono />
              <Cell label="Max stable down" value={kbpsLabel(sync?.maxStableDownKbps)} mono />
              <Cell label="Max stable up" value={kbpsLabel(sync?.maxStableUpKbps)} mono />
              <Cell label="SNR margin" value={sync?.snrMarginDb != null ? `${sync.snrMarginDb} dB` : undefined} mono />
              <Cell label="Attenuation" value={sync?.attenuationDb != null ? `${sync.attenuationDb} dB` : undefined} mono />
              <Cell label="DLM profile" value={sync?.profileName} />
              <Cell label="Interleaving" value={sync?.interleaving} />
              <Cell label="Retrains (24h)" value={sync?.retrains24h} mono />
              <Cell label="Last resync" value={formatDateTime(sync?.lastResync)} />
              <Cell label="Uptime" value={formatDuration(sync?.uptimeSeconds)} />
            </div>
          </div>
        )}

        {radius && (
          <div>
            <Label>Authentication and session</Label>
            <div className="kv" style={{ marginTop: 5 }}>
              <Cell label="RADIUS username" value={radius.username} mono copy />
              <Cell label="Last authentication" value={formatDateTime(radius.lastAuthAt)} />
              <Cell label="Online since" value={formatDateTime(radius.onlineSince)} />
              <Cell label="NAS / gateway" value={radius.nasIpAddress} mono />
              <Cell label="Session ID" value={radius.sessionId} mono />
              <Cell label="Data in" value={formatBytes(radius.bytesIn)} mono />
              <Cell label="Data out" value={formatBytes(radius.bytesOut)} mono />
            </div>
          </div>
        )}

        {line.ipAddresses?.length ? (
          <div>
            <Label>IP addressing</Label>
            <div className="table-wrap" style={{ marginTop: 5 }}>
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
          </div>
        ) : null}

        {(line.ont || line.cpe) && (
          <div>
            <Label>Equipment</Label>
            <div className="kv" style={{ marginTop: 5 }}>
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
          </div>
        )}

        {line.contract && (
          <div>
            <Label>Contract</Label>
            <div className="kv" style={{ marginTop: 5 }}>
              <Cell label="Start" value={formatDate(line.contract.startDate)} />
              <Cell label="End" value={formatDate(line.contract.endDate)} />
              <Cell label="Minimum term" value={line.contract.minimumTermMonths ? `${line.contract.minimumTermMonths} months` : undefined} />
              <Cell label="In contract" value={line.contract.inContract} />
              <Cell
                label="Early termination"
                value={line.contract.earlyTerminationCharge != null ? `£${line.contract.earlyTerminationCharge.toLocaleString('en-GB')}` : undefined}
              />
            </div>
          </div>
        )}

        {line.faults?.length ? (
          <div>
            <Label>Open faults</Label>
            {line.faults.map((fault) => (
              <div key={fault.reference} className="flag flag--critical" style={{ marginTop: 6 }}>
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
          </div>
        ) : null}

        {line.appointments?.length ? (
          <div>
            <Label>Appointments</Label>
            {line.appointments.map((appt) => (
              <div key={appt.reference} className="flag flag--info" style={{ marginTop: 6 }}>
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
        ) : null}

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
    </Card>
  );
}

export function LinesPanel({ lines }: { lines: LineRecord[] }): ReactElement {
  if (!lines.length) {
    return (
      <Card title="Lines at this premises" accent={1}>
        <div className="empty">
          <h3>No lines found</h3>
          <p>
            Nothing is recorded against this premises in any connected provider. That usually means the site is served
            by another provider, or has never had a fixed line. Availability under Broadband still applies.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <div className="stack">
      {lines.map((line) => (
        <LineCard key={line.id} line={line} />
      ))}
    </div>
  );
}
