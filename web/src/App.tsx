import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { AddressSuggestion, SearchResponse, SiteReport } from '@sw/shared';
import { ApiClientError, api, type PublicUser, type SessionState } from './lib/api';
import { SearchBar } from './components/SearchBar';
import { IdentityBox } from './components/IdentityBox';
import { BroadbandPanel, OpenreachPanel } from './components/BroadbandPanel';
import { SignalPanel } from './components/SignalPanel';
import { LinesPanel } from './components/LinesPanel';
import { AdminPortal } from './components/AdminPortal';
import { NetworkStatusPage } from './pages/NetworkStatus';
import { FaultsPage } from './pages/Faults';
import { OrdersPage } from './pages/Orders';
import { SimsPage } from './pages/Sims';
import { ToolsPage } from './pages/Tools';
import { ForcePasswordChange, Login } from './components/Login';
import { Alert, Card, Chip, Empty, Label, Spinner } from './components/ui';
import { Tabs, TabPanel, type TabDef } from './components/Tabs';
import { Modal } from './components/overlay';

/**
 * Application shell.
 *
 * State is deliberately flat: a session, a search result, and which tab is
 * showing. There is no router — the whole tool is one search box and the
 * report it produces, so URL state is limited to the deep link for a UPRN.
 */

type View = 'lookup' | 'network' | 'faults' | 'orders' | 'sims' | 'tools' | 'admin';
type ReportTab = 'broadband' | 'openreach' | 'signal' | 'lines';

/** The primary navigation. `admin` is reached by its own button. */
const NAV: Array<{ id: Exclude<View, 'admin'>; label: string }> = [
  { id: 'lookup', label: 'Lookup' },
  { id: 'network', label: 'Network status' },
  { id: 'faults', label: 'Faults' },
  { id: 'orders', label: 'Orders' },
  { id: 'sims', label: 'SIMs' },
  { id: 'tools', label: 'Tools' },
];

export function App(): ReactElement {
  const [session, setSession] = useState<SessionState | null>(null);
  const [booting, setBooting] = useState(true);

  const refreshSession = useCallback(async () => {
    try {
      setSession(await api.session());
    } catch {
      setSession({ authenticated: false });
    } finally {
      setBooting(false);
    }
  }, []);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  if (booting) {
    return (
      <div className="login">
        <Spinner label="Loading NetKit…" />
      </div>
    );
  }

  if (!session?.authenticated || !session.user) {
    return <Login onSignedIn={setSession} />;
  }

  if (session.mustChangePassword) {
    return <ForcePasswordChange onDone={refreshSession} />;
  }

  return <Portal user={session.user} onSignOut={() => setSession({ authenticated: false })} />;
}

/* ------------------------------------------------------------------ *
 * The portal
 * ------------------------------------------------------------------ */

function Portal({ user, onSignOut }: { user: PublicUser; onSignOut: () => void }): ReactElement {
  const [view, setView] = useState<View>('lookup');
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [report, setReport] = useState<SiteReport | null>(null);
  const [tab, setTab] = useState<ReportTab>('broadband');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialQuery, setInitialQuery] = useState('');
  /**
   * The address picker opens as a dialog the moment a postcode resolves to
   * several premises — that is the one decision the user has to make, so it
   * gets the foreground. The same list stays on the page behind it, so
   * dismissing the dialog does not lose the results.
   */
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerFilter, setPickerFilter] = useState('');

  /** Deep link: `#/site/<uprn>` loads a premises straight away. */
  useEffect(() => {
    const match = window.location.hash.match(/^#\/site\/(\d{1,12})$/);
    if (match?.[1]) void loadSite(match[1]);
    // Only on first mount — later navigation is driven by the search box.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runSearch = async (query: string) => {
    setBusy(true);
    setError(null);
    setInitialQuery(query);
    try {
      const response = await api.search(query);
      setResult(response);
      setReport(response.report ?? null);
      setPickerFilter('');
      setPickerOpen((response.suggestions?.length ?? 0) > 1 && !response.report);
      // Searching a CLI or line ID means you want the line; anything else
      // starts on availability.
      setTab(response.lines?.length ? 'lines' : 'broadband');
      if (response.report?.uprn) window.location.hash = `#/site/${response.report.uprn}`;
    } catch (err) {
      setResult(null);
      setReport(null);
      if (err instanceof ApiClientError) {
        setError(err.message);
        // An ambiguous query still hands back the address list to choose from.
        if (err.suggestions?.length) {
          setResult({ query: { raw: query, normalised: query, kind: 'address', confidence: 0, alternatives: [], reason: '' }, suggestions: err.suggestions });
        }
      } else {
        setError('Something went wrong with that lookup.');
      }
    } finally {
      setBusy(false);
    }
  };

  async function loadSite(uprn: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const site = await api.site(uprn);
      setPickerOpen(false);
      setReport(site);
      setResult({ query: site.query, suggestions: [], report: site });
      setTab('broadband');
      window.location.hash = `#/site/${uprn}`;
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not load that premises.');
    } finally {
      setBusy(false);
    }
  }

  const pickAddress = async (suggestion: AddressSuggestion) => {
    if (suggestion.uprn) return loadSite(suggestion.uprn);
    return runSearch(suggestion.label);
  };

  const signOut = async () => {
    try {
      await api.logout();
    } finally {
      onSignOut();
    }
  };

  return (
    <div className="shell">
      <header className="masthead">
        <div className="masthead__inner">
          <button
            type="button"
            className="masthead__logo"
            onClick={() => setView('lookup')}
            title="NetKit home"
          >
            <img src="/brand/supportwizard-lockup.png" alt="Support Wizard" />
            <span className="sw-label masthead__service">NetKit</span>
          </button>

          <nav className="nav" aria-label="Main sections">
            {NAV.map((item) => (
              <button
                key={item.id}
                type="button"
                className="nav__item"
                aria-current={view === item.id ? 'page' : undefined}
                onClick={() => setView(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <span className="masthead__spacer" />

          <div className="masthead__actions">
            <div className="masthead__user">
              <strong>{user.name}</strong>
              <span className="sw-label">{user.role === 'admin' ? 'Administrator' : 'User'}</span>
            </div>

            {user.role === 'admin' && (
              <button
                className={`btn btn--small ${view === 'admin' ? 'btn--primary' : 'btn--ghost'}`}
                onClick={() => setView(view === 'admin' ? 'lookup' : 'admin')}
              >
                {view === 'admin' ? 'Back to lookup' : 'Admin portal'}
              </button>
            )}

            <button className="btn btn--ghost btn--small" onClick={signOut}>
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="shell__body">
        {view === 'admin' && <AdminPortal me={user} />}
        {view === 'network' && <NetworkStatusPage />}
        {view === 'faults' && <FaultsPage />}
        {view === 'orders' && <OrdersPage />}
        {view === 'sims' && <SimsPage />}
        {view === 'tools' && <ToolsPage />}

        {view === 'lookup' && (
          <>
            <SearchBar onSubmit={runSearch} onPickAddress={pickAddress} busy={busy} initialValue={initialQuery} />

            {error && <Alert tone="error">{error}</Alert>}

            {busy && !report && (
              <Card title="Looking up…" accent={1}>
                <Spinner label="Checking address, availability, coverage and lines" />
              </Card>
            )}

            {/* Address picker — a postcode always resolves to a choice. */}
            {!report && result?.suggestions?.length ? (
              <Card
                title="Choose the exact address"
                eyebrow={`${result.suggestions.length} premises found`}
                index="01"
                accent={1}
                flush
                meta={
                  <button className="btn btn--primary btn--small" onClick={() => setPickerOpen(true)}>
                    Pick an address
                  </button>
                }
              >
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Address</th>
                        <th>Post town</th>
                        <th>UPRN</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {result.suggestions.map((s) => (
                        <tr key={s.id}>
                          <td><strong style={{ color: 'var(--sw-ink)' }}>{s.label}</strong></td>
                          <td>{s.postTown}</td>
                          <td className="sw-mono">{s.uprn ?? '—'}</td>
                          <td style={{ textAlign: 'right' }}>
                            <button className="btn btn--primary btn--small" onClick={() => pickAddress(s)} disabled={busy}>
                              Open
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            ) : null}

            {report && <SiteReportView report={report} onOpenSibling={loadSite} busy={busy} tab={tab} setTab={setTab} />}

            <AddressPickerDialog
              open={pickerOpen}
              onClose={() => setPickerOpen(false)}
              suggestions={result?.suggestions ?? []}
              heading={result?.query.kind === 'postcode' ? result.query.normalised : (result?.query.raw ?? '')}
              filter={pickerFilter}
              onFilterChange={setPickerFilter}
              onPick={pickAddress}
              busy={busy}
            />

            {!report && !result && !busy && !error && (
              <Card title="Everything about a site, from one box" accent={1}>
                <Empty title="Type a postcode, an address, a UPRN, a phone number or a line ID">
                  A postcode gives you every premises to choose from. An address, UPRN, CLI, Openreach access line ID,
                  service ID or ONT serial goes straight to the site. Whatever you type, you get the full address and
                  UPRN, what can be ordered there, what mobile signal to expect, and every line already in place.
                </Empty>
              </Card>
            )}
          </>
        )}
      </main>

      <footer className="footer">
        <div className="footer__rule" aria-hidden="true" />
        <div className="footer__band">
          <div className="footer__inner">
            <span>
              SupportWizard – a division of ClubWizard Ltd · 26 Fitzroy Square, London W1T 6ES ·
              help@supportwizard.net · +44 20 7043 3171
            </span>
            <span className="footer__classification">SupportWizard Internal · Confidential</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The site report
 * ------------------------------------------------------------------ */

function SiteReportView({
  report,
  onOpenSibling,
  busy,
  tab,
  setTab,
}: {
  report: SiteReport;
  onOpenSibling: (uprn: string) => void;
  busy: boolean;
  tab: ReportTab;
  setTab: (tab: ReportTab) => void;
}): ReactElement {
  const [siblingsOpen, setSiblingsOpen] = useState(false);
  const [siblingFilter, setSiblingFilter] = useState('');

  const degraded = Object.entries(report.status).filter(([, s]) => !s.ok);
  const usingDemoData = Object.values(report.status).some((s) => s.mode === 'mock');

  const orderable = report.broadband?.offers.filter((o) => o.status === 'available').length;
  const criticalFlags = report.broadband?.openreach?.flags.filter((f) => f.level === 'critical').length ?? 0;
  const openFaults = report.lines.reduce((n, l) => n + (l.faults?.length ?? 0), 0);

  const tabs: Array<TabDef<ReportTab>> = [
    { id: 'broadband', label: 'Broadband', ...(orderable ? { count: orderable } : {}) },
    {
      id: 'openreach',
      label: 'Openreach',
      ...(report.broadband?.openreach?.flags.length ? { count: report.broadband.openreach.flags.length } : {}),
      ...(criticalFlags ? { tone: 'crit' as const } : {}),
    },
    { id: 'signal', label: 'Mobile signal', ...(report.signal?.operators.length ? { count: report.signal.operators.length } : {}) },
    {
      id: 'lines',
      label: 'Lines',
      ...(report.lines.length ? { count: report.lines.length } : {}),
      ...(openFaults ? { tone: 'crit' as const } : {}),
    },
  ];

  const siblings = report.siblings ?? [];
  const filteredSiblings = siblingFilter.trim()
    ? siblings.filter((s) =>
        `${s.label} ${s.uprn ?? ''}`.toLowerCase().includes(siblingFilter.trim().toLowerCase()),
      )
    : siblings;

  return (
    <>
      <IdentityBox
        address={report.address}
        {...(report.uprn ? { uprn: report.uprn } : {})}
        extra={
          <div className="row" style={{ gap: 6 }}>
            {usingDemoData && (
              <Chip tone="warn" dot title="At least one panel is showing fixture data because a provider is not connected">
                Demo data
              </Chip>
            )}
            {siblings.length > 0 && (
              <button className="btn btn--ghost btn--small" onClick={() => setSiblingsOpen(true)}>
                {siblings.length} more at this postcode
              </button>
            )}
            <button className="btn btn--ghost btn--small" onClick={() => window.print()}>
              Print
            </button>
          </div>
        }
      />

      {degraded.length > 0 && (
        <Alert tone="warn">
          <span>{degraded.map(([name, s]) => `${name}: ${s.error ?? 'unavailable'}`).join(' · ')}</span>
        </Alert>
      )}

      <Tabs tabs={tabs} active={tab} onChange={setTab} variant="primary" label="Site sections" />

      {busy && (
        <div style={{ marginBottom: 12 }}>
          <Spinner label="Refreshing…" />
        </div>
      )}

      <TabPanel>
        {tab === 'broadband' &&
          (report.broadband ? (
            <BroadbandPanel data={report.broadband} />
          ) : (
            <Card title="Broadband availability" eyebrow="Wholesale and retail" index="01" accent={1}>
              <Empty title="No availability data">
                {report.status.broadband.error ?? 'No availability provider is connected for this premises.'}
              </Empty>
            </Card>
          ))}

        {tab === 'openreach' &&
          (report.broadband ? (
            <OpenreachPanel data={report.broadband} />
          ) : (
            <Card title="Openreach detail" eyebrow="Access network" index="02" accent={2}>
              <Empty title="No Openreach data">{report.status.broadband.error ?? 'Not available.'}</Empty>
            </Card>
          ))}

        {tab === 'signal' &&
          (report.signal ? (
            <SignalPanel data={report.signal} />
          ) : (
            <Card title="Mobile coverage" eyebrow="At this premises" index="03" accent={4}>
              <Empty title="No coverage data">
                {report.status.signal.error ?? 'No mobile coverage provider is connected.'}
              </Empty>
            </Card>
          ))}

        {tab === 'lines' && <LinesPanel lines={report.lines} />}
      </TabPanel>

      <div style={{ marginTop: 18 }}>
        <Label>
          Report generated {new Date(report.generatedAt).toLocaleString('en-GB')} · query “{report.query.raw}” read as{' '}
          {report.query.kind}
        </Label>
      </div>

      {/* ---- Other premises at this postcode ---------------------------- */}
      <Modal
        open={siblingsOpen}
        onClose={() => setSiblingsOpen(false)}
        eyebrow={report.address.postcode}
        title="Other premises at this postcode"
        subtitle={`${siblings.length} other addresses share this postcode. Pick one to jump straight to it.`}
        width="wide"
        flush
        footer={
          <>
            <span className="grow" />
            <button type="button" className="btn btn--ghost" onClick={() => setSiblingsOpen(false)}>
              Close
            </button>
          </>
        }
      >
        <div style={{ padding: '14px 20px 0' }}>
          <label className="field" style={{ marginBottom: 12 }}>
            <Label>Filter</Label>
            <input
              className="field__input"
              value={siblingFilter}
              onChange={(event) => setSiblingFilter(event.target.value)}
              placeholder="Flat number, street or UPRN…"
              autoFocus
            />
          </label>
        </div>
        <div className="table-wrap" style={{ maxHeight: 420 }}>
          <table className="data">
            <thead>
              <tr>
                <th>Address</th>
                <th>UPRN</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filteredSiblings.map((s) => (
                <tr
                  key={s.id}
                  className="clickable"
                  onClick={() => {
                    if (!s.uprn) return;
                    setSiblingsOpen(false);
                    onOpenSibling(s.uprn);
                  }}
                >
                  <td>{s.label}</td>
                  <td className="sw-mono">{s.uprn ?? '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      className="btn btn--ghost btn--small"
                      disabled={!s.uprn || busy}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (!s.uprn) return;
                        setSiblingsOpen(false);
                        onOpenSibling(s.uprn);
                      }}
                    >
                      Open
                    </button>
                  </td>
                </tr>
              ))}
              {filteredSiblings.length === 0 && (
                <tr>
                  <td colSpan={3} className="muted" style={{ padding: 20, textAlign: 'center' }}>
                    Nothing matches “{siblingFilter}”.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Modal>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Address picker
 * ------------------------------------------------------------------ */

function AddressPickerDialog({
  open,
  onClose,
  suggestions,
  heading,
  filter,
  onFilterChange,
  onPick,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  suggestions: AddressSuggestion[];
  heading: string;
  filter: string;
  onFilterChange: (value: string) => void;
  onPick: (suggestion: AddressSuggestion) => void;
  busy: boolean;
}): ReactElement | null {
  if (!open) return null;

  const needle = filter.trim().toLowerCase();
  const rows = needle
    ? suggestions.filter((s) => `${s.label} ${s.uprn ?? ''}`.toLowerCase().includes(needle))
    : suggestions;

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={heading}
      title="Choose the exact address"
      subtitle={`${suggestions.length} premises share this postcode. Pick one to see availability, coverage and lines.`}
      width="wide"
      flush
      footer={
        <>
          <span className="grow muted" style={{ fontSize: 11.5 }}>
            Showing {rows.length} of {suggestions.length}
          </span>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <div style={{ padding: '14px 20px 0' }}>
        <label className="field" style={{ marginBottom: 12 }}>
          <Label>Narrow it down</Label>
          <input
            className="field__input"
            value={filter}
            onChange={(event) => onFilterChange(event.target.value)}
            placeholder="House number, flat, street or UPRN…"
            autoFocus
            spellCheck={false}
          />
        </label>
      </div>
      <div className="table-wrap" style={{ maxHeight: 440 }}>
        <table className="data">
          <thead>
            <tr>
              <th>Address</th>
              <th>Post town</th>
              <th>UPRN</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} className="clickable" onClick={() => onPick(s)}>
                <td>
                  <strong style={{ color: 'var(--sw-ink)' }}>{s.label}</strong>
                </td>
                <td>{s.postTown}</td>
                <td className="sw-mono">{s.uprn ?? '—'}</td>
                <td style={{ textAlign: 'right' }}>
                  <button
                    className="btn btn--ghost btn--small"
                    disabled={busy}
                    onClick={(event) => {
                      event.stopPropagation();
                      onPick(s);
                    }}
                  >
                    Open
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="muted" style={{ padding: 22, textAlign: 'center' }}>
                  Nothing matches “{filter}”.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
