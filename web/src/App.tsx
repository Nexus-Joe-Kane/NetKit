import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { AddressSuggestion, LookupSuggestion, SearchResponse, SiteReport, PrintSection } from '@sw/shared';
import { ApiClientError, api, type PublicUser, type SessionState } from './lib/api';
import { SearchBar } from './components/SearchBar';
import { IdentityBox } from './components/IdentityBox';
import { BroadbandPanel, OpenreachPanel } from './components/BroadbandPanel';
import { SignalPanel } from './components/SignalPanel';
import { LinesPanel } from './components/LinesPanel';
import { CompaniesPanel } from './components/CompaniesPanel';
import { SitePanel } from './components/SitePanel';
import { AdminPortal } from './components/AdminPortal';
import { NetworkStatusPage } from './pages/NetworkStatus';
import { FaultsPage } from './pages/Faults';
import { VisitsPage } from './pages/Visits';
import { OrdersPage } from './pages/Orders';
import { SimsPage } from './pages/Sims';
import { ToolsPage } from './pages/Tools';
import { InboxPage } from './pages/Inbox';
import { ForcePasswordChange, Login } from './components/Login';
import { Alert, Card, Chip, Empty, Label, Spinner } from './components/ui';
import { Tabs, TabPanel, type TabDef } from './components/Tabs';
import { useEdgeFade } from './lib/edgeFade';
import { Modal } from './components/overlay';
import { siteReportToText } from './lib/reportText';
import { PrintableReport } from './components/PrintableReport';
import { PrintDialog } from './components/PrintDialog';
import { ClientStandingGate } from './components/ClientStandingGate';
import { go, readRoute, toHash, useRoute } from './lib/route';
import { WatchButton } from './components/WatchPanel';
import { loadSections } from './lib/printStorage';

/**
 * Application shell.
 *
 * State is deliberately flat: a session, a search result, and which tab is
 * showing. There is no router — the whole tool is one search box and the
 * report it produces, so URL state is limited to the deep link for a UPRN.
 */

type View = 'lookup' | 'inbox' | 'network' | 'faults' | 'visits' | 'orders' | 'sims' | 'tools' | 'admin';
type ReportTab = 'broadband' | 'openreach' | 'signal' | 'lines' | 'site' | 'companies';

/** The primary navigation. `admin` is reached by its own button. */
const NAV: Array<{ id: Exclude<View, 'admin'>; label: string }> = [
  { id: 'lookup', label: 'Lookup' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'network', label: 'Network status' },
  { id: 'faults', label: 'Faults' },
  { id: 'visits', label: 'Visits' },
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

  return (
    <Portal
      user={session.user}
      onSignOut={() => setSession({ authenticated: false })}
    />
  );
}

/* ------------------------------------------------------------------ *
 * The portal
 * ------------------------------------------------------------------ */

function Portal({
  user,
  onSignOut,
}: {
  user: PublicUser;
  onSignOut: () => void;
}): ReactElement {
  /*
   * The URL is the state.
   *
   * Which page, which premises and which tab of the report all live in the
   * hash, so a refresh comes back where it was, the back button steps back
   * one tab rather than out of the app, and a link to what is on screen can
   * be pasted into a ticket.
   */
  const route = useRoute();
  const view: View = ((): View => {
    if (route.view === 'site') return 'lookup';
    const known: View[] = ['lookup', 'inbox', 'network', 'faults', 'visits', 'orders', 'sims', 'tools', 'admin'];
    return known.find((v) => v === route.view) ?? 'lookup';
  })();
  const setView = (next: View): void => go(toHash(next));

  /* Fades whichever end of the section nav has more behind it on a narrow
     screen, so the strip reads as swipeable rather than cut off, and keeps
     the current section scrolled into view. */
  const navStrip = useEdgeFade<HTMLElement>([view]);

  const [result, setResult] = useState<SearchResponse | null>(null);
  const [report, setReport] = useState<SiteReport | null>(null);

  const REPORT_TABS: ReportTab[] = ['broadband', 'openreach', 'signal', 'lines', 'site', 'companies'];
  const routedTab = REPORT_TABS.find((t) => t === route.b);
  const [fallbackTab, setFallbackTab] = useState<ReportTab>('broadband');
  const tab: ReportTab = routedTab ?? fallbackTab;
  const setTab = (next: ReportTab): void => {
    setFallbackTab(next);
    // Only a premises has tabs in its URL; without one there is nothing to
    // hang the tab off, so it stays in memory.
    if (report?.uprn) go(toHash('site', report.uprn, next));
  };
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

  /**
   * `#/site/<uprn>` loads that premises — on first paint, and again whenever
   * the address bar changes to a different one.
   *
   * Keyed on the UPRN rather than the whole route, so switching tabs inside a
   * report does not refetch it, and the back button out of a report into a
   * different one does.
   */
  const routedUprn = route.view === 'site' ? route.a : '';
  useEffect(() => {
    if (!routedUprn) return;
    if (report?.uprn === routedUprn) return;
    void loadSite(routedUprn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routedUprn]);

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
      const opening: ReportTab = response.lines?.length ? 'lines' : 'broadband';
      setFallbackTab(opening);
      if (response.report?.uprn) go(toHash('site', response.report.uprn, opening));
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
      // Keep whichever tab the link asked for; only default it when the URL
      // named none, so `#/site/x/lines` opens on Lines.
      const asked = REPORT_TABS.find((t) => t === readRoute().b);
      setFallbackTab(asked ?? 'broadband');
      go(toHash('site', uprn, asked ?? undefined), true);
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

  /**
   * A broadband service or a mobile, which open different things.
   *
   * Broadband goes through the ordinary search: a service reference already
   * resolves to the premises report with that circuit on it, so there is
   * nothing to build and nothing that can drift out of step with it.
   *
   * A mobile goes to the SIM estate with that SIM open — the page already
   * has a detail panel per SIM and fetches the full record on open, so this
   * is a deep link into it rather than a second view of the same thing.
   */
  const pickService = async (suggestion: LookupSuggestion) => {
    if (suggestion.kind === 'mobile' && suggestion.iccid) {
      go(toHash('sims', 'all', suggestion.iccid));
      return;
    }
    return runSearch(suggestion.query);
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

          <nav
            className="nav"
            aria-label="Main sections"
            ref={navStrip.ref}
            onScroll={navStrip.onScroll}
            data-edges={navStrip.edges}
          >
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
        {view === 'visits' && <VisitsPage />}
        {view === 'orders' && <OrdersPage />}
        {view === 'sims' && <SimsPage />}
        {view === 'inbox' && <InboxPage />}
        {view === 'tools' && <ToolsPage onOpenSite={(uprn) => go(toHash('site', uprn))} />}

        {view === 'lookup' && (
          <>
            <SearchBar
              onSubmit={runSearch}
              onPickAddress={pickAddress}
              onPickService={pickService}
              busy={busy}
              initialValue={initialQuery}
            />

            {error && <Alert tone="error">{error}</Alert>}

            {busy && !report && (
              <Card title="Looking up…" accent={1}>
                <Spinner label="Checking address, availability, coverage and lines" />
              </Card>
            )}

            {/* Address picker — a postcode always resolves to a choice. */}
            {!report && result?.suggestions?.length ? (
              <Card
                title={result.unmatched?.length ? 'Nothing matched every word' : 'Choose the exact address'}
                eyebrow={
                  result.unmatched?.length
                    ? `closest ${result.suggestions.length}`
                    : `${result.suggestions.length} premises found`
                }
                index="01"
                accent={1}
                flush
                meta={
                  <button className="btn btn--primary btn--small" onClick={() => setPickerOpen(true)}>
                    Pick an address
                  </button>
                }
              >
                {/* Same caveat as the typeahead: a list of near-misses under
                    "pick the exact address" is the search claiming to have
                    answered a question it has not. */}
                {result.unmatched?.length ? (
                  <div className="flag flag--warn" style={{ margin: '14px 18px 0' }}>
                    <span className="flag__marker" aria-hidden="true" />
                    <span>
                      <strong>
                        No premises came back for {result.unmatched.map((w) => `“${w}”`).join(' or ')}
                      </strong>
                      <span className="flag__detail">
                        Every address below matches the rest of what you typed. AddressBase may not carry the trading
                        name at that address yet — search the postcode, or the UPRN if you have it.
                      </span>
                    </span>
                  </div>
                ) : null}
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Address</th>
                        <th className="col-optional">Post town</th>
                        <th>UPRN</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {result.suggestions.map((s) => (
                        <tr key={s.id}>
                          <td><strong style={{ color: 'var(--sw-ink)' }}>{s.label}</strong></td>
                          <td className="col-optional">{s.postTown}</td>
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

            {report && (
              <SiteReportView
                report={report}
                onOpenSibling={loadSite}
                busy={busy}
                tab={tab}
                setTab={setTab}
                engineerName={user.name}
              />
            )}

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
  engineerName,
}: {
  report: SiteReport;
  onOpenSibling: (uprn: string) => void;
  busy: boolean;
  tab: ReportTab;
  setTab: (tab: ReportTab) => void;
  /** Who is signed in, so a nudge can greet them by name. */
  engineerName?: string;
}): ReactElement {
  const [siblingsOpen, setSiblingsOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  /**
   * What the printable report renders.
   *
   * Seeded from the remembered choice so a browser print triggered by
   * Ctrl-P, which never opens the dialog, still produces the shape this
   * person last asked for rather than an empty page.
   */
  const [printSections, setPrintSections] = useState<Set<PrintSection>>(() => loadSections());
  const [siblingFilter, setSiblingFilter] = useState('');
  const [textOpen, setTextOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const degraded = Object.entries(report.status).filter(([, s]) => !s.ok);

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
    { id: 'site', label: 'On site' },
    { id: 'companies', label: 'Who is here' },
  ];

  /*
   * Whose premises this is.
   *
   * Taken from a line at the address rather than from the companies at the
   * postcode: the register lists whoever is registered nearby, and putting a
   * neighbour's payment terms in front of an engineer is worse than showing
   * none.
   */
  const clientName = report.lines.find((l) => l.customerName)?.customerName;

  const siblings = report.siblings ?? [];
  const filteredSiblings = siblingFilter.trim()
    ? siblings.filter((s) =>
        `${s.label} ${s.uprn ?? ''}`.toLowerCase().includes(siblingFilter.trim().toLowerCase()),
      )
    : siblings;

  return (
    <>
      {/* Everything on screen. Print hides this and uses PrintableReport,
          which is the only way to get every section on paper: the tabs mount
          one panel at a time. */}
      <div className="report-interactive">
      <IdentityBox
        address={report.address}
        {...(report.uprn ? { uprn: report.uprn } : {})}
        extra={
          <div className="row" style={{ gap: 6 }}>
            {siblings.length > 0 && (
              <button className="btn btn--ghost btn--small" onClick={() => setSiblingsOpen(true)}>
                {siblings.length} more at this postcode
              </button>
            )}
            <button
              className="btn btn--ghost btn--small"
              onClick={() => {
                setCopied(false);
                setTextOpen(true);
              }}
              title="Plain text for pasting into a ticket or email"
            >
              Copy as text
            </button>
            <button
              className="btn btn--ghost btn--small"
              onClick={() => setPrintOpen(true)}
              title="Choose which sections go on the page"
            >
              Print
            </button>
            {/* A watch is keyed by UPRN, so a premises without one cannot be
                re-checked reliably and the button is not offered. */}
            {report.uprn && <WatchButton uprn={report.uprn} />}
          </div>
        }
      />

      {degraded.length > 0 && (
        <Alert tone="warn">
          <span>{degraded.map(([name, s]) => `${name}: ${s.error ?? 'unavailable'}`).join(' · ')}</span>
        </Alert>
      )}

      {/* Terms before work. The client name comes from a line at the premises
          — an address alone cannot tell us whose it is, and guessing from the
          companies at the postcode would put another business's terms in
          front of an engineer. */}
      {clientName && (
        <ClientStandingGate
          clientName={clientName}
          {...(engineerName ? { engineerName } : {})}
        />
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

        {tab === 'lines' && (
          <LinesPanel lines={report.lines} nearbyLines={report.nearbyLines ?? []} lineSearch={report.lineSearch ?? []} />
        )}

        {tab === 'site' && (
          <SitePanel
            {...(report.uprn ?? report.address.uprn ? { uprn: report.uprn ?? report.address.uprn } : {})}
            {...(report.address.organisation ? { clientName: report.address.organisation } : {})}
          />
        )}

        {tab === 'companies' && (
          <CompaniesPanel
            postcode={report.address.postcode}
            {...(report.uprn ? { uprn: report.uprn } : {})}
          />
        )}
      </TabPanel>

      <div style={{ marginTop: 18 }}>
        <Label>
          Report generated {new Date(report.generatedAt).toLocaleString('en-GB')} · query “{report.query.raw}” read as{' '}
          {report.query.kind}
        </Label>
      </div>

      </div>

      {/* Print takes this instead of the open tab. Hidden on screen. */}
      <PrintableReport report={report} sections={printSections} />

      <PrintDialog
        report={report}
        open={printOpen}
        onClose={() => setPrintOpen(false)}
        onApply={setPrintSections}
      />

      {/* ---- Plain text for a ticket ------------------------------------ */}
      <Modal
        open={textOpen}
        onClose={() => setTextOpen(false)}
        eyebrow="For pasting elsewhere"
        title="Site report as text"
        subtitle="Plain text with no formatting, so it survives a helpdesk, an email reply or a message."
        width="wide"
        footer={
          <>
            <span className="grow muted" style={{ fontSize: 11.5 }}>
              {siteReportToText(report).split('\n').length} lines
            </span>
            <button
              type="button"
              className={`btn ${copied ? 'btn--ghost' : 'btn--primary'}`}
              onClick={async () => {
                const text = siteReportToText(report);
                try {
                  await navigator.clipboard.writeText(text);
                } catch {
                  // Clipboard permission can be refused; fall back to a
                  // hidden textarea so the button still works.
                  const el = document.createElement('textarea');
                  el.value = text;
                  el.style.position = 'fixed';
                  el.style.opacity = '0';
                  document.body.appendChild(el);
                  el.select();
                  document.execCommand('copy');
                  document.body.removeChild(el);
                }
                setCopied(true);
                setTimeout(() => setCopied(false), 2500);
              }}
            >
              {copied ? 'Copied to clipboard' : 'Copy to clipboard'}
            </button>
          </>
        }
      >
        <pre className="report-text">{siteReportToText(report)}</pre>
      </Modal>

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
              <th className="col-optional">Post town</th>
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
                <td className="col-optional">{s.postTown}</td>
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
