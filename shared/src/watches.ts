/**
 * Watching a premises for change.
 *
 * An FTTP row reading "build planned, 20 Sept 2027" is worth nothing unless
 * somebody remembers to look again, and nobody does. The interesting changes
 * are slow — a planned build becomes orderable, an RFS date moves, a
 * technology appears — so the answer is not a faster refresh, it is being
 * told.
 */

/** The facts a change is judged against. */
export interface WatchSnapshot {
  /** Best orderable technology at the premises. */
  bestTechnology?: string;
  bestDownMbps?: number;
  /** How many options could be ordered. */
  orderableCount: number;
  /** Every technology seen, sorted, so an arrival or a withdrawal is visible. */
  technologies: string[];
  /** Openreach FTTP build state and date, which is what usually moves. */
  fttpBuildStatus?: string;
  fttpRfsDate?: string;
  takenAt: string;
}

export interface WatchRecord {
  id: string;
  uprn: string;
  address: string;
  postcode: string;
  createdAt: string;
  /** What it looked like when last checked. */
  snapshot: WatchSnapshot;
  lastCheckedAt?: string;
  /** When something last actually changed. */
  lastChangedAt?: string;
  /** What changed, most recent first. Capped. */
  history: WatchChange[];
  /** Set when a check failed, so a watch cannot fail silently for weeks. */
  lastError?: string;
}

export interface WatchChange {
  at: string;
  /** One line per difference, already in words. */
  changes: string[];
}

/** How many changes to keep per watch. */
export const WATCH_HISTORY_LIMIT = 10;

/**
 * Compares two snapshots and describes what moved, in words.
 *
 * Only differences worth an email. A speed estimate wobbling by a megabit
 * between two Openreach checks is noise, and a watch that emails on noise
 * gets muted within a week — which is the same as not having it.
 */
export function describeChanges(before: WatchSnapshot, after: WatchSnapshot): string[] {
  const out: string[] = [];

  if (before.bestTechnology !== after.bestTechnology) {
    out.push(
      after.bestTechnology
        ? `Best available is now ${after.bestTechnology}${
            before.bestTechnology ? ` (was ${before.bestTechnology})` : ''
          }`
        : `No technology is available any more (was ${before.bestTechnology})`,
    );
  }

  const gained = after.technologies.filter((t) => !before.technologies.includes(t));
  const lost = before.technologies.filter((t) => !after.technologies.includes(t));
  if (gained.length) out.push(`Now offered: ${gained.join(', ')}`);
  if (lost.length) out.push(`No longer offered: ${lost.join(', ')}`);

  if (before.orderableCount !== after.orderableCount) {
    out.push(`Orderable options: ${after.orderableCount} (was ${before.orderableCount})`);
  }

  if (before.fttpBuildStatus !== after.fttpBuildStatus) {
    out.push(
      after.fttpBuildStatus
        ? `Openreach FTTP build state is now "${after.fttpBuildStatus}"${
            before.fttpBuildStatus ? ` (was "${before.fttpBuildStatus}")` : ''
          }`
        : 'Openreach no longer report an FTTP build state',
    );
  }

  if (before.fttpRfsDate !== after.fttpRfsDate) {
    out.push(
      after.fttpRfsDate
        ? `FTTP ready-for-service date is now ${after.fttpRfsDate}${
            before.fttpRfsDate ? ` (was ${before.fttpRfsDate})` : ''
          }`
        : 'The FTTP ready-for-service date has been withdrawn',
    );
  }

  // Speed last, and only when it moves meaningfully. Openreach estimates
  // drift by a megabit or two between checks and nobody wants an email
  // about it.
  const beforeDown = before.bestDownMbps;
  const afterDown = after.bestDownMbps;
  if (beforeDown !== afterDown) {
    const changedALot =
      beforeDown === undefined ||
      afterDown === undefined ||
      Math.abs(afterDown - beforeDown) >= Math.max(5, beforeDown * 0.1);
    if (changedALot) {
      out.push(
        afterDown !== undefined
          ? `Best speed is now ${afterDown} Mb${beforeDown !== undefined ? ` (was ${beforeDown} Mb)` : ''}`
          : 'No speed estimate is published any more',
      );
    }
  }

  return out;
}
