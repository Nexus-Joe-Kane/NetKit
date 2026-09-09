import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  MAJOR_PROVIDERS,
  attributionLabel,
  dispositionDef,
  eventKindLabel,
  ispIdentity,
  providerStateLabel,
  sortEvents,
  type Disposition,
  type DispositionDef,
  type EventWan,
  type NetEvent,
} from '@sw/shared';
import { ApiClientError, api, type DashboardPayload } from '../lib/api';
import { Alert, Card, Cell, Chip, Empty, Label, Spinner, formatDateTime, relativeTime } from '../components/ui';
import { Modal } from '../components/overlay';
import { go } from '../lib/route';

/**
 * The home page.
 *
 * Four numbers, then what is on fire, then everything else. The question at
 * half past eight is "is anything wrong", and it has to be answerable before
 * anybody takes their coat off — so the glance is counts rather than lists,
 * and the lists are one click away.
 *
 * Nothing here polls. The sweep runs on the server every five minutes
 * whether or not anybody has the page open, and a browser refreshing every
 * ten seconds would only tell the same story more often. There is a Check
 * now button for when somebody wants the answer this minute.
 */

export function Dashboard(): ReactElement {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<NetEvent | null>(null);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.dashboard());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not load the dashboard.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const checkNow = async (): Promise<void> => {
    setChecking(true);
    setChecked(null);
    try {
      const outcome = await api.checkSitesNow();
      setChecked(
        outcome.skipped
          ? outcome.skipped
          : `${outcome.checked} sites checked · ${outcome.down} down · ${outcome.raised} raised` +
            (outcome.deferred ? ` · ${outcome.deferred} left for the next pass` : ''),
      );
      await load();
    } catch (err) {
      setChecked(err instanceof ApiClientError ? err.message : 'The check could not be run.');
    } finally {
      setChecking(false);
    }
  };

  if (!data && !error) return <Spinner label="Reading the board" />;

  const events = data ? sortEvents(data.events) : [];
  const worst = events.filter((e) => e.kind === 'outage');

  return (
    <div className="stack">
      {error && <Alert tone="error">{error}</Alert>}

      {/*
        The banner. Deliberately loud and deliberately conditional: a
        dashboard that shows a red bar reading "0 sites off" teaches people to
        ignore red bars.
      */}
      {worst.length > 0 && (
        <div className="siren">
          <div className="siren__mark" aria-hidden="true" />
          <div className="siren__body">
            <strong>
              {worst.length === 1
                ? `${worst[0]!.clientName} is off`
                : `${worst.length} sites are off`}
            </strong>
            <p>
              {worst
                .slice(0, 3)
                .map((e) => `${e.siteName ?? e.clientName}${e.attribution && e.attribution !== 'unclear' ? ` — ${attributionLabel(e.attribution).toLowerCase()}` : ''}`)
                .join(' · ')}
              {worst.length > 3 ? ` · and ${worst.length - 3} more` : ''}
            </p>
          </div>
          <button type="button" className="btn btn--primary btn--small" onClick={() => setOpen(worst[0]!)}>
            Open the first
          </button>
        </div>
      )}

      {data && <Glance data={data} />}

      <Card
        title="Open events"
        eyebrow={events.length ? 'worst first' : 'nothing open'}
        index="01"
        accent={1}
        flush
        meta={
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            {checked && <span className="muted" style={{ fontSize: 12 }}>{checked}</span>}
            <button type="button" className="btn btn--ghost btn--small" disabled={checking} onClick={() => void checkNow()}>
              {checking ? 'Checking…' : 'Check now'}
            </button>
          </div>
        }
      >
        {events.length === 0 ? (
          <Empty title="Nothing is open">
            Sites are checked every five minutes. Anything that fails twice in a row appears here with a ticket
            already raised.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>What</th>
                  <th>Cause</th>
                  <th>Since</th>
                  <th>Ticket</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id} className="clickable" onClick={() => setOpen(event)}>
                    <td>
                      <strong>{event.clientName}</strong>
                      {event.siteName && event.siteName !== event.clientName && (
                        <div className="muted" style={{ fontSize: 12 }}>{event.siteName}</div>
                      )}
                    </td>
                    <td>
                      <Chip tone={event.kind === 'outage' ? 'crit' : 'warn'}>{eventKindLabel(event.kind)}</Chip>
                    </td>
                    <td style={{ fontSize: 12.5 }}>
                      {event.attribution ? attributionLabel(event.attribution) : <span className="muted">—</span>}
                    </td>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 12.5 }}>
                      {relativeTime(event.environment?.downSince ?? event.openedAt)}
                    </td>
                    <td className="sw-mono" style={{ fontSize: 12 }}>
                      {event.ticketId ?? <span className="muted">not raised</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {data && <NationalStrip data={data} />}
      {data && <ProviderStrip data={data} />}
      {data && <ToolsBox />}

      <EventModal
        event={open}
        onClose={() => setOpen(null)}
        onChanged={() => {
          setOpen(null);
          void load();
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The glance
 * ------------------------------------------------------------------ */

function Glance({ data }: { data: DashboardPayload }): ReactElement {
  const g = data.glance;
  const tiles: Array<{ label: string; value: number | string; tone?: 'crit' | 'warn' | 'ok'; hint?: string }> = [
    { label: 'Sites off', value: g.sitesOff, ...(g.sitesOff ? { tone: 'crit' as const } : {}) },
    { label: 'Not staying up', value: g.sitesUnstable, ...(g.sitesUnstable ? { tone: 'warn' as const } : {}) },
    {
      label: 'Faults with suppliers',
      // A zero we could not verify is not a zero. The assurance API is
      // entitlement-gated, and reporting its 401 as "no faults" is the kind
      // of reassurance that gets somebody in trouble.
      value: data.faultsError ? '—' : g.faults,
      ...(data.faultsError ? { hint: 'Could not be read' } : {}),
    },
    { label: 'Visits booked', value: g.appointments },
    {
      label: 'Nobody has looked',
      value: g.untouched,
      ...(g.untouched ? { tone: 'warn' as const } : { tone: 'ok' as const }),
      hint: 'No human step yet',
    },
  ];

  return (
    <div className="glance">
      {tiles.map((tile) => (
        <div key={tile.label} className={`glance__tile${tile.tone ? ` glance__tile--${tile.tone}` : ''}`}>
          <span className="glance__label">{tile.label}</span>
          <span className="glance__value">{tile.value}</span>
          {tile.hint && <span className="glance__hint">{tile.hint}</span>}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Who is having a bad morning
 * ------------------------------------------------------------------ */

function ProviderStrip({ data }: { data: DashboardPayload }): ReactElement {
  // The suppliers we sell, plus anything the consoles reported that we do
  // not. Ours first, because those are the ones we can do something about.
  const rows = useMemo(() => {
    const seen = new Map(data.providers.map((p) => [p.provider, p]));
    const ours = ['Zen Internet', 'Giacom'];
    const ordered = [
      ...ours.map((name) => ({ provider: name, openEvents: seen.get(name)?.openEvents ?? 0, sites: seen.get(name)?.sites ?? [], managed: true })),
      ...data.providers
        .filter((p) => !ours.includes(p.provider))
        .map((p) => ({ ...p, managed: false })),
    ];
    return ordered;
  }, [data.providers]);

  return (
    <Card title="Our providers" eyebrow="ours first, then whatever the consoles reported" index="03" accent={3}>
      <div className="provider-strip">
        {rows.map((row) => {
          const identity = ispIdentity(row.provider);
          return (
            <div key={row.provider} className={`provider${row.openEvents ? ' provider--trouble' : ''}`}>
              <span className="provider__mark" style={{ background: identity.colour }} aria-hidden="true">
                {identity.monogram}
              </span>
              <span className="provider__name">
                {identity.name}
                {row.managed && <span className="provider__tag">managed by us</span>}
              </span>
              <span className="provider__state">
                {row.openEvents === 0 ? (
                  <Chip tone="ok">No problems</Chip>
                ) : (
                  <Chip tone="crit">
                    {row.openEvents} site{row.openEvents === 1 ? '' : 's'} down
                  </Chip>
                )}
              </span>
              {row.sites.length > 0 && <span className="provider__sites">{row.sites.join(' · ')}</span>}
            </div>
          );
        })}
      </div>
      <p className="muted" style={{ fontSize: 12.5, margin: '12px 0 0' }}>
        This is our own sites, from our own checks. For whether a supplier is down nationally, set a Downdetector
        key and {MAJOR_PROVIDERS.length} major networks appear in their own card above.
      </p>
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * Is the country having a bad morning?
 * ------------------------------------------------------------------ */

/**
 * The majors, from a national status source.
 *
 * Separate from the providers card on purpose, and the distinction matters:
 * that one is about our sites, this one is about the country. Three of our
 * customers off and BT reporting a national outage is one story; three off
 * and BT green is a different one, and merging the two into a single row
 * would lose exactly that.
 */
function NationalStrip({ data }: { data: DashboardPayload }): ReactElement | null {
  const rows = data.national ?? [];

  // Not rendered at all when nothing is configured. An empty card headed
  // "National status" is a card that teaches people the feature is broken.
  if (!rows.length && !data.nationalError) return null;

  return (
    <Card
      title="National supplier status"
      eyebrow={data.nationalHeadline ? 'something is up' : 'the country, not our sites'}
      index="02"
      accent={2}
    >
      {data.nationalError ? (
        <Alert tone="info">{data.nationalError}</Alert>
      ) : (
        <>
          {data.nationalHeadline && <Alert tone="warn">{data.nationalHeadline}</Alert>}
          <div className="provider-strip" style={{ marginTop: data.nationalHeadline ? 10 : 0 }}>
            {rows.map((row) => {
              const identity = ispIdentity(row.provider);
              const tone = row.state === 'outage' ? 'crit' : row.state === 'degraded' ? 'warn' : row.state === 'ok' ? 'ok' : 'idle';
              return (
                <div key={row.provider} className={`provider${row.state === 'outage' ? ' provider--trouble' : ''}`}>
                  <span className="provider__mark" style={{ background: identity.colour }} aria-hidden="true">
                    {identity.monogram}
                  </span>
                  <span className="provider__name">{identity.name}</span>
                  <span className="provider__state">
                    <Chip tone={tone}>{providerStateLabel(row.state)}</Chip>
                  </span>
                  {(row.reports !== undefined || row.detail) && (
                    <span className="provider__sites">
                      {row.reports !== undefined ? `${row.reports.toLocaleString('en-GB')} reports` : ''}
                      {row.detail ? ` ${row.detail}` : ''}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * Tools, in a box
 * ------------------------------------------------------------------ */

const TOOL_LINKS: Array<{ label: string; hash: string; hint: string }> = [
  { label: 'Look up an address', hash: '#/lookup', hint: 'Postcode, first line, UPRN, CLI or service reference' },
  { label: 'Faults', hash: '#/faults', hint: 'Open with suppliers' },
  { label: 'Visits', hash: '#/visits', hint: 'Booked engineer appointments' },
  { label: 'SIMs', hash: '#/sims', hint: 'The mobile estate' },
  { label: 'Orders', hash: '#/orders', hint: 'In flight and searchable' },
  { label: 'Network status', hash: '#/status', hint: 'Supplier outages and planned works' },
  { label: 'Tools', hash: '#/tools', hint: 'Bulk lookup, exports, calculators' },
  { label: 'Admin portal', hash: '#/admin', hint: 'Credentials, users, the audit log' },
];

function ToolsBox(): ReactElement {
  return (
    <Card title="Everything else" eyebrow="the rest of the portal" index="04" accent={4}>
      <div className="tool-grid">
        {TOOL_LINKS.map((tool) => (
          <button key={tool.hash} type="button" className="tool" onClick={() => go(tool.hash)}>
            <span className="tool__label">{tool.label}</span>
            <span className="tool__hint">{tool.hint}</span>
          </button>
        ))}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * One event
 * ------------------------------------------------------------------ */

/** Green tick, red cross, amber question mark. */
function Mark({ state }: { state: 'yes' | 'no' | 'unknown' }): ReactElement {
  if (state === 'yes') return <span className="mark mark--yes" title="Yes">✓</span>;
  if (state === 'no') return <span className="mark mark--no" title="No">✕</span>;
  return <span className="mark mark--unknown" title="Not known">?</span>;
}

function testRunMark(wan: EventWan): 'yes' | 'no' | 'unknown' {
  if (wan.lineTestRun === 'yes') return 'yes';
  if (wan.lineTestRun === 'no') return 'no';
  return 'unknown';
}

function testResultMark(wan: EventWan): 'yes' | 'no' | 'unknown' {
  if (wan.lineTestResult === 'pass') return 'yes';
  if (wan.lineTestResult === 'fail') return 'no';
  return 'unknown';
}

function EventModal({
  event,
  onClose,
  onChanged,
}: {
  event: NetEvent | null;
  onClose: () => void;
  onChanged: () => void;
}): ReactElement {
  const [disposition, setDisposition] = useState<Disposition | ''>('');
  const [resolution, setResolution] = useState('');
  const [reason, setReason] = useState('');
  const [signedOffBy, setSignedOffBy] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const [noteBody, setNoteBody] = useState('');
  const [noteVisibility, setNoteVisibility] = useState<'private' | 'public'>('private');
  const [noteState, setNoteState] = useState<string | null>(null);

  useEffect(() => {
    setDisposition('');
    setResolution('');
    setReason('');
    setSignedOffBy('');
    setProblem(null);
    setNoteBody('');
    setNoteState(null);
  }, [event?.id]);

  if (!event) return <Modal open={false} onClose={onClose} title="" children={null} />;

  const def: DispositionDef | undefined = disposition ? dispositionDef(disposition) : undefined;
  const anyManaged = (event.wans ?? []).some((w) => w.managed);

  const submit = async (): Promise<void> => {
    if (!disposition) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.clearEvent(event.id, {
        disposition,
        ...(resolution.trim() ? { resolution: resolution.trim() } : {}),
        ...(reason.trim() ? { exceptionReason: reason.trim() } : {}),
        ...(signedOffBy.trim() ? { signedOffBy: signedOffBy.trim() } : {}),
      });
      onChanged();
    } catch (err) {
      setProblem(err instanceof ApiClientError ? err.message : 'The event could not be closed.');
    } finally {
      setBusy(false);
    }
  };

  const postNote = async (): Promise<void> => {
    if (!noteBody.trim()) return;
    setBusy(true);
    setNoteState(null);
    try {
      await api.addEventNote(event.id, { visibility: noteVisibility, body: noteBody.trim() });
      setNoteBody('');
      setNoteState(noteVisibility === 'public' ? 'Sent to the customer, signed off by the network team.' : 'Added as an internal note.');
    } catch (err) {
      setNoteState(err instanceof ApiClientError ? err.message : 'The note could not be added.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      width="wide"
      eyebrow={eventKindLabel(event.kind)}
      title={event.clientName}
      subtitle={[event.siteName, event.address].filter(Boolean).join(' · ') || undefined}
      footer={
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button type="button" className="btn btn--ghost" onClick={onClose}>Close</button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!disposition || busy}
            onClick={() => void submit()}
          >
            {busy ? 'Working…' : def ? def.label : 'Choose an outcome'}
          </button>
        </div>
      }
    >
      <div className="stack stack--tight">
        {problem && <Alert tone="error">{problem}</Alert>}

        <Alert tone={event.kind === 'outage' ? 'error' : 'warn'}>{event.because}</Alert>

        {/* ---- The connectivity table, as specified ------------------ */}
        <div>
          <Label>Connectivity</Label>
          <div className="table-wrap" style={{ marginTop: 6 }}>
            <table className="data data--tight">
              <thead>
                <tr>
                  <th>WAN</th>
                  <th>Provider</th>
                  <th style={{ textAlign: 'center' }}>Online</th>
                  {anyManaged && <th style={{ textAlign: 'center' }}>Line test run</th>}
                  {anyManaged && <th style={{ textAlign: 'center' }}>Result</th>}
                </tr>
              </thead>
              <tbody>
                {(event.wans ?? []).map((wan) => {
                  const identity = ispIdentity(wan.providerName);
                  return (
                    <tr key={wan.id}>
                      <td className="sw-mono" style={{ whiteSpace: 'nowrap' }}>{wan.label}</td>
                      <td>
                        <span className="row" style={{ gap: 8, alignItems: 'center' }}>
                          <span className="provider__mark provider__mark--small" style={{ background: identity.colour }} aria-hidden="true">
                            {identity.monogram}
                          </span>
                          <span>
                            {identity.name}
                            {!wan.managed && <span className="muted" style={{ fontSize: 11.5, display: 'block' }}>Not managed by us</span>}
                            {wan.serviceReference && <span className="sw-mono muted" style={{ fontSize: 11.5, display: 'block' }}>{wan.serviceReference}</span>}
                          </span>
                        </span>
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <Mark state={wan.online === true ? 'yes' : wan.online === false ? 'no' : 'unknown'} />
                      </td>
                      {anyManaged && (
                        <td style={{ textAlign: 'center' }}>
                          {wan.managed ? <Mark state={testRunMark(wan)} /> : <span className="muted">—</span>}
                        </td>
                      )}
                      {anyManaged && (
                        <td style={{ textAlign: 'center' }}>
                          {wan.managed ? <Mark state={testResultMark(wan)} /> : <span className="muted">—</span>}
                        </td>
                      )}
                    </tr>
                  );
                })}
                {/* The gateway is a row too: an engineer asks about it first. */}
                <tr>
                  <td className="sw-mono">Gateway</td>
                  <td>
                    {event.environment?.gatewayName ?? 'The console'}
                    {event.environment?.gatewayModel && (
                      <span className="muted" style={{ fontSize: 11.5, display: 'block' }}>{event.environment.gatewayModel}</span>
                    )}
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <Mark
                      state={
                        event.environment?.totalDevices === undefined
                          ? 'unknown'
                          : (event.environment.offlineDevices ?? 0) >= event.environment.totalDevices
                            ? 'no'
                            : 'yes'
                      }
                    />
                  </td>
                  {anyManaged && <td style={{ textAlign: 'center' }}><span className="muted">—</span></td>}
                  {anyManaged && <td style={{ textAlign: 'center' }}><span className="muted">—</span></td>}
                </tr>
              </tbody>
            </table>
          </div>
          {(event.wans ?? [])
            .filter((w) => w.lineTestNote)
            .map((w) => (
              <p key={w.id} className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>{w.lineTestNote}</p>
            ))}
        </div>

        {/* ---- What it is, in numbers -------------------------------- */}
        <div className="kv">
          <Cell label="Offline since" value={formatDateTime(event.environment?.downSince ?? event.openedAt)} />
          <Cell label="Cause" value={event.attribution ? attributionLabel(event.attribution) : undefined} />
          <Cell
            label="Devices"
            value={
              event.environment?.totalDevices !== undefined
                ? `${event.environment.totalDevices - (event.environment.offlineDevices ?? 0)} of ${event.environment.totalDevices} reachable`
                : undefined
            }
          />
          <Cell label="Ticket" value={event.ticketId} mono />
          <Cell label="Drops in 24h" value={event.dropsInWindow ? String(event.dropsInWindow) : undefined} />
          <Cell label="UniFi site" value={event.environment?.siteId} mono />
        </div>

        {event.attributionBecause && <p style={{ fontSize: 13, margin: 0 }}>{event.attributionBecause}</p>}

        {/* ---- The line test output, verbatim ------------------------ */}
        {(event.wans ?? []).some((w) => w.lineTestOutput) && (
          <div>
            <Label>Line test output</Label>
            {(event.wans ?? [])
              .filter((w) => w.lineTestOutput)
              .map((w) => (
                <div key={w.id}>
                  <p className="muted" style={{ fontSize: 12, margin: '6px 0 2px' }}>
                    {w.label} — {w.providerName}
                    {w.serviceReference ? ` (${w.serviceReference})` : ''}
                  </p>
                  <pre className="raw">{w.lineTestOutput}</pre>
                </div>
              ))}
          </div>
        )}

        {/* ---- Mobile backup ---------------------------------------- */}
        {(event.inventory?.mobiles ?? []).length > 0 && (
          <div>
            <Label>Mobile backup</Label>
            <div className="table-wrap" style={{ marginTop: 6 }}>
              <table className="data data--tight">
                <thead>
                  <tr><th>Unit</th><th>Number</th><th>Network</th><th>Tariff</th><th>State</th></tr>
                </thead>
                <tbody>
                  {(event.inventory?.mobiles ?? []).map((m, i) => (
                    <tr key={m.iccid ?? m.msisdn ?? i}>
                      <td>{m.deviceName ?? <span className="muted">—</span>}</td>
                      <td className="sw-mono">{m.msisdn ?? <span className="muted">—</span>}</td>
                      <td>{m.operator ?? <span className="muted">—</span>}</td>
                      <td>{m.tariff ?? <span className="muted">—</span>}</td>
                      <td>{m.online === true ? 'Online' : m.online === false ? 'Not online' : (m.state ?? '—')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ---- What has been done ----------------------------------- */}
        {(event.activity ?? []).length > 0 && (
          <div>
            <Label>What has been done</Label>
            <ul className="trail">
              {(event.activity ?? []).map((step, i) => (
                <li key={i} className={step.automatic ? 'trail__item trail__item--auto' : 'trail__item'}>
                  <span className="trail__when">{formatDateTime(step.at)}</span>
                  <span className="trail__what">
                    {step.summary}
                    {step.outcome && <span className="muted"> — {step.outcome}</span>}
                  </span>
                  <span className="trail__who">
                    {step.automatic ? <Chip tone="info">Automatic</Chip> : (step.actor?.name ?? step.actor?.email ?? '')}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ---- Write to the ticket ---------------------------------- */}
        {event.ticketId && (
          <div>
            <Label>Update the ticket</Label>
            <div className="row" style={{ gap: 6, margin: '6px 0' }}>
              {(['private', 'public'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  className={`btn btn--small ${noteVisibility === v ? 'btn--primary' : 'btn--ghost'}`}
                  onClick={() => setNoteVisibility(v)}
                >
                  {v === 'private' ? 'Internal note' : 'Reply to the customer'}
                </button>
              ))}
            </div>
            <textarea
              className="field__input"
              rows={4}
              value={noteBody}
              placeholder={
                noteVisibility === 'public'
                  ? 'What the customer should know. The network team sign-off is added for you.'
                  : 'What you want the next person to know.'
              }
              onChange={(e) => setNoteBody(e.target.value)}
            />
            <div className="row" style={{ gap: 8, marginTop: 6, alignItems: 'center' }}>
              <button type="button" className="btn btn--ghost btn--small" disabled={busy || !noteBody.trim()} onClick={() => void postNote()}>
                Add to ticket {event.ticketId}
              </button>
              {noteState && <span className="muted" style={{ fontSize: 12 }}>{noteState}</span>}
            </div>
          </div>
        )}

        {/* ---- Closing it ------------------------------------------- */}
        <div>
          <Label>Close this event</Label>
          <div className="stack stack--tight" style={{ marginTop: 6 }}>
            {[...(['resolved', 'known-cause', 'exception', 'not-ours'] as const)].map((id) => {
              const d = dispositionDef(id)!;
              return (
                <label key={id} className={`choice${disposition === id ? ' choice--on' : ''}`}>
                  <input
                    type="radio"
                    name="disposition"
                    checked={disposition === id}
                    onChange={() => setDisposition(id)}
                  />
                  <span>
                    <strong>{d.label}</strong>
                    <span className="choice__hint">{d.hint}</span>
                  </span>
                </label>
              );
            })}
          </div>

          {def?.needsReport && (
            <div style={{ marginTop: 10 }}>
              <Label>Closure report — goes on the ticket</Label>
              <textarea
                className="field__input"
                rows={3}
                value={resolution}
                placeholder="What was done, whether the line tests clean now, whether the console is back."
                onChange={(e) => setResolution(e.target.value)}
              />
            </div>
          )}

          {def?.needsSignOff && (
            <div className="row" style={{ gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 320px' }}>
                <Label>Why an exception is acceptable</Label>
                <textarea
                  className="field__input"
                  rows={2}
                  value={reason}
                  placeholder="In six months this is the only record of why this site stopped being checked."
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
              <div style={{ flex: '0 1 220px' }}>
                <Label>Signed off by</Label>
                <input
                  className="field__input"
                  value={signedOffBy}
                  placeholder="Who accepted it"
                  onChange={(e) => setSignedOffBy(e.target.value)}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
