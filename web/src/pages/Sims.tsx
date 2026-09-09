import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { DEFAULT_SIM_SECTIONS, type SimReportSection } from '@sw/shared';
import type { SimEstate, SimProviderResult, SimRecord, SimState } from '@sw/shared';
import { SimEstateReport } from '../components/SimEstateReport';
import { SimReportDialog } from '../components/SimReportDialog';
import { go, toHash, useRoute, useTabRoute } from '../lib/route';
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
  formatDate,
  formatDateTime,
  type ChipTone,
} from '../components/ui';
import type { CsvColumn } from '../lib/csv';

/** Bytes, not gigabytes — a spreadsheet can divide, a lossy export cannot. */
const SIM_COLUMNS: Array<CsvColumn<SimRecord>> = [
  { header: 'ICCID', value: (s) => s.iccid },
  { header: 'MSISDN', value: (s) => s.msisdn },
  { header: 'Client', value: (s) => s.clientName },
  { header: 'Site', value: (s) => s.site },
  { header: 'Labels', value: (s) => s.tags?.join('; ') },
  { header: 'Tariff', value: (s) => s.tariff },
  { header: 'Monthly cost (pence)', value: (s) => s.monthlyCostPence },
  { header: 'IMSI', value: (s) => s.imsi },
  { header: 'Service reference', value: (s) => s.zenReference },
  { header: 'State', value: (s) => s.state },
  { header: 'Network', value: (s) => s.network },
  { header: 'Attached', value: (s) => s.attached },
  { header: 'Last seen', value: (s) => s.lastSeenAt },
  { header: 'Allowance (bytes)', value: (s) => s.allowanceBytes },
  { header: 'Bolt-on (bytes)', value: (s) => s.boltOnBytes },
  { header: 'Used (bytes)', value: (s) => s.usedBytes },
  { header: 'Bars', value: (s) => s.bars?.join('; ') },
  { header: 'APN', value: (s) => s.apn },
  { header: 'IP address', value: (s) => s.ipAddress },
  { header: 'Postcode', value: (s) => s.postcode },
  { header: 'Provider', value: (s) => s.provider },
];
import { Tabs, TabPanel, type TabDef } from '../components/Tabs';
import { Modal } from '../components/overlay';

/**
 * The mobile SIM estate.
 *
 * Two separate accounts, shown as one estate: SIMs held directly with Jola
 * Mobile Manager, and SIMs bought through Zen. They are merged and deduped
 * by ICCID rather than one standing in for the other, and each vendor's
 * outcome is reported on its own -- one being down is one being down, not an
 * empty estate.
 *
 * The thing worth seeing first is pool overage, because that is what costs
 * money.
 */

const STATE_TONE: Record<SimState, ChipTone> = {
  active: 'ok',
  suspended: 'warn',
  ceased: 'crit',
  pending: 'info',
  test: 'idle',
  spare: 'idle',
  unknown: 'idle',
};

/** What each state is called on screen, where the raw word is not enough. */
const STATE_LABEL: Partial<Record<SimState, string>> = {
  spare: 'spare — not issued',
  unknown: 'no state reported',
};

type Tab = 'active' | 'all' | 'overage' | 'barred' | 'suspended' | 'spare';

/*
 * Active leads, not All.
 *
 * "All SIMs" opened on 236 rows of which 124 were spares in a drawer with no
 * number and no usage — a page of blanks as the first thing anybody sees.
 * The live estate is the useful default and the stock has a tab of its own.
 */
const TABS = ['active', 'all', 'overage', 'barred', 'suspended', 'spare'] as const;

/**
 * Share of allowance used, as a percentage.
 *
 * The provider's own figure first. Jola do not document what unit their
 * allowance and usage numbers are in, so dividing the two is a guess with a
 * factor of 1024 riding on it — where their percentage needs no unit at all.
 * The division stays as the fallback for providers that report sizes and no
 * percentage.
 */
function usedPercent(sim: SimRecord): number | null {
  if (sim.usedPercentReported != null) return sim.usedPercentReported;
  const allowance = (sim.allowanceBytes ?? 0) + (sim.boltOnBytes ?? 0);
  if (!allowance || sim.usedBytes == null) return null;
  return Math.round((sim.usedBytes / allowance) * 100);
}

export function SimsPage(): ReactElement {
  const [estate, setEstate] = useState<SimEstate | null>(null);
  const [mode, setMode] = useState<'live'>('live');
  const [providerError, setProviderError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // The open tab lives in the URL, so a refresh or a pasted link comes back
  // to the same one.
  const [tab, setTab] = useTabRoute<Tab>('sims', TABS, 'active');
  const [filter, setFilter] = useState('');
  /* A SIM named in the URL, so the lookup box can link straight to one. */
  const route = useRoute();
  const linkedIccid = route.b;
  /*
   * The SIM that is open, and its full record.
   *
   * `detail` is the row that was clicked -- enough to draw the header
   * immediately -- and `full` is what the provider returns when asked about
   * that one SIM: voice, SMS, the usage period, and usage for SIMs the estate
   * listing carries none for. One request, on open, so the API is not asked
   * for this across a whole estate.
   */
  const [detail, setDetail] = useState<SimRecord | null>(null);
  const [full, setFull] = useState<SimRecord | null>(null);
  /* The report builder: which sections, what it is called, and whether it is
     limited to one client. */
  const [reportOpen, setReportOpen] = useState(false);
  const [reportSections, setReportSections] = useState<Set<SimReportSection>>(new Set(DEFAULT_SIM_SECTIONS));
  const [reportTitle, setReportTitle] = useState('Mobile estate');
  const [reportClient, setReportClient] = useState('');
  const [fullBusy, setFullBusy] = useState(false);
  const [fullError, setFullError] = useState<string | null>(null);

  /*
   * Opens the SIM the URL names.
   *
   * Waits for the estate rather than fetching that one SIM: the detail panel
   * draws its header from the row and then asks for the full record, so
   * without the row there is nothing to draw while the request is in flight.
   * Cleared from the URL once opened, so closing the panel does not
   * immediately reopen it.
   */
  useEffect(() => {
    if (!linkedIccid || !estate) return;
    const found = estate.sims.find((sim) => sim.iccid === linkedIccid);
    if (found) {
      setDetail(found);
      setFilter(found.msisdn ?? found.iccid);
    }
    go(toHash('sims', tab), true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedIccid, estate]);

  useEffect(() => {
    if (!detail) {
      setFull(null);
      setFullError(null);
      return;
    }
    let live = true;
    setFullBusy(true);
    setFullError(null);
    void (async () => {
      try {
        const result = await api.simDetail(detail.iccid);
        if (live) setFull(result.sim);
      } catch (err) {
        if (live) {
          setFull(null);
          // The row is still worth showing, so this is a note rather than a
          // replacement for the panel.
          setFullError(err instanceof ApiClientError ? err.message : 'Could not fetch the full record.');
        }
      } finally {
        if (live) setFullBusy(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [detail]);

  useEffect(() => {
    void (async () => {
      try {
        const result = await api.sims();
        setEstate({
          sims: result.sims,
          ...(result.pool ? { pool: result.pool } : {}),
          ...(result.providers ? { providers: result.providers } : {}),
          checkedAt: result.checkedAt,
          sources: result.sources,
        });
        setMode(result.mode);
        setProviderError(result.providerError);
      } catch (err) {
        setError(err instanceof ApiClientError ? err.message : 'Could not load the SIM estate.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const sims = estate?.sims ?? [];

  const buckets = useMemo(
    () => ({
      all: sims,
      active: sims.filter((s) => s.state === 'active'),
      overage: sims.filter((s) => {
        const pct = usedPercent(s);
        return pct != null && pct >= 90;
      }),
      // Barred is not the same as suspended: a live SIM with a data bar on it
      // is still on the account and still billing, and it is the group
      // somebody actually goes looking for.
      barred: sims.filter((s) => (s.bars?.length ?? 0) > 0 && s.state !== 'ceased'),
      suspended: sims.filter((s) => s.state === 'suspended' || s.state === 'ceased'),
      // Stock: no number, no usage, nobody's yet. Kept out of the other
      // groups so they read as an estate rather than a stock take.
      spare: sims.filter((s) => s.state === 'spare'),
    }),
    [sims],
  );

  /**
   * How many SIMs the estate listing gave usage for.
   *
   * "Near or over allowance: 0" is only good news if usage is actually known.
   * Where the listing carries none — and Jola's does not, for most accounts —
   * that group is empty because nothing was measured, and saying zero would
   * be a reassurance the tool has not earned.
   */
  const withUsage = useMemo(() => sims.filter((s) => usedPercent(s) != null).length, [sims]);

  /**
   * What the report is built from.
   *
   * The whole estate, or one client's slice of it. A client-facing report
   * must not carry another client's SIMs, and filtering here rather than in
   * each section means no section can forget to.
   */
  const reportEstate = useMemo<SimEstate>(
    () => ({
      ...(estate ?? { sims: [], checkedAt: new Date().toISOString(), sources: [] }),
      sims: reportClient ? sims.filter((s) => (s.clientName ?? 'Not assigned') === reportClient) : sims,
    }),
    [estate, sims, reportClient],
  );

  const rows = useMemo(() => {
    const list = buckets[tab];
    const needle = filter.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((s) =>
      `${s.iccid} ${s.msisdn ?? ''} ${s.zenReference ?? ''} ${s.postcode ?? ''} ${s.clientName ?? ''} ${
        s.site ?? ''
      } ${(s.tags ?? []).join(' ')}`
        .toLowerCase()
        .includes(needle),
    );
  }, [buckets, tab, filter]);

  if (loading) {
    return (
      <Card title="SIM estate" eyebrow="Mobile" index="01" accent={1}>
        <Spinner label="Loading the SIM estate…" />
      </Card>
    );
  }

  const pool = estate?.pool;
  const poolPercent = pool?.sizeBytes && pool.usedBytes != null ? Math.round((pool.usedBytes / pool.sizeBytes) * 100) : null;

  const tabs: Array<TabDef<Tab>> = [
    { id: 'active', label: 'Active', count: buckets.active.length },
    { id: 'all', label: 'All SIMs', count: buckets.all.length },
    {
      id: 'overage',
      label: 'Near or over allowance',
      count: buckets.overage.length,
      ...(buckets.overage.length ? { tone: 'crit' as const } : {}),
    },
    {
      id: 'barred',
      label: 'Barred',
      count: buckets.barred.length,
      ...(buckets.barred.length ? { tone: 'warn' as const } : {}),
    },
    { id: 'suspended', label: 'Suspended & ceased', count: buckets.suspended.length },
    { id: 'spare', label: 'Stock', count: buckets.spare.length },
  ];

  return (
    <div className="stack">
      {error && <Alert tone="error">{error}</Alert>}
      {providerError && (
        <Alert tone="warn">
          <span>This is incomplete — the live call failed: {providerError}</span>
        </Alert>
      )}

      {/* One vendor failing must not read as an empty estate, so each is
          named with what it actually said. */}
      {(estate?.providers ?? [])
        .filter((p) => p.error)
        .map((p) => (
          <Alert key={p.name} tone="warn">
            <span>
              <strong>{p.name}</strong> did not answer: {p.error}. The SIMs below are everything the other
              accounts returned.
            </span>
          </Alert>
        ))}

      <section className="card card--accent-1">
        <div className="headline">
          <div className="headline__tile">
            <Label>SIMs</Label>
            <div className="headline__big">
              {buckets.active.length}
              <span className="headline__unit">of {sims.length}</span>
            </div>
            <div className="headline__sub">active in the estate</div>
          </div>
          <div className="headline__tile">
            <Label>Pool used</Label>
            <div
              className="headline__big"
              style={{ color: poolPercent != null && poolPercent > 100 ? 'var(--sw-crit-ink)' : 'var(--sw-ink)' }}
            >
              {poolPercent != null ? `${poolPercent}` : '—'}
              {poolPercent != null && <span className="headline__unit">%</span>}
            </div>
            <div className="headline__sub">
              {pool?.usedBytes != null && pool.sizeBytes
                ? `${formatBytes(pool.usedBytes)} of ${formatBytes(pool.sizeBytes)}`
                : 'no pool reported'}
            </div>
          </div>
          <div className="headline__tile">
            <Label>Overage</Label>
            <div
              className="headline__big"
              style={{ color: pool?.overageBytes ? 'var(--sw-crit-ink)' : 'var(--sw-ok)' }}
            >
              {pool?.overageBytes ? formatBytes(pool.overageBytes) : 'None'}
            </div>
            <div className="headline__sub">beyond the pool</div>
          </div>
          <div className="headline__tile">
            <Label>Near allowance</Label>
            <div
              className="headline__big"
              style={{ color: buckets.overage.length ? 'var(--sw-amber-ink)' : 'var(--sw-ink)' }}
            >
              {buckets.overage.length}
            </div>
            <div className="headline__sub">SIMs at 90% or more</div>
          </div>
        </div>
      </section>

      {poolPercent != null && (
        <Card title="Shared data pool" eyebrow={pool?.name ?? 'Pool'} index="02" accent={4}>
          <div className="row" style={{ gap: 14 }}>
            <div className="grow">
              <div className="pool-bar">
                <span
                  className={`pool-bar__fill${poolPercent > 100 ? ' pool-bar__fill--over' : poolPercent > 85 ? ' pool-bar__fill--warn' : ''}`}
                  style={{ width: `${Math.min(100, poolPercent)}%` }}
                />
              </div>
              <div className="row" style={{ justifyContent: 'space-between', marginTop: 6 }}>
                <span className="muted" style={{ fontSize: 12 }}>
                  {formatBytes(pool?.usedBytes)} used
                </span>
                <span className="muted" style={{ fontSize: 12 }}>
                  {formatBytes(pool?.sizeBytes)} pooled across {pool?.simCount ?? 0} SIMs
                </span>
              </div>
            </div>
          </div>
        </Card>
      )}

      <Card
        title="SIMs"
        eyebrow={estateEyebrow(estate?.providers)}
        index="03"
        accent={2}
        flush
        meta={
          <>
            <Chip tone="ok" dot>Live</Chip>
            <button
              type="button"
              className="btn btn--ghost btn--small"
              onClick={() => setReportOpen(true)}
              title="Choose what goes on the page"
            >
              Build a report
            </button>
            <ExportButtons rows={rows} columns={SIM_COLUMNS} filenamePrefix="sims" label="the SIM list" />
          </>
        }
        tabs={<Tabs tabs={tabs} active={tab} onChange={setTab} variant="sub" label="SIM groups" />}
      >
        <TabPanel>
          <div style={{ padding: '14px 18px 0' }}>
            <label className="field" style={{ marginBottom: 14, maxWidth: 420 }}>
              <Label>Filter</Label>
              <input
                className="field__input"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Number, ICCID, client, site, label or postcode…"
              />
            </label>
          </div>

          {rows.length === 0 ? (
            <div className="empty">
              <h3>No SIMs here</h3>
              <p>{filter ? `Nothing matches “${filter}”.` : 'This group is empty.'}</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Number</th>
                    <th>ICCID</th>
                    <th>Client and site</th>
                    <th>State</th>
                    <th>Network</th>
                    <th style={{ minWidth: 190 }}>Data used</th>
                    <th>Online</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((sim) => {
                    const pct = usedPercent(sim);
                    return (
                      <tr key={sim.iccid} className="clickable" onClick={() => setDetail(sim)}>
                        <td className="sw-mono" style={{ fontSize: 13 }}>{sim.msisdn ?? '—'}</td>
                        <td className="sw-mono" style={{ fontSize: 11.5 }}>{sim.iccid}</td>
                        <td style={{ fontSize: 12.5, maxWidth: 220 }}>
                          {/* Whichever of the two exists, and never a
                              dangling separator: a missing client name was
                              rendering as "– Sent iPhone SIMs". */}
                          {sim.clientName ? (
                            <>
                              <strong style={{ color: 'var(--sw-ink)' }}>{sim.clientName}</strong>
                              {sim.site && <div className="muted" style={{ fontSize: 11.5 }}>{sim.site}</div>}
                            </>
                          ) : sim.site ? (
                            <>
                              <strong style={{ color: 'var(--sw-ink)' }}>{sim.site}</strong>
                              <div className="muted" style={{ fontSize: 11.5 }}>
                                {sim.state === 'spare' ? 'stock, not issued to a client' : 'no client recorded'}
                              </div>
                            </>
                          ) : (
                            <span className="muted">
                              {sim.state === 'spare' ? 'Stock' : 'Not assigned'}
                            </span>
                          )}
                          <div className="muted" style={{ fontSize: 11 }}>{vendorLabel(sim.provider)}</div>
                        </td>
                        <td>
                          <Chip tone={STATE_TONE[sim.state]} dot>
                            {STATE_LABEL[sim.state] ?? sim.state}
                          </Chip>
                          {(sim.bars?.length ?? 0) > 0 && (
                            <div style={{ marginTop: 3 }}>
                              <Chip tone="warn" title={sim.bars?.join(', ')}>
                                {sim.bars?.length === 1 ? sim.bars[0] : `${sim.bars?.length} bars`}
                              </Chip>
                            </div>
                          )}
                        </td>
                        <td>{sim.network ?? '—'}</td>
                        <td>
                          {/* Both figures side by side, as asked: how much of
                              how much, and the percentage. */}
                          {pct != null ? (
                            <>
                              <div className="pool-bar pool-bar--slim">
                                <span
                                  className={`pool-bar__fill${pct > 100 ? ' pool-bar__fill--over' : pct > 85 ? ' pool-bar__fill--warn' : ''}`}
                                  style={{ width: `${Math.min(100, pct)}%` }}
                                />
                              </div>
                              <div className="sw-mono" style={{ fontSize: 11.5, marginTop: 3 }}>
                                {formatBytes(sim.usedBytes) ?? '0 B'} / {formatBytes(allowanceWithBoltOn(sim)) ?? '—'}
                                <span className={pct > 100 ? 'usage-pct usage-pct--over' : pct > 85 ? 'usage-pct usage-pct--warn' : 'usage-pct'}>
                                  {pct}%
                                </span>
                              </div>
                            </>
                          ) : (
                            <span className="muted" title="The estate listing carries no usage for this SIM. Open it to fetch usage.">
                              not reported
                            </span>
                          )}
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <OnlineIndicator sim={sim} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </TabPanel>
      </Card>

      {/* Print takes this instead of the screen: the groups above mount one
          at a time, so printing the page would capture whichever tab happened
          to be open. Hidden on screen. */}
      <SimEstateReport
        estate={reportEstate}
        sections={reportSections}
        title={reportTitle}
        {...(reportClient ? { subtitle: `${reportClient} — mobile SIMs` } : {})}
      />

      <SimReportDialog
        estate={reportEstate}
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        onApply={setReportSections}
        title={reportTitle}
        onTitleChange={setReportTitle}
        clientFilter={reportClient}
        onClientFilterChange={setReportClient}
      />

      <Modal
        open={detail !== null}
        onClose={() => setDetail(null)}
        eyebrow={detail?.provider}
        title={detail?.msisdn ?? detail?.iccid ?? ''}
        subtitle={detail ? `ICCID ${detail.iccid}` : undefined}
        footer={
          <>
            <span className="grow" />
            <button type="button" className="btn btn--primary" onClick={() => setDetail(null)}>
              Close
            </button>
          </>
        }
      >
        {open2(detail, full) && (
          <div className="stack stack--tight">
            {fullBusy && <Spinner label="Fetching everything on this SIM…" />}
            {fullError && <Alert tone="warn">{fullError} Showing what the estate listing carried.</Alert>}

            <div className="kv">
              <Cell label="Number" value={shown(detail, full)?.msisdn} mono copy />
              <Cell label="ICCID" value={shown(detail, full)?.iccid} mono copy />
              <Cell label="Client" value={shown(detail, full)?.clientName} />
              <Cell label="Site" value={shown(detail, full)?.site} />
              <Cell label="State" value={shown(detail, full)?.state} />
              <Cell label="Network" value={shown(detail, full)?.network} />
              <Cell label="Online" value={attachedLabel(shown(detail, full)?.attached)} />
              <Cell label="Last seen" value={formatDateTime(shown(detail, full)?.lastSeenAt)} />
              <Cell label="Allowance" value={formatBytes(shown(detail, full)?.allowanceBytes)} mono />
              <Cell label="Bolt-on" value={formatBytes(shown(detail, full)?.boltOnBytes)} mono />
              <Cell label="Data used" value={usedLabel(shown(detail, full))} mono />
              <Cell label="Voice used" value={minutesLabel(shown(detail, full)?.usedVoiceMinutes)} mono />
              <Cell label="SMS used" value={shown(detail, full)?.usedSms} mono />
              <Cell label="Usage period" value={periodLabel(shown(detail, full))} />
              <Cell label="IMSI" value={shown(detail, full)?.imsi} mono copy />
              <Cell label="Zen reference" value={shown(detail, full)?.zenReference} mono copy />
              <Cell label="Postcode" value={shown(detail, full)?.postcode} mono />
              <Cell label="APN" value={shown(detail, full)?.apn} mono />
              <Cell label="IP address" value={shown(detail, full)?.ipAddress} mono copy />
            </div>

            {(shown(detail, full)?.tags?.length ?? 0) > 0 && (
              <div>
                <Label>Labels on this SIM</Label>
                <div className="row" style={{ gap: 5, flexWrap: 'wrap', marginTop: 5 }}>
                  {shown(detail, full)?.tags?.map((tag) => (
                    <Chip key={tag} tone="idle">
                      {tag}
                    </Chip>
                  ))}
                </div>
              </div>
            )}

            {shown(detail, full)?.bars?.length ? (
              <div className="flag flag--warn">
                <span className="flag__marker" aria-hidden="true" />
                <span>
                  <strong>Bars applied</strong>
                  <span className="flag__detail">
                    {shown(detail, full)?.bars?.join(', ')}. This is why the SIM is not passing traffic.
                  </span>
                </span>
              </div>
            ) : null}

            {shown(detail, full)?.state === 'active' && shown(detail, full)?.attached === false && (
              <div className="flag flag--warn">
                <span className="flag__marker" aria-hidden="true" />
                <span>
                  <strong>Active but not attached</strong>
                  <span className="flag__detail">
                    The SIM is live but not currently on the network. Handset off, out of coverage, or in a device that
                    is powered down.
                  </span>
                </span>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

/**
 * Which account a SIM came from.
 *
 * `provider` carries the internal key; this is the name somebody would use
 * out loud, because "jola-mobile-manager" in a table column is not an answer
 * to "whose SIM is this".
 */
function vendorLabel(provider?: string): string {
  const key = (provider ?? '').toLowerCase();
  if (key.includes('jola')) return 'Jola';
  if (key.includes('zen')) return 'Zen';
  return provider ?? '—';
}

/** Names the accounts the estate is actually made of. */
function estateEyebrow(providers?: SimProviderResult[]): string {
  const answered = (providers ?? []).filter((p) => p.configured && !p.error).map((p) => vendorLabel(p.name));
  if (answered.length === 0) return 'Mobile estate';
  return answered.join(' + ');
}

/**
 * The allowance a percentage should be measured against.
 *
 * A bolt-on is extra allowance the customer has bought, so leaving it out
 * shows a SIM at 140% when it is comfortably inside what it is paying for --
 * and somebody chases an overage that does not exist.
 */
function allowanceWithBoltOn(sim: SimRecord): number | undefined {
  if (sim.allowanceBytes == null) return undefined;
  return sim.allowanceBytes + (sim.boltOnBytes ?? 0);
}

/**
 * Whether the SIM is on the network right now.
 *
 * Three states, not two. "Offline" and "the provider does not tell us" are
 * different facts, and showing the second as the first sends somebody to a
 * site to look at a router that is working.
 */
function OnlineIndicator({ sim }: { sim: SimRecord }): ReactElement {
  const seen = formatDateTime(sim.lastSeenAt);

  if (sim.attached === true) {
    return (
      <>
        <Chip tone="ok" dot>Online</Chip>
        {seen && <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>{seen}</div>}
      </>
    );
  }

  if (sim.attached === false) {
    return (
      <>
        <Chip tone={sim.state === 'active' ? 'crit' : 'idle'} dot>
          Offline
        </Chip>
        <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>
          {seen ? `Last seen ${seen}` : 'Never seen'}
        </div>
      </>
    );
  }

  return (
    <>
      <Chip tone="idle" title="The provider does not report attach state for this SIM">
        Unknown
      </Chip>
      {seen && <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>Last seen {seen}</div>}
    </>
  );
}

/** True once there is anything to draw — the row alone is enough. */
const open2 = (row: SimRecord | null, full: SimRecord | null): boolean => Boolean(row ?? full);

/**
 * The record to display.
 *
 * The full one where it arrived, otherwise the row. Merged rather than
 * swapped, so a field the single-SIM call omits does not vanish from a panel
 * that was already showing it.
 */
const shown = (row: SimRecord | null, full: SimRecord | null): SimRecord | null =>
  row && full ? { ...row, ...full } : (full ?? row);

/** Attach state in words, keeping "unknown" distinct from "offline". */
const attachedLabel = (attached?: boolean): string | undefined =>
  attached === true ? 'Online' : attached === false ? 'Offline' : undefined;

/** Data used against allowance, with the percentage — both, side by side. */
function usedLabel(sim: SimRecord | null): string | undefined {
  if (!sim || sim.usedBytes == null) return undefined;
  const used = formatBytes(sim.usedBytes) ?? '0 B';
  const allowance = allowanceWithBoltOn(sim);
  if (allowance == null) return used;
  const pct = Math.round((sim.usedBytes / allowance) * 100);
  return `${used} / ${formatBytes(allowance)} · ${pct}%`;
}

const minutesLabel = (minutes?: number): string | undefined =>
  minutes == null ? undefined : `${minutes} min`;

/** The period the usage figures cover, so a number has a timeframe. */
function periodLabel(sim: SimRecord | null): string | undefined {
  if (!sim?.usagePeriodStart && !sim?.usagePeriodEnd) return undefined;
  const from = formatDate(sim?.usagePeriodStart);
  const to = formatDate(sim?.usagePeriodEnd);
  if (from && to) return `${from} – ${to}`;
  return from ?? to;
}
