import { SITE_VISIT_SIGN_OFF } from './houseContact';
import { NO_SHOW_CHARGE } from './charges';
import { reasonDef, type Side, type SiteVisitReason, type TestFinding } from './lineTestAdvice';
import type { AccessTechnology } from './types';

/**
 * Booking an engineer to site.
 *
 * The expensive decision in fault handling. An Openreach visit that finds
 * nothing wrong with the network is charged to us at NO_SHOW_CHARGE and
 * passed to the customer, and so is one where nobody is there to open the
 * door. Both are avoidable, and both were avoidable by asking two questions
 * before the booking rather than after the invoice.
 *
 * So this module is three things: the questions that have to be answered
 * before a visit can be raised, the reason that goes on it (picked from a
 * fixed list, suggested from the last line test), and the two messages that
 * go to the customer -- one when the slot is known and one when it is not.
 * Both carry the charge, because a customer who learns about it afterwards
 * is a customer who disputes it.
 */

/** Does this fault need somebody on site? */
export type VisitNeeded = 'yes' | 'no' | 'unclear';

/** Where the engineer will be working, which decides what we ask of the customer. */
export type AccessNeed = 'inside' | 'outside' | 'unknown';

/* ------------------------------------------------------------------ *
 * The gate
 * ------------------------------------------------------------------ */

/**
 * One thing that has to be true before a visit is fair to book.
 *
 * Each item is here because Openreach have charged for it. They are phrased
 * as questions rather than statements so that answering them is a decision
 * rather than a formality -- a checkbox list somebody ticks straight through
 * is a form, not a gate.
 */
export interface GateItem {
  id: string;
  question: string;
  /** What it costs to skip. Shown next to the question, not buried in help. */
  why: string;
  /** Only asked of the technologies where it is possible. */
  technologies?: AccessTechnology[];
}

export const GATE_ITEMS: readonly GateItem[] = [
  {
    id: 'power-cycle',
    question: 'Has the router been powered off for a full minute and back on?',
    why: 'The first thing the supplier will ask, and the first thing they will close the fault for.',
  },
  {
    id: 'test-socket',
    question: 'Has it been tested in the test socket behind the faceplate, with everything else unplugged?',
    why:
      'A fault that clears in the test socket is internal wiring, which is the customer’s side. ' +
      `An engineer who proves that on site charges ${NO_SHOW_CHARGE}.`,
    technologies: ['SOGEA', 'FTTC', 'ADSL2+', 'GFAST'],
  },
  {
    id: 'ont-lights',
    question: 'Have the lights on the fibre terminal been read out, and is the power supply definitely in?',
    why:
      'An unplugged ONT and a cut fibre look identical from here. One is a plug and the other is a dig, and ' +
      `booking the wrong one costs ${NO_SHOW_CHARGE}.`,
    technologies: ['FTTP'],
  },
  {
    id: 'second-router',
    question: 'Has a second router, or a known-good cable, been tried?',
    why: 'Kit fails more often than lines do, and it is the cheapest thing to rule out.',
  },
  {
    id: 'line-test',
    question: 'Has a line test been run today, and does it point at the network?',
    why: 'A booking with no current test behind it is a guess, and the supplier will treat it as one.',
  },
  {
    id: 'known-outage',
    question: 'Has the postcode been checked for a known outage or planned works?',
    why: 'An engineer sent into an incident that is already being worked is a wasted visit we still pay for.',
  },
  {
    id: 'access',
    question: 'Has somebody at the site confirmed they can be there for the whole appointment window?',
    why:
      `Nobody on site is a missed appointment, charged at ${NO_SHOW_CHARGE}. The window is hours, not minutes, ` +
      'so "someone will probably be around" is not a yes.',
  },
] as const;

/** How an engineer answers a gate question. */
export type GateAnswer = 'done' | 'not-applicable' | 'not-done';

/**
 * The questions to ask for this line.
 *
 * Filtered by technology, then extended with anything the line test itself
 * said had to be true first — `beforeBooking` on a finding is exactly that,
 * written for the fault in hand rather than in general, so it belongs in the
 * gate alongside the standing questions.
 */
export function gateFor(
  technology: AccessTechnology | undefined,
  findings: readonly TestFinding[] = [],
): GateItem[] {
  const standing = GATE_ITEMS.filter(
    (item) => !item.technologies || !technology || item.technologies.includes(technology),
  );

  const fromTest: GateItem[] = findings
    .filter((f) => f.beforeBooking)
    .map((f) => ({
      id: `test:${f.kind}`,
      question: f.beforeBooking!,
      why: 'The line test asked for this specifically, for this fault.',
    }));

  // Deduplicated by question text, not by id: a test can restate a standing
  // question in its own words and asking it twice makes the gate look
  // careless.
  const seen = new Set(standing.map((i) => i.question.toLowerCase()));
  return [...standing, ...fromTest.filter((i) => !seen.has(i.question.toLowerCase()))];
}

/**
 * What still stands in the way.
 *
 * An unanswered question blocks exactly as hard as one answered "not done".
 * Silence is not a yes -- that is the whole point of a gate -- and treating a
 * blank as a pass is how a checklist becomes decoration.
 */
export function gateBlockers(
  items: readonly GateItem[],
  answers: Readonly<Record<string, GateAnswer | undefined>>,
): GateItem[] {
  return items.filter((item) => answers[item.id] !== 'done' && answers[item.id] !== 'not-applicable');
}

export const gateReady = (
  items: readonly GateItem[],
  answers: Readonly<Record<string, GateAnswer | undefined>>,
): boolean => gateBlockers(items, answers).length === 0;

/**
 * The gate, written out for the ticket.
 *
 * Goes on as a private note so that when the supplier comes back with "did
 * you try the test socket", the answer is already on the ticket with the date
 * on it, rather than being re-established from memory a week later.
 */
export function gateNote(
  items: readonly GateItem[],
  answers: Readonly<Record<string, GateAnswer | undefined>>,
): string {
  const lines = items.map((item) => {
    const answer = answers[item.id];
    const mark = answer === 'done' ? 'checked' : answer === 'not-applicable' ? 'not applicable' : 'NOT CHECKED';
    return `· ${item.question} — ${mark}`;
  });
  return ['Checks before booking:', ...lines].join('\n');
}

/* ------------------------------------------------------------------ *
 * The reason
 * ------------------------------------------------------------------ */

/**
 * Reasons worth offering, best first.
 *
 * The line test's own suggestions lead, in the order the findings came back
 * — which is severity order, so the critical finding's reason is the default.
 * Everything else follows so an engineer who disagrees is one click from the
 * right answer rather than scrolling a list of fifteen.
 */
export function suggestedReasons(findings: readonly TestFinding[]): SiteVisitReason[] {
  const suggested: SiteVisitReason[] = [];
  for (const finding of findings) {
    if (finding.suggestedReason && !suggested.includes(finding.suggestedReason)) {
      suggested.push(finding.suggestedReason);
    }
  }
  return suggested;
}

/**
 * Whether the reason and the test agree about whose fault it is.
 *
 * Not a block -- an engineer on the phone to the customer knows things the
 * test does not -- but worth saying out loud, because booking a network visit
 * for a fault the test puts inside the building is the single most expensive
 * mistake available here.
 */
export function reasonConflict(
  reason: SiteVisitReason,
  testSide: Side,
): { conflict: boolean; warning?: string } {
  const def = reasonDef(reason);
  if (def.side === 'unclear' || testSide === 'unclear' || def.side === testSide) return { conflict: false };

  return {
    conflict: true,
    warning:
      def.side === 'network'
        ? `The line test points at the customer’s own side, not the network. If the supplier agrees, the visit ` +
          `is chargeable at ${NO_SHOW_CHARGE}. Be sure before booking.`
        : 'The line test points at the network, but this reason puts the fault inside the building. The supplier ' +
          'may refuse the visit, or attend and do nothing.',
  };
}

/* ------------------------------------------------------------------ *
 * What the customer is told
 * ------------------------------------------------------------------ */

/** A confirmed appointment. `window` is the supplier's own wording. */
export interface VisitSlot {
  /** ISO date, `2026-09-15`. */
  date: string;
  /** `08:00 – 13:00`, or `AM`, as the supplier gave it. */
  window: string;
}

export interface VisitDetails {
  /**
   * The real supplier — Zen, Giacom, an alt-net.
   *
   * For the private record only. It is deliberately impossible to get this
   * into the customer's message: see siteVisitMessage.
   */
  supplier?: string;
  contactName?: string;
  reason: SiteVisitReason;
  access: AccessNeed;
  /** Absent or null when the supplier has not given a slot yet. */
  slot?: VisitSlot | null;
}

/** `Tuesday 15 September`, which is how a person reads a date. */
export function visitDateLabel(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
}

const accessSentence = (access: AccessNeed): string => {
  switch (access) {
    case 'inside':
      return (
        'The engineer will need to come inside the property, so please make sure somebody can let them in and ' +
        'stay with them for the visit.'
      );
    case 'outside':
      return (
        'The engineer expects the work to be outside the property, but they may still need to come in to test ' +
        'the socket, so please have somebody available.'
      );
    default:
      return (
        'We do not yet know whether the engineer will need to come inside, so please assume they will and have ' +
        'somebody available.'
      );
  }
};

/**
 * The message that goes to the customer when a visit is booked.
 *
 * Two variants and one set of facts. The supplier confirms a slot when it
 * suits them, and the version that says "we will tell you when we know" has
 * to carry exactly the same warnings as the version with a date on it —
 * otherwise a customer who is told the date a day later has never been told
 * about the charge at all.
 *
 * Deliberately public. Everything else NetKit writes to a ticket is a private
 * note, because a raw supplier exchange is engineering detail. This is the
 * exception: somebody has to be at the property, there is a notice period,
 * and there is a charge, and all three are things a customer has to know
 * before the visit rather than after it.
 *
 * The supplier is never named, and `details.supplier` is deliberately not
 * consulted here. Two reasons, and the second is the one that bites. A
 * customer told the fault is with Zen can ring Zen, who will not discuss a
 * wholesale fault with an end customer — so it loses us the thread and gets
 * them nowhere. And a customer told who we buy from is a customer who can
 * work out what we pay. Making that a matter of caller discipline is how it
 * leaks; making it structurally impossible is not.
 */
export function siteVisitMessage(details: VisitDetails): { subject: string; body: string } {
  const supplier = 'the network supplier';
  const greeting = details.contactName?.trim() ? `Hello ${details.contactName.trim()},` : 'Hello,';
  const because = reasonDef(details.reason).customerWording;
  const slot = details.slot;

  const opening = slot
    ? `We have booked an engineer visit with ${supplier} for ${visitDateLabel(slot.date)}, ${slot.window}. ` +
      `They are coming out because of ${because}.`
    : `We have booked an engineer visit with ${supplier} for this fault, because of ${because}. They have not ` +
      'given us a time slot yet — we will come back to you with the date and window as soon as they confirm it.';

  const body = [
    greeting,
    '',
    opening,
    '',
    accessSentence(details.access),
    '',
    'Two things it is worth knowing now:',
    '',
    `· If nobody is at the property when the engineer arrives, ${supplier} charge the visit as a missed ` +
      `appointment at ${NO_SHOW_CHARGE}, and that is passed on to you. We would also have to book another one.`,
    '',
    slot
      ? `· If this slot does not suit, tell us as soon as you can. We need at least 24 hours before the ` +
        `appointment to move or cancel it — inside that window ${supplier} treat it as attended and charge ` +
        `${NO_SHOW_CHARGE} for it.`
      : `· Once the slot is confirmed, we need at least 24 hours’ notice to move or cancel it. Inside that ` +
        `window ${supplier} treat it as attended and charge ${NO_SHOW_CHARGE} for it, so it is worth telling us ` +
        'now if there are days or times that will not work.',
    '',
    'Anything at your end changes, just reply to this ticket and it comes straight to us.',
    '',
    'Kind regards',
    SITE_VISIT_SIGN_OFF,
  ].join('\n');

  const subject = slot
    ? `Engineer visit booked — ${visitDateLabel(slot.date)}, ${slot.window}`
    : 'Engineer visit booked — slot to follow';

  return { subject, body };
}

/**
 * The private note recording what was booked and on what basis.
 *
 * Separate from the customer message on purpose. This one names the reason as
 * an engineer would, says which side the test pointed at, and carries the
 * gate — the things somebody confirmed before spending the customer's money.
 */
export function visitBookedNote(
  details: VisitDetails & { testSide?: Side; gate?: string; bookedBy?: string },
): string {
  const def = reasonDef(details.reason);
  const slot = details.slot;

  const lines = [
    'Engineer visit booked.',
    '',
    `Supplier: ${details.supplier?.trim() || 'not recorded'}`,
    `Reason: ${def.label} (${def.side} side)`,
    `Slot: ${slot ? `${visitDateLabel(slot.date)}, ${slot.window}` : 'not yet confirmed by the supplier'}`,
    `Access expected: ${details.access === 'unknown' ? 'not established' : details.access}`,
    ...(details.testSide ? [`Last line test pointed at: ${details.testSide}`] : []),
    ...(details.bookedBy ? [`Booked by: ${details.bookedBy}`] : []),
    `Missed-appointment charge quoted to the customer: ${NO_SHOW_CHARGE}`,
  ];

  if (details.gate) lines.push('', details.gate);

  const conflict = details.testSide ? reasonConflict(details.reason, details.testSide) : { conflict: false };
  if (conflict.conflict && conflict.warning) lines.push('', `Flagged at booking: ${conflict.warning}`);

  return lines.join('\n');
}
