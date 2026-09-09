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

/**
 * How often a site cleared with an exception is checked.
 *
 * Monthly rather than never. A line signed off as knowingly bad is still a
 * line, and a site nobody looks at for a year is a site whose contract
 * renewal arrives as a surprise. But it is checked on a cadence that cannot
 * bombard anybody.
 */
export const EXCEPTION_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

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
  /**
   * When the open event was last noted as answering again.
   *
   * The same guard for the opposite case, and it was a live bug: with an
   * event open and the site back up, every subsequent check reported
   * `recovered` — 288 times a day, on an event a person has not closed yet.
   * Noted once; the event stays open until somebody clears it.
   */
  recoveryNotedAt?: string;
  /**
   * How often this site is checked.
   *
   * `sparse` is monthly, set by an exception somebody signed off. Absent
   * means the normal five minutes.
   */
  cadence?: 'normal' | 'sparse';
  /** Why this site is checked monthly, and who decided. */
  exception?: { reason: string; signedOffBy: string; at: string };
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
    // An open event means the work is already on somebody's desk. The check
    // keeps running so the history is complete, and nothing else happens:
    // no second test, no second ticket, no follow-up. Put to one side until
    // a person clears it.
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

  if (next.openEventId) {
    if (next.consecutiveSuccesses < SUCCESSES_TO_CLEAR) {
      return { state: next, action: 'nothing', because: 'Answering again, but not yet for long enough to say so.' };
    }
    // Noted once, not on every check for the rest of the day. The event is
    // not closed either way -- coming back up is not the same as being
    // fixed, and only a person deciding that closes it.
    if (next.recoveryNotedAt) {
      return { state: next, action: 'nothing', because: 'Still answering, and the event already says so.' };
    }
    next.recoveryNotedAt = now;
    delete next.downSince;
    return {
      state: next,
      action: 'recovered',
      because: `${next.consecutiveSuccesses} checks in a row reached the site. The event stays open until somebody closes it.`,
    };
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
 * What somebody chose when they closed an event.
 *
 * Three ways out, and the difference between them is what happens next
 * rather than how the row looks:
 *
 * `resolved` — fixed. A closure report goes on the same ticket (the clean
 *   line test, whether the console is back, what was done) and monitoring
 *   picks up on the next cycle at the normal five minutes. Counting restarts
 *   from here, so the drops already dealt with cannot raise the next one.
 *
 * `known-cause` — not fixed and not going to be. Failing kit on site the
 *   customer will not replace, a building with no power at weekends. No
 *   closure report, because nothing was closed; alerting stops until
 *   somebody puts the site back on watch, and it stays visible as a known
 *   problem rather than disappearing.
 *
 * `exception` — knowingly bad, signed off. Same closure report as `resolved`
 *   plus the engineer's reason and who accepted it, and the site drops to a
 *   monthly check. Monthly rather than never: a line signed off as bad is
 *   still a line, and one nobody looks at for a year is one whose renewal
 *   arrives as a surprise.
 *
 * `not-ours` — not a site we look after. Stop checking it.
 */
export type Disposition = 'resolved' | 'known-cause' | 'exception' | 'not-ours';

export interface DispositionDef {
  id: Disposition;
  label: string;
  hint: string;
  /** True where the ticket needs a closure report before this is allowed. */
  needsReport?: boolean;
  /** True where an engineer has to say why and who signed it off. */
  needsSignOff?: boolean;
}

export const DISPOSITIONS: readonly DispositionDef[] = [
  {
    id: 'resolved',
    label: 'Resolved',
    hint:
      'Fixed. A closure report goes on the ticket and monitoring restarts on the next cycle — it takes two ' +
      'fresh failed checks to raise this site again, so the drops from this outage cannot re-raise it.',
    needsReport: true,
  },
  {
    id: 'known-cause',
    label: 'Dismiss — known cause',
    hint:
      'Not fixed and not going to be: failing kit the customer will not replace, a building with no weekend ' +
      'power. No alerts until somebody puts it back on watch, and it stays listed as a known problem.',
  },
  {
    id: 'exception',
    label: 'Resolve with exception',
    hint:
      'Knowingly bad and accepted. Closure report as above, plus your reason and who signed it off, and the ' +
      'site drops to a monthly check instead of every five minutes.',
    needsReport: true,
    needsSignOff: true,
  },
  {
    id: 'not-ours',
    label: 'Not our site',
    hint: 'Stop checking it. It will not come back until somebody adds it again.',
  },
];

export const dispositionDef = (id: Disposition): DispositionDef | undefined =>
  DISPOSITIONS.find((d) => d.id === id);

export interface Clearance {
  disposition: Disposition;
  at: string;
  by?: string;
  /** What was done and how it was left. Required where `needsReport`. */
  resolution?: string;
  /** Why an exception is acceptable. Required for `exception`. */
  exceptionReason?: string;
  /** Who accepted it. Required for `exception`. */
  signedOffBy?: string;
  note?: string;
}

/**
 * Why a clearance cannot be accepted as given, or nothing.
 *
 * Enforced here rather than in the form so the API cannot be talked past.
 * The sign-off requirement is the one that matters: an exception with no
 * name against it is a line quietly checked once a month because somebody
 * clicked a button, and in six months nobody will know who or why.
 */
export function clearanceProblem(clearance: Clearance): string | undefined {
  const def = dispositionDef(clearance.disposition);
  if (!def) return 'That is not a way to close an event.';

  if (def.needsReport && !(clearance.resolution ?? '').trim()) {
    return 'Say what was done and how it was left. It goes on the ticket as the closure report.';
  }
  if (def.needsSignOff) {
    if (!(clearance.exceptionReason ?? '').trim()) {
      return 'An exception needs a reason. In six months this is the only record of why the site stopped being checked.';
    }
    if (!(clearance.signedOffBy ?? '').trim()) {
      return 'An exception needs a name against it. Who accepted that the site stays like this?';
    }
  }
  return undefined;
}

/**
 * The watcher's state after somebody closes an event.
 *
 * The counter reset lives here and nowhere else. `resolved` moves
 * `countingFrom` to the moment of resolution, which is what stops the next
 * check raising a fresh event off the back of drops already dealt with.
 */
export function applyClearance(state: SiteWatchState, clearance: Clearance): SiteWatchState {
  const next: SiteWatchState = { ...state, disconnections: [...state.disconnections] };
  delete next.openEventId;
  delete next.recoveryNotedAt;

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
      // Back to the normal cadence: a site that was on an exception and has
      // now genuinely been fixed should be watched properly again.
      next.cadence = 'normal';
      delete next.exception;
      break;

    case 'known-cause':
      /*
       * No counter is reset, deliberately. The site is still bad and the
       * history should say so — what changes is that nobody is told about it
       * any more. Suppressed with no end date, which is the honest shape for
       * "the customer will not replace the switch": there is no date on
       * which that stops being true.
       */
      next.suppressedUntil = FOREVER;
      break;

    case 'exception':
      // Counting restarts, as with a resolution, because the closure report
      // says the line was tested. What differs is the cadence and the fact
      // that somebody's name is on it.
      next.countingFrom = clearance.at;
      next.consecutiveFailures = 0;
      next.consecutiveSuccesses = 0;
      delete next.downSince;
      delete next.suppressedUntil;
      delete next.unstableNotifiedAt;
      next.cadence = 'sparse';
      next.exception = {
        reason: (clearance.exceptionReason ?? '').trim(),
        signedOffBy: (clearance.signedOffBy ?? '').trim(),
        at: clearance.at,
      };
      break;

    case 'not-ours':
      // Handled by the caller removing the site. Counters are left alone so
      // that a site added back by mistake does not read as freshly healthy.
      break;
  }

  return next;
}

/**
 * A suppression with no end.
 *
 * A date rather than a flag, so every "is this suppressed" check stays one
 * comparison instead of two, and so the reason it is suppressed is never
 * ambiguous with a very long planned outage.
 */
export const FOREVER = '9999-12-31T00:00:00.000Z';

/** How often this site should be checked, in milliseconds. */
export function checkIntervalFor(state: SiteWatchState): number {
  return state.cadence === 'sparse' ? EXCEPTION_INTERVAL_MS : CHECK_INTERVAL_MS;
}

/**
 * Is this site due a check?
 *
 * The sweep asks per site rather than checking everything every time, so a
 * site on a monthly exception costs one request a month instead of 8,640.
 *
 * Named for sites rather than `dueForCheck`, which is already taken by the
 * visit chaser. Two exports with one name in a barrel file is a build error,
 * and the shorter name belongs to whichever came first.
 */
export function siteDueForCheck(state: SiteWatchState, now: string): boolean {
  const last = ms(state.lastCheckedAt);
  if (Number.isNaN(last)) return true;
  const at = ms(now);
  if (Number.isNaN(at)) return true;
  return at - last >= checkIntervalFor(state);
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
