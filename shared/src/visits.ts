import { SITE_VISIT_SIGN_OFF } from './houseContact';
import { NO_SHOW_CHARGE } from './charges';
import { reasonDef, type Side, type SiteVisitReason } from './lineTestAdvice';
import { visitDateLabel, type AccessNeed, type VisitSlot } from './siteVisit';

/**
 * Chasing a booked engineer visit, and cancelling it in time.
 *
 * The gap this closes: a supplier very often fixes a fault remotely in the
 * days after a visit is booked and does not withdraw the appointment.
 * Nobody notices, the engineer turns up to a working line, and the visit is
 * billed as no fault found — the same NO_SHOW_CHARGE as an empty building,
 * for a fault that was already fixed.
 *
 * Worse, the window to cancel for free is 24 hours. A check that happens on
 * the morning of the visit is a check that costs the charge whatever it
 * finds. So the chase opens two days out, and says plainly how long is left
 * before cancelling stops being free.
 */

/**
 * Who signs off a visit going ahead or being dropped.
 *
 * A person rather than a role, because there is one of him and pretending
 * otherwise would mean building an approvals system for a three-person desk.
 * The handle is what Zendesk needs to notify him; the email is what makes
 * him a follower.
 */
export const APPROVER = {
  name: 'Sam Roffey',
  email: 'sam@supportwizard.net',
  /** As typed in a Zendesk comment to notify him. */
  handle: '@Sam Roffey',
} as const;

/**
 * How long before the slot the chase opens.
 *
 * Two days, not one. Cancelling inside 24 hours is charged, so a check that
 * runs the day before has already lost the choice it exists to inform.
 */
export const CHECK_OPENS_HOURS = 48;

/** Inside this many hours of the slot, cancelling is charged anyway. */
export const FREE_CANCEL_HOURS = 24;

/** With no slot yet, the chase opens this long after booking instead. */
export const CHECK_OPENS_AFTER_BOOKING_HOURS = 48;

export type VisitState =
  /** Booked, nothing to do yet. */
  | 'booked'
  /** The chase is open: somebody has to say whether it is still needed. */
  | 'checking'
  /** Resolved without a visit; the appointment was dropped. */
  | 'cancelled'
  /** Checked and still needed; the slot is being held. */
  | 'confirmed'
  /** The engineer attended. */
  | 'attended';

export interface VisitRecord {
  id: string;
  /** The Zendesk ticket the customer is being talked to on. */
  ticketId: string;
  /** Our own service reference, so it ties back to a line. */
  serviceReference?: string;
  /** The supplier's fault reference, where there is one. */
  faultReference?: string;
  supplier?: string;
  reason: SiteVisitReason;
  access: AccessNeed;
  slot?: VisitSlot | null;
  state: VisitState;
  bookedAt: string;
  bookedBy?: string;
  /** Which side the line test pointed at when it was booked. */
  testSide?: Side;
  /** Set when the approver has been asked. */
  approvalAskedAt?: string;
  /** How it ended, and who said so. */
  closedAt?: string;
  closedBy?: string;
  outcomeNote?: string;
  /** What was true at the time of the check, kept as the reason for the call. */
  evidence?: string[];
}

/* ------------------------------------------------------------------ *
 * Timing
 * ------------------------------------------------------------------ */

const HOUR = 60 * 60 * 1000;

/** The slot as a moment. Midday, since a window is a range not an instant. */
export function slotTime(slot: VisitSlot | null | undefined): number | null {
  if (!slot?.date) return null;
  const t = new Date(`${slot.date}T12:00:00Z`).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Whether this visit needs somebody to look at it now.
 *
 * A visit already closed is never due. One with a slot becomes due two days
 * out. One with no slot becomes due two days after booking, because there is
 * nothing else to count from and a supplier that has not given a slot in two
 * days is a supplier worth chasing anyway.
 */
export function dueForCheck(visit: VisitRecord, now: Date = new Date()): boolean {
  if (visit.state === 'cancelled' || visit.state === 'attended') return false;
  const at = now.getTime();
  const slot = slotTime(visit.slot);
  if (slot !== null) return at >= slot - CHECK_OPENS_HOURS * HOUR;
  const booked = new Date(visit.bookedAt).getTime();
  if (Number.isNaN(booked)) return true;
  return at >= booked + CHECK_OPENS_AFTER_BOOKING_HOURS * HOUR;
}

/**
 * How long is left to cancel without being charged for it.
 *
 * Returns null where there is no slot to cancel against — nothing to be
 * charged for yet, which is a different answer from "plenty of time".
 */
export function cancelWindow(
  visit: VisitRecord,
  now: Date = new Date(),
): { hoursLeft: number; chargeable: boolean; label: string } | null {
  const slot = slotTime(visit.slot);
  if (slot === null) return null;

  const freeUntil = slot - FREE_CANCEL_HOURS * HOUR;
  const hoursLeft = Math.floor((freeUntil - now.getTime()) / HOUR);

  if (hoursLeft < 0) {
    return {
      hoursLeft,
      chargeable: true,
      label: `Inside the 24-hour window — cancelling now is charged at ${NO_SHOW_CHARGE} either way.`,
    };
  }
  if (hoursLeft === 0) {
    return { hoursLeft, chargeable: false, label: 'Less than an hour left to cancel without a charge.' };
  }
  return {
    hoursLeft,
    chargeable: false,
    label:
      hoursLeft === 1
        ? '1 hour left to cancel without a charge.'
        : `${hoursLeft} hours left to cancel without a charge.`,
  };
}

/** Chase order: the ones about to become chargeable first. */
export function sortByUrgency(visits: readonly VisitRecord[], now: Date = new Date()): VisitRecord[] {
  const key = (v: VisitRecord): number => {
    const slot = slotTime(v.slot);
    // No slot sorts last: nothing can become chargeable until there is one.
    return slot === null ? Number.MAX_SAFE_INTEGER : slot;
  };
  return [...visits].sort((a, b) => key(a) - key(b) || a.bookedAt.localeCompare(b.bookedAt));
}

/* ------------------------------------------------------------------ *
 * What gets written
 * ------------------------------------------------------------------ */

const slotPhrase = (slot: VisitSlot | null | undefined): string =>
  slot ? `${visitDateLabel(slot.date)}, ${slot.window}` : 'no slot confirmed yet';

/**
 * The internal note that pulls the approver in.
 *
 * Private, and it names him with the handle so Zendesk notifies him rather
 * than leaving it to somebody remembering to mention it. The deadline is in
 * the first line because that is the only part that is time-critical: after
 * it passes, the decision costs the same either way and the note is just
 * history.
 */
export function approvalRequestNote(input: {
  visit: VisitRecord;
  /** Deep link into NetKit, where there is a public URL to build one from. */
  deepLink?: string;
  requestedBy?: string;
  now?: Date;
}): string {
  const { visit } = input;
  const window = cancelWindow(visit, input.now ?? new Date());
  const def = reasonDef(visit.reason);

  const lines = [
    `${APPROVER.handle} — engineer visit to confirm or drop.`,
    '',
    window
      ? window.chargeable
        ? `Heads up: we are already inside the 24-hour window, so cancelling costs ${NO_SHOW_CHARGE} either way.`
        : `${window.label} After that it costs ${NO_SHOW_CHARGE} whatever we decide.`
      : 'No slot from the supplier yet, so there is nothing chargeable to cancel — but it is worth chasing.',
    '',
    `Slot: ${slotPhrase(visit.slot)}`,
    `Reason booked: ${def.label} (${def.side} side)`,
    ...(visit.supplier ? [`Supplier: ${visit.supplier}`] : []),
    ...(visit.faultReference ? [`Fault reference: ${visit.faultReference}`] : []),
    ...(visit.serviceReference ? [`Service: ${visit.serviceReference}`] : []),
    ...(visit.bookedBy ? [`Booked by: ${visit.bookedBy}`] : []),
    '',
    'The question is whether the supplier has quietly fixed this without telling us. They often do, and they ' +
      'do not withdraw the appointment, so the engineer arrives at a working line and it is billed as no fault ' +
      `found — the same ${NO_SHOW_CHARGE}.`,
  ];

  if (input.deepLink) {
    lines.push('', `Run the checks and decide here: ${input.deepLink}`);
  } else {
    lines.push('', 'Run the checks and decide in NetKit, under Visits.');
  }

  if (input.requestedBy) lines.push('', `Asked by ${input.requestedBy}.`);
  return lines.join('\n');
}

/**
 * The customer message when a visit is dropped.
 *
 * Public, like the booking message, and for the same reason: the customer
 * arranged their day around it. It says plainly that there is nothing to pay,
 * because the last thing they were told about this appointment was that it
 * could cost them NO_SHOW_CHARGE.
 */
export function visitCancelledMessage(input: {
  contactName?: string;
  slot?: VisitSlot | null;
  /** What made it unnecessary, in plain words. Optional. */
  because?: string;
}): { subject: string; body: string } {
  const greeting = input.contactName?.trim() ? `Hello ${input.contactName.trim()},` : 'Hello,';
  const because = input.because?.trim();

  const body = [
    greeting,
    '',
    input.slot
      ? `Good news — we have cancelled the engineer visit that was booked for ${slotPhrase(input.slot)}. ` +
        'You do not need anybody on site.'
      : 'Good news — we have cancelled the engineer visit that was booked for this fault. You do not need ' +
        'anybody on site.',
    '',
    because
      ? `The line has been tested and is working normally again: ${because}`
      : 'The line has been tested and is working normally again, so the visit is not needed.',
    '',
    'There is nothing to pay for the cancelled appointment. We cancelled it in good time, so the ' +
      'missed-appointment charge we mentioned when it was booked does not apply.',
    '',
    'We will keep an eye on the line for a few days in case anything comes back. If you see the same problem ' +
      'again, reply to this ticket and it comes straight to us — we would rather look again than have you put ' +
      'up with it.',
    '',
    'Kind regards',
    SITE_VISIT_SIGN_OFF,
  ].join('\n');

  return { subject: 'Engineer visit cancelled — nothing needed at your end', body };
}

/**
 * The internal note when the visit is still needed.
 *
 * The important part is the instruction about the slot. A supplier who is
 * asked "is this still needed" and told yes will sometimes rebook rather than
 * hold, and a rebooked visit is a new date the customer has not been told
 * about — which is how somebody ends up out when the engineer arrives.
 */
export function visitStillNeededNote(input: {
  visit: VisitRecord;
  checkedBy?: string;
  evidence?: readonly string[];
}): string {
  const lines = [
    'Checked before the visit: still needed.',
    '',
    `Slot to keep: ${slotPhrase(input.visit.slot)}`,
    'Do not let the supplier rebook. The customer has been told this date and has arranged to be there — a new ' +
      'date nobody has passed on is how a visit gets missed and charged for.',
  ];

  if (input.evidence?.length) {
    lines.push('', 'What the check found:', ...input.evidence.map((e) => `· ${e}`));
  }
  if (input.checkedBy) lines.push('', `Checked by ${input.checkedBy}.`);
  return lines.join('\n');
}
