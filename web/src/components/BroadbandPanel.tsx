import type { ReactElement } from 'react';
import { statusLabel, technologyRank, type BroadbandAvailability, type BroadbandOffer } from '@sw/shared';
import { Card, Cell, Chip, Label, SpeedBar, formatDate, formatMbps, type ChipTone } from './ui';

/**
 * Broadband availability.
 *
 * Ordered by whether it can actually be sold today, then by technology, so
 * the first row is always the best thing orderable at this premises.
 */

const TONE_BY_STATUS: Record<string, ChipTone> = {
  available: 'ok',
  available_soon: 'info',
  on_demand: 'info',
  build_planned: 'warn',
  waiting_list: 'warn',
  not_available: 'crit',
  unknown: 'idle',
};

/** Fibre, cable and copper get different bar colours. */
function speedKind(offer: BroadbandOffer): 'fibre' | 'cable' | 'copper' {
  if (offer.technology === 'DOCSIS3.1') return 'cable';
  return technologyRank(offer.technology) >= technologyRank('SOGFAST') ? 'fibre' : 'copper';
}

export function BroadbandPanel({ data }: { data: BroadbandAvailability }): ReactElement {
  const { offers, headline } = data;
  const orderable = offers.filter((o) => o.status === 'available');
  const rest = offers.filter((o) => o.status !== 'available');

  return (
    <div className="stack">
      {headline && (
        <section className="card card--accent-1">
          <div className="headline">
            <div className="headline__tile">
              <Label>Best available</Label>
              <div className="headline__big">{headline.technology}</div>
              <div className="headline__sub">{headline.operatorLabel}</div>
            </div>
            <div className="headline__tile">
              <Label>Download</Label>
              <div className="headline__big">{headline.downMbps != null ? formatMbps(headline.downMbps) : '—'}</div>
              <div className="headline__sub">per second, headline</div>
            </div>
            <div className="headline__tile">
              <Label>Upload</Label>
              <div className="headline__big">{headline.upMbps != null ? formatMbps(headline.upMbps) : '—'}</div>
              <div className="headline__sub">per second, headline</div>
            </div>
            <div className="headline__tile">
              <Label>Orderable options</Label>
              <div className="headline__big">{orderable.length}</div>
              <div className="headline__sub">
                of {offers.length} checked
              </div>
            </div>
          </div>
        </section>
      )}

      <Card
        title="Availability by technology"
        eyebrow={`Checked ${formatDate(data.checkedAt) ?? 'just now'}`}
        accent={1}
        flush
        meta={<Chip tone="idle">{data.sources.filter((s) => !s.startsWith('availabilityReference')).join(', ')}</Chip>}
      >
        {offers.length === 0 ? (
          <div className="empty">
            <h3>No availability returned</h3>
            <p>The provider did not return any products for this premises. Check the Openreach tab for the raw line detail.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Technology</th>
                  <th>Operator</th>
                  <th>Status</th>
                  <th style={{ minWidth: 190 }}>Estimated speed</th>
                  <th>Product</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {[...orderable, ...rest].map((offer) => (
                  <tr key={offer.id}>
                    <td>
                      <strong style={{ color: 'var(--sw-ink)' }}>{offer.technology}</strong>
                    </td>
                    <td>{offer.operatorLabel}</td>
                    <td>
                      <Chip tone={TONE_BY_STATUS[offer.status] ?? 'idle'} dot>
                        {statusLabel(offer.status)}
                      </Chip>
                      {offer.rfsDate && (
                        <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>
                          {formatDate(offer.rfsDate)}
                        </div>
                      )}
                    </td>
                    <td>
                      <SpeedBar
                        {...(offer.speeds.downMbpsHigh != null ? { down: offer.speeds.downMbpsHigh } : {})}
                        {...(offer.speeds.upMbpsHigh != null ? { up: offer.speeds.upMbpsHigh } : {})}
                        kind={speedKind(offer)}
                      />
                      {offer.speeds.downMbpsLow != null && offer.speeds.downMbpsHigh != null && (
                        <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                          range {formatMbps(offer.speeds.downMbpsLow)}–{formatMbps(offer.speeds.downMbpsHigh)}
                        </div>
                      )}
                    </td>
                    <td>
                      {offer.productName ?? '—'}
                      {offer.productCode && (
                        <div className="muted sw-mono" style={{ fontSize: 11 }}>{offer.productCode}</div>
                      )}
                      {offer.excessConstructionCharge != null && (
                        <div style={{ fontSize: 11, marginTop: 3, color: 'var(--sw-amber-ink)' }}>
                          ECC £{offer.excessConstructionCharge.toLocaleString('en-GB')}
                        </div>
                      )}
                    </td>
                    <td style={{ maxWidth: 300 }}>
                      {offer.notes.length ? (
                        <ul style={{ margin: 0, paddingLeft: 15, fontSize: 12.5, lineHeight: 1.55 }}>
                          {offer.notes.map((note, i) => (
                            <li key={i}>{note}</li>
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
      </Card>
    </div>
  );
}

/** The Openreach engineering detail — the panel support actually lives in. */
export function OpenreachPanel({ data }: { data: BroadbandAvailability }): ReactElement {
  const or = data.openreach;
  if (!or) {
    return (
      <Card title="Openreach detail" accent={2}>
        <div className="empty">
          <h3>No Openreach detail available</h3>
          <p>
            This premises has no Openreach line record, or the availability provider did not return the engineering
            block. Alt-net options are listed under Broadband.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <div className="stack">
      {or.flags.length > 0 && (
        <Card title="Flags" eyebrow="Read these first" accent={2}>
          {or.flags.map((flag, i) => (
            <div key={i} className={`flag flag--${flag.level}`}>
              <span className="flag__marker" aria-hidden="true" />
              <span>
                <strong>{flag.label}</strong>
                {flag.detail && <span className="flag__detail">{flag.detail}</span>}
              </span>
            </div>
          ))}
        </Card>
      )}

      <div className="two-col">
        <Card title="Exchange" accent={2}>
          <div className="kv">
            <Cell label="Name" value={or.exchange?.name} />
            <Cell label="Code / TLC" value={or.exchange?.tlc ?? or.exchange?.code} mono copy />
            <Cell label="MDF site ID" value={or.exchange?.mdfSiteId} mono />
            <Cell label="Status" value={or.exchange?.status} />
            <Cell label="WLR withdrawal" value={formatDate(or.exchange?.wlrWithdrawalDate)} />
            <Cell label="Stop sell from" value={formatDate(or.exchange?.stopSellDate)} />
            <Cell
              label="Distance"
              value={or.exchange?.distanceMetres != null ? `${or.exchange.distanceMetres.toLocaleString('en-GB')} m` : undefined}
            />
            <Cell label="District code" value={or.districtCode} mono />
          </div>
        </Card>

        <Card title="Cabinet" accent={2}>
          <div className="kv">
            <Cell label="PCP" value={or.cabinet?.id} mono copy />
            <Cell label="Fibre cabinet" value={or.cabinet?.fibreCabinetId} mono />
            <Cell label="Technology" value={or.cabinet?.technology} />
            <Cell label="Status" value={or.cabinet?.status} />
            <Cell label="FTTC enabled" value={or.cabinet?.fttcAvailable} />
            <Cell label="G.fast enabled" value={or.cabinet?.gfastAvailable} />
            <Cell label="Congested" value={or.cabinet?.congested} />
            <Cell
              label="Distance"
              value={or.cabinet?.distanceMetres != null ? `${or.cabinet.distanceMetres.toLocaleString('en-GB')} m` : undefined}
            />
          </div>
        </Card>

        <Card title="Fibre (FTTP)" accent={4}>
          <div className="kv">
            <Cell label="Available" value={or.fttp?.available} />
            <Cell label="Build status" value={or.fttp?.buildStatus} />
            <Cell label="RFS date" value={formatDate(or.fttp?.rfsDate)} />
            <Cell label="CBT" value={or.fttp?.cbtId} mono />
            <Cell label="CBT spare ports" value={or.fttp?.cbtSpareCapacity} />
            <Cell label="SN1" value={or.fttp?.sn1} mono />
            <Cell label="ONT fitted" value={or.fttp?.ontPresent} />
            <Cell label="ONT serial" value={or.fttp?.ontSerial} mono copy />
            <Cell label="ONT type" value={or.fttp?.ontType} />
            <Cell
              label="ONT ports"
              value={
                or.fttp?.ontPortsTotal != null
                  ? `${or.fttp.ontPortsUsed ?? 0} used of ${or.fttp.ontPortsTotal}`
                  : undefined
              }
            />
            <Cell label="FoD available" value={or.fttp?.fodAvailable} />
            <Cell
              label="FoD excess construction"
              value={
                or.fttp?.fodExcessConstruction != null
                  ? `£${or.fttp.fodExcessConstruction.toLocaleString('en-GB')}`
                  : undefined
              }
            />
          </div>
        </Card>

        <Card title="Copper" accent={3}>
          <div className="kv">
            <Cell label="WLR available" value={or.copper?.wlrAvailable} />
            <Cell label="SOGEA available" value={or.copper?.sogeaAvailable} />
            <Cell label="MPF available" value={or.copper?.mpfAvailable} />
            <Cell label="Spare pairs at DP" value={or.copper?.sparePairs} />
            <Cell
              label="Line length"
              value={or.copper?.lineLengthMetres != null ? `${or.copper.lineLengthMetres.toLocaleString('en-GB')} m` : undefined}
            />
            <Cell label="Attenuation" value={or.copper?.attenuationDb != null ? `${or.copper.attenuationDb} dB` : undefined} />
            <Cell label="Distribution point" value={or.copper?.dpId} mono />
            <Cell label="Address key" value={or.addressKey} mono copy />
          </div>
        </Card>
      </div>

      {or.stopSell && (
        <Card title="All-IP stop sell" eyebrow="Copper withdrawal" accent={3}>
          <div className="kv">
            <Cell label="WLR stopped" value={or.stopSell.wlr} />
            <Cell label="MPF stopped" value={or.stopSell.mpf} />
            <Cell label="SOGEA stopped" value={or.stopSell.sogea} />
            <Cell label="FTTC stopped" value={or.stopSell.fttc} />
            <Cell label="Effective" value={formatDate(or.stopSell.effectiveDate)} />
          </div>
          {or.stopSell.reason && (
            <p className="muted" style={{ marginTop: 12, marginBottom: 0, fontSize: 13 }}>
              {or.stopSell.reason}
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
