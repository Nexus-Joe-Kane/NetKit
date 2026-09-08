import type { ReactElement } from 'react';
import type { SiteReport } from '@sw/shared';
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
export function PrintableReport({ report }: { report: SiteReport }): ReactElement {
  const b = report.broadband;
  const sellable = (b?.offers ?? []).filter((o) => o.serviceability !== 'footprint');
  const footprint = (b?.offers ?? []).filter((o) => o.serviceability === 'footprint');

  return (
    <div className="print-only print-report">
      <header className="print-report__head">
        <h1>{report.address.singleLine}</h1>
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
      </header>

      <section>
        <h2>Broadband</h2>
        {b?.headline ? (
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
        )}

        {sellable.length > 0 && (
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

        {footprint.length > 0 && (
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

        {b?.predicted && (
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
      </section>

      {report.signal && report.signal.operators.length > 0 && (
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

        {report.nearbyLines && report.nearbyLines.length > 0 && (
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
