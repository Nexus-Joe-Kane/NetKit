import { authenticates } from './lineHandover';
import type { LineRecord } from './types';

/**
 * Things nobody asked about that somebody should look at.
 *
 * The portal is good at answering questions. This is the other half: the
 * things it notices while nobody is looking, in one place everybody can see,
 * with three ways out — turn it into a ticket, snooze it, or dismiss it and
 * say what the answer was.
 *
 * Shared rather than per-person on purpose. A per-user inbox becomes four
 * inboxes with the same thing in them, and the first person to fix it has no
 * way of telling the other three.
 *
 * The dismissal reason is not paperwork. It is what turns "this line has
 * never authenticated" from a monthly nag into a record of what it was last
 * time — which is the difference between a list people read and a list people
 * mute.
 */

export type InboxKind = 'line-never-authenticated';

export type InboxState = 'open' | 'snoozed' | 'dismissed' | 'converted';

export interface InboxEvidence {
  label: string;
  value: string;
}

export interface InboxItem {
  /**
   * Stable across sweeps, so the same finding is one item rather than one a
   * day. Derived from the kind and what it is about.
   */
  id: string;
  kind: InboxKind;
  /** One line, for the list. */
  subject: string;
  /** Why it matters and what to do, for the detail view. */
  detail: string;
  /** The facts behind it, so nobody has to go and look them up. */
  evidence: InboxEvidence[];
  /** Where to go to act on it. */
  link?: string;
  raisedAt: string;
  state: InboxState;
  /** ISO date; the item comes back at this point. */
  snoozedUntil?: string;
  /** Why it was snoozed — "not open until October" is the useful bit. */
  snoozeReason?: string;
  /** What it turned out to be. Kept on the item after it is closed. */
  resolution?: string;
  /** Who acted, and when. */
  actedBy?: string;
  actedAt?: string;
  /** The Zendesk ticket, once one exists. */
  ticketId?: string;
  /** How many sweeps have seen it, so a persistent thing reads as persistent. */
  seenCount: number;
  lastSeenAt: string;
}

/**
 * How long a line can be live with no authentication before it is worth
 * asking about.
 *
 * A month. Long enough that a genuine install-then-open gap does not fire on
 * day three, short enough that a service billed since the spring gets noticed
 * before the annual review.
 */
export const NEVER_AUTH_AFTER_DAYS = 30;

/** Snooze options, written for the reasons these actually get snoozed. */
export const SNOOZE_PRESETS: readonly { label: string; days: number; hint: string }[] = [
  { label: '2 weeks', days: 14, hint: 'Fit-out nearly done' },
  { label: '1 month', days: 30, hint: 'Opening next month' },
  { label: '3 months', days: 90, hint: 'Site not opening for a while' },
  { label: '6 months', days: 182, hint: 'Taken early, opening much later' },
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO date this many days from now, for a snooze. */
export const snoozeUntil = (days: number, from: Date = new Date()): string =>
  new Date(from.getTime() + days * DAY_MS).toISOString();

/** Whether a snoozed item is due back. */
export function isDue(item: InboxItem, now: Date = new Date()): boolean {
  if (item.state !== 'snoozed' || !item.snoozedUntil) return false;
  const until = new Date(item.snoozedUntil).getTime();
  return Number.isFinite(until) && until <= now.getTime();
}

/** What the list shows: open items, and snoozed ones that are due back. */
export const isActionable = (item: InboxItem, now: Date = new Date()): boolean =>
  item.state === 'open' || isDue(item, now);

/**
 * A line that has been live for a month and has never authenticated.
 *
 * This is nearly always one of two things: a service that was never fully
 * provisioned and is billing for nothing, or a site that is not open yet.
 * The first costs money quietly; the second is completely normal and is why
 * snooze exists — restaurants get their line in weeks before they open, and
 * an alert that nags monthly about a site fitting out is an alert people
 * learn to ignore.
 *
 * Requires a start date. Without one there is no way to know how long it has
 * been live, and guessing would fire on lines installed yesterday.
 */
export function findNeverAuthenticated(
  lines: LineRecord[],
  now: Date = new Date(),
): Array<Omit<InboxItem, 'state' | 'seenCount' | 'lastSeenAt'>> {
  const out: Array<Omit<InboxItem, 'state' | 'seenCount' | 'lastSeenAt'>> = [];

  for (const line of lines) {
    if (line.status !== 'active') continue;
    if (!authenticates(line)) continue;

    // Any evidence of a session at all, ever, and there is nothing to say.
    const radius = line.radius;
    if (radius?.online === true || radius?.lastAuthAt || radius?.onlineSince) continue;

    const start = line.contract?.startDate;
    if (!start) continue;
    const startedAt = new Date(start).getTime();
    if (!Number.isFinite(startedAt)) continue;

    const liveDays = Math.floor((now.getTime() - startedAt) / DAY_MS);
    if (liveDays < NEVER_AUTH_AFTER_DAYS) continue;

    const identifier = line.serviceId ?? line.lineAccessId ?? line.cli ?? line.id;
    const who = line.customerName ?? line.customerReference;

    out.push({
      id: `line-never-authenticated:${identifier}`,
      kind: 'line-never-authenticated',
      subject: `${line.technology} at ${line.address.singleLine} has never connected`,
      detail:
        `This line has been active for ${liveDays} days and has never authenticated. That is usually one of ` +
        'two things: the service was never fully provisioned and is billing for nothing, or the site is not ' +
        'open yet. If it is the second, snooze it until they open rather than dismissing it — a dismissed ' +
        'item comes straight back on the next sweep.',
      evidence: [
        { label: 'Live since', value: start },
        { label: 'Days live', value: String(liveDays) },
        { label: 'Product', value: [line.productName, line.bearerSpeed].filter(Boolean).join(' ') || line.technology },
        { label: 'Identifier', value: identifier },
        ...(line.cli ? [{ label: 'CLI', value: line.cli }] : []),
        ...(who ? [{ label: 'Client', value: who }] : []),
        { label: 'Provider', value: line.provider },
      ],
      ...(line.address.uprn ? { link: `#/site/${line.address.uprn}/lines` } : {}),
      raisedAt: now.toISOString(),
    });
  }

  return out;
}

/**
 * How the list reads, worst first.
 *
 * Something seen five times is more likely to be real than something seen
 * once, so persistence sorts up — and a snoozed item that has come back is
 * the strongest signal of all, because somebody looked at it and expected it
 * to be gone by now.
 */
export function sortInbox(items: InboxItem[], now: Date = new Date()): InboxItem[] {
  return [...items].sort((a, b) => {
    const dueA = isDue(a, now) ? 1 : 0;
    const dueB = isDue(b, now) ? 1 : 0;
    return dueB - dueA || b.seenCount - a.seenCount || a.raisedAt.localeCompare(b.raisedAt);
  });
}

/** How long it has been open, in words, for the list. */
export function ageLabel(item: InboxItem, now: Date = new Date()): string {
  const days = Math.floor((now.getTime() - new Date(item.raisedAt).getTime()) / DAY_MS);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 9) return `${weeks} weeks ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}
