import { useCallback, useEffect, useState, type ReactElement } from 'react';
import {
  APPROVER,
  FREE_CANCEL_HOURS,
  NO_SHOW_CHARGE,
  cancelWindow,
  reasonDef,
  visitDateLabel,
  type LineTestResult,
  type VisitRecord,
} from '@sw/shared';
import { ApiClientError, api } from '../lib/api';
import { useRoute, go, toHash } from '../lib/route';
import { Alert, Card, Cell, Chip, Empty, Label, Spinner, formatDateTime } from '../components/ui';

/**
 * Booked engineer visits, and deciding whether they are still needed.
 *
 * The problem this page exists for: a supplier fixes a fault remotely in the
 * days after a visit is booked and does not withdraw the appointment. The
 * engineer turns up to a working line and it is billed as no fault found — the
 * same charge as an empty building, for a fault that was already fixed.
 *
 * So the board is ordered by how long is left to cancel for free, not by when
 * the visit is. A visit tomorrow with the window already closed is less
 * urgent than one next week with two hours left on the clock, because only
 * one of them still has a decision worth making.
 */

export function VisitsPage(): ReactElement {
  const route = useRoute();
  const [open, setOpen] = useState<Array<VisitRecord & { due: boolean }>>([]);
  const [closed, setClosed] = useState<VisitRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /*
   * The confirmation lives on the page, not the card.
   *
   * A decided visit leaves "needs a decision" for the settled list, so a
   * notice inside the card unmounts with it and the engineer is left staring
   * at a board that has silently changed shape.
   */
  const [outcome, setOutcome] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.visits();
      setOpen(result.open);
      setClosed(result.closed);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not load booked visits.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const settled = useCallback(
    async (message: string) => {
      setOutcome(message);
      await load();
    },
    [load],
  );

  // Deep link from the ticket note: #/visits/<id> opens that one expanded.
  const focused = route.a;

  if (loading && !open.length && !closed.length) return <Spinner label="Loading booked visits" />;

  const due = open.filter((v) => v.due);
  const later = open.filter((v) => !v.due);

  return (
    <div className="stack">
      {error && <Alert tone="error">{error}</Alert>}
      {outcome && <Alert tone="ok">{outcome}</Alert>}

      <Card
        title="Needs a decision"
        eyebrow={due.length ? `${due.length} waiting` : 'nothing waiting'}
        index="01"
        accent={1}
        meta={
          <button type="button" className="btn btn--ghost btn--small" onClick={() => void load()}>
            Refresh
          </button>
        }
      >
        {due.length === 0 ? (
          <Empty title="Nothing to decide">
            {`Visits appear here two days before the slot — early enough that cancelling is still free. Inside ${FREE_CANCEL_HOURS} hours it costs ${NO_SHOW_CHARGE} either way, so there is no point asking then.`}
          </Empty>
        ) : (
          <div className="stack stack--tight">
            {due.map((visit) => (
              <VisitCard key={visit.id} visit={visit} expanded={visit.id === focused} onDone={settled} />
            ))}
          </div>
        )}
      </Card>

      {later.length > 0 && (
        <Card title="Booked, not yet due" eyebrow={`${later.length}`} index="02" accent={2}>
          <div className="stack stack--tight">
            {later.map((visit) => (
              <VisitCard key={visit.id} visit={visit} expanded={visit.id === focused} onDone={settled} />
            ))}
          </div>
        </Card>
      )}

      {closed.length > 0 && (
        <Card title="Recently settled" eyebrow={`${closed.length}`} index="03" accent={3}>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Slot</th>
                  <th>Outcome</th>
                  <th className="col-optional">Decided</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                {closed.map((visit) => (
                  <tr key={visit.id}>
                    <td className="sw-mono">{visit.ticketId}</td>
                    <td>{visit.slot ? `${visitDateLabel(visit.slot.date)}, ${visit.slot.window}` : 'never confirmed'}</td>
                    <td>
                      <Chip tone={visit.state === 'cancelled' ? 'ok' : 'idle'}>
                        {visit.state === 'cancelled' ? 'cancelled — not needed' : 'engineer attended'}
                      </Chip>
                    </td>
                    <td className="col-optional">{formatDateTime(visit.closedAt) ?? '—'}</td>
                    <td>{visit.closedBy ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * One visit, and the decision
 * ------------------------------------------------------------------ */

function VisitCard({
  visit,
  expanded,
  onDone,
}: {
  visit: VisitRecord & { due?: boolean };
  expanded: boolean;
  onDone: (message: string) => Promise<void> | void;
}): ReactElement {
  const [showing, setShowing] = useState(expanded);
  const [test, setTest] = useState<LineTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [because, setBecause] = useState('');
  const [contactName, setContactName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const window = cancelWindow(visit);
  const def = reasonDef(visit.reason);

  /*
   * The test is run here rather than expected of the engineer.
   *
   * The question on this page is "has the supplier fixed it quietly", and the
   * only honest way to answer it is to test the line now. Asking somebody to
   * go and do that elsewhere and come back is how the decision gets made on
   * a hunch instead.
   */
  const runTest = async (): Promise<void> => {
    if (!visit.serviceReference) {
      setError('No service reference on this visit, so a test cannot be run from here.');
      return;
    }
    setTesting(true);
    setError(null);
    try {
      const result = await api.runTest(visit.serviceReference, 'linetest', undefined, visit.ticketId);
      setTest(result.result);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'The test could not be run.');
    } finally {
      setTesting(false);
    }
  };

  const evidence = (): string[] => {
    const out: string[] = [];
    if (test) {
      out.push(`Line test ${test.outcome}${test.summary ? `: ${test.summary}` : ''}`);
      if (test.faultLocation) out.push(`Fault location reported: ${test.faultLocation}`);
    }
    if (because.trim()) out.push(because.trim());
    return out;
  };

  const decide = async (outcome: 'cancelled' | 'confirmed' | 'attended'): Promise<void> => {
    setBusy(outcome);
    setError(null);
    try {
      await api.closeVisit(visit.id, {
        outcome,
        ...(because.trim() ? { because: because.trim() } : {}),
        ...(contactName.trim() ? { contactName: contactName.trim() } : {}),
        evidence: evidence(),
      });
      await onDone(
        outcome === 'cancelled'
          ? `Visit on ticket ${visit.ticketId} cancelled, and the customer has been told there is nothing to pay.`
          : outcome === 'confirmed'
            ? `Visit on ticket ${visit.ticketId} kept. The ticket says not to let the supplier rebook it.`
            : `Visit on ticket ${visit.ticketId} marked as attended.`,
      );
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'That decision was not recorded.');
    } finally {
      setBusy(null);
    }
  };

  const ask = async (): Promise<void> => {
    setBusy('ask');
    setError(null);
    try {
      await api.askApprover(visit.id);
      await onDone(`${APPROVER.name} has been tagged on ticket ${visit.ticketId}, with a link back here.`);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not write to that ticket.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={`visit${window?.chargeable ? ' visit--late' : ''}`}>
      <div className="visit__head">
        <div className="visit__title">
          <strong>
            {visit.slot ? `${visitDateLabel(visit.slot.date)}, ${visit.slot.window}` : 'No slot confirmed yet'}
          </strong>
          <span className="muted">
            Ticket {visit.ticketId} · {def.label}
            {visit.supplier ? ` · ${visit.supplier}` : ''}
          </span>
        </div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {window ? (
            <Chip tone={window.chargeable ? 'crit' : window.hoursLeft < 8 ? 'warn' : 'ok'}>{window.label}</Chip>
          ) : (
            <Chip tone="idle">No slot to cancel against</Chip>
          )}
          {visit.approvalAskedAt && <Chip tone="idle">{APPROVER.name} asked</Chip>}
          <button
            type="button"
            className="btn btn--ghost btn--small"
            onClick={() => {
              setShowing((v) => !v);
              // Keep the URL honest, so this row can be linked to from a ticket.
              if (!showing) go(toHash('visits', visit.id));
            }}
          >
            {showing ? 'Close' : 'Decide'}
          </button>
        </div>
      </div>

      {showing && (
        <div className="visit__body">
          {error && <Alert tone="error">{error}</Alert>}

          <div className="kv">
            <Cell label="Reason booked" value={def.label} />
            <Cell label="Told to the customer as" value={def.customerWording} />
            <Cell label="Access expected" value={visit.access === 'unknown' ? 'not established' : visit.access} />
            <Cell label="Booked" value={formatDateTime(visit.bookedAt) ?? '—'} />
            {visit.bookedBy && <Cell label="Booked by" value={visit.bookedBy} />}
            {visit.testSide && <Cell label="Test pointed at" value={visit.testSide} />}
            {visit.faultReference && <Cell label="Fault reference" value={visit.faultReference} mono copy />}
            {visit.serviceReference && <Cell label="Service" value={visit.serviceReference} mono copy />}
          </div>

          <div>
            <Label>Has the supplier fixed it without telling us?</Label>
            <p className="muted" style={{ fontSize: 12.5, margin: '4px 0 8px', maxWidth: 640 }}>
              They often do, and they do not withdraw the appointment. Test the line now — that is the only honest
              way to answer it.
            </p>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn--ghost btn--small"
                disabled={testing || !visit.serviceReference}
                onClick={() => void runTest()}
              >
                {testing ? 'Testing…' : 'Run a line test now'}
              </button>
              {!visit.serviceReference && (
                <Chip tone="idle">No service reference — test from the line instead</Chip>
              )}
            </div>

            {test && (
              <div className="flag flag--info" style={{ marginTop: 10 }}>
                <span className="flag__marker" aria-hidden="true" />
                <span>
                  <strong>
                    {test.outcome}
                    {test.faultLocation ? ` · ${test.faultLocation}` : ''}
                  </strong>
                  {test.summary && <span className="flag__detail">{test.summary}</span>}
                </span>
              </div>
            )}

            {/*
              * The UniFi side of this check is not built yet.
              *
              * Said out loud rather than left as a gap: whether the customer's
              * own router has a WAN up is the other half of "is it actually
              * fixed", and reading it from the controller is the Site Manager
              * work. Until then the engineer has to look, and pretending
              * otherwise would make this page claim more than it knows.
              */}
            <p className="muted" style={{ fontSize: 12, margin: '10px 0 0', maxWidth: 640 }}>
              The router's own WAN state is not read here yet — that comes with the UniFi Site Manager work. Check
              the controller as well before dropping a visit.
            </p>
          </div>

          <label className="field" style={{ maxWidth: 620 }}>
            <Label>What you found</Label>
            <input
              className="field__input"
              value={because}
              onChange={(e) => setBecause(e.target.value)}
              placeholder="e.g. the fibre path was repaired at the cabinet on Tuesday"
            />
            <span className="muted" style={{ fontSize: 12 }}>
              Goes to the customer in the cancellation, and onto the ticket either way.
            </span>
          </label>

          <label className="field" style={{ maxWidth: 320 }}>
            <Label>Who to address it to</Label>
            <input
              className="field__input"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              placeholder="First name, optional"
            />
          </label>

          {window?.chargeable && (
            <Alert tone="warn">
              Already inside the {FREE_CANCEL_HOURS}-hour window, so cancelling costs {NO_SHOW_CHARGE} either way.
              Dropping it still saves the customer having to be there, but it does not save the charge.
            </Alert>
          )}

          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn--primary btn--small"
              disabled={busy !== null}
              onClick={() => void decide('cancelled')}
            >
              {busy === 'cancelled' ? 'Cancelling…' : 'Fixed — cancel the visit'}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--small"
              disabled={busy !== null}
              onClick={() => void decide('confirmed')}
            >
              {busy === 'confirmed' ? 'Keeping…' : 'Still needed — keep the slot'}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--small"
              disabled={busy !== null}
              onClick={() => void decide('attended')}
            >
              Engineer attended
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--small"
              disabled={busy !== null}
              onClick={() => void ask()}
              title={`Tags ${APPROVER.handle} on the ticket and adds ${APPROVER.email} as a follower`}
            >
              {busy === 'ask' ? 'Asking…' : `Ask ${APPROVER.name}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
