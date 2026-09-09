import { useMemo, useState, type ReactElement } from 'react';
import {
  SITE_VISIT_REASONS,
  gateBlockers,
  gateFor,
  overallSide,
  reasonConflict,
  reasonDef,
  siteVisitMessage,
  suggestedReasons,
  type AccessNeed,
  type AccessTechnology,
  type GateAnswer,
  type SiteVisitReason,
  type TestFinding,
  type VisitNeeded,
} from '@sw/shared';
import { ApiClientError, api } from '../lib/api';
import { Alert, Chip, Label } from './ui';

/**
 * Booking an engineer, and the questions that come first.
 *
 * The expensive decision in fault handling: a visit that finds nothing wrong
 * with the network is charged to us and passed to the customer, and so is one
 * where nobody is there to open the door. Both are avoidable by asking before
 * the booking rather than after the invoice, which is what this is.
 *
 * Deliberately not a wizard. Everything is on one screen, because an engineer
 * on the phone to a customer needs to see the whole shape of what they are
 * about to commit to — including the wording the customer will read — not
 * step four of six.
 */

const TECHNOLOGIES: Array<{ id: AccessTechnology | ''; label: string }> = [
  { id: '', label: 'Not sure — ask everything' },
  { id: 'FTTP', label: 'FTTP (fibre to the premises)' },
  { id: 'SOGEA', label: 'SOGEA' },
  { id: 'FTTC', label: 'FTTC' },
  { id: 'GFAST', label: 'G.fast' },
  { id: 'ADSL2+', label: 'ADSL2+' },
];

const ACCESS_OPTIONS: Array<{ id: AccessNeed; label: string }> = [
  { id: 'inside', label: 'Inside the property' },
  { id: 'outside', label: 'Outside only' },
  { id: 'unknown', label: 'Not established' },
];

export function SiteVisitBooking({
  supplier: supplierName,
  technology: knownTechnology,
  findings = [],
  contactName,
  appointment,
  ticketId: initialTicket,
}: {
  /**
   * The real supplier, for the private record on the ticket.
   *
   * It cannot reach the customer's message: siteVisitMessage ignores it and
   * always writes "the network supplier". See the note there for why.
   */
  supplier?: string;
  /** Known where the line is in hand; otherwise the engineer picks it. */
  technology?: AccessTechnology;
  /** The last line test's findings, which suggest the reason and add checks. */
  findings?: readonly TestFinding[];
  contactName?: string;
  /** The provider's own appointment, where it has already given one. */
  appointment?: { date: string; slot?: string };
  ticketId?: string;
}): ReactElement {
  const supplier = supplierName?.trim() || '';

  const [needed, setNeeded] = useState<VisitNeeded | null>(null);
  const [ticketId, setTicketId] = useState(initialTicket ?? '');
  const [technology, setTechnology] = useState<AccessTechnology | ''>(knownTechnology ?? '');
  const [reason, setReason] = useState<SiteVisitReason | ''>('');
  const [access, setAccess] = useState<AccessNeed>('unknown');
  const [slotKnown, setSlotKnown] = useState(Boolean(appointment?.date));
  const [date, setDate] = useState(appointment?.date ?? '');
  const [window, setWindow] = useState(appointment?.slot ?? '');
  const [gate, setGate] = useState<Record<string, GateAnswer>>({});
  const [ccEngineer, setCcEngineer] = useState(false);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ subject: string; warning?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const testSide = useMemo(() => (findings.length ? overallSide(findings) : undefined), [findings]);
  const suggested = useMemo(() => suggestedReasons(findings), [findings]);
  const items = useMemo(() => gateFor(technology || undefined, findings), [technology, findings]);
  const blockers = gateBlockers(items, gate);

  /*
   * The reason list, suggestions first.
   *
   * The test's own suggestion is the default so that the common case is one
   * click, and the rest of the list is right there so an engineer who
   * disagrees is not scrolling fifteen options to say so.
   */
  const reasonOptions = useMemo(() => {
    const bySuggested = SITE_VISIT_REASONS.filter((r) => suggested.includes(r.id));
    const rest = SITE_VISIT_REASONS.filter((r) => !suggested.includes(r.id));
    return { bySuggested, rest };
  }, [suggested]);

  const chosen: SiteVisitReason = reason || suggested[0] || 'unknown';
  const conflict = testSide ? reasonConflict(chosen, testSide) : { conflict: false as const };

  const slot = slotKnown && date && window.trim() ? { date, window: window.trim() } : null;
  const ticketReady = /^#?\d{1,12}$/.test(ticketId.trim());
  const slotReady = !slotKnown || Boolean(slot);
  const ready = ticketReady && slotReady && blockers.length === 0 && !busy;

  const message = siteVisitMessage({
    ...(contactName ? { contactName } : {}),
    reason: chosen,
    access,
    ...(slot ? { slot } : {}),
  });

  const send = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.notifySiteVisit(ticketId.trim().replace(/^#/, ''), {
        ...(supplier ? { supplier } : {}),
        ...(contactName ? { contactName } : {}),
        reason: chosen,
        access,
        slot,
        ...(technology ? { technology } : {}),
        ...(testSide ? { testSide } : {}),
        extraChecks: items
          .filter((i) => i.id.startsWith('test:'))
          .map((i) => ({ id: i.id, question: i.question })),
        gate,
        ccEngineer,
      });
      setDone({ subject: result.subject, ...(result.warning ? { warning: result.warning } : {}) });
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not write to that ticket.');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="stack stack--tight">
        <Alert tone="ok">
          The customer has been told, with the missed-appointment charge and the 24 hours’ notice in the message.
          Subject: <strong>{done.subject}</strong>
        </Alert>
        {done.warning && <Alert tone="warn">{done.warning}</Alert>}
      </div>
    );
  }

  /* ---- Step one: is a visit even the answer? ------------------------- */

  if (needed === null) {
    return (
      <div className="stack stack--tight">
        <Label>Does this fault need an engineer on site?</Label>
        <p className="muted" style={{ fontSize: 12.5, margin: '4px 0 8px', maxWidth: 640 }}>
          Worth a moment. A visit that finds nothing wrong with the network is charged to us and passed to the
          customer, and so is one where nobody is in.
        </p>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn--primary btn--small" onClick={() => setNeeded('yes')}>
            Yes — book one
          </button>
          <button type="button" className="btn btn--ghost btn--small" onClick={() => setNeeded('unclear')}>
            Not sure yet
          </button>
          <button type="button" className="btn btn--ghost btn--small" onClick={() => setNeeded('no')}>
            No — the supplier can fix it remotely
          </button>
        </div>
        {testSide && (
          <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>
            The last line test points at{' '}
            <strong>
              {testSide === 'network'
                ? 'the network'
                : testSide === 'customer'
                  ? 'the customer’s own side'
                  : 'nothing conclusive'}
            </strong>
            .
          </p>
        )}
      </div>
    );
  }

  if (needed === 'no') {
    return (
      <div className="stack stack--tight">
        <Alert tone="info">
          Nothing sent. The fault stays with the supplier to fix remotely — there is no customer message for that,
          because a visit is the only thing they need to plan around.
        </Alert>
        <button type="button" className="btn btn--ghost btn--small" onClick={() => setNeeded(null)}>
          Changed my mind
        </button>
      </div>
    );
  }

  /* ---- Everything else, on one screen ------------------------------- */

  return (
    <div className="stack stack--tight">
      {needed === 'unclear' && (
        <Alert tone="warn">
          Booked without a cause identified, the customer is told only that there is “a fault on the line”. If you
          can narrow it down below, the message is better and the supplier is less likely to push back.
        </Alert>
      )}

      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="field" style={{ marginBottom: 0, maxWidth: 170 }}>
          <Label>Ticket number</Label>
          <input
            className="field__input"
            value={ticketId}
            onChange={(e) => setTicketId(e.target.value)}
            placeholder="e.g. 48213"
            inputMode="numeric"
          />
        </label>

        {!knownTechnology && (
          <label className="field" style={{ marginBottom: 0, maxWidth: 260 }}>
            <Label>Line type</Label>
            <select className="field__input" value={technology} onChange={(e) => setTechnology(e.target.value as AccessTechnology | '')}>
              {TECHNOLOGIES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {/* ---- The reason, which the customer will read ----------------- */}
      <label className="field" style={{ marginBottom: 0, maxWidth: 520 }}>
        <Label>Why the engineer is coming</Label>
        <select className="field__input" value={chosen} onChange={(e) => setReason(e.target.value as SiteVisitReason)}>
          {reasonOptions.bySuggested.length > 0 && (
            <optgroup label="Suggested by the line test">
              {reasonOptions.bySuggested.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label={reasonOptions.bySuggested.length ? 'Everything else' : 'Reason'}>
            {reasonOptions.rest.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </optgroup>
        </select>
      </label>
      <p className="muted" style={{ fontSize: 12.5, margin: '2px 0 0', maxWidth: 620 }}>
        The customer is told this as “{reasonDef(chosen).customerWording}”.
      </p>
      {conflict.conflict && conflict.warning && <Alert tone="warn">{conflict.warning}</Alert>}

      {/* ---- Access, which decides what we ask of the customer -------- */}
      <div>
        <Label>Will the engineer need to come inside?</Label>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
          {ACCESS_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`btn btn--small ${access === option.id ? 'btn--primary' : 'btn--ghost'}`}
              onClick={() => setAccess(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {/* ---- The slot, or the honest absence of one ------------------- */}
      <div>
        <Label>Appointment</Label>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 6, alignItems: 'flex-end' }}>
          <button
            type="button"
            className={`btn btn--small ${slotKnown ? 'btn--primary' : 'btn--ghost'}`}
            onClick={() => setSlotKnown(true)}
          >
            Slot confirmed
          </button>
          <button
            type="button"
            className={`btn btn--small ${!slotKnown ? 'btn--primary' : 'btn--ghost'}`}
            onClick={() => setSlotKnown(false)}
          >
            No slot yet
          </button>
          {slotKnown && (
            <>
              <input
                className="field__input"
                style={{ maxWidth: 160 }}
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
              <input
                className="field__input"
                style={{ maxWidth: 170 }}
                value={window}
                onChange={(e) => setWindow(e.target.value)}
                placeholder="08:00 – 13:00, or AM"
              />
            </>
          )}
        </div>
        <p className="muted" style={{ fontSize: 12, margin: '6px 0 0', maxWidth: 620 }}>
          Both versions of the message carry the charge and the notice period. A customer told the date a day later
          would otherwise never have been told the charge at all.
        </p>
      </div>

      {/* ---- The gate ------------------------------------------------- */}
      <div>
        <Label>Before this is booked</Label>
        <p className="muted" style={{ fontSize: 12.5, margin: '4px 0 8px', maxWidth: 640 }}>
          Every one of these has been charged for at some point. The server checks them again, so skipping them
          here does not skip them.
        </p>
        <div className="stack stack--tight">
          {items.map((item) => (
            <div key={item.id} className={`gate-item${gate[item.id] === 'done' || gate[item.id] === 'not-applicable' ? ' is-clear' : ''}`}>
              <div className="gate-item__text">
                <strong>{item.question}</strong>
                <span className="muted">{item.why}</span>
              </div>
              <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                {(
                  [
                    ['done', 'Checked'],
                    ['not-applicable', 'N/A'],
                    ['not-done', 'Not yet'],
                  ] as Array<[GateAnswer, string]>
                ).map(([answer, label]) => (
                  <button
                    key={answer}
                    type="button"
                    className={`btn btn--small ${gate[item.id] === answer ? 'btn--primary' : 'btn--ghost'}`}
                    onClick={() => setGate((g) => ({ ...g, [item.id]: answer }))}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ---- Send ----------------------------------------------------- */}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" className="btn btn--ghost btn--small" onClick={() => setPreview((p) => !p)}>
          {preview ? 'Hide the wording' : 'Read the wording'}
        </button>
        <button type="button" className="btn btn--primary btn--small" disabled={!ready} onClick={() => void send()}>
          {busy ? 'Sending…' : 'Book it and tell the customer'}
        </button>
        {blockers.length > 0 && (
          <Chip tone="warn">
            {blockers.length} check{blockers.length === 1 ? '' : 's'} still open
          </Chip>
        )}
        {!ticketReady && <Chip tone="warn">Ticket number needed</Chip>}
        {slotKnown && !slot && <Chip tone="warn">Date and window needed</Chip>}
      </div>

      <label className="field field--check" style={{ marginTop: 0, marginBottom: 0 }}>
        <input type="checkbox" checked={ccEngineer} onChange={(e) => setCcEngineer(e.target.checked)} />
        <span>Copy me in on the ticket</span>
      </label>

      {preview && (
        <pre className="ticket-preview">
          {message.subject}
          {'\n\n'}
          {message.body}
        </pre>
      )}
      {error && <Alert tone="error">{error}</Alert>}
    </div>
  );
}
