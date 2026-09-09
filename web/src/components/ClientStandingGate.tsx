import { useEffect, useState, type ReactElement } from 'react';
import {
  PAYG_PICKER_LIMIT,
  firstName,
  onStopReminder,
  paygNudge,
  standingDef,
  type AccountStanding,
} from '@sw/shared';
import { ApiClientError, api, type ClientContext, type ClientTicket } from '../lib/api';
import { Alert, Chip, Label, Spinner } from './ui';
import { Modal } from './overlay';

/**
 * Whether to start work on this client at all.
 *
 * Two standings stop an engineer, for different reasons and with different
 * consequences for getting it wrong.
 *
 * **Pay as you go** is a question, not a banner. A banner gets read once and
 * then stops being seen; a question with a No that actually does something
 * gets answered. The No sends the client the request to buy time, on a ticket
 * the engineer picks — never in bulk, because a payment request in front of
 * the wrong customer is worse than one that took a moment longer.
 *
 * **On stop** is a standing reminder rather than a prompt. The failure it
 * exists to prevent is somebody opening the record next week, seeing a barred
 * line, and helpfully unbarring it — so it names the reason and who to ask.
 */

const TONE: Record<AccountStanding, 'crit' | 'warn' | 'ok' | 'idle'> = {
  'on-stop': 'crit',
  payg: 'warn',
  support: 'ok',
  unknown: 'idle',
};

export function ClientStandingBadge({ standing }: { standing: AccountStanding }): ReactElement | null {
  const def = standingDef(standing);
  if (def.prominence === 'none') return null;
  return (
    <Chip tone={TONE[standing]} dot={def.prominence === 'blocking'} title={def.hint}>
      {def.label}
    </Chip>
  );
}

/**
 * The gate.
 *
 * Rendered wherever an engineer is about to act on a client. It asks once per
 * client per session — asking again after they have answered is how a prompt
 * becomes something people click through without reading.
 */
export function ClientStandingGate({
  clientName,
  engineerName,
  barredCount,
}: {
  clientName: string;
  engineerName?: string;
  /** How many services are barred, for the on-stop reminder. */
  barredCount?: number;
}): ReactElement | null {
  const [client, setClient] = useState<ClientContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);
  const [flowOpen, setFlowOpen] = useState(false);

  useEffect(() => {
    let live = true;
    setClient(null);
    setError(null);
    setAsked(false);
    void (async () => {
      try {
        const result = await api.client(clientName);
        if (live) setClient(result.client);
      } catch (err) {
        // A client we cannot look up is not a blocker — it is a gap, and the
        // engineer still has work to do.
        if (live) setError(err instanceof ApiClientError ? err.message : 'Could not read this client’s terms.');
      }
    })();
    return () => {
      live = false;
    };
  }, [clientName]);

  useEffect(() => {
    // The nudge opens itself for PAYG, because the whole point is that it is
    // seen before the work starts rather than after.
    if (client?.standing === 'payg' && !asked) setFlowOpen(true);
  }, [client, asked]);

  if (error) {
    return (
      <Alert tone="info">
        {error} Terms not confirmed — check before spending time on this if it is not a support client.
      </Alert>
    );
  }

  if (!client) return null;

  if (client.standing === 'on-stop') {
    return (
      <Alert tone="error">
        <strong>{onStopReminder({ clientName: client.name, barred: barredCount ?? 0 })}</strong>
      </Alert>
    );
  }

  if (client.standing !== 'payg') return null;

  return (
    <>
      <Alert tone="warn">
        <span>
          {paygNudge({ clientName: client.name, ...(engineerName ? { engineerFirstName: firstName(engineerName) } : {}) })}{' '}
          <button type="button" className="btn btn--ghost btn--small" onClick={() => setFlowOpen(true)}>
            Open the check
          </button>
        </span>
      </Alert>

      <PaygFlow
        client={client}
        open={flowOpen}
        onClose={() => {
          setFlowOpen(false);
          setAsked(true);
        }}
      />
    </>
  );
}

/**
 * The question, and what happens when the answer is no.
 *
 * Yes closes it and gets out of the way. No offers the client's own open
 * tickets — but only while the list is short enough to recognise one from a
 * title. Past that a ticket number is asked for instead: a list of twenty is
 * a search problem, and picking wrong sends a bill request to the wrong
 * person.
 */
function PaygFlow({
  client,
  open,
  onClose,
}: {
  client: ClientContext;
  open: boolean;
  onClose: () => void;
}): ReactElement {
  const [answer, setAnswer] = useState<'unasked' | 'yes' | 'no'>('unasked');
  const [ticketId, setTicketId] = useState('');
  const [chosen, setChosen] = useState<ClientTicket | null>(null);
  const [ccEngineer, setCcEngineer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickable = client.openTickets.length > 0 && client.openTickets.length <= PAYG_PICKER_LIMIT;
  const targetId = chosen?.id ?? ticketId.trim();

  const send = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.paygRequest({
        ticketId: targetId,
        clientName: client.name,
        ...(chosen?.requesterName ? { contactName: chosen.requesterName } : {}),
        ccEngineer,
      });
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not send the request.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="Pay as you go"
      title={`Has ${client.name} bought time for this?`}
      subtitle="They are on PAYG, so time has to be purchased before the work starts."
      tone={answer === 'no' ? 'danger' : undefined}
      footer={
        <>
          <span className="grow" />
          {answer === 'unasked' ? (
            <>
              <button type="button" className="btn btn--ghost" onClick={() => setAnswer('no')}>
                No — not yet
              </button>
              <button type="button" className="btn btn--primary" onClick={onClose}>
                Yes — carry on
              </button>
            </>
          ) : sent ? (
            <button type="button" className="btn btn--primary" onClick={onClose}>
              Done
            </button>
          ) : (
            <>
              <button type="button" className="btn btn--ghost" onClick={onClose}>
                Skip for now
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={!/^#?\d{1,12}$/.test(targetId) || busy}
                onClick={() => void send()}
              >
                {busy ? 'Sending…' : 'Send the request'}
              </button>
            </>
          )}
        </>
      }
    >
      {answer === 'unasked' && (
        <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
          If they have, carry on. If not, <strong>No</strong> will send them the link to buy time — on a ticket you
          pick, so it lands in the right conversation.
        </p>
      )}

      {answer === 'no' && !sent && (
        <div className="stack stack--tight">
          <Alert tone="warn">
            Nothing is sent until you press the button, and it goes out as a public reply from you.
          </Alert>

          {pickable ? (
            <div>
              <Label>Which ticket is this about?</Label>
              <div className="payg-tickets">
                {client.openTickets.map((ticket) => (
                  <label key={ticket.id} className={`payg-ticket${chosen?.id === ticket.id ? ' is-chosen' : ''}`}>
                    <input
                      type="radio"
                      name="payg-ticket"
                      checked={chosen?.id === ticket.id}
                      onChange={() => {
                        setChosen(ticket);
                        setTicketId('');
                      }}
                    />
                    <span>
                      <span className="payg-ticket__subject">{ticket.subject}</span>
                      <span className="payg-ticket__meta">
                        #{ticket.id} · {ticket.status}
                        {ticket.requesterName ? ` · ${ticket.requesterName}` : ''}
                        {ticket.requesterEmail ? ` · ${ticket.requesterEmail}` : ''}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ) : (
            <label className="field" style={{ marginBottom: 0, maxWidth: 220 }}>
              <Label>Ticket number</Label>
              <input
                className="field__input"
                value={ticketId}
                onChange={(e) => {
                  setTicketId(e.target.value);
                  setChosen(null);
                }}
                placeholder="48213"
                inputMode="numeric"
              />
              <span className="field__hint">
                {client.openTickets.length === 0
                  ? 'They have no open tickets, so there is nothing to pick from.'
                  : `${client.openTicketCount} open tickets — too many to pick from safely, so name the one this is about.`}
              </span>
            </label>
          )}

          {targetId && (
            <div>
              <Label>What they will receive</Label>
              <pre className="ticket-preview">
                {paygPreview(client.name, chosen?.requesterName)}
              </pre>
            </div>
          )}

          <label className="field field--check" style={{ marginBottom: 0 }}>
            <input type="checkbox" checked={ccEngineer} onChange={(e) => setCcEngineer(e.target.checked)} />
            <span>Copy me in on the ticket</span>
          </label>

          {error && <Alert tone="error">{error}</Alert>}
        </div>
      )}

      {sent && (
        <Alert tone="ok">
          Sent on ticket {targetId}. It went out as a public reply, so they have it in the same conversation.
        </Alert>
      )}
    </Modal>
  );
}

/**
 * The wording, for the engineer to read before sending.
 *
 * Nobody should send a message to a customer they have not read, and the
 * signature is filled in server-side from the account — so this shows the
 * body with the greeting it will actually carry.
 */
function paygPreview(clientName: string, contactName?: string): string {
  return [
    `Hi ${firstName(contactName)},`,
    '',
    `It looks like ${clientName} is on PAYG terms for IT Support currently, so you would need to purchase time ` +
      'from our website before we’re able to action this request.',
    '',
    "Here's the link: https://supportwizard.net/store",
    '',
    'If you have any questions, feel free to let me know!',
    '',
    'All the best,',
    '',
    '(your first name)',
  ].join('\n');
}
