import { useEffect, useState, type ReactElement } from 'react';
import type { Incident, IncidentImpact, IncidentState } from '@sw/shared';
import { ApiClientError, api } from '../lib/api';
import { Alert, Card, Cell, Chip, Label, Spinner, formatDateTime, type ChipTone } from '../components/ui';
import { Tabs, TabPanel, type TabDef } from '../components/Tabs';
import { Modal } from '../components/overlay';

/**
 * Network status — outages and planned engineering work.
 *
 * The point of this page is to answer "is it just us?" before anyone raises
 * a fault, so current incidents lead and the impact is stated in words
 * rather than a colour alone.
 */

const IMPACT_TONE: Record<IncidentImpact, ChipTone> = {
  total_loss: 'crit',
  partial_loss: 'crit',
  degraded: 'warn',
  at_risk: 'warn',
  no_impact: 'idle',
  unknown: 'idle',
};

const IMPACT_LABEL: Record<IncidentImpact, string> = {
  total_loss: 'Total loss of service',
  partial_loss: 'Partial loss',
  degraded: 'Degraded',
  at_risk: 'At risk',
  no_impact: 'No expected impact',
  unknown: 'Impact unknown',
};

const STATE_LABEL: Record<IncidentState, string> = {
  open: 'Open',
  monitoring: 'Monitoring',
  resolved: 'Resolved',
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  unknown: 'Unknown',
};

const STATE_TONE: Record<IncidentState, ChipTone> = {
  open: 'crit',
  monitoring: 'info',
  resolved: 'ok',
  scheduled: 'info',
  in_progress: 'warn',
  unknown: 'idle',
};

type Tab = 'outages' | 'planned' | 'history';

export function NetworkStatusPage(): ReactElement {
  const [tab, setTab] = useState<Tab>('outages');
  const [current, setCurrent] = useState<{ outages: Incident[]; plannedWork: Incident[] } | null>(null);
  const [past, setPast] = useState<{ outages: Incident[]; plannedWork: Incident[] } | null>(null);
  const [mode, setMode] = useState<'live' | 'mock'>('mock');
  const [providerError, setProviderError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<Incident | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const result = await api.networkStatus(false);
        setCurrent({ outages: result.outages, plannedWork: result.plannedWork });
        setMode(result.mode);
        setProviderError(result.providerError);
      } catch (err) {
        setError(err instanceof ApiClientError ? err.message : 'Could not load network status.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // History is fetched lazily — it is the tab nobody opens first.
  useEffect(() => {
    if (tab !== 'history' || past) return;
    void (async () => {
      try {
        const result = await api.networkStatus(true);
        setPast({ outages: result.outages, plannedWork: result.plannedWork });
      } catch {
        setPast({ outages: [], plannedWork: [] });
      }
    })();
  }, [tab, past]);

  if (loading) {
    return (
      <Card title="Network status" eyebrow="Outages and planned work" index="01" accent={1}>
        <Spinner label="Checking for outages and planned engineering work…" />
      </Card>
    );
  }

  const outages = current?.outages ?? [];
  const planned = current?.plannedWork ?? [];
  const liveOutages = outages.filter((o) => o.state !== 'resolved');

  const tabs: Array<TabDef<Tab>> = [
    {
      id: 'outages',
      label: 'Outages',
      ...(outages.length ? { count: outages.length } : {}),
      ...(liveOutages.length ? { tone: 'crit' as const } : {}),
    },
    { id: 'planned', label: 'Planned work', ...(planned.length ? { count: planned.length } : {}) },
    { id: 'history', label: 'History' },
  ];

  const historyList = past ? [...past.outages, ...past.plannedWork] : null;

  return (
    <div className="stack">
      {error && <Alert tone="error">{error}</Alert>}
      {providerError && (
        <Alert tone="warn">
          <span>Showing demo data — the live call failed: {providerError}</span>
        </Alert>
      )}

      <section className="card card--accent-1">
        <div className="headline">
          <div className="headline__tile">
            <Label>Live outages</Label>
            <div className="headline__big" style={{ color: liveOutages.length ? 'var(--sw-crit-ink)' : 'var(--sw-ok)' }}>
              {liveOutages.length}
            </div>
            <div className="headline__sub">
              {liveOutages.length === 0 ? 'Nothing currently affecting service' : 'affecting service now'}
            </div>
          </div>
          <div className="headline__tile">
            <Label>Total loss</Label>
            <div className="headline__big">{outages.filter((o) => o.impact === 'total_loss').length}</div>
            <div className="headline__sub">hard down, not degraded</div>
          </div>
          <div className="headline__tile">
            <Label>Planned work</Label>
            <div className="headline__big">{planned.length}</div>
            <div className="headline__sub">scheduled or under way</div>
          </div>
          <div className="headline__tile">
            <Label>Source</Label>
            <div className="headline__big" style={{ fontSize: 20 }}>
              {mode === 'live' ? 'Live' : 'Demo'}
            </div>
            <div className="headline__sub">{mode === 'live' ? 'Zen Assurance' : 'awaiting credentials'}</div>
          </div>
        </div>
      </section>

      <Card
        title="Network status"
        eyebrow="Zen Assurance"
        index="01"
        accent={2}
        flush
        meta={mode === 'mock' ? <Chip tone="warn" dot>Demo data</Chip> : <Chip tone="ok" dot>Live</Chip>}
        tabs={<Tabs tabs={tabs} active={tab} onChange={setTab} variant="sub" label="Network status sections" />}
      >
        <TabPanel>
          {tab === 'outages' && <IncidentTable incidents={outages} onOpen={setDetail} emptyTitle="No outages" emptyBody="Nothing is currently reported as affecting service. If a customer is down, it is theirs alone — run a line test." />}
          {tab === 'planned' && <IncidentTable incidents={planned} onOpen={setDetail} emptyTitle="No planned work" emptyBody="No engineering work is scheduled that would affect service." />}
          {tab === 'history' &&
            (historyList === null ? (
              <div style={{ padding: 18 }}>
                <Spinner label="Loading history…" />
              </div>
            ) : (
              <IncidentTable incidents={historyList} onOpen={setDetail} emptyTitle="No history" emptyBody="No past incidents were returned." />
            ))}
        </TabPanel>
      </Card>

      <IncidentModal incident={detail} onClose={() => setDetail(null)} />
    </div>
  );
}

function IncidentTable({
  incidents,
  onOpen,
  emptyTitle,
  emptyBody,
}: {
  incidents: Incident[];
  onOpen: (incident: Incident) => void;
  emptyTitle: string;
  emptyBody: string;
}): ReactElement {
  if (!incidents.length) {
    return (
      <div className="empty">
        <h3>{emptyTitle}</h3>
        <p>{emptyBody}</p>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Reference</th>
            <th>What</th>
            <th>Impact</th>
            <th>State</th>
            <th>Started</th>
            <th>Areas</th>
          </tr>
        </thead>
        <tbody>
          {incidents.map((incident) => (
            <tr key={incident.reference} className="clickable" onClick={() => onOpen(incident)}>
              <td className="sw-mono">{incident.reference}</td>
              <td style={{ maxWidth: 320 }}>
                <strong style={{ color: 'var(--sw-ink)' }}>{incident.title}</strong>
              </td>
              <td>
                <Chip tone={IMPACT_TONE[incident.impact]} dot>
                  {IMPACT_LABEL[incident.impact]}
                </Chip>
              </td>
              <td>
                <Chip tone={STATE_TONE[incident.state]}>{STATE_LABEL[incident.state]}</Chip>
              </td>
              <td style={{ whiteSpace: 'nowrap', fontSize: 12.5 }}>{formatDateTime(incident.startedAt) ?? '—'}</td>
              <td style={{ fontSize: 12.5, maxWidth: 220 }}>
                {incident.areasAffected?.length ? incident.areasAffected.join(', ') : <span className="muted">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function IncidentModal({ incident, onClose }: { incident: Incident | null; onClose: () => void }): ReactElement | null {
  if (!incident) return null;

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={incident.kind === 'planned' ? 'Planned engineering work' : 'Major service outage'}
      title={incident.title}
      subtitle={incident.reference}
      width="default"
      {...(incident.impact === 'total_loss' ? { tone: 'danger' as const } : {})}
      footer={
        <>
          <span className="grow muted" style={{ fontSize: 11.5 }}>
            {incident.provider}
          </span>
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="stack stack--tight">
        {incident.detail && (
          <div className={`flag flag--${incident.impact === 'total_loss' ? 'critical' : incident.impact === 'no_impact' ? 'info' : 'warn'}`}>
            <span className="flag__marker" aria-hidden="true" />
            <span>
              <strong>{IMPACT_LABEL[incident.impact]}</strong>
              <span className="flag__detail">{incident.detail}</span>
            </span>
          </div>
        )}

        <div className="kv">
          <Cell label="State" value={STATE_LABEL[incident.state]} />
          <Cell label="Started" value={formatDateTime(incident.startedAt)} />
          <Cell label="Expected to end" value={formatDateTime(incident.endsAt)} />
          <Cell label="Cleared" value={formatDateTime(incident.clearedAt)} />
          <Cell label="Last updated" value={formatDateTime(incident.lastUpdatedAt)} />
          <Cell label="Reference" value={incident.reference} mono copy />
        </div>

        {incident.areasAffected?.length ? (
          <div>
            <Label>Areas affected</Label>
            <div className="row" style={{ gap: 5, marginTop: 6 }}>
              {incident.areasAffected.map((area) => (
                <Chip key={area} tone="idle">
                  {area}
                </Chip>
              ))}
            </div>
          </div>
        ) : null}

        {incident.affectedServices?.length ? (
          <div>
            <Label>Our services affected</Label>
            <div className="table-wrap" style={{ marginTop: 6 }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>Zen reference</th>
                    <th>Service ID</th>
                    <th>CLI</th>
                    <th>Postcode</th>
                  </tr>
                </thead>
                <tbody>
                  {incident.affectedServices.map((s, i) => (
                    <tr key={i}>
                      <td className="sw-mono">{s.zenReference ?? '—'}</td>
                      <td className="sw-mono">{s.serviceId ?? '—'}</td>
                      <td className="sw-mono">{s.cli ?? '—'}</td>
                      <td className="sw-mono">{s.postcode ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        {incident.updates?.length ? (
          <div>
            <Label>Updates — newest first</Label>
            <div className="timeline" style={{ marginTop: 8 }}>
              {incident.updates.map((update, i) => (
                <div key={i} className="timeline__item">
                  <span className="timeline__dot" aria-hidden="true" />
                  <div>
                    <div className="sw-label">{formatDateTime(update.at)}</div>
                    <div style={{ fontSize: 13, lineHeight: 1.55 }}>{update.text}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
