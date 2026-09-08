import type { ReactElement } from 'react';
import type { PrintSection, SiteReport } from '@sw/shared';
import { printDensity } from '@sw/shared';
import { formatMbps } from './ui';

/**
 * The whole report on paper.
 *
 * Printing used to capture whichever tab happened to be open, which is right
 * for "print what I am looking at" and useless for the actual job: attaching
 * a complete picture of a premises to a quote. Sections are tabbed, so only
 * the open panel is mounted and the rest cannot be printed at all.
 *
 * This is built straight from the report data instead, laid out for A4 and
 * hidden on screen. Same numbers, every section, one pass.
 *
 * Deliberately plain. It has to survive being printed in black and white and
 * photocopied, so nothing here depends on colour to carry meaning, and
 * anything qualified on screen is qualified here in words.
 */
export function PrintableReport({
  report,
  sections,
}: {
  report: SiteReport;
  /** What was ticked in the print dialog. */
  sections: Set<PrintSection>;
}): ReactElement {
  const b = report.broadband;
  const sellable = (b?.offers ?? []).filter((o) => o.serviceability !== 'footprint');
  const footprint = (b?.offers ?? []).filter((o) => o.serviceability === 'footprint');

  const on = (id: PrintSection): boolean => sections.has(id);
  // Drives the layout. One or two sections get room to breathe; six get
  // packed tighter, and the short fact blocks pair up two to a row rather
  // than each taking a full width of white space.
  const density = printDensity(sections.size);
  const showBroadband = on('headline') || on('options') || on('footprint') || on('predicted') || on('openreach');

  return (
    <div className="print-only print-report" data-density={density}>
      <header className="print-report__brand">
        <img className="print-report__logo" src="/brand/supportwizard-lockup.png" alt="Support Wizard" />
        <span className="print-report__service">NetKit · Site report</span>
      </header>

      <header className="print-report__head">
        <h1>{report.address.singleLine}</h1>
        {on('identity') && (
        <dl>
          <div>
            <dt>UPRN</dt>
            <dd>{report.uprn ?? report.address.uprn ?? '—'}</dd>
          </div>
          <div>
            <dt>Postcode</dt>
            <dd>{report.address.postcode}</dd>
          </div>
          <div>
            <dt>Premises type</dt>
            <dd>
              {report.address.classificationLabel ?? report.address.premisesType ?? '—'}
              {report.address.classificationCode ? ` (${report.address.classificationCode})` : ''}
            </dd>
          </div>
        </dl>
        )}
      </header>

      {showBroadband && (
      <section>
        <h2>Broadband</h2>
        {on('headline') && (b?.headline ? (
          <p className="print-report__lead">
            Best available: <strong>{b.headline.technology}</strong> from {b.headline.operatorLabel}
            {b.headline.downMbps != null && (
              <>
                {' '}
                at {formatMbps(b.headline.downMbps)}
                {b.headline.upMbps != null ? ` down / ${formatMbps(b.headline.upMbps)} up` : ' down'}
              </>
            )}
            .
          </p>
        ) : (
          <p className="print-report__lead">No availability was returned for this premises.</p>
        ))}

        {on('options') && sellable.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Technology</th>
                <th>Operator</th>
                <th>Status</th>
                <th>Speed (down / up)</th>
                <th>Product</th>
              </tr>
            </thead>
            <tbody>
              {sellable.map((offer, i) => (
                <tr key={`${offer.operator}:${offer.technology}:${i}`}>
                  <td>{offer.technology}</td>
                  <td>{offer.operator}</td>
                  <td>{offer.status.replace(/_/g, ' ')}</td>
                  <td>
                    {offer.speeds.downMbpsHigh != null
                      ? `${formatMbps(offer.speeds.downMbpsHigh)} / ${
                          offer.speeds.upMbpsHigh != null ? formatMbps(offer.speeds.upMbpsHigh) : '?'
                        }`
                      : '—'}
                  </td>
                  <td>{offer.productName ?? offer.productCode ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {on('footprint') && footprint.length > 0 && (
          <>
            <h3>Other networks in the area — not checked for this address</h3>
            <p className="print-report__note">
              These operators are recorded as having a network nearby. Nothing here has been checked against this
              premises and none of it can be ordered on the strength of this report.
            </p>
            <ul>
              {footprint.map((offer, i) => (
                <li key={`${offer.operator}:${i}`}>
                  {offer.operator} — {offer.technology}
                </li>
              ))}
            </ul>
          </>
        )}

        {on('predicted') && b?.predicted && (
          <>
            <h3>Ofcom prediction — independent, names no operator</h3>
            <p className="print-report__note">
              {b.predicted.maxDownMbps != null
                ? `Up to ${formatMbps(b.predicted.maxDownMbps)} down`
                : 'No download figure published'}
              {b.predicted.maxUpMbps != null ? `, ${formatMbps(b.predicted.maxUpMbps)} up` : ''}.{' '}
              {b.predicted.premisesMatched
                ? 'Published for this exact premises.'
                : `Published across the postcode, not this premises${
                    b.predicted.premisesInPostcode ? ` (${b.predicted.premisesInPostcode} premises)` : ''
                  }.`}
            </p>
          </>
        )}
        {on('openreach') && b?.openreach && <OpenreachBlock detail={b.openreach} />}
      </section>
      )}

      {on('signal') && report.signal && report.signal.operators.length > 0 && (
        <section>
          <h2>Mobile signal</h2>
          <table>
            <thead>
              <tr>
                <th>Operator</th>
                <th>Voice indoor</th>
                <th>Voice outdoor</th>
                <th>4G indoor</th>
                <th>4G outdoor</th>
              </tr>
            </thead>
            <tbody>
              {report.signal.operators.map((op) => (
                <tr key={op.operator}>
                  <td>{op.operator}</td>
                  <td>{op.voice.indoor}</td>
                  <td>{op.voice.outdoor}</td>
                  <td>{op.data4g.indoor}</td>
                  <td>{op.data4g.outdoor}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="print-report__note">
            Ofcom predicted coverage, not a measurement. Local obstructions are not modelled.
          </p>
        </section>
      )}

      {on('lines') && (
      <section>
        <h2>Lines at this premises</h2>
        {report.lines.length === 0 ? (
          <p className="print-report__lead">
            Nothing is recorded against this premises in any connected provider.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Service</th>
                <th>CLI</th>
                <th>Product</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {report.lines.map((line) => (
                <tr key={line.serviceId ?? line.lineAccessId ?? line.cli ?? line.id}>
                  <td>{line.provider}</td>
                  <td>{line.serviceId ?? line.lineAccessId ?? '—'}</td>
                  <td>{line.cli ?? '—'}</td>
                  <td>{line.productName ?? line.technology ?? '—'}</td>
                  <td>{line.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {on('nearbyLines') && report.nearbyLines && report.nearbyLines.length > 0 && (
          <>
            <h3>At this postcode but not matched to this premises</h3>
            <ul>
              {report.nearbyLines.map((line) => (
                <li key={line.serviceId ?? line.lineAccessId ?? line.cli ?? line.id}>
                  {line.provider} — {line.serviceId ?? line.lineAccessId ?? line.cli ?? 'unknown'} at{' '}
                  {line.address.singleLine || 'an address the supplier did not give'}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      )}

      <footer className="print-report__foot">
        <p>
          Generated {new Date(report.generatedAt).toLocaleString('en-GB')} by SupportWizard NetKit. Query “
          {report.query.raw}” read as {report.query.kind}.
        </p>
        <p>SupportWizard Internal · Confidential</p>
      </footer>
    </div>
  );
}

/**
 * The Openreach facts an engineer or a survey actually uses.
 *
 * This section was offered in the print picker before it existed, which is
 * the worst of both: a tick that silently does nothing. Laid out as pairs
 * rather than a table because it is a handful of facts, not a list, and only
 * the ones present are shown -- an empty "Cabinet: —" row is noise on paper.
 */
function OpenreachBlock({ detail }: { detail: NonNullable<SiteReport['broadband']>['openreach'] }): ReactElement | null {
  if (!detail) return null;

  const facts: Array<[string, string]> = [];
  const add = (label: string, value?: string | number | null): void => {
    if (value === undefined || value === null || value === '') return;
    facts.push([label, String(value)]);
  };

  add('Exchange', detail.exchange?.name);
  add('Exchange code', detail.exchange?.code ?? detail.exchange?.tlc);
  add('Exchange status', detail.exchange?.status);
  add(
    'Distance to exchange',
    detail.exchange?.distanceMetres != null ? `${detail.exchange.distanceMetres} m` : undefined,
  );
  add('WLR withdrawal', detail.exchange?.wlrWithdrawalDate);
  add('Stop sell', detail.exchange?.stopSellDate);
  add('Cabinet', detail.cabinet?.id);
  add('Cabinet technology', detail.cabinet?.technology);
  add('Cabinet status', detail.cabinet?.status);
  add(
    'Distance to cabinet',
    detail.cabinet?.distanceMetres != null ? `${detail.cabinet.distanceMetres} m` : undefined,
  );
  add('FTTP build', detail.fttp?.buildStatus);
  add('FTTP ready for service', detail.fttp?.rfsDate);
  add('CBT', detail.fttp?.cbtId);
  add('CBT spare capacity', detail.fttp?.cbtSpareCapacity);
  add('ONT fitted', detail.fttp?.ontPresent === undefined ? undefined : detail.fttp.ontPresent ? 'Yes' : 'No');
  add('ONT serial', detail.fttp?.ontSerial);
  add('Openreach address key', detail.addressKey ?? detail.alk);

  const flags = (detail.flags ?? []).filter((f) => f.level === 'critical' || f.level === 'warn');

  if (!facts.length && !flags.length) return null;

  return (
    <>
      <h3>Openreach</h3>
      {facts.length > 0 && (
        <dl className="print-report__facts">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {flags.length > 0 && (
        <ul>
          {flags.map((flag, i) => (
            <li key={`${flag.level}:${i}`}>
              <strong>{flag.level === 'critical' ? 'Critical' : 'Note'}:</strong> {flag.label}
              {flag.detail ? ` — ${flag.detail}` : ''}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
