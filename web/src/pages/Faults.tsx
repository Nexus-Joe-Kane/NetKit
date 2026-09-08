import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { FaultCategory, FaultRecord, SiteContact } from '@sw/shared';
import { HOUSE_CONTACT, siteContactLabel, siteVisitBookedMessage, slaState } from '@sw/shared';
import { useTabRoute } from '../lib/route';
import { ApiClientError, api } from '../lib/api';
import { Alert, Card, Cell, Chip, ExportButtons, Label, Spinner, formatDateTime, type ChipTone } from '../components/ui';
import type { CsvColumn } from '../lib/csv';
import { Tabs, TabPanel, type TabDef } from '../components/Tabs';
import { Modal } from '../components/overlay';

/**
 * Faults — the open book, closed history, and raising a new one.
 *
 * The raise form deliberately requires what has already been tested. Every
 * provider rejects faults without it, and a chargeable no-fault-found visit
 * is the expensive outcome of skipping it.
 */

const STATE_TONE: Record<FaultRecord['state'], ChipTone> = {
  open: 'crit',
  engineer_assigned: 'warn',
  awaiting_customer: 'warn',
  cleared: 'ok',
  closed: 'idle',
  unknown: 'idle',
};

const CATEGORY_LABEL: Record<FaultCategory, string> = {
  synchronisation: 'Sync',
  performance: 'Performance',
  authentication: 'Authentication',
  voice: 'Voice',
  other: 'Other',
};

const FAULT_COLUMNS: Array<CsvColumn<FaultRecord>> = [
  { header: 'Reference', value: (f) => f.reference },
  { header: 'Service reference', value: (f) => f.zenReference },
  { header: 'Service ID', value: (f) => f.serviceId },
  { header: 'CLI', value: (f) => f.cli },
  { header: 'Category', value: (f) => CATEGORY_LABEL[f.category] },
  { header: 'Frequency', value: (f) => f.frequency },
  { header: 'State', value: (f) => f.state },
  { header: 'Provider status', value: (f) => f.status },
  { header: 'Summary', value: (f) => f.summary },
  { header: 'Raised', value: (f) => f.raisedAt },
  { header: 'Raised by', value: (f) => f.raisedBy },
  { header: 'Cleared', value: (f) => f.clearedAt },
  { header: 'Care level', value: (f) => f.careLevel },
  { header: 'SLA target', value: (f) => f.slaTarget },
  { header: 'SLA remaining', value: (f) => slaState(f)?.label },
  { header: 'Committed fix', value: (f) => f.committedAt },
  { header: 'Appointment date', value: (f) => f.appointment?.date },
  { header: 'Appointment slot', value: (f) => f.appointment?.slot },
  { header: 'Chargeable risk', value: (f) => f.chargeableRisk },
  { header: 'Address', value: (f) => f.address?.singleLine },
  { header: 'Postcode', value: (f) => f.address?.postcode },
  { header: 'Updates', value: (f) => f.updates?.length ?? 0 },
];

type Tab = 'open' | 'closed';

const TABS = ['open', 'closed'] as const;

export function FaultsPage(): ReactElement {
  // The open tab lives in the URL, so a refresh or a pasted link comes back
  // to the same one.
  const [tab, setTab] = useTabRoute<Tab>('faults', TABS, 'open');
  const [faults, setFaults] = useState<FaultRecord[]>([]);
  const [mode, setMode] = useState<'live'>('live');
  const [providerError, setProviderError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<FaultRecord | null>(null);
  const [raising, setRaising] = useState(false);
  const [raised, setRaised] = useState<FaultRecord | null>(null);

  const load = useCallback(async (state: Tab) => {
    setLoading(true);
    try {
      const result = await api.faults(state);
      setFaults(result.faults);
      setMode(result.mode);
      setProviderError(result.providerError);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not load faults.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(tab);
  }, [load, tab]);

  const tabs: Array<TabDef<Tab>> = [
    { id: 'open', label: 'Open', ...(tab === 'open' && faults.length ? { count: faults.length, tone: 'crit' as const } : {}) },
    { id: 'closed', label: 'Recently closed', ...(tab === 'closed' && faults.length ? { count: faults.length } : {}) },
  ];

  const withEngineer = faults.filter((f) => f.state === 'engineer_assigned').length;
  const awaitingCustomer = faults.filter((f) => f.state === 'awaiting_customer').length;
  const chargeable = faults.filter((f) => f.chargeableRisk).length;

  return (
    <div className="stack">
      {error && <Alert tone="error">{error}</Alert>}
      {providerError && (
        <Alert tone="warn">
          <span>This is incomplete — the live call failed: {providerError}</span>
        </Alert>
      )}

      {tab === 'open' && (
        <section className="card card--accent-1">
          <div className="headline">
            <div className="headline__tile">
              <Label>Open faults</Label>
              <div className="headline__big" style={{ color: faults.length ? 'var(--sw-crit-ink)' : 'var(--sw-ok)' }}>
                {faults.length}
              </div>
              <div className="headline__sub">across all services</div>
            </div>
            <div className="headline__tile">
              <Label>Engineer assigned</Label>
              <div className="headline__big">{withEngineer}</div>
              <div className="headline__sub">visit booked</div>
            </div>
            <div className="headline__tile">
              <Label>Awaiting customer</Label>
              <div className="headline__big" style={{ color: awaitingCustomer ? 'var(--sw-amber-ink)' : 'var(--sw-ink)' }}>
                {awaitingCustomer}
              </div>
              <div className="headline__sub">chase these first</div>
            </div>
            <div className="headline__tile">
              <Label>Chargeable risk</Label>
              <div className="headline__big" style={{ color: chargeable ? 'var(--sw-amber-ink)' : 'var(--sw-ink)' }}>
                {chargeable}
              </div>
              <div className="headline__sub">could bill on no fault found</div>
            </div>
          </div>
        </section>
      )}

      <Card
        title="Faults"
        eyebrow="Zen Assurance"
        index="01"
        accent={2}
        flush
        meta={
          <>
            <Chip tone="ok" dot>Live</Chip>
            <ExportButtons rows={faults} columns={FAULT_COLUMNS} filenamePrefix={`faults-${tab}`} label="the fault book" />
            <button className="btn btn--primary btn--small" onClick={() => setRaising(true)}>
              Raise a fault
            </button>
          </>
        }
        tabs={<Tabs tabs={tabs} active={tab} onChange={setTab} variant="sub" label="Fault sections" />}
      >
        <TabPanel>
          {loading ? (
            <div style={{ padding: 18 }}>
              <Spinner label="Loading faults…" />
            </div>
          ) : faults.length === 0 ? (
            <div className="empty">
              <h3>{tab === 'open' ? 'No open faults' : 'Nothing recently closed'}</h3>
              <p>
                {tab === 'open'
                  ? 'Nothing is currently raised. Check Network status before raising one — an area outage should not become a per-site fault.'
                  : 'No faults have been closed recently.'}
              </p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Reference</th>
                    <th>Service</th>
                    <th>Category</th>
                    <th>Summary</th>
                    <th>State</th>
                    <th>SLA</th>
                    <th>Raised</th>
                  </tr>
                </thead>
                <tbody>
                  {faults.map((fault) => (
                    <tr key={fault.reference} className="clickable" onClick={() => setDetail(fault)}>
                      <td className="sw-mono">{fault.reference}</td>
                      <td className="sw-mono" style={{ fontSize: 12 }}>
                        {fault.cli ?? fault.serviceId ?? fault.zenReference ?? '—'}
                      </td>
                      <td>
                        <Chip tone="idle">{CATEGORY_LABEL[fault.category]}</Chip>
                        {fault.frequency && (
                          <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>{fault.frequency}</div>
                        )}
                      </td>
                      <td style={{ maxWidth: 300 }}>{fault.summary}</td>
                      <td><SlaChip fault={fault} /></td>
                      <td>
                        <Chip tone={STATE_TONE[fault.state]} dot>
                          {fault.status}
                        </Chip>
                        {fault.chargeableRisk && (
                          <div style={{ marginTop: 3 }}>
                            <Chip tone="warn">Chargeable risk</Chip>
                          </div>
                        )}
                      </td>
                      <td style={{ whiteSpace: 'nowrap', fontSize: 12.5 }}>{formatDateTime(fault.raisedAt) ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabPanel>
      </Card>

      <FaultModal fault={detail} onClose={() => setDetail(null)} />

      <RaiseFaultModal
        open={raising}
        onClose={() => setRaising(false)}
        onRaised={(fault) => {
          setRaising(false);
          setRaised(fault);
          void load(tab);
        }}
      />

      <Modal
        open={raised !== null}
        onClose={() => setRaised(null)}
        title={raised?.reference === 'DEMO-NOT-RAISED' ? 'Nothing was raised' : 'Fault raised'}
        subtitle={raised?.reference === 'DEMO-NOT-RAISED' ? undefined : raised?.reference}
        width="narrow"
        footer={
          <button type="button" className="btn btn--primary" onClick={() => setRaised(null)}>
            Done
          </button>
        }
      >
        <p style={{ margin: 0 }}>
          The fault is with Zen as <strong className="sw-mono">{raised?.reference}</strong>. It will appear in the
          open list, and updates from the supplier land on its timeline.
        </p>
      </Modal>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Fault detail
 * ------------------------------------------------------------------ */

export function FaultModal({ fault, onClose }: { fault: FaultRecord | null; onClose: () => void }): ReactElement | null {
  if (!fault) return null;

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={`${CATEGORY_LABEL[fault.category]} fault`}
      title={fault.summary}
      subtitle={fault.reference}
      {...(fault.state === 'open' ? { tone: 'danger' as const } : {})}
      footer={
        <>
          <span className="grow muted" style={{ fontSize: 11.5 }}>
            {fault.provider}
          </span>
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="stack stack--tight">
        {fault.detail && (
          <div className="flag flag--info">
            <span className="flag__marker" aria-hidden="true" />
            <span className="flag__detail">{fault.detail}</span>
          </div>
        )}

        <SiteVisitNotice fault={fault} />

        {fault.chargeableRisk && (
          <div className="flag flag--warn">
            <span className="flag__marker" aria-hidden="true" />
            <span>
              <strong>Chargeable risk</strong>
              <span className="flag__detail">
                If the engineer finds no network fault, the visit is likely to be billed. Confirm the customer has
                tested at the master socket with known-good equipment.
              </span>
            </span>
          </div>
        )}

        <div className="kv">
          <Cell label="Status" value={fault.status} />
          <Cell label="Category" value={CATEGORY_LABEL[fault.category]} />
          <Cell label="Frequency" value={fault.frequency} />
          <Cell label="Raised" value={formatDateTime(fault.raisedAt)} />
          <Cell label="Raised by" value={fault.raisedBy} />
          <Cell label="Cleared" value={formatDateTime(fault.clearedAt)} />
          <Cell label="Care level" value={fault.careLevel} />
          <Cell label="SLA target" value={formatDateTime(fault.slaTarget)} />
          <Cell label="Committed" value={formatDateTime(fault.committedAt)} />
          <Cell label="Zen reference" value={fault.zenReference} mono copy />
          <Cell label="Service ID" value={fault.serviceId} mono copy />
          <Cell label="CLI" value={fault.cli} mono copy />
        </div>

        {fault.appointment && (
          <div className="flag flag--info">
            <span className="flag__marker" aria-hidden="true" />
            <span>
              <strong>Engineer visit booked</strong>
              <span className="flag__detail">
                {formatDateTime(fault.appointment.date)}
                {fault.appointment.slot ? `, ${fault.appointment.slot}` : ''} · {fault.appointment.status ?? 'Booked'}
                {fault.appointment.type ? ` · ${fault.appointment.type}` : ''}
              </span>
            </span>
          </div>
        )}

        {fault.updates?.length ? (
          <div>
            <Label>Updates — newest first</Label>
            <div className="timeline" style={{ marginTop: 8 }}>
              {fault.updates.map((update, i) => (
                <div key={i} className="timeline__item">
                  <span className="timeline__dot" aria-hidden="true" />
                  <div>
                    <div className="sw-label">
                      {formatDateTime(update.at)}
                      {update.author ? ` · ${update.author}` : ''}
                    </div>
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

/* ------------------------------------------------------------------ *
 * Raising a fault
 * ------------------------------------------------------------------ */

export function RaiseFaultModal({
  open,
  onClose,
  onRaised,
  presetZenReference,
}: {
  open: boolean;
  onClose: () => void;
  onRaised: (fault: FaultRecord) => void;
  presetZenReference?: string;
}): ReactElement | null {
  const [form, setForm] = useState({
    zenReference: presetZenReference ?? '',
    category: 'synchronisation' as FaultCategory,
    frequency: 'intermittent' as 'intermittent' | 'permanent',
    summary: '',
    testsCarriedOut: '',
    siteNotes: '',
    ticketId: '',
    ccEngineer: false,
    siteContactId: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * The customer's own contacts, loaded from the ticket.
   *
   * A picker rather than a text box, because the name and number handed to an
   * engineer who is about to knock on a door has to be right, and a
   * misremembered mobile number is a wasted visit somebody gets charged for.
   * Limited to the organisation the ticket belongs to, so it cannot offer
   * somebody from a different customer.
   */
  const [contacts, setContacts] = useState<SiteContact[] | null>(null);
  const [contactsError, setContactsError] = useState<string | null>(null);
  const chosenContact = contacts?.find((c) => c.id === form.siteContactId);

  const ticketId = form.ticketId.trim();
  useEffect(() => {
    if (!/^#?\d{1,12}$/.test(ticketId)) {
      setContacts(null);
      setContactsError(null);
      return;
    }
    let live = true;
    // A short delay so a ticket number being typed does not fire a request
    // per keystroke.
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await api.ticketContacts(ticketId);
          if (live) {
            setContacts(result.contacts);
            setContactsError(null);
          }
        } catch (err) {
          if (live) {
            setContacts(null);
            setContactsError(err instanceof ApiClientError ? err.message : 'Could not read that ticket.');
          }
        }
      })();
    }, 400);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [ticketId]);

  useEffect(() => {
    if (open && presetZenReference) setForm((f) => ({ ...f, zenReference: presetZenReference }));
  }, [open, presetZenReference]);

  if (!open) return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.raiseFault({
        zenReference: form.zenReference.trim(),
        category: form.category,
        frequency: form.frequency,
        summary: form.summary.trim(),
        ...(form.testsCarriedOut.trim() ? { testsCarriedOut: form.testsCarriedOut.trim() } : {}),
        ...(form.siteNotes.trim() ? { siteNotes: form.siteNotes.trim() } : {}),
        ...(ticketId ? { ticketId } : {}),
        ...(form.ccEngineer ? { ccEngineer: true } : {}),
        ...(chosenContact
          ? {
              siteContactId: chosenContact.id,
              siteContactName: chosenContact.name,
              ...(chosenContact.email ? { siteContactEmail: chosenContact.email } : {}),
              ...(chosenContact.phone ? { siteContactPhone: chosenContact.phone } : {}),
            }
          : {}),
      });
      // The fault is raised even if the ticket note failed — saying so is the
      // point, because an error would read as "the fault was not raised".
      if (result.ticket?.attempted && !result.ticket.posted) {
        setError(`Fault raised, but nothing was written to ticket ${ticketId}: ${result.ticket.error}`);
        setBusy(false);
        return;
      }
      onRaised(result.fault);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not raise the fault.');
    } finally {
      setBusy(false);
    }
  };

  const ready = form.zenReference.trim().length > 0 && form.summary.trim().length >= 10;

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Zen Assurance"
      title="Raise a fault"
      subtitle="Goes to Zen, who pass it to the access provider. Anything you put here reaches the engineer."
      footer={
        <>
          <span className="grow" />
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" onClick={submit} disabled={busy || !ready}>
            {busy ? 'Raising…' : 'Raise fault'}
          </button>
        </>
      }
    >
      <form onSubmit={submit}>
        {error && <Alert tone="error">{error}</Alert>}

        <div className="flag flag--warn" style={{ marginBottom: 14 }}>
          <span className="flag__marker" aria-hidden="true" />
          <span>
            <strong>Check Network status first</strong>
            <span className="flag__detail">
              If an area outage is already open, a per-site fault will be rejected or closed as a duplicate.
            </span>
          </span>
        </div>

        <label className="field">
          <Label>Zen service reference</Label>
          <input
            className="field__input sw-mono"
            value={form.zenReference}
            onChange={(e) => setForm({ ...form, zenReference: e.target.value })}
            placeholder="ZEN1234567"
            required
            {...(presetZenReference ? { readOnly: true } : { autoFocus: true })}
          />
        </label>

        <div className="two-col">
          <label className="field">
            <Label>Category</Label>
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as FaultCategory })}>
              <option value="synchronisation">Synchronisation — dropping or no sync</option>
              <option value="performance">Performance — slow throughput</option>
              <option value="authentication">Authentication — not connecting</option>
            </select>
          </label>

          <label className="field">
            <Label>Frequency</Label>
            <select
              value={form.frequency}
              onChange={(e) => setForm({ ...form, frequency: e.target.value as 'intermittent' | 'permanent' })}
            >
              <option value="intermittent">Intermittent — comes and goes</option>
              <option value="permanent">Permanent — constant</option>
            </select>
          </label>
        </div>

        <label className="field">
          <Label>What is happening</Label>
          <textarea
            value={form.summary}
            onChange={(e) => setForm({ ...form, summary: e.target.value })}
            rows={3}
            required
            placeholder="Line drops 6–8 times a day, mostly late afternoon. Router logs show DSL retrains, not PPP failures."
          />
          <span className="field__hint">
            At least a sentence. Specific symptoms and timings get a fault accepted; “internet not working” does not.
          </span>
        </label>

        <label className="field">
          <Label>Tests already carried out</Label>
          <textarea
            value={form.testsCarriedOut}
            onChange={(e) => setForm({ ...form, testsCarriedOut: e.target.value })}
            rows={3}
            placeholder="Tested at the master socket with a known-good router. Microfilter swapped. xDSL test run — SNR 12 dB, banded profile applied."
          />
          <span className="field__hint">
            Strongly recommended. Without it the provider may bill a no-fault-found visit.
          </span>
        </label>

        <div className="two-col">
          <label className="field">
            <Label>Ticket number (optional)</Label>
            <input
              className="field__input"
              value={form.ticketId}
              onChange={(e) => setForm({ ...form, ticketId: e.target.value, siteContactId: '' })}
              placeholder="48213"
              inputMode="numeric"
            />
            <span className="field__hint">
              What was sent to the supplier and what came back is added as a <strong>private note</strong> —
              engineers see it, the customer does not.
            </span>
          </label>

          <label className="field">
            <Label>Site contact</Label>
            <select
              className="field__input"
              value={form.siteContactId}
              onChange={(e) => setForm({ ...form, siteContactId: e.target.value })}
              disabled={!contacts?.length}
            >
              <option value="">
                {contacts === null
                  ? 'Enter a ticket number to load contacts'
                  : contacts.length === 0
                    ? 'No contacts on that ticket'
                    : 'Nobody — use the support desk'}
              </option>
              {(contacts ?? []).map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {siteContactLabel(contact)}
                </option>
              ))}
            </select>
            <span className="field__hint">
              {contactsError
                ? contactsError
                : chosenContact?.phone
                  ? `The supplier will be given ${chosenContact.name} on ${chosenContact.phone}.`
                  : chosenContact
                    ? `${chosenContact.name} has no phone number on the ticket — the supplier gets the desk number.`
                    : 'Only contacts at this customer, taken from the ticket.'}
            </span>
          </label>
        </div>

        {/* The contact the supplier actually gets. Stated rather than left as
            a form default somebody could type over. */}
        <div className="flag flag--info" style={{ marginBottom: 14 }}>
          <span className="flag__marker" aria-hidden="true" />
          <span>
            <strong>The supplier gets the desk, not you</strong>
            <span className="flag__detail">
              Every fault goes out with {HOUSE_CONTACT.email} and {HOUSE_CONTACT.phone}, so an update reaches
              whoever is on rather than sitting in one inbox. Tick below to be added to the ticket as well.
            </span>
          </span>
        </div>

        <label className="field field--check" style={{ marginBottom: 14 }}>
          <input
            type="checkbox"
            checked={form.ccEngineer}
            onChange={(e) => setForm({ ...form, ccEngineer: e.target.checked })}
            disabled={!ticketId}
          />
          <span>
            Copy me in on the ticket
            <span className="field__hint" style={{ display: 'block' }}>
              {ticketId
                ? 'Adds your account email to the Zendesk ticket, so supplier updates reach you directly too.'
                : 'Needs a ticket number.'}
            </span>
          </span>
        </label>

        <label className="field" style={{ marginBottom: 0 }}>
          <Label>Access and hazard notes</Label>
          <textarea
            value={form.siteNotes}
            onChange={(e) => setForm({ ...form, siteNotes: e.target.value })}
            rows={2}
            placeholder="Report to reception. Dog on site. Ladder needed for the DP."
          />
        </label>
      </form>
    </Modal>
  );
}

/**
 * Time left on a fault's SLA.
 *
 * A date tells an operator nothing at a glance; "1h 30m" tells them whether
 * to chase now. Recomputed on a timer so a board left open on a wall does
 * not quietly go stale -- the whole point is the number counting down.
 */
function SlaChip({ fault }: { fault: FaultRecord }): ReactElement {
  const [now, setNow] = useState(() => new Date());

  const state = slaState(fault, now);

  useEffect(() => {
    // Only while a clock is actually running.
    if (!state?.live) return;
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, [state?.live]);

  if (!state) return <span className="muted">—</span>;

  const tone = state.tone === 'breached' ? 'crit' : state.tone === 'soon' ? 'warn' : 'ok';
  return (
    <Chip tone={tone} dot={state.live} title={`Target ${formatDateTime(fault.committedAt ?? fault.slaTarget) ?? ''}`}>
      {state.label}
    </Chip>
  );
}


/**
 * Tells the customer a visit is booked.
 *
 * The one message here that the customer sees. It is deliberately vague about
 * who is coming — naming Openreach invites the customer to ring them, which
 * loses us the thread and gets them nowhere, because a supplier will not
 * discuss a wholesale fault with an end customer.
 *
 * It is a button rather than automatic because NetKit does not book
 * appointments yet: the engineer books with the supplier and presses this.
 * The wording and the posting are the same either way, so when booking does
 * land it calls exactly this.
 */
function SiteVisitNotice({ fault }: { fault: FaultRecord }): ReactElement {
  const [ticketId, setTicketId] = useState('');
  const [ccEngineer, setCcEngineer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);

  const supplier = fault.provider || 'the network supplier';
  const ready = /^#?\d{1,12}$/.test(ticketId.trim());

  const send = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.notifySiteVisit(ticketId.trim(), { supplier, ccEngineer });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not write to that ticket.');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Alert tone="ok">
        The customer has been told the visit is booked, including the 24 hours’ notice and the missed-appointment
        charge.
      </Alert>
    );
  }

  return (
    <div className="stack stack--tight">
      <div>
        <Label>Engineer visit booked?</Label>
        <p className="muted" style={{ fontSize: 12.5, margin: '4px 0 8px', maxWidth: 620 }}>
          Sends the customer a <strong>public</strong> reply saying a visit is booked with the supplier and that a
          slot will follow — including the 24 hours’ notice to change it and the charge if nobody is on site. It does
          not name {supplier} to the customer.
        </p>

        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <input
            className="field__input"
            style={{ maxWidth: 160 }}
            value={ticketId}
            onChange={(e) => setTicketId(e.target.value)}
            placeholder="Ticket number"
            inputMode="numeric"
          />
          <button type="button" className="btn btn--ghost btn--small" onClick={() => setPreview((p) => !p)}>
            {preview ? 'Hide wording' : 'Read the wording'}
          </button>
          <button
            type="button"
            className="btn btn--primary btn--small"
            disabled={!ready || busy}
            onClick={() => void send()}
          >
            {busy ? 'Sending…' : 'Tell the customer'}
          </button>
        </div>

        <label className="field field--check" style={{ marginTop: 8, marginBottom: 0 }}>
          <input type="checkbox" checked={ccEngineer} onChange={(e) => setCcEngineer(e.target.checked)} />
          <span>Copy me in on the ticket</span>
        </label>
      </div>

      {preview && <pre className="ticket-preview">{siteVisitBookedMessage({ supplier })}</pre>}
      {error && <Alert tone="error">{error}</Alert>}
    </div>
  );
}
