import type { ReactElement } from 'react';
import {
  formatPence,
  rollupByClient,
  simUsedPercent,
  type SimEstate,
  type SimRecord,
  type SimReportSection,
} from '@sw/shared';
import { formatBytes, formatDateTime } from './ui';

/**
 * The mobile estate, on paper.
 *
 * Print-only and section by section, the same as the site report: the tabs on
 * screen mount one panel at a time, so printing the screen would capture
 * whichever group happened to be open. This is the whole thing, built from
 * the ticks in the dialog, on brand.
 *
 * Everything here reads from the estate already in hand. No section triggers
 * a provider call — a report is a view of what has been fetched, not a reason
 * to hammer Jola for two hundred usage figures.
 */

const percentClass = (pct?: number): string =>
  pct == null ? '' : pct > 100 ? ' print-over' : pct >= 90 ? ' print-warn' : '';

/** Used against allowance and the percentage, in one cell. */
function usage(sim: SimRecord): string {
  if (sim.usedBytes == null) return '—';
  const allowance = sim.allowanceBytes == null ? undefined : sim.allowanceBytes + (sim.boltOnBytes ?? 0);
  const used = formatBytes(sim.usedBytes) ?? '0 B';
  if (allowance == null) return used;
  return `${used} / ${formatBytes(allowance)} · ${simUsedPercent(sim) ?? 0}%`;
}

const stateLabel = (sim: SimRecord): string => {
  const bars = sim.bars?.length ? ` · ${sim.bars.length === 1 ? sim.bars[0] : `${sim.bars.length} bars`}` : '';
  return `${sim.state}${bars}`;
};

const onlineLabel = (sim: SimRecord): string =>
  sim.attached === true ? 'Online' : sim.attached === false ? 'Offline' : 'Unknown';

export function SimEstateReport({
  estate,
  sections,
  title,
  subtitle,
}: {
  estate: SimEstate;
  sections: Set<SimReportSection>;
  /** What the report is called, so it can be a client's name. */
  title: string;
  subtitle?: string;
}): ReactElement {
  const on = (id: SimReportSection): boolean => sections.has(id);
  const sims = estate.sims;

  const active = sims.filter((s) => s.state === 'active');
  const offline = sims.filter((s) => s.attached === false && s.state === 'active');
  const overage = sims.filter((s) => (simUsedPercent(s) ?? 0) >= 90);
  const barred = sims.filter((s) => (s.bars?.length ?? 0) > 0 && s.state !== 'ceased');
  const suspended = sims.filter((s) => s.state === 'suspended' || s.state === 'ceased');
  const unassigned = sims.filter((s) => !s.clientName);
  const withUsage = sims.filter((s) => s.usedBytes != null);

  // Density follows the number of sections, so a two-section report is not
  // three lines on a sheet of A4 and a nine-section one still lands on a
  // sensible number of pages.
  const density = sections.size >= 7 ? 'tight' : sections.size >= 4 ? 'regular' : 'roomy';

  return (
    <div className="print-only print-report" data-density={density}>
      <header className="print-report__brand">
        <img className="print-report__logo" src="/brand/supportwizard-lockup.png" alt="Support Wizard" />
        <span className="print-report__service">NetKit · Mobile estate</span>
      </header>

      <header className="print-report__head">
        <h1>{title}</h1>
        {subtitle && <p className="print-report__lead">{subtitle}</p>}
      </header>

      {on('summary') && (
        <section>
          <h2>Summary</h2>
          <dl className="print-report__facts">
            <div>
              <dt>SIMs</dt>
              <dd>{sims.length}</dd>
            </div>
            <div>
              <dt>Active</dt>
              <dd>{active.length}</dd>
            </div>
            <div>
              <dt>Offline while active</dt>
              <dd>{offline.length}</dd>
            </div>
            <div>
              <dt>Near or over allowance</dt>
              <dd>{withUsage.length === 0 ? 'not reported' : overage.length}</dd>
            </div>
            <div>
              <dt>Barred</dt>
              <dd>{barred.length}</dd>
            </div>
            <div>
              <dt>Suspended or ceased</dt>
              <dd>{suspended.length}</dd>
            </div>
          </dl>

          {withUsage.length === 0 && (
            <p className="print-report__note">
              The provider's estate listing carried no usage figures, so nothing here counts data used. That is
              why "near or over allowance" reads as not reported rather than nought.
            </p>
          )}

          {(estate.providers ?? []).some((p) => p.error) && (
            <p className="print-report__note">
              Incomplete:{' '}
              {(estate.providers ?? [])
                .filter((p) => p.error)
                .map((p) => `${p.name} did not answer (${p.error})`)
                .join('; ')}
              . Every figure above covers only the accounts that did.
            </p>
          )}
        </section>
      )}

      {on('clients') && (
        <section>
          <h2>By client</h2>
          <table>
            <thead>
              <tr>
                <th>Client</th>
                <th>Sites</th>
                <th>SIMs</th>
                <th>Active</th>
                <th>Data used</th>
                {on('cost') && <th>Monthly</th>}
              </tr>
            </thead>
            <tbody>
              {rollupByClient(sims).map((row) => (
                <tr key={row.clientName}>
                  <td>{row.clientName}</td>
                  <td>{row.sites.length ? row.sites.join(', ') : '—'}</td>
                  <td>{row.simCount}</td>
                  <td>{row.activeCount}</td>
                  <td>
                    {row.usedBytes == null
                      ? '—'
                      : row.allowanceBytes == null
                        ? formatBytes(row.usedBytes)
                        : `${formatBytes(row.usedBytes)} / ${formatBytes(row.allowanceBytes)}`}
                  </td>
                  {on('cost') && <td>{formatPence(row.monthlyCostPence) ?? '—'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {on('sims') && (
        <section>
          <h2>Every SIM</h2>
          <table>
            <thead>
              <tr>
                <th>Number</th>
                <th>ICCID</th>
                <th>Client and site</th>
                <th>State</th>
                <th>Network</th>
                {on('usage') && <th>Data used</th>}
                {on('cost') && <th>Tariff</th>}
                <th>Online</th>
              </tr>
            </thead>
            <tbody>
              {sims.map((sim) => (
                <tr key={sim.iccid}>
                  <td>{sim.msisdn ?? '—'}</td>
                  <td>{sim.iccid}</td>
                  <td>
                    {sim.clientName ?? 'Not assigned'}
                    {sim.site ? ` — ${sim.site}` : ''}
                  </td>
                  <td>{stateLabel(sim)}</td>
                  <td>{sim.network ?? '—'}</td>
                  {on('usage') && <td className={percentClass(simUsedPercent(sim)).trim()}>{usage(sim)}</td>}
                  {on('cost') && (
                    <td>
                      {sim.tariff ?? '—'}
                      {sim.monthlyCostPence != null ? ` · ${formatPence(sim.monthlyCostPence)}` : ''}
                    </td>
                  )}
                  <td>{onlineLabel(sim)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {on('cost') && (
        <section>
          <h2>Cost</h2>
          {sims.some((s) => s.monthlyCostPence != null) ? (
            <dl className="print-report__facts">
              <div>
                <dt>Monthly total</dt>
                <dd>
                  {formatPence(
                    sims.reduce((total, s) => total + (s.monthlyCostPence ?? 0), 0),
                  )}
                </dd>
              </div>
              <div>
                <dt>SIMs with a cost</dt>
                <dd>
                  {sims.filter((s) => s.monthlyCostPence != null).length} of {sims.length}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="print-report__note">
              The provider does not publish a cost against these SIMs, so this section can show tariff names only.
              Nothing here is a price we have invented.
            </p>
          )}
        </section>
      )}

      {on('overage') && overage.length > 0 && (
        <section>
          <h2>Near or over allowance</h2>
          <AttentionTable sims={overage} showUsage />
        </section>
      )}

      {on('barred') && barred.length > 0 && (
        <section>
          <h2>Barred</h2>
          <p className="print-report__note">
            Live SIMs with a restriction on them. These are still on the account and still billing.
          </p>
          <AttentionTable sims={barred} />
        </section>
      )}

      {on('suspended') && suspended.length > 0 && (
        <section>
          <h2>Suspended and ceased</h2>
          <AttentionTable sims={suspended} />
        </section>
      )}

      {on('offline') && offline.length > 0 && (
        <section>
          <h2>Offline</h2>
          <p className="print-report__note">
            Active SIMs that are not attached to the network. For a 5G backup that is normal until it is needed;
            for a primary connection it is an outage.
          </p>
          <AttentionTable sims={offline} showLastSeen />
        </section>
      )}

      {on('unassigned') && unassigned.length > 0 && (
        <section>
          <h2>Not assigned to a client</h2>
          <p className="print-report__note">
            The provider holds no client against these. Usually stock; occasionally a SIM somebody forgot to
            record.
          </p>
          <AttentionTable sims={unassigned} />
        </section>
      )}

      <footer className="print-report__foot">
        Generated {formatDateTime(new Date().toISOString())} from{' '}
        {estate.sources.join(', ') || 'the connected mobile accounts'}. Figures are as the provider reported them at
        that moment.
      </footer>
    </div>
  );
}

/** One of the attention lists: the same columns, so they read as a set. */
function AttentionTable({
  sims,
  showUsage = false,
  showLastSeen = false,
}: {
  sims: SimRecord[];
  showUsage?: boolean;
  showLastSeen?: boolean;
}): ReactElement {
  return (
    <table>
      <thead>
        <tr>
          <th>Number</th>
          <th>Client and site</th>
          <th>State</th>
          {showUsage && <th>Data used</th>}
          {showLastSeen && <th>Last seen</th>}
        </tr>
      </thead>
      <tbody>
        {sims.map((sim) => (
          <tr key={sim.iccid}>
            <td>{sim.msisdn ?? sim.iccid}</td>
            <td>
              {sim.clientName ?? 'Not assigned'}
              {sim.site ? ` — ${sim.site}` : ''}
            </td>
            <td>{stateLabel(sim)}</td>
            {showUsage && <td className={percentClass(simUsedPercent(sim)).trim()}>{usage(sim)}</td>}
            {showLastSeen && <td>{formatDateTime(sim.lastSeenAt) ?? 'Never seen'}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
