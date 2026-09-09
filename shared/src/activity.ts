/**
 * What was actually done, and by whom.
 *
 * The point of it: everything on a fault happens through this portal — a line
 * test, a fault raise, a visit booked, a SIM barred — so the portal is the
 * only thing that knows the sequence. Writing that sequence onto the ticket
 * means the next person picking it up sees the working rather than the
 * outcome, and nobody has to reconstruct "what have we already tried" from
 * memory a week later.
 *
 * Two rules the shape follows.
 *
 * Automatic work is marked as automatic. A line test the watcher ran at three
 * in the morning and a line test an engineer ran on the phone to a customer
 * are different facts, and a trail that presents them identically invites
 * somebody to credit a person with a decision nothing made.
 *
 * And the trail never goes out where a customer can read it. A raw sequence
 * of internal steps is engineering detail: useful to the desk, and not
 * something to put in front of the person paying the bill. Where the note it
 * accompanies is already private it is appended; where the note is public it
 * follows as a separate private one.
 */

export interface ActivityEntry {
  at: string;
  /** The audit action key, kept so the UI can group without matching prose. */
  action: string;
  /** Who did it. Absent means the system did. */
  actor?: { name?: string; email?: string };
  /** True where nothing human triggered it. */
  automatic?: boolean;
  /** What it was about, already reduced to a sentence. */
  summary: string;
  /** How it turned out, where the action has an outcome worth stating. */
  outcome?: string;
  ticketId?: string;
  eventId?: string;
}

/**
 * How each audited action reads on a ticket.
 *
 * A lookup table rather than prose built at each call site, so the wording is
 * consistent and so a new action that nobody has written a phrase for shows
 * up as its own key instead of silently reading as something else.
 */
const PHRASES: Record<string, string> = {
  'diagnostics.test_run': 'Ran a line test',
  'diagnostics.profile_change': 'Requested a line profile change',
  'fault.raised': 'Raised a fault with the supplier',
  'ticket.site_visit_notified': 'Booked an engineer visit and told the customer',
  'visit.approval_requested': 'Asked for approval on the booked visit',
  'visit.cancelled': 'Cancelled the engineer visit',
  'visit.confirmed': 'Confirmed the engineer visit is still needed',
  'visit.attended': 'Recorded that the engineer attended',
  'order.submitting': 'Submitted an order',
  'order.placed': 'The order was accepted',
  'order.rejected': 'The order was rejected',
  'order.cancelled': 'Cancelled an order',
  'address.registered': 'Registered the address with the supplier',
  'client.payg_request_sent': 'Sent the pay-as-you-go authorisation request',
  'watch.added': 'Started watching the premises',
  'watch.removed': 'Stopped watching the premises',
  'watch.changed': 'Recorded a change at the watched premises',
  'watch.notified': 'Told the watcher what changed',
  'inbox.converted': 'Turned the finding into a ticket',
  'inbox.dismissed': 'Dismissed the finding',
  'inbox.snoozed': 'Snoozed the finding',
  'sim.barred': 'Barred the SIM',
  'sim.unbarred': 'Lifted the bar on the SIM',
  'sim.ceased': 'Ceased the SIM',
  'event.opened': 'Opened an event',
  'event.check_failed': 'A check failed',
  'event.check_passed': 'A check passed',
  'event.resolved': 'Marked the event resolved',
  'event.dismissed': 'Dismissed the event',
  'event.ticket_raised': 'Raised an unassigned ticket for the event',
  'supervisor.recovered': 'An integration recovered on its own',
  'supervisor.escalated': 'Escalated a failing integration',
};

/** The phrase for an action, or the key itself where nobody has written one. */
export const actionPhrase = (action: string): string => PHRASES[action] ?? action;

/** Actions worth putting on a ticket. Everything else is noise there. */
const ON_TICKET = new Set(Object.keys(PHRASES));

export const worthReporting = (action: string): boolean => ON_TICKET.has(action);

/** `Joe Kane`, `joe@…` or `NetKit`, in that order of preference. */
export function actorLabel(entry: ActivityEntry): string {
  if (entry.automatic) return 'NetKit, automatically';
  return entry.actor?.name || entry.actor?.email || 'NetKit, automatically';
}

const time = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/London',
  });
};

/**
 * The trail, as a note.
 *
 * Plain text with a rule and a heading rather than a bare list, because it is
 * appended to somebody else's note and has to read as a distinct section
 * instead of running on from their last sentence. Automatic steps are marked
 * in the line itself, not in a footnote nobody reads.
 */
export function activityNote(entries: readonly ActivityEntry[], heading = 'What has been done'): string {
  if (!entries.length) return '';

  const lines = [...entries]
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((entry) => {
      const parts = [`${time(entry.at)} — ${actionPhrase(entry.action)}`];
      if (entry.summary && entry.summary !== actionPhrase(entry.action)) parts.push(entry.summary);
      if (entry.outcome) parts.push(entry.outcome);
      return `· ${parts.join('. ')}. (${actorLabel(entry)})`;
    });

  return ['————————————', heading, '', ...lines].join('\n');
}

/**
 * Where the trail goes, given the note it is travelling with.
 *
 * `append` when that note is already private — one note is easier to read
 * than two, and the trail belongs with the thing it explains. `separate`
 * when the note is public, because the trail is engineering detail and a
 * customer reading "Ran a line test. Fault raised. UniFi adjusted." learns
 * only that we were flailing.
 */
export function trailPlacement(visibility: 'private' | 'public'): 'append' | 'separate' {
  return visibility === 'private' ? 'append' : 'separate';
}

/**
 * The note to post, and the one to post after it.
 *
 * Returns the primary note with the trail folded in where that is allowed,
 * and a follow-up private note where it is not. A caller that ignores the
 * second half silently drops the trail, so it is returned rather than
 * appended by side effect.
 */
export function withTrail(
  body: string,
  visibility: 'private' | 'public',
  entries: readonly ActivityEntry[],
  heading?: string,
): { primary: string; followUp?: string } {
  const trail = activityNote(entries, heading);
  if (!trail) return { primary: body };
  if (trailPlacement(visibility) === 'append') return { primary: `${body}\n\n${trail}` };
  return { primary: body, followUp: trail };
}
