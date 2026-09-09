import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import {
  PUBLIC_REPLY_OPENER,
  handoffProblem,
  handoffSummary,
  ticketLabel,
  type HandoffDocument,
  type NoteVisibility,
  type QueueOption,
  type TicketOption,
} from '@sw/shared';
import { ApiClientError, api } from '../lib/api';
import { Alert, Chip, Label, Spinner } from './ui';
import { Modal } from './overlay';

/**
 * Send this document to a ticket.
 *
 * Three steps, and the shape of the panel changes between them rather than
 * showing all three at once: pick the ticket, say what goes with it, then
 * check it before it goes. All three on one screen is a form; one at a time
 * is a decision, and the last one is the one that matters — the mistake being
 * guarded against is the right document on the wrong customer's ticket.
 *
 * The height is animated between steps because the content genuinely changes
 * size and a panel that jumps is a panel somebody loses their place in. The
 * animation is measured from the content rather than set to a fixed height,
 * so a long ticket subject does not get clipped.
 */

type Step = 'pick' | 'compose' | 'confirm' | 'done';

export function SendToTicket({
  open,
  onClose,
  document: doc,
}: {
  open: boolean;
  onClose: () => void;
  document: HandoffDocument;
}): ReactElement {
  const [step, setStep] = useState<Step>('pick');
  const [queues, setQueues] = useState<QueueOption[]>([]);
  const [queue, setQueue] = useState<string>('');
  const [term, setTerm] = useState('');
  const [tickets, setTickets] = useState<TicketOption[]>([]);
  const [ticket, setTicket] = useState<TicketOption | null>(null);
  const [visibility, setVisibility] = useState<NoteVisibility>('private');
  const [message, setMessage] = useState(`${PUBLIC_REPLY_OPENER}\n\n`);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState<number | undefined>(undefined);

  /* ---- The queues, loaded once ------------------------------------ */
  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const result = await api.queues();
        setQueues(result.queues);
        // The signed-in engineer's own queue, pre-selected: it is the common
        // case, and the other queues are there for the uncommon one.
        const mine = result.queues.find((q) => q.me);
        if (mine) setQueue(mine.id);
      } catch {
        // A missing queue list is not fatal — searching without one searches
        // everything, which is a wider net rather than no net.
      }
    })();
  }, [open]);

  /* ---- Live search, debounced ------------------------------------- */
  const search = useCallback(async () => {
    setSearching(true);
    try {
      const result = await api.searchTickets(term.trim(), queue || undefined);
      setTickets(result.tickets);
      setError(result.error ?? null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'The ticket search failed.');
    } finally {
      setSearching(false);
    }
  }, [term, queue]);

  useEffect(() => {
    if (!open || step !== 'pick') return;
    const timer = setTimeout(() => void search(), 220);
    return () => clearTimeout(timer);
  }, [open, step, search]);

  /* ---- Animate the height between steps --------------------------- */
  useEffect(() => {
    if (!bodyRef.current) return;
    // Measured rather than fixed, so a long subject or a failed source does
    // not get clipped by a height somebody guessed at.
    const measure = (): void => setHeight(bodyRef.current?.scrollHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bodyRef.current);
    return () => observer.disconnect();
  }, [step, tickets.length, ticket?.id, visibility, error]);

  useEffect(() => {
    if (!open) {
      setStep('pick');
      setTicket(null);
      setTerm('');
      setTickets([]);
      setMessage(`${PUBLIC_REPLY_OPENER}\n\n`);
      setError(null);
    }
  }, [open]);

  const problem = ticket
    ? handoffProblem({ visibility, ticketId: ticket.id, ...(visibility === 'public' ? { body: message } : {}) })
    : 'Choose a ticket.';

  const send = async (): Promise<void> => {
    if (!ticket || problem) return;
    setBusy(true);
    setError(null);
    try {
      await api.sendDocument(ticket.id, {
        visibility,
        filename: doc.filename,
        kind: doc.kind,
        ...(doc.about ? { about: doc.about } : {}),
        ...(doc.engineerNotes ? { engineerNotes: doc.engineerNotes } : {}),
        ...(visibility === 'public' ? { message } : {}),
      });
      setStep('done');
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'It could not be sent.');
    } finally {
      setBusy(false);
    }
  };

  const summary = ticket ? handoffSummary({ ticket, visibility, document: doc }) : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow={doc.kind}
      title={step === 'done' ? 'Sent' : 'Send to a ticket'}
      subtitle={doc.filename}
      footer={
        <div className="row" style={{ gap: 8, justifyContent: 'space-between', width: '100%' }}>
          <span>
            {step !== 'pick' && step !== 'done' && (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setStep(step === 'confirm' ? 'compose' : 'pick')}
              >
                Back
              </button>
            )}
          </span>
          <span className="row" style={{ gap: 8 }}>
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              {step === 'done' ? 'Close' : 'Cancel'}
            </button>
            {step === 'pick' && (
              <button type="button" className="btn btn--primary" disabled={!ticket} onClick={() => setStep('compose')}>
                Next
              </button>
            )}
            {step === 'compose' && (
              <button type="button" className="btn btn--primary" disabled={Boolean(problem)} onClick={() => setStep('confirm')}>
                Check it
              </button>
            )}
            {step === 'confirm' && (
              <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void send()}>
                {busy ? 'Sending…' : summary?.heading === 'This goes to the customer' ? 'Send to the customer' : 'Add the note'}
              </button>
            )}
          </span>
        </div>
      }
    >
      <div className="shifter" style={height !== undefined ? { height } : undefined}>
        <div ref={bodyRef} className="shifter__body">
          {error && <Alert tone="error">{error}</Alert>}

          {/* ---- Pick the ticket ------------------------------------ */}
          {step === 'pick' && (
            <div className="stack stack--tight">
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div style={{ flex: '0 1 220px' }}>
                  <Label>Whose queue</Label>
                  <select className="field__input" value={queue} onChange={(e) => setQueue(e.target.value)}>
                    <option value="">Everybody</option>
                    {queues.map((q) => (
                      <option key={q.id} value={q.id}>
                        {q.me ? `${q.name} (me)` : q.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={{ flex: '1 1 260px' }}>
                  <Label>Search</Label>
                  <input
                    className="field__input"
                    value={term}
                    placeholder="Ticket number, customer, or words from the subject"
                    onChange={(e) => setTerm(e.target.value)}
                  />
                </div>
              </div>

              <p className="muted" style={{ fontSize: 12, margin: 0 }}>
                Searched live on the helpdesk. Solved and closed tickets are left out unless you type the number —
                sending a document to a closed ticket reopens it and emails the customer about something they
                thought was finished.
              </p>

              {searching && !tickets.length ? (
                <Spinner label="Searching" />
              ) : tickets.length === 0 ? (
                <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
                  {term ? 'Nothing matched.' : 'Start typing, or pick a queue.'}
                </p>
              ) : (
                <div className="stack stack--tight">
                  {tickets.map((t) => (
                    <label key={t.id} className={`choice${ticket?.id === t.id ? ' choice--on' : ''}`}>
                      <input type="radio" name="ticket" checked={ticket?.id === t.id} onChange={() => setTicket(t)} />
                      <span>
                        <strong>{ticketLabel(t)}</strong>
                        <span className="choice__hint">
                          {t.status}
                          {t.assigneeName ? ` · ${t.assigneeName}` : ' · unassigned'}
                          {t.requesterEmail ? ` · ${t.requesterEmail}` : ''}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ---- What goes with it --------------------------------- */}
          {step === 'compose' && (
            <div className="stack stack--tight">
              <div className="row" style={{ gap: 6 }}>
                {(['private', 'public'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    className={`btn btn--small ${visibility === v ? 'btn--primary' : 'btn--ghost'}`}
                    onClick={() => setVisibility(v)}
                  >
                    {v === 'private' ? 'Internal note' : 'Send to the customer'}
                  </button>
                ))}
              </div>

              {visibility === 'private' ? (
                <Alert tone="info">
                  The note will say what the document is, who produced it and when — nothing else. There is nothing
                  to write: prose on an internal note about a document is prose nobody reads.
                  {doc.engineerNotes ? ' Your notes on the document go on it too.' : ''}
                </Alert>
              ) : (
                <>
                  <Label>What the customer reads</Label>
                  <textarea
                    className="field__input"
                    rows={6}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                  />
                  <p className="muted" style={{ fontSize: 12, margin: 0 }}>
                    The network team sign-off is added for you, so it matches every other message we send.
                    {doc.engineerNotes
                      ? ' Your notes on the document are not included — they were written for the desk.'
                      : ''}
                  </p>
                </>
              )}
            </div>
          )}

          {/* ---- Check it before it goes --------------------------- */}
          {step === 'confirm' && summary && (
            <div className="stack stack--tight">
              <Chip tone={visibility === 'public' ? 'warn' : 'idle'}>{summary.heading}</Chip>
              {summary.warning && <Alert tone="warn">{summary.warning}</Alert>}
              <div className="kv">
                {summary.rows.map((row) => (
                  <div key={row.label} className="cell">
                    <span className="cell__label">{row.label}</span>
                    <span className="cell__value">{row.value}</span>
                  </div>
                ))}
              </div>
              {visibility === 'public' && (
                <div>
                  <Label>What will be sent</Label>
                  <pre className="raw">{message.trim()}</pre>
                </div>
              )}
            </div>
          )}

          {/* ---- Done --------------------------------------------- */}
          {step === 'done' && ticket && (
            <Alert tone="ok">
              {visibility === 'public'
                ? `Sent to ${ticket.requesterName ?? 'the requester'} on ticket #${ticket.id}.`
                : `Added as an internal note on ticket #${ticket.id}.`}
            </Alert>
          )}
        </div>
      </div>
    </Modal>
  );
}
