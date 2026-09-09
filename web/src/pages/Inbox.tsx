import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { SNOOZE_PRESETS, ageLabel, isDue, type InboxItem } from '@sw/shared';
import { ApiClientError, api } from '../lib/api';
import { Alert, Card, Chip, Empty, Label, Spinner, formatDateTime } from '../components/ui';
import { Modal } from '../components/overlay';
import { useTabRoute } from '../lib/route';

/**
 * Things nobody asked about.
 *
 * The rest of the portal answers questions. This is the other half: what it
 * noticed while nobody was looking. One list everybody sees — a per-person
 * inbox becomes four copies of the same finding, and the first person to fix
 * it has no way of telling the other three.
 *
 * Three ways out, and the shape of them is the whole design:
 *
 * - **Snooze** is the common one, and it exists because of restaurants. A
 *   site takes its line weeks before it opens, and a finding that nags every
 *   month about a building being fitted out is a finding people learn to
 *   ignore. Snoozing asks when, and why.
 * - **Dismiss** demands what it turned out to be. Not paperwork — it is what
 *   turns a monthly nag into a record of the answer, and if the condition is
 *   still true next month the item comes back with that answer attached.
 * - **Convert** puts it on a ticket, with the evidence, so it becomes work
 *   somebody is accountable for.
 */

type Tab = 'open' | 'closed';
const TABS = ['open', 'closed'] as const;

export function InboxPage(): ReactElement {
  const [tab, setTab] = useTabRoute<Tab>('inbox', TABS, 'open');
  const [actionable, setActionable] = useState<InboxItem[] | null>(null);
  const [closed, setClosed] = useState<InboxItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<InboxItem | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await api.inbox();
      setActionable(result.actionable);
      setClosed(result.closed);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not load the inbox.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const items = tab === 'open' ? (actionable ?? []) : closed;

  return (
    <div className="stack">
      <Card
        title="Inbox"
        eyebrow="Noticed while nobody was looking"
        index="01"
        accent={3}
        meta={
          actionable && actionable.length > 0 ? (
            <Chip tone="warn" dot>
              {actionable.length} to look at
            </Chip>
          ) : actionable ? (
            <Chip tone="ok" dot>
              Nothing outstanding
            </Chip>
          ) : undefined
        }
      >
        <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
          Everyone sees the same list. Snooze what is not a problem yet — a site that took its line before it
          opened is the usual case — and dismiss what is resolved, saying what it turned out to be. If the
          condition is still true next month the item comes back with that answer on it.
        </p>
      </Card>

      {error && <Alert tone="error">{error}</Alert>}

      <Card
        title={tab === 'open' ? 'To look at' : 'Snoozed and closed'}
        eyebrow={tab === 'open' ? 'Open findings' : 'History'}
        index="02"
        accent={1}
        flush
        tabs={
          <div className="row" style={{ gap: 4, padding: '0 18px' }}>
            {TABS.map((id) => (
              <button
                key={id}
                type="button"
                className={`btn btn--small ${tab === id ? 'btn--primary' : 'btn--ghost'}`}
                onClick={() => setTab(id)}
              >
                {id === 'open' ? `To look at (${actionable?.length ?? 0})` : `Snoozed and closed (${closed.length})`}
              </button>
            ))}
          </div>
        }
      >
        {actionable === null ? (
          <div style={{ padding: 18 }}>
            <Spinner label="Reading the inbox…" />
          </div>
        ) : items.length === 0 ? (
          <Empty title={tab === 'open' ? 'Nothing to look at' : 'Nothing here yet'}>
            {tab === 'open'
              ? 'Findings appear here on their own. Nothing is outstanding.'
              : 'Snoozed and dismissed findings are kept here, with what they turned out to be.'}
          </Empty>
        ) : (
          <div className="stack stack--tight" style={{ padding: '14px 18px 18px' }}>
            {items.map((item) => (
              <InboxRow key={item.id} item={item} onAct={() => setActing(item)} />
            ))}
          </div>
        )}
      </Card>

      {acting && (
        <ActDialog
          item={acting}
          onClose={() => setActing(null)}
          onDone={() => {
            setActing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function InboxRow({ item, onAct }: { item: InboxItem; onAct: () => void }): ReactElement {
  const returned = isDue(item);

  return (
    <div className={`inbox-row${returned ? ' inbox-row--returned' : ''}`}>
      <div className="inbox-row__main">
        <div className="inbox-row__subject">{item.subject}</div>

        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
          <Chip tone="idle">First seen {ageLabel(item)}</Chip>
          {item.seenCount > 1 && (
            <Chip tone={item.seenCount >= 4 ? 'warn' : 'idle'} title="Every sweep that has seen it">
              seen {item.seenCount} times
            </Chip>
          )}
          {returned && <Chip tone="warn" dot>Back off snooze</Chip>}
          {item.state === 'snoozed' && !returned && (
            <Chip tone="idle">Snoozed until {formatDateTime(item.snoozedUntil)}</Chip>
          )}
          {item.state === 'dismissed' && <Chip tone="ok">Dismissed</Chip>}
          {item.state === 'converted' && <Chip tone="ok">Ticket {item.ticketId}</Chip>}
        </div>

        <p className="inbox-row__detail">{item.detail}</p>

        {item.evidence.length > 0 && (
          <dl className="inbox-row__evidence">
            {item.evidence.map((fact) => (
              <div key={fact.label}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        )}

        {item.snoozeReason && (
          <p className="inbox-row__note">
            <strong>Snoozed because:</strong> {item.snoozeReason}
          </p>
        )}
        {item.resolution && (
          <p className="inbox-row__note">
            <strong>Last time this was:</strong> {item.resolution}
            {item.actedBy ? ` — ${item.actedBy}` : ''}
          </p>
        )}
      </div>

      <div className="inbox-row__actions">
        {item.link && (
          <a className="btn btn--ghost btn--small" href={item.link}>
            Open the site
          </a>
        )}
        {(item.state === 'open' || returned) && (
          <button type="button" className="btn btn--primary btn--small" onClick={onAct}>
            Deal with it
          </button>
        )}
      </div>
    </div>
  );
}

/** Snooze, dismiss with a reason, or convert to a ticket. */
function ActDialog({
  item,
  onClose,
  onDone,
}: {
  item: InboxItem;
  onClose: () => void;
  onDone: () => void;
}): ReactElement {
  const [choice, setChoice] = useState<'snoozed' | 'dismissed' | 'converted'>('snoozed');
  const [snoozeDays, setSnoozeDays] = useState(SNOOZE_PRESETS[1]?.days ?? 30);
  const [snoozeReason, setSnoozeReason] = useState('');
  const [resolution, setResolution] = useState('');
  const [ticketId, setTicketId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready =
    choice === 'snoozed'
      ? snoozeDays > 0
      : choice === 'dismissed'
        ? resolution.trim().length > 3
        : /^#?\d{1,12}$/.test(ticketId.trim());

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.actOnInboxItem(item.id, {
        state: choice,
        ...(choice === 'snoozed' ? { snoozeDays, ...(snoozeReason.trim() ? { snoozeReason } : {}) } : {}),
        ...(choice === 'dismissed' ? { resolution } : {}),
        ...(choice === 'converted' ? { ticketId: ticketId.trim(), createTicket: true } : {}),
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not update that item.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Inbox"
      title={item.subject}
      subtitle="Snooze it, close it with what it turned out to be, or put it on a ticket."
      footer={
        <>
          <span className="grow" />
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={!ready || busy} onClick={() => void submit()}>
            {busy ? 'Saving…' : choice === 'snoozed' ? 'Snooze it' : choice === 'dismissed' ? 'Close it' : 'Put it on the ticket'}
          </button>
        </>
      }
    >
      <div className="stack stack--tight">
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {(['snoozed', 'dismissed', 'converted'] as const).map((id) => (
            <button
              key={id}
              type="button"
              className={`btn btn--small ${choice === id ? 'btn--primary' : 'btn--ghost'}`}
              onClick={() => setChoice(id)}
            >
              {id === 'snoozed' ? 'Not yet a problem' : id === 'dismissed' ? 'Resolved' : 'Make it a ticket'}
            </button>
          ))}
        </div>

        {choice === 'snoozed' && (
          <>
            <div>
              <Label>Come back in</Label>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 5 }}>
                {SNOOZE_PRESETS.map((preset) => (
                  <button
                    key={preset.days}
                    type="button"
                    className={`btn btn--small ${snoozeDays === preset.days ? 'btn--primary' : 'btn--ghost'}`}
                    onClick={() => setSnoozeDays(preset.days)}
                    title={preset.hint}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            <label className="field" style={{ marginBottom: 0 }}>
              <Label>Why (optional, but it saves the next person asking)</Label>
              <input
                className="field__input"
                value={snoozeReason}
                onChange={(e) => setSnoozeReason(e.target.value)}
                placeholder="Restaurant opens in November"
              />
            </label>
          </>
        )}

        {choice === 'dismissed' && (
          <label className="field" style={{ marginBottom: 0 }}>
            <Label>What did it turn out to be?</Label>
            <textarea
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              rows={3}
              placeholder="Service was never provisioned — Zen re-provisioned it and it authenticated the same day."
            />
            <span className="field__hint">
              Required. If this comes back next month, whoever sees it gets your answer rather than a blank —
              which is the difference between a list people read and one they mute.
            </span>
          </label>
        )}

        {choice === 'converted' && (
          <label className="field" style={{ marginBottom: 0, maxWidth: 240 }}>
            <Label>Ticket number</Label>
            <input
              className="field__input"
              value={ticketId}
              onChange={(e) => setTicketId(e.target.value)}
              placeholder="48213"
              inputMode="numeric"
            />
            <span className="field__hint">
              The finding and its evidence go on as a private note. An existing ticket, because Zendesk needs a
              requester and inventing one puts a customer's name on a ticket they did not raise.
            </span>
          </label>
        )}

        {error && <Alert tone="error">{error}</Alert>}
      </div>
    </Modal>
  );
}
