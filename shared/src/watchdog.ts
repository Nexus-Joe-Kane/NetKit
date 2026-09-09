/**
 * Is the site up, and if not, whose fault is it?
 *
 * A check every five minutes against everything that can say whether a site
 * is reachable — the UniFi console, the Zen circuit, the Giacom service. One
 * failed check is a blip; two in a row is an outage worth somebody's morning.
 * At that point the portal runs the line tests itself, bundles what it found,
 * and puts an unassigned ticket on the desk with an event behind it.
 *
 * The whole file is pure. State in, state and a list of things to do out. The
 * point of that is testability: the rules below are the ones that decide
 * whether a customer gets rung at seven in the morning, and they are much
 * easier to get right when they can be driven through a hundred synthetic
 * checks in a millisecond than when they are tangled up with HTTP.
 *
 * The rule that took the most care is the reset. Somebody who marks an event
 * resolved must not be emailed again five minutes later because a rolling
 * 24-hour counter is still sitting above its threshold from the outage they
 * have just fixed. So resolving moves a watermark, and everything before the
 * watermark stops counting. Not "clear the history" — the history is still
 * worth reading — but "stop counting it towards raising the next one".
 */

/** Every five minutes. Frequent enough to catch a reboot, cheap enough to run. */
export const CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Two consecutive failures before anything is raised.
 *
 * One is a blip: a console losing its heartbeat, a request timing out, a
 * router rebooting after a firmware push. Raising on one would put a ticket
 * on the desk every time anything anywhere hiccuped, and a board full of
 * tickets that resolve themselves is a board nobody reads.
 */
export const FAILURES_TO_RAISE = 2;

/**
 * Two consecutive successes before an outage is called over.
 *
 * Asymmetric on purpose. A flapping line answers one check in three, and
 * closing on the first success would open and close the same event all
 * morning.
 */
export const SUCCESSES_TO_CLEAR = 2;

/** Drops in a day before the line is called unstable rather than merely up. */
export const UNSTABLE_DISCONNECTS = 5;

/** The window those drops are counted over. */
export const UNSTABLE_WINDOW_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * What a check saw
 * ------------------------------------------------------------------ */

/** Which platform answered. Kept so an event can say what it is based on. */
export type CheckSource = 'unifi' | 'zen' | 'giacom' | 'jola';

export interface CheckResult {
  source: CheckSource;
  at: string;
  /**
   * `up`, `down`, or `unknown`.
   *
   * `unknown` is a first-class answer and is not `down`. An expired API key,
   * a 500 from a console, a circuit breaker that has tripped — none of those
   * are the customer being off. Treating them as `down` is how a portal
   * raises forty tickets the morning a credential expires.
   */
  reachable: 'up' | 'down' | 'unknown';
  /** What answered, in the provider's own words, for the event page. */
  detail?: string;
}

/** `up` if anything says up; `down` only if something says down and nothing says up. */
export function verdict(results: readonly CheckResult[]): 'up' | 'down' | 'unknown' {
  if (!results.length) return 'unknown';
  if (results.some((r) => r.reachable === 'up')) return 'up';
  if (results.some((r) => r.reachable === 'down')) return 'down';
  return 'unknown';
}

/* ------------------------------------------------------------------ *
 * What the watcher remembers
 * ------------------------------------------------------------------ */

export interface SiteWatchState {
  /** The client-index key, so a site is one thing across every platform. */
  key: string;
  siteName: string;
  lastCheckedAt?: string;
  lastVerdict?: 'up' | 'down' | 'unknown';
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  /** When the current outage started. Absent when the site is up. */
  downSince?: string;
  /** Timestamps of drops, newest last. Trimmed to the counting window. */
  disconnections: string[];
  /**
   * Drops before this moment do not count towards raising anything.
   *
   * Set when somebody resolves an event. The history stays — it is worth
   * reading — but it stops arming the threshold that would raise the next
   * one straight back.
   */
  countingFrom?: string;
  /** Planned works and the like: checks still run, nothing is raised. */
  suppressedUntil?: string;
  /**
   * The open outage event, where there is one.
   *
   * Outages only. A stability report is not an outage — the site is up — and
   * hanging one on this field would have the next good check call it
   * recovered, which it never was.
   */
  openEventId?: string;
  /**
   * When the site was last reported unstable.
   *
   * Without this a site sitting above the threshold reports unstable on every
   * check: 288 identical reports a day. Cleared once the drops fall back
   * under, so a site that goes bad again is reported again.
   */
  unstableNotifiedAt?: string;
}

export function newWatchState(key: string, siteName: string): SiteWatchState {
  return { key, siteName, consecutiveFailures: 0, consecutiveSuccesses: 0, disconnections: [] };
}

/* ------------------------------------------------------------------ *
 * What to do about it
 * ------------------------------------------------------------------ */

/**
 * `raise` — two failures in a row and nothing open: diagnose and make a ticket.
 * `recovered` — an open event's site is answering again.
 * `unstable` — up, but dropping too often to leave alone.
 * `nothing` — the usual answer.
 */
export type WatchAction = 'raise' | 'recovered' | 'unstable' | 'nothing';

export interface CheckOutcome {
  state: SiteWatchState;
  action: WatchAction;
  /** Why, in one line, for the audit row and the event page. */
  because: string;
}

const ms = (iso?: string): number => (iso ? Date.parse(iso) : Number.NaN);

/** Drops that still count: inside the window, and after any resolution. */
export function countingDisconnections(state: SiteWatchState, now: string): string[] {
  const cutoffs = [ms(now) - UNSTABLE_WINDOW_MS];
  const watermark = ms(state.countingFrom);
  if (!Number.isNaN(watermark)) cutoffs.push(watermark);
  const cutoff = Math.max(...cutoffs);
  return state.disconnections.filter((at) => {
    const t = ms(at);
    return !Number.isNaN(t) && t >= cutoff;
  });
}

export function isUnstable(state: SiteWatchState, now: string): boolean {
  return countingDisconnections(state, now).length >= UNSTABLE_DISCONNECTS;
}

function suppressed(state: SiteWatchState, now: string): boolean {
  const until = ms(state.suppressedUntil);
  return !Number.isNaN(until) && ms(now) < until;
}

/**
 * One check, folded in.
 *
 * Returns a new state rather than mutating, so a sweep that throws halfway
 * cannot leave a site counted twice.
 */
export function applyCheck(
  state: SiteWatchState,
  results: readonly CheckResult[],
  now: string,
): CheckOutcome {
  const seen = verdict(results);
  const next: SiteWatchState = {
    ...state,
    disconnections: [...state.disconnections],
    lastCheckedAt: now,
    lastVerdict: seen,
  };

  // Nothing could tell us. Do not move either counter: an outage that
  // started before a credential expired should still be an outage, and a
  // healthy site should not creep towards a ticket because a console is down.
  if (seen === 'unknown') {
    return { state: next, action: 'nothing', because: 'Nothing could say whether the site was up.' };
  }

  if (seen === 'down') {
    next.consecutiveSuccesses = 0;
    next.consecutiveFailures = state.consecutiveFailures + 1;

    // The drop is recorded on the first failed check, not on the second.
    // Recording it on the raise would undercount a site that drops for five
    // minutes at a time all day and never trips the threshold.
    if (state.consecutiveFailures === 0) {
      next.downSince = now;
      next.disconnections = [...next.disconnections, now].slice(-200);
    }

    if (suppressed(state, now)) {
      return { state: next, action: 'nothing', because: 'The site is down, and alerting is suppressed until ' + state.suppressedUntil + '.' };
    }
    if (next.openEventId) {
      return { state: next, action: 'nothing', because: 'Still down, on an event that is already open.' };
    }
    if (next.consecutiveFailures >= FAILURES_TO_RAISE) {
      return {
        state: next,
        action: 'raise',
        because: `${next.consecutiveFailures} checks in a row could not reach the site.`,
      };
    }
    return {
      state: next,
      action: 'nothing',
      because: 'One failed check. Waiting for a second before calling it an outage.',
    };
  }

  // Up.
  next.consecutiveFailures = 0;
  next.consecutiveSuccesses = state.consecutiveSuccesses + 1;

  if (next.openEventId && next.consecutiveSuccesses >= SUCCESSES_TO_CLEAR) {
    delete next.downSince;
    return {
      state: next,
      action: 'recovered',
      because: `${next.consecutiveSuccesses} checks in a row reached the site.`,
    };
  }
  if (next.openEventId) {
    return { state: next, action: 'nothing', because: 'Answering again, but not yet for long enough to call it fixed.' };
  }

  delete next.downSince;

  if (!isUnstable(next, now)) {
    // Back under the threshold, so a fresh run of drops is worth reporting.
    delete next.unstableNotifiedAt;
    return { state: next, action: 'nothing', because: 'The site is up.' };
  }

  if (suppressed(state, now) || next.unstableNotifiedAt) {
    return { state: next, action: 'nothing', because: 'Still dropping, and already reported.' };
  }

  next.unstableNotifiedAt = now;
  const drops = countingDisconnections(next, now).length;
  return {
    state: next,
    action: 'unstable',
    because: `${drops} drops in the last 24 hours. The site is up, but not staying up.`,
  };
}

/* ------------------------------------------------------------------ *
 * Closing one down
 * ------------------------------------------------------------------ */

/**
 * What somebody chose when they cleared an event.
 *
 * `resolved` — fixed. Start counting again from here, so it takes two fresh
 *   failed checks to raise the next one and the drops from this outage do not
 *   arm the threshold.
 * `monitoring` — seen, not fixed. Nothing is raised while it stays open, and
 *   the counters keep running so the history is honest.
 * `expected` — planned works, a customer moving office, a site being rebuilt.
 *   Alerting is suppressed until a date somebody has to give.
 * `not-ours` — not a site we look after. Stop checking it.
 */
export type Disposition = 'resolved' | 'monitoring' | 'expected' | 'not-ours';

export const DISPOSITIONS: Array<{ id: Disposition; label: string; hint: string; needsUntil?: boolean }> = [
  {
    id: 'resolved',
    label: 'Resolved',
    hint: 'Fixed. Counting starts again from now, so it takes two fresh failed checks to raise this site again.',
  },
  {
    id: 'monitoring',
    label: 'Keeping an eye on it',
    hint: 'Seen but not fixed. Nothing new is raised while this stays open, and the drops keep counting.',
  },
  {
    id: 'expected',
    label: 'Expected',
    hint: 'Planned works, a move, a rebuild. Alerting is off until the date you give.',
    needsUntil: true,
  },
  {
    id: 'not-ours',
    label: 'Not our site',
    hint: 'Stop checking it. It will not come back until somebody adds it again.',
  },
];

export interface Clearance {
  disposition: Disposition;
  at: string;
  /** Required for `expected`: when to start alerting again. */
  until?: string;
  by?: string;
  note?: string;
}

/** Why a clearance cannot be accepted as given, or nothing. */
export function clearanceProblem(clearance: Clearance): string | undefined {
  if (clearance.disposition === 'expected') {
    const until = ms(clearance.until);
    if (Number.isNaN(until)) return 'Say when the planned work ends, or alerting stays off for good.';
    if (until <= ms(clearance.at)) return 'That date has already passed.';
  }
  return undefined;
}

/**
 * The watcher's state after somebody clears an event.
 *
 * The counter reset lives here and nowhere else. `resolved` moves
 * `countingFrom` to the moment of resolution, which is what stops the next
 * check raising a fresh event off the back of drops that have already been
 * dealt with.
 */
export function applyClearance(state: SiteWatchState, clearance: Clearance): SiteWatchState {
  const next: SiteWatchState = { ...state, disconnections: [...state.disconnections] };
  delete next.openEventId;

  switch (clearance.disposition) {
    case 'resolved':
      // Both counters, not just the failure one. A site cleared while still
      // failing must earn its next event from scratch.
      next.countingFrom = clearance.at;
      next.consecutiveFailures = 0;
      next.consecutiveSuccesses = 0;
      delete next.downSince;
      delete next.suppressedUntil;
      delete next.unstableNotifiedAt;
      break;

    case 'monitoring':
      // Deliberately changes no counter. "I have seen it" is not "it is
      // fixed", and a history that quietly restarted every time somebody
      // acknowledged something would understate a site that is genuinely bad.
      break;

    case 'expected':
      if (clearance.until) next.suppressedUntil = clearance.until;
      break;

    case 'not-ours':
      // Handled by the caller removing the site. Counters are left alone so
      // that a site added back by mistake does not read as freshly healthy.
      break;
  }

  return next;
}

/** Where the fault sits, once the tests have run. */
export type Attribution = 'ours' | 'supplier' | 'power-or-site' | 'unclear';

/**
 * Whose problem it is, from what the checks and tests said.
 *
 * The judgement the desk makes first and the one worth automating, because
 * it decides who gets rung. Deliberately conservative: `unclear` is a real
 * answer, and a wrong confident answer sends an engineer to the wrong place.
 */
export function attribute(input: {
  /** Did the console answer? */
  unifi?: 'up' | 'down' | 'unknown';
  /** Did the circuit answer? */
  circuit?: 'up' | 'down' | 'unknown';
  /** Did a line test find a fault, and on whose side? */
  lineTest?: 'network-fault' | 'clean' | 'not-run';
  /** Is there a mobile backup, and is it carrying traffic? */
  backupCarrying?: boolean;
}): { attribution: Attribution; because: string } {
  const { unifi, circuit, lineTest, backupCarrying } = input;

  if (lineTest === 'network-fault') {
    return { attribution: 'supplier', because: 'The line test found a fault in the network.' };
  }

  // The circuit is up and the console is not: everything between the
  // customer's socket and the internet is working, so what is broken is on
  // our side of it.
  if (circuit === 'up' && unifi === 'down') {
    return {
      attribution: 'ours',
      because: 'The circuit is up but the console is not answering, so the fault is between the socket and the network.',
    };
  }

  if (circuit === 'down' && lineTest === 'clean') {
    // A clean test on a dead circuit is the signature of no power at the
    // site, or kit unplugged — not a network fault to raise with a supplier
    // who will find nothing and bill for the visit.
    return {
      attribution: 'power-or-site',
      because: 'The circuit is down and the line tests clean, which usually means no power or kit unplugged on site.',
    };
  }

  if (circuit === 'down' && unifi === 'down' && backupCarrying === true) {
    return {
      attribution: 'supplier',
      because: 'Everything hardwired is down and the mobile backup is carrying the site.',
    };
  }

  return { attribution: 'unclear', because: 'Not enough came back to say where the fault is.' };
}
