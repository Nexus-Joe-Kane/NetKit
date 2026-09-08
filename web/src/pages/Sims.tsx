import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { SimEstate, SimProviderResult, SimRecord, SimState } from '@sw/shared';
import { useTabRoute } from '../lib/route';
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
  type ChipTone,
} from '../components/ui';
import type { CsvColumn } from '../lib/csv';

/** Bytes, not gigabytes — a spreadsheet can divide, a lossy export cannot. */
const SIM_COLUMNS: Array<CsvColumn<SimRecord>> = [
  { header: 'ICCID', value: (s) => s.iccid },
  { header: 'MSISDN', value: (s) => s.msisdn },
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
  unknown: 'idle',
};

type Tab = 'all' | 'active' | 'overage' | 'suspended';

const TABS = ['all', 'active', 'overage', 'suspended'] as const;

/** Share of allowance used, as a percentage. */
function usedPercent(sim: SimRecord): number | null {
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
  const [tab, setTab] = useTabRoute<Tab>('sims', TABS, 'all');
  const [filter, setFilter] = useState('');
  const [detail, setDetail] = useState<SimRecord | null>(null);

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
      suspended: sims.filter((s) => s.state === 'suspended' || s.state === 'ceased'),
    }),
    [sims],
  );

  const rows = useMemo(() => {
    const list = buckets[tab];
    const needle = filter.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((s) =>
      `${s.iccid} ${s.msisdn ?? ''} ${s.zenReference ?? ''} ${s.postcode ?? ''}`.toLowerCase().includes(needle),
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
    { id: 'all', label: 'All SIMs', count: buckets.all.length },
    { id: 'active', label: 'Active', count: buckets.active.length },
    {
      id: 'overage',
      label: 'Near or over allowance',
      count: buckets.overage.length,
      ...(buckets.overage.length ? { tone: 'crit' as const } : {}),
    },
    { id: 'suspended', label: 'Suspended & ceased', count: buckets.suspended.length },
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
                placeholder="ICCID, number, Zen reference or postcode…"
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
                    <th>ICCID</th>
                    <th>Number</th>
                    <th>State</th>
                    <th>Network</th>
                    <th>Account</th>
                    <th style={{ minWidth: 160 }}>Data used</th>
                    <th>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((sim) => {
                    const pct = usedPercent(sim);
                    return (
                      <tr key={sim.iccid} className="clickable" onClick={() => setDetail(sim)}>
                        <td className="sw-mono" style={{ fontSize: 11.5 }}>{sim.iccid}</td>
                        <td className="sw-mono">{sim.msisdn ?? '—'}</td>
                        <td>
                          <Chip tone={STATE_TONE[sim.state]} dot>
                            {sim.state}
                          </Chip>
                          {sim.attached === false && sim.state === 'active' && (
                            <div style={{ marginTop: 3 }}>
                              <Chip tone="warn">Not attached</Chip>
                            </div>
                          )}
                        </td>
                        <td>{sim.network ?? '—'}</td>
                        <td style={{ fontSize: 12 }}>{vendorLabel(sim.provider)}</td>
                        <td>
                          {pct != null ? (
                            <>
                              <div className="pool-bar pool-bar--slim">
                                <span
                                  className={`pool-bar__fill${pct > 100 ? ' pool-bar__fill--over' : pct > 85 ? ' pool-bar__fill--warn' : ''}`}
                                  style={{ width: `${Math.min(100, pct)}%` }}
                                />
                              </div>
                              <div className="muted sw-mono" style={{ fontSize: 11, marginTop: 3 }}>
                                {formatBytes(sim.usedBytes)} · {pct}%
                              </div>
                            </>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td style={{ whiteSpace: 'nowrap', fontSize: 12.5 }}>{formatDateTime(sim.lastSeenAt) ?? '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </TabPanel>
      </Card>

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
        {detail && (
          <div className="stack stack--tight">
            <div className="kv">
              <Cell label="ICCID" value={detail.iccid} mono copy />
              <Cell label="Number" value={detail.msisdn} mono copy />
              <Cell label="IMSI" value={detail.imsi} mono copy />
              <Cell label="State" value={detail.state} />
              <Cell label="Network" value={detail.network} />
              <Cell label="Attached" value={detail.attached} />
              <Cell label="Zen reference" value={detail.zenReference} mono copy />
              <Cell label="Postcode" value={detail.postcode} mono />
              <Cell label="Allowance" value={formatBytes(detail.allowanceBytes)} mono />
              <Cell label="Bolt-on" value={formatBytes(detail.boltOnBytes)} mono />
              <Cell label="Used" value={formatBytes(detail.usedBytes)} mono />
              <Cell label="APN" value={detail.apn} mono />
              <Cell label="IP address" value={detail.ipAddress} mono copy />
              <Cell label="Last seen" value={formatDateTime(detail.lastSeenAt)} />
            </div>

            {detail.bars?.length ? (
              <div className="flag flag--warn">
                <span className="flag__marker" aria-hidden="true" />
                <span>
                  <strong>Bars applied</strong>
                  <span className="flag__detail">
                    {detail.bars.join(', ')}. This is why the SIM is not passing traffic.
                  </span>
                </span>
              </div>
            ) : null}

            {detail.state === 'active' && detail.attached === false && (
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
