/**
 * How long is left on a fault's SLA.
 *
 * The fault records already carry `slaTarget` and `committedAt` and neither
 * was ever shown as time remaining, so the one number an operator wants
 * during a chase -- am I about to breach this -- had to be worked out by
 * reading a date and doing the arithmetic in their head.
 *
 * A closed fault is measured against when it cleared rather than against
 * now, so a fault that breached last week still says so instead of drifting
 * further past its target every time the page is opened.
 */

export interface SlaState {
  /** Milliseconds remaining. Negative once the target has passed. */
  remainingMs: number;
  /** True when the target has passed and the fault was not cleared in time. */
  breached: boolean;
  /** True when the fault cleared inside its target. */
  metOnClear: boolean;
  /** `4h 20m`, or `2h 05m over` once breached. */
  label: string;
  /** How urgent this is, for colouring. */
  tone: 'ok' | 'soon' | 'breached';
  /** True while the clock is still running. */
  live: boolean;
}

/** Under this much time left, a chase stops being optional. */
const SOON_MS = 2 * 60 * 60 * 1000;

function humanise(ms: number): string {
  const total = Math.floor(Math.abs(ms) / 1000);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  // Days and hours for anything long, hours and minutes for the working
  // window, minutes alone once it is close -- which is when the number is
  // being watched.
  if (days > 0) return `${days}d ${String(hours).padStart(2, '0')}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m`;
}

/**
 * Reads the SLA clock for one fault.
 *
 * Returns null when there is nothing to measure -- no target, or a target
 * that is not a date. A missing SLA is common and is not an error; the UI
 * shows nothing rather than a zero.
 */
export function slaState(
  input: { slaTarget?: string; committedAt?: string; clearedAt?: string },
  now: Date = new Date(),
): SlaState | null {
  // `committedAt` is the supplier's own commitment and beats a generic
  // target where both are present: it is the date they will be held to.
  const raw = input.committedAt ?? input.slaTarget;
  if (!raw) return null;

  const target = new Date(raw);
  if (Number.isNaN(target.getTime())) return null;

  const cleared = input.clearedAt ? new Date(input.clearedAt) : null;
  const clearedValid = cleared && !Number.isNaN(cleared.getTime()) ? cleared : null;

  // A cleared fault is judged at the moment it cleared, not now.
  const measuredAt = clearedValid ?? now;
  const remainingMs = target.getTime() - measuredAt.getTime();
  const late = remainingMs < 0;

  if (clearedValid) {
    return {
      remainingMs,
      breached: late,
      metOnClear: !late,
      label: late ? `${humanise(remainingMs)} late` : `cleared with ${humanise(remainingMs)} to spare`,
      tone: late ? 'breached' : 'ok',
      live: false,
    };
  }

  return {
    remainingMs,
    breached: late,
    metOnClear: false,
    label: late ? `${humanise(remainingMs)} over` : humanise(remainingMs),
    tone: late ? 'breached' : remainingMs <= SOON_MS ? 'soon' : 'ok',
    live: true,
  };
}
