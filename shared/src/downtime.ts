/**
 * How long a line has been down.
 *
 * Two figures with different jobs. The moment it went down is stated to the
 * second and never rounded: it is evidence, it goes on a fault, and a
 * supplier will ask for it. The elapsed time is rounded to five minutes and
 * only recomputed on that boundary, so a number an engineer reads out on a
 * call is not "3 hours 42 minutes and 17 seconds" and is not different by
 * the time they have finished the sentence.
 */

/** The rounding, in milliseconds. */
export const DOWNTIME_STEP_MS = 5 * 60 * 1000;

export interface Downtime {
  /** ISO timestamp of when it went down, unrounded. */
  since: string;
  /** `08/09/2026 at 14:32:07` — to the second, for a fault or a note. */
  exact: string;
  /** `3 hours 40 minutes`, rounded down to the 5-minute step. */
  elapsed: string;
  /** Milliseconds, rounded down to the step, for anything comparing. */
  elapsedMs: number;
  /** Where the timestamp came from, so a report can say. */
  basis: 'provider' | 'radius-session' | 'last-auth' | 'last-resync';
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** `08/09/2026 at 14:32:07` in UK order, local time. */
export function formatExact(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return (
    `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} at ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/**
 * Words for a duration.
 *
 * Two units at most. "4 days 3 hours" is a number somebody can hold; "4 days
 * 3 hours 25 minutes" is one they have to write down, and the third unit
 * never changes the decision.
 */
export function describeDuration(ms: number): string {
  if (ms < 60_000) return 'less than a minute';

  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / (60 * 24));
  const hours = Math.floor((minutes % (60 * 24)) / 60);
  const mins = minutes % 60;

  const part = (value: number, unit: string): string => `${value} ${unit}${value === 1 ? '' : 's'}`;

  if (days > 0) return hours > 0 ? `${part(days, 'day')} ${part(hours, 'hour')}` : part(days, 'day');
  if (hours > 0) return mins > 0 ? `${part(hours, 'hour')} ${part(mins, 'minute')}` : part(hours, 'hour');
  return part(mins, 'minute');
}

/**
 * The best available answer to "when did this go down", and where it came
 * from.
 *
 * Ordered by how directly each source answers the question. A provider
 * saying so outright beats us inferring it from a RADIUS session, which
 * beats a last-auth timestamp — because a last auth is when it last *worked*,
 * which is an upper bound on when it broke rather than the moment itself.
 * Whichever is used is named, so nobody quotes an inference as a fact.
 */
export function downtimeFrom(
  input: {
    downSince?: string;
    radius?: { online?: boolean; onlineSince?: string; lastAuthAt?: string };
    sync?: { lastResync?: string };
  },
  now: Date = new Date(),
): Downtime | null {
  // A line that is up has no downtime, whatever timestamps it carries.
  if (input.radius?.online === true) return null;

  const candidates: Array<{ iso?: string; basis: Downtime['basis'] }> = [
    { iso: input.downSince, basis: 'provider' },
    // `onlineSince` on an offline line is when the session that has since
    // ended began, so it is not the moment it went down. Only used when
    // nothing better exists, and labelled as the session rather than the
    // fault.
    { iso: input.radius?.lastAuthAt, basis: 'last-auth' },
    { iso: input.sync?.lastResync, basis: 'last-resync' },
    { iso: input.radius?.onlineSince, basis: 'radius-session' },
  ];

  const chosen = candidates.find((c) => {
    if (!c.iso) return false;
    const t = new Date(c.iso).getTime();
    return Number.isFinite(t) && t <= now.getTime();
  });
  if (!chosen?.iso) return null;

  const raw = now.getTime() - new Date(chosen.iso).getTime();
  const elapsedMs = Math.floor(raw / DOWNTIME_STEP_MS) * DOWNTIME_STEP_MS;

  return {
    since: chosen.iso,
    exact: formatExact(chosen.iso),
    elapsed: describeDuration(elapsedMs),
    elapsedMs,
    basis: chosen.basis,
  };
}

/** How the basis reads on screen, so an inference is never quoted as fact. */
export const BASIS_LABEL: Record<Downtime['basis'], string> = {
  provider: 'the provider states this',
  'radius-session': 'from the last RADIUS session',
  'last-auth': 'last successful authentication — the line broke at or after this',
  'last-resync': 'last resync reported',
};

/**
 * Milliseconds until the elapsed figure would change.
 *
 * A timer set to this rather than to a fixed minute means the number changes
 * exactly when it becomes wrong, and not four and a half minutes later.
 */
export function msUntilNextStep(since: string, now: Date = new Date()): number {
  const raw = now.getTime() - new Date(since).getTime();
  if (!Number.isFinite(raw)) return DOWNTIME_STEP_MS;
  const remainder = raw % DOWNTIME_STEP_MS;
  return DOWNTIME_STEP_MS - (remainder < 0 ? 0 : remainder);
}
