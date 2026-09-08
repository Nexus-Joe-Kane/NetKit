import { useMemo, useState, type ReactElement } from 'react';
import { statusLabel, technologyRank, type BroadbandAvailability, type BroadbandOffer } from '@sw/shared';
import { Card, Cell, Chip, Label, SpeedBar, formatDate, formatMbps, type ChipTone } from './ui';
import { Tabs, TabPanel, type TabDef } from './Tabs';
import { Disclosure, Modal } from './overlay';
import { OrderFlow } from './OrderFlow';
import { ExternalCheckers } from './ExternalCheckers';

/**
 * Broadband availability.
 *
 * Ordered by whether it can actually be sold today, then by technology, so
 * the first row is always the best thing orderable at this premises. Any row
 * opens into a dialog carrying the full product detail.
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

type Filter = 'all' | 'orderable' | 'coming' | 'unavailable' | 'coverage';

const COMING = new Set(['available_soon', 'build_planned', 'waiting_list', 'on_demand']);

export function BroadbandPanel({ data }: { data: BroadbandAvailability }): ReactElement {
  const { offers, headline } = data;
  const [filter, setFilter] = useState<Filter>('all');
  const [detail, setDetail] = useState<BroadbandOffer | null>(null);
  const [ordering, setOrdering] = useState<BroadbandOffer | null>(null);

  // A row we can actually sell is one the wholesale check answered for. An
  // alt-net footprint is coverage intelligence, and mixing the two in
  // "Orderable now" is how somebody quotes Community Fibre by accident.
  const sellable = useMemo(() => offers.filter((o) => o.serviceability !== 'footprint'), [offers]);
  const coverageOnly = useMemo(() => offers.filter((o) => o.serviceability === 'footprint'), [offers]);

  const buckets = useMemo(
    () => ({
      all: offers,
      orderable: sellable.filter((o) => o.status === 'available'),
      coming: sellable.filter((o) => COMING.has(o.status)),
      unavailable: sellable.filter((o) => o.status === 'not_available' || o.status === 'unknown'),
      coverage: coverageOnly,
    }),
    [coverageOnly, offers, sellable],
  );

  const tabs: Array<TabDef<Filter>> = [
    { id: 'all', label: 'All options', count: buckets.all.length },
    { id: 'orderable', label: 'Orderable now', count: buckets.orderable.length },
    { id: 'coming', label: 'Planned', count: buckets.coming.length },
    { id: 'unavailable', label: 'Not available', count: buckets.unavailable.length },
    {
      id: 'coverage',
      label: 'Other networks',
      // Always present. No footprint data is precisely when someone needs
      // the manual checkers, so hiding the tab then was backwards.
      ...(buckets.coverage.length ? { count: buckets.coverage.length } : {}),
    },
  ];

  const rows = buckets[filter];
  const availabilityRef = data.availabilityReference;

  /**
   * An option is orderable through NetKit only when the provider says so and
   * the check gave us the reference an order is built from. Everything else
   * is a read-only row — no button, rather than a button that fails.
   */
  const canOrder = (offer: BroadbandOffer): boolean =>
    Boolean(availabilityRef) &&
    Boolean(offer.productCode) &&
    offer.status === 'available' &&
    offer.orderable !== false &&
    // Coverage intelligence is never orderable, whatever else it says.
    offer.serviceability !== 'footprint';

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
              <div className="headline__big">
                {headline.downMbps != null ? splitSpeed(headline.downMbps) : '—'}
              </div>
              <div className="headline__sub">per second, headline</div>
            </div>
            <div className="headline__tile">
              <Label>Upload</Label>
              <div className="headline__big">
                {headline.upMbps != null ? splitSpeed(headline.upMbps) : '—'}
              </div>
              <div className="headline__sub">per second, headline</div>
            </div>
            <div className="headline__tile">
              <Label>Orderable</Label>
              <div className="headline__big">
                {buckets.orderable.length}
                <span className="headline__unit">of {sellable.length}</span>
              </div>
              <div className="headline__sub">options checked</div>
            </div>
          </div>
        </section>
      )}

      <Card
        title="Availability by technology"
        eyebrow="Wholesale and retail"
        index="01"
        accent={1}
        flush
        meta={
          <>
            {availabilityRef && (
              <Chip tone="idle" title="Required to place an order or book an appointment">
                Ref {availabilityRef}
              </Chip>
            )}
            {data.predicted && (
              <Chip
                tone="idle"
                title={
                  data.predicted.premisesMatched
                    ? 'Ofcom predict this for this exact premises. An independent figure — not a provider quote, and it names no operator.'
                    : `Ofcom have no record of this exact premises, so this is the best predicted across the ${data.predicted.premisesInPostcode ?? 0} premises in the postcode.`
                }
              >
                Ofcom predict {formatMbps(data.predicted.maxDownMbps ?? 0)}
                {!data.predicted.premisesMatched ? ' (postcode)' : ''}
              </Chip>
            )}
            {data.remainingChecks != null && (
              <Chip
                tone={data.remainingChecks < 25 ? 'warn' : 'idle'}
                title="Availability checks left on the account today, under the provider's fair-use policy"
              >
                {data.remainingChecks} checks left
              </Chip>
            )}
            <span className="muted" style={{ fontSize: 11.5 }}>
              Checked {formatDate(data.checkedAt) ?? 'just now'}
            </span>
          </>
        }
        tabs={<Tabs tabs={tabs} active={filter} onChange={setFilter} variant="sub" label="Filter availability" />}
      >
        <TabPanel>
          {filter === 'coverage' && (
            <div style={{ padding: '14px 18px 0' }}>
              {rows.length > 0 && (
                <div className="flag flag--warn">
                  <span className="flag__marker" aria-hidden="true" />
                  <span>
                    <strong>Coverage intelligence, not a serviceability check</strong>
                    <span className="flag__detail">
                      These networks build in this area. Nobody has checked whether they can serve this exact address,
                      and none of them are resellable through our wholesale account. Check before you quote.
                    </span>
                  </span>
                </div>
              )}
              {data.predicted && (
                <div style={{ marginTop: rows.length > 0 ? 14 : 0 }}>
                  <Label>What Ofcom predict for this premises</Label>
                  <p className="muted" style={{ fontSize: 12.5, margin: '4px 0 8px', maxWidth: 640 }}>
                    The regulator's own model, {data.predicted.premisesMatched ? 'for this exact UPRN' : 'averaged across the postcode because Ofcom have no record of this UPRN'}.
                    It names no operator — Ofcom withhold that as commercially confidential — so it answers what is
                    possible here, never who from. Useful as a second opinion when a wholesale estimate looks wrong.
                  </p>
                  <div className="kv">
                    <Cell label="Max predicted down" value={data.predicted.maxDownMbps != null ? formatMbps(data.predicted.maxDownMbps) : undefined} mono />
                    <Cell label="Max predicted up" value={data.predicted.maxUpMbps != null ? formatMbps(data.predicted.maxUpMbps) : undefined} mono />
                    <Cell label="Superfast (30 Mb+)" value={data.predicted.superfastDownMbps != null ? formatMbps(data.predicted.superfastDownMbps) : undefined} mono />
                    <Cell label="Ultrafast (300 Mb+)" value={data.predicted.ultrafastDownMbps != null ? formatMbps(data.predicted.ultrafastDownMbps) : undefined} mono />
                    <Cell label="Matched" value={data.predicted.premisesMatched ? 'This exact premises' : 'Postcode only'} />
                    <Cell label="Premises in postcode" value={data.predicted.premisesInPostcode} mono />
                  </div>
                </div>
              )}

              <div style={{ marginTop: 16 }}>
                <ExternalCheckers postcode={data.address.postcode} />
              </div>
            </div>
          )}

          {rows.length === 0 ? (
            filter === 'coverage' ? (
              <div style={{ padding: '18px 18px 6px' }}>
                <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
                  No alt-net footprint data for this premises — either nothing was reported here, or no coverage
                  source is connected. The checkers above answer either way.
                </p>
              </div>
            ) : (
              <div className="empty">
                <h3>Nothing in this group</h3>
                <p>Try another tab — the full list is under “All options”.</p>
              </div>
            )
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Technology</th>
                    <th>Operator</th>
                    <th>Status</th>
                    <th style={{ minWidth: 185 }}>Estimated speed</th>
                    <th>Product</th>
                    <th style={{ textAlign: 'right' }}>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((offer) => (
                    <tr key={offer.id} className="clickable" onClick={() => setDetail(offer)}>
                      <td>
                        <strong style={{ color: 'var(--sw-ink)' }}>{offer.technology}</strong>
                      </td>
                      <td>{offer.operatorLabel}</td>
                      <td>
                        <Chip tone={TONE_BY_STATUS[offer.status] ?? 'idle'} dot>
                          {statusLabel(offer.status)}
                        </Chip>
                        {offer.serviceability === 'footprint' && (
                          <div style={{ marginTop: 3 }}>
                            <Chip
                              tone="warn"
                              title="This network builds in the area. Nobody has checked whether it can serve this exact address — confirm with the network before quoting."
                            >
                              Not checked
                            </Chip>
                          </div>
                        )}
                        {offer.rfsDate && (
                          <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>{formatDate(offer.rfsDate)}</div>
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
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {offer.notes.length > 0 && (
                          <Chip tone="idle" title={`${offer.notes.length} note(s)`}>
                            {offer.notes.length} note{offer.notes.length === 1 ? '' : 's'}
                          </Chip>
                        )}
                        <button
                          type="button"
                          className="btn btn--ghost btn--small"
                          style={{ marginLeft: 6 }}
                          onClick={(event) => {
                            event.stopPropagation();
                            setDetail(offer);
                          }}
                        >
                          Open
                        </button>
                        {canOrder(offer) && (
                          <button
                            type="button"
                            className="btn btn--primary btn--small"
                            style={{ marginLeft: 6 }}
                            onClick={(event) => {
                              event.stopPropagation();
                              setOrdering(offer);
                            }}
                          >
                            Order
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabPanel>
      </Card>

      <OfferModal
        offer={detail}
        onClose={() => setDetail(null)}
        {...(detail && canOrder(detail)
          ? {
              onOrder: () => {
                setDetail(null);
                setOrdering(detail);
              },
            }
          : {})}
      />

      {ordering && <OrderFlow availability={data} offer={ordering} onClose={() => setOrdering(null)} />}
    </div>
  );
}

/** `900` → `900 Mb` with the unit set smaller, so figures line up. */
function splitSpeed(mbps: number): ReactElement {
  const text = formatMbps(mbps);
  const [value, unit] = text.split(' ');
  return (
    <>
      {value}
      <span className="headline__unit">{unit}</span>
    </>
  );
}

function OfferModal({
  offer,
  onClose,
  onOrder,
}: {
  offer: BroadbandOffer | null;
  onClose: () => void;
  onOrder?: () => void;
}): ReactElement | null {
  if (!offer) return null;

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={offer.operatorLabel}
      title={offer.productName ?? offer.technology}
      subtitle={`${offer.technology} · ${statusLabel(offer.status)}`}
      width="default"
      footer={
        <>
          <span className="grow muted" style={{ fontSize: 11.5 }}>
            Source: {offer.source}
          </span>
          {onOrder && (
            <button type="button" className="btn btn--primary" onClick={onOrder}>
              Order this
            </button>
          )}
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="stack stack--tight">
        <div className="kv">
          <Cell label="Technology" value={offer.technology} />
          <Cell label="Operator" value={offer.operatorLabel} />
          <Cell label="Status" value={statusLabel(offer.status)} />
          <Cell label="Retailer" value={offer.retailer ? offer.retailer.toUpperCase() : undefined} />
          <Cell label="Product code" value={offer.productCode} mono copy />
          <Cell label="Ready for service" value={formatDate(offer.rfsDate)} />
          <Cell label="Install category" value={offer.installCategory} />
          <Cell label="Appointment required" value={offer.appointmentRequired} />
          <Cell
            label="Serviceability"
            value={
              offer.serviceability === 'confirmed'
                ? 'Checked for this address'
                : offer.serviceability === 'footprint'
                  ? 'Not checked — area footprint only'
                  : undefined
            }
          />
          <Cell label="Orderable" value={offer.orderable} />
          <Cell label="If not, why" value={offer.orderableReason} />
        </div>

        <div>
          <Label>Speed estimate</Label>
          <div className="kv" style={{ marginTop: 5 }}>
            <Cell
              label="Download"
              value={
                offer.speeds.downMbpsHigh != null
                  ? offer.speeds.downMbpsLow != null
                    ? `${formatMbps(offer.speeds.downMbpsLow)} – ${formatMbps(offer.speeds.downMbpsHigh)}`
                    : formatMbps(offer.speeds.downMbpsHigh)
                  : undefined
              }
              mono
            />
            <Cell
              label="Upload"
              value={
                offer.speeds.upMbpsHigh != null
                  ? offer.speeds.upMbpsLow != null
                    ? `${formatMbps(offer.speeds.upMbpsLow)} – ${formatMbps(offer.speeds.upMbpsHigh)}`
                    : formatMbps(offer.speeds.upMbpsHigh)
                  : undefined
              }
              mono
            />
            <Cell
              label="Average peak"
              value={offer.speeds.downMbpsAvgPeak != null ? formatMbps(offer.speeds.downMbpsAvgPeak) : undefined}
              mono
            />
            <Cell label="Basis" value={offer.speeds.basis} />
          </div>
        </div>

        {offer.excessConstructionCharge != null && (
          <div className="flag flag--warn">
            <span className="flag__marker" aria-hidden="true" />
            <span>
              <strong>Excess construction charge</strong>
              <span className="flag__detail">
                Estimated at £{offer.excessConstructionCharge.toLocaleString('en-GB')}. A survey is required before
                this is confirmed.
              </span>
            </span>
          </div>
        )}

        {offer.notes.length > 0 && (
          <Disclosure
            summary={`Notes from the provider`}
            meta={<Chip tone="idle">{offer.notes.length}</Chip>}
            defaultOpen
          >
            <ul style={{ margin: 0, paddingLeft: 17, fontSize: 13, lineHeight: 1.65 }}>
              {offer.notes.map((note, i) => (
                <li key={i}>{note}</li>
              ))}
            </ul>
          </Disclosure>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Openreach engineering detail
 * ------------------------------------------------------------------ */

type OrTab = 'flags' | 'exchange' | 'cabinet' | 'fibre' | 'copper' | 'stopsell';

/** The Openreach engineering detail — the panel support actually lives in. */
export function OpenreachPanel({ data }: { data: BroadbandAvailability }): ReactElement {
  const or = data.openreach;
  const [tab, setTab] = useState<OrTab>('flags');

  if (!or) {
    return (
      <Card title="Openreach detail" eyebrow="Engineering" index="02" accent={2}>
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

  const critical = or.flags.filter((f) => f.level === 'critical').length;

  const tabs: Array<TabDef<OrTab>> = [
    {
      id: 'flags',
      label: 'Flags',
      count: or.flags.length,
      ...(critical ? { tone: 'crit' as const } : {}),
    },
    { id: 'exchange', label: 'Exchange' },
    { id: 'cabinet', label: 'Cabinet' },
    { id: 'fibre', label: 'Fibre' },
    { id: 'copper', label: 'Copper' },
    { id: 'stopsell', label: 'Stop sell' },
  ];

  return (
    <Card
      title="Openreach engineering detail"
      eyebrow="Access network"
      index="02"
      accent={2}
      meta={
        <>
          {or.fttp?.available ? (
            <Chip tone="ok" dot>Fibre ready</Chip>
          ) : (
            <Chip tone="warn" dot>{or.fttp?.buildStatus ?? 'No fibre'}</Chip>
          )}
          {critical > 0 && (
            <Chip tone="crit" dot>
              {critical} critical
            </Chip>
          )}
        </>
      }
      tabs={<Tabs tabs={tabs} active={tab} onChange={setTab} variant="sub" label="Openreach sections" />}
    >
      <TabPanel>
        {tab === 'flags' &&
          (or.flags.length === 0 ? (
            <div className="empty">
              <h3>Nothing flagged</h3>
              <p>No stop-sell, capacity or line-length warnings were returned for this premises.</p>
            </div>
          ) : (
            <div>
              {or.flags.map((flag, i) => (
                <div key={i} className={`flag flag--${flag.level}`}>
                  <span className="flag__marker" aria-hidden="true" />
                  <span>
                    <strong>{flag.label}</strong>
                    {flag.detail && <span className="flag__detail">{flag.detail}</span>}
                  </span>
                </div>
              ))}
            </div>
          ))}

        {tab === 'exchange' && (
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
            <Cell label="CSS district" value={or.cssDistrictCode} mono />
            <Cell label="Address key" value={or.addressKey} mono copy />
            <Cell label="ALK" value={or.alk} mono />
          </div>
        )}

        {tab === 'cabinet' && (
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
        )}

        {tab === 'fibre' && (
          <div className="kv">
            <Cell label="Available" value={or.fttp?.available} />
            <Cell label="Build status" value={or.fttp?.buildStatus} />
            <Cell label="RFS date" value={formatDate(or.fttp?.rfsDate)} />
            <Cell label="CBT" value={or.fttp?.cbtId} mono />
            <Cell label="CBT spare ports" value={or.fttp?.cbtSpareCapacity} />
            <Cell label="SN1" value={or.fttp?.sn1} mono />
            <Cell label="Spine" value={or.fttp?.spineId} mono />
            <Cell label="ONT fitted" value={or.fttp?.ontPresent} />
            <Cell label="ONT serial" value={or.fttp?.ontSerial} mono copy />
            <Cell label="ONT type" value={or.fttp?.ontType} />
            <Cell
              label="ONT ports"
              value={
                or.fttp?.ontPortsTotal != null ? `${or.fttp.ontPortsUsed ?? 0} used of ${or.fttp.ontPortsTotal}` : undefined
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
        )}

        {tab === 'copper' && (
          <div className="kv">
            <Cell label="WLR available" value={or.copper?.wlrAvailable} />
            <Cell label="SOGEA available" value={or.copper?.sogeaAvailable} />
            <Cell label="MPF available" value={or.copper?.mpfAvailable} />
            <Cell label="Spare pairs at DP" value={or.copper?.sparePairs} />
            <Cell
              label="Line length"
              value={or.copper?.lineLengthMetres != null ? `${or.copper.lineLengthMetres.toLocaleString('en-GB')} m` : undefined}
              mono
            />
            <Cell label="Attenuation" value={or.copper?.attenuationDb != null ? `${or.copper.attenuationDb} dB` : undefined} mono />
            <Cell label="Distribution point" value={or.copper?.dpId} mono />
          </div>
        )}

        {tab === 'stopsell' &&
          (or.stopSell ? (
            <div className="stack stack--tight">
              <div className="kv">
                <Cell label="WLR stopped" value={or.stopSell.wlr} />
                <Cell label="MPF stopped" value={or.stopSell.mpf} />
                <Cell label="SOGEA stopped" value={or.stopSell.sogea} />
                <Cell label="FTTC stopped" value={or.stopSell.fttc} />
                <Cell label="Effective" value={formatDate(or.stopSell.effectiveDate)} />
              </div>
              {or.stopSell.reason && (
                <div className="flag flag--info">
                  <span className="flag__marker" aria-hidden="true" />
                  <span>
                    <strong>Why</strong>
                    <span className="flag__detail">{or.stopSell.reason}</span>
                  </span>
                </div>
              )}
            </div>
          ) : (
            <div className="empty">
              <h3>No stop-sell recorded</h3>
              <p>Copper products are not restricted at this premises.</p>
            </div>
          ))}
      </TabPanel>
    </Card>
  );
}
