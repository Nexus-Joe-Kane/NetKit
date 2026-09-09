import { useCallback, useEffect, useState, type ReactElement } from 'react';
import {
  deviceKindLabel,
  siteIdentifier,
  type AddressAssignment,
  type ClientProfile,
  type ClientSite,
} from '@sw/shared';
import { ApiClientError, api, type ClientListRow } from '../lib/api';
import { Alert, Card, Cell, Chip, Empty, Label, Spinner, formatDateTime } from '../components/ui';
import { Modal } from '../components/overlay';
import { Tabs, TabPanel, type TabDef } from '../components/Tabs';
import { go, toHash } from '../lib/route';

/**
 * The customer, as one page.
 *
 * The lookup answers "what is at this address". This answers "tell me about
 * this client", which is the question somebody actually has when the phone
 * rings — and the two have almost no overlap.
 *
 * Every panel here can be empty, and an empty panel says which source did
 * not answer rather than looking the same as a customer we hold nothing
 * about. Those are different problems and only one of them is ours to fix.
 */

type ClientTab = 'overview' | 'equipment' | 'documented' | 'mobile' | 'sites';

const TABS = ['overview', 'equipment', 'documented', 'mobile', 'sites'] as const;

export function ClientsPage(): ReactElement {
  const [rows, setRows] = useState<ClientListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [term, setTerm] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const load = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const result = await api.clients(q, 40);
      setRows(result.clients);
      setTotal(result.total);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not load the client list.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load('');
  }, [load]);

  // Debounced, because the list is local and a keystroke does not need a
  // round trip — but a round trip per keystroke is still rude.
  useEffect(() => {
    const timer = setTimeout(() => void load(term.trim()), 180);
    return () => clearTimeout(timer);
  }, [term, load]);

  return (
    <div className="stack">
      {error && <Alert tone="error">{error}</Alert>}

      <Card
        title="Clients"
        eyebrow={total ? `${total} on file` : 'the local list'}
        index="01"
        accent={1}
        meta={
          <input
            className="field__input"
            style={{ maxWidth: 280 }}
            value={term}
            placeholder="Registered or trading name"
            onChange={(e) => setTerm(e.target.value)}
          />
        }
        flush
      >
        {loading && !rows.length ? (
          <Spinner label="Reading the client list" />
        ) : rows.length === 0 ? (
          <Empty title={term ? `Nothing matched “${term}”` : 'The client list is empty'}>
            {term
              ? 'Try the name as the customer is filed under in IT Glue, or their trading name.'
              : 'The list is built from IT Glue, Jola and Zendesk once a day. Admin portal → Credentials → Client list → Rebuild now.'}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Sites</th>
                  <th>Services</th>
                  <th>Known to</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className="clickable" onClick={() => setOpenKey(row.key)}>
                    <td>
                      <strong>{row.name}</strong>
                      {row.tradingName && row.tradingName !== row.name && (
                        <span className="muted"> ({row.tradingName})</span>
                      )}
                    </td>
                    <td style={{ fontSize: 12.5 }}>
                      {row.sites === 0 ? (
                        <span className="muted">none</span>
                      ) : (
                        <>
                          {row.sites}
                          {row.lookupable < row.sites && (
                            <span className="muted"> · {row.sites - row.lookupable} not pinned</span>
                          )}
                        </>
                      )}
                    </td>
                    <td style={{ fontSize: 12.5 }}>
                      {row.serviceRefs || <span className="muted">—</span>}
                    </td>
                    <td>
                      <span className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                        {row.sources.map((s) => (
                          <Chip key={s} tone="idle">{s}</Chip>
                        ))}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {openKey && <ClientModal clientKey={openKey} onClose={() => setOpenKey(null)} />}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * One client
 * ------------------------------------------------------------------ */

function ClientModal({ clientKey, onClose }: { clientKey: string; onClose: () => void }): ReactElement {
  const [data, setData] = useState<{
    profile: ClientProfile;
    unassigned: ClientSite[];
    assignments: AddressAssignment[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<ClientTab>('overview');

  const load = useCallback(async () => {
    try {
      setData(await api.clientProfile(clientKey));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not load this client.');
    }
  }, [clientKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const profile = data?.profile;
  const failed = (profile?.sources ?? []).filter((s) => !s.ok);

  const tabs: Array<TabDef<ClientTab>> = [
    { id: 'overview', label: 'Overview' },
    { id: 'equipment', label: 'Equipment', ...(profile?.devices?.length ? { count: profile.devices.length } : {}) },
    { id: 'documented', label: 'Documented', ...(profile?.configurations?.length ? { count: profile.configurations.length } : {}) },
    { id: 'mobile', label: 'Mobile', ...(profile?.sims?.length ? { count: profile.sims.length } : {}) },
    { id: 'sites', label: 'Sites', ...(profile?.entry.sites.length ? { count: profile.entry.sites.length } : {}) },
  ];

  return (
    <Modal
      open
      onClose={onClose}
      width="wide"
      eyebrow="Client"
      title={profile?.display ?? 'Loading…'}
      subtitle={profile ? `${profile.entry.sites.length} site${profile.entry.sites.length === 1 ? '' : 's'} · read ${formatDateTime(profile.generatedAt)}` : undefined}
      footer={
        <button type="button" className="btn btn--ghost" onClick={onClose}>Close</button>
      }
    >
      {error && <Alert tone="error">{error}</Alert>}
      {!profile && !error && <Spinner label="Gathering everything" />}

      {profile && (
        <div className="stack stack--tight">
          {failed.length > 0 && (
            <Alert tone="warn">
              {failed.map((s) => s.name).join(' and ')} did not answer, so this page is incomplete rather than
              this client being quiet. {failed.map((s) => s.detail).filter(Boolean).join(' · ')}
            </Alert>
          )}

          <Tabs tabs={tabs} active={tab} onChange={setTab} variant="sub" label="Client sections" />
          <TabPanel>
            {tab === 'overview' && <Overview profile={profile} />}
            {tab === 'equipment' && <Equipment profile={profile} />}
            {tab === 'documented' && <Documented profile={profile} />}
            {tab === 'mobile' && <Mobile profile={profile} />}
            {tab === 'sites' && data && (
              <Sites profile={profile} unassigned={data.unassigned} assignments={data.assignments} onChanged={load} />
            )}
          </TabPanel>
        </div>
      )}
    </Modal>
  );
}

function Overview({ profile }: { profile: ClientProfile }): ReactElement {
  const staff = profile.staff;
  return (
    <div className="stack stack--tight">
      <div className="kv">
        <Cell label="Registered name" value={profile.entry.name} />
        <Cell label="Trades as" value={profile.entry.tradingName} />
        <Cell
          label="People"
          value={staff.value !== undefined ? `${staff.value}${staff.margin ? ` ± ${staff.margin}` : ''}` : 'not known'}
        />
        <Cell label="Open tickets" value={profile.tickets ? String(profile.tickets.open) : undefined} />
        <Cell label="Credentials on file" value={profile.credentialCount !== undefined ? String(profile.credentialCount) : undefined} />
        <Cell label="Services we supply" value={profile.services?.length ? String(profile.services.length) : undefined} />
      </div>

      {/*
        The headcount's provenance, in the open. A licence count is quotable;
        a helpdesk contact count is a different number that looks like the
        same number, and quoting it is how a proposal gets priced wrong.
      */}
      <Alert tone={staff.unreliable ? 'warn' : 'info'}>{staff.because}</Alert>

      {profile.rate && (
        <div className="kv">
          <Cell label="Tickets per person, per month" value={String(profile.rate.perHeadPerMonth)} />
          <Cell label="Which is" value={profile.rate.verdict} />
        </div>
      )}

      {(profile.tickets?.topRequesters ?? []).length > 0 && (
        <div>
          <Label>Who raises them</Label>
          <div className="table-wrap" style={{ marginTop: 6 }}>
            <table className="data data--tight">
              <thead><tr><th>Person</th><th>Open tickets</th></tr></thead>
              <tbody>
                {(profile.tickets?.topRequesters ?? []).map((r) => (
                  <tr key={r.name}><td>{r.name}</td><td>{r.tickets}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {profile.services?.length ? (
        <div>
          <Label>What we supply</Label>
          <div className="table-wrap" style={{ marginTop: 6 }}>
            <table className="data data--tight">
              <thead><tr><th>Reference</th><th>Supplier</th></tr></thead>
              <tbody>
                {profile.services.map((s) => (
                  <tr key={s.reference}>
                    <td className="sw-mono">{s.reference}</td>
                    <td>{s.supplier ?? <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Equipment({ profile }: { profile: ClientProfile }): ReactElement {
  if (!profile.devices?.length) {
    return (
      <Empty title="No equipment reported">
        Either no UniFi site matched this client, or the console is not connected. The Sites tab is where an
        address gets pinned to them.
      </Empty>
    );
  }
  return (
    <div className="table-wrap">
      <table className="data data--tight">
        <thead><tr><th>Device</th><th>Kind</th><th>Model</th><th>Site</th><th>State</th></tr></thead>
        <tbody>
          {profile.devices.map((d) => (
            <tr key={d.id}>
              <td><strong>{d.name}</strong></td>
              <td>{d.kind ?? deviceKindLabel('other')}</td>
              <td style={{ fontSize: 12.5 }}>{d.model ?? <span className="muted">—</span>}</td>
              <td style={{ fontSize: 12.5 }}>{d.siteName ?? <span className="muted">—</span>}</td>
              <td>
                {d.status ? (
                  <Chip tone={/online|connected/i.test(d.status) ? 'ok' : 'crit'}>{d.status}</Chip>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Documented({ profile }: { profile: ClientProfile }): ReactElement {
  if (!profile.configurations?.length) {
    return <Empty title="Nothing documented">Either IT Glue is not connected or no organisation matched this name.</Empty>;
  }
  return (
    <div className="stack stack--tight">
      {profile.credentialCount !== undefined && (
        <Alert tone="info">
          {profile.credentialCount} credential{profile.credentialCount === 1 ? '' : 's'} on file. NetKit never asks
          IT Glue for a password value — open IT Glue to read one, so the read is logged there against your name.
        </Alert>
      )}
      <div className="table-wrap">
        <table className="data data--tight">
          <thead><tr><th>Name</th><th>Type</th><th>Hostname</th><th>IP</th><th>Site</th></tr></thead>
          <tbody>
            {profile.configurations.map((c) => (
              <tr key={c.id}>
                <td><strong>{c.name}</strong></td>
                <td style={{ fontSize: 12.5 }}>{c.type ?? <span className="muted">—</span>}</td>
                <td className="sw-mono" style={{ fontSize: 12 }}>{c.hostname ?? <span className="muted">—</span>}</td>
                <td className="sw-mono" style={{ fontSize: 12 }}>{c.ip ?? <span className="muted">—</span>}</td>
                <td style={{ fontSize: 12.5 }}>{c.siteName ?? <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Mobile({ profile }: { profile: ClientProfile }): ReactElement {
  if (!profile.sims?.length) return <Empty title="No SIMs">Nothing on this client in the mobile estate.</Empty>;
  return (
    <div className="table-wrap">
      <table className="data data--tight">
        <thead><tr><th>Number</th><th>Network</th><th>Tariff</th><th>State</th><th>Allowance used</th></tr></thead>
        <tbody>
          {profile.sims.map((s, i) => (
            <tr key={s.iccid ?? s.msisdn ?? i}>
              <td className="sw-mono">{s.msisdn ?? <span className="muted">no number</span>}</td>
              <td>{s.operator ?? <span className="muted">—</span>}</td>
              <td style={{ fontSize: 12.5 }}>{s.tariff ?? <span className="muted">—</span>}</td>
              <td>{s.state ?? <span className="muted">—</span>}</td>
              <td>
                {s.usedPercent !== undefined ? (
                  <Chip tone={s.usedPercent >= 90 ? 'crit' : s.usedPercent >= 75 ? 'warn' : 'ok'}>
                    {Math.round(s.usedPercent)}%
                  </Chip>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Sites, and claiming an address
 * ------------------------------------------------------------------ */

function Sites({
  profile,
  unassigned,
  assignments,
  onChanged,
}: {
  profile: ClientProfile;
  unassigned: ClientSite[];
  assignments: AddressAssignment[];
  onChanged: () => void;
}): ReactElement {
  const [uprn, setUprn] = useState('');
  const [siteName, setSiteName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const claim = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await api.assignAddress({
        uprn: uprn.trim(),
        clientKey: profile.entry.key,
        clientName: profile.entry.name,
        ...(siteName.trim() ? { siteName: siteName.trim() } : {}),
      });
      setUprn('');
      setSiteName('');
      onChanged();
    } catch (err) {
      setProblem(err instanceof ApiClientError ? err.message : 'The address could not be assigned.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack stack--tight">
      {profile.entry.sites.length > 0 && (
        <div className="table-wrap">
          <table className="data data--tight">
            <thead><tr><th>Site</th><th>Postcode</th><th>UPRN</th><th /></tr></thead>
            <tbody>
              {profile.entry.sites.map((site, i) => {
                const identifier = siteIdentifier(site);
                return (
                  <tr key={site.uprn ?? `${site.name}-${i}`}>
                    <td><strong>{site.name}</strong>
                      {site.address && <div className="muted" style={{ fontSize: 12 }}>{site.address}</div>}
                    </td>
                    <td className="sw-mono" style={{ fontSize: 12 }}>{site.postcode ?? <span className="muted">—</span>}</td>
                    <td className="sw-mono" style={{ fontSize: 12 }}>
                      {site.uprn ?? <Chip tone="warn">not pinned</Chip>}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {identifier && (
                        <button
                          type="button"
                          className="btn btn--ghost btn--small"
                          onClick={() => go(toHash('site', identifier.value))}
                        >
                          Open
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/*
        Claiming an address. The whole promise of the portal depends on it:
        a UPRN lookup finds a building, and the building does not know whose
        it is until somebody says. A postcode is not enough — two of our
        customers share a business park.
      */}
      <div>
        <Label>Pin an address to this client</Label>
        <p className="muted" style={{ fontSize: 12.5, margin: '4px 0 8px', maxWidth: 640 }}>
          Once an address is pinned, looking that UPRN up offers this client's UniFi site, their circuits and
          their tickets. A postcode is not enough on its own — two of our customers share a business park.
          {unassigned.length > 0 && ` ${unassigned.length} of their sites have no UPRN yet.`}
        </p>
        {problem && <Alert tone="error">{problem}</Alert>}
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <Label>UPRN</Label>
            <input className="field__input" style={{ maxWidth: 190 }} value={uprn} placeholder="100023336956" onChange={(e) => setUprn(e.target.value)} />
          </div>
          <div>
            <Label>Site name (optional)</Label>
            <input className="field__input" style={{ maxWidth: 220 }} value={siteName} placeholder="Oxford Street" onChange={(e) => setSiteName(e.target.value)} />
          </div>
          <button type="button" className="btn btn--primary btn--small" disabled={busy || !uprn.trim()} onClick={() => void claim()}>
            {busy ? 'Pinning…' : 'Pin it'}
          </button>
        </div>
      </div>

      {assignments.length > 0 && (
        <div>
          <Label>Pinned by hand</Label>
          <div className="table-wrap" style={{ marginTop: 6 }}>
            <table className="data data--tight">
              <thead><tr><th>UPRN</th><th>Site</th><th>Who</th><th>When</th><th /></tr></thead>
              <tbody>
                {assignments.map((a) => (
                  <tr key={a.uprn}>
                    <td className="sw-mono" style={{ fontSize: 12 }}>{a.uprn}</td>
                    <td>{a.siteName ?? a.addressLine ?? <span className="muted">—</span>}</td>
                    <td style={{ fontSize: 12.5 }}>{a.assignedBy ?? <span className="muted">—</span>}</td>
                    <td style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>{formatDateTime(a.assignedAt)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        type="button"
                        className="btn btn--ghost btn--small"
                        onClick={() => void api.unassignAddress(a.uprn).then(onChanged)}
                      >
                        Unpin
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
