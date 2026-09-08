import { config } from '../config';
import { sendEmail, watchChangeEmail } from '../auth/email';
import { audit, findUserById } from '../auth/store';
import { addressByUprn, buildSiteReport } from './resolve';
import { consumeQuota, quotaState } from './quota';
import { allWatches, applyCheck, recordCheckFailure } from './watches';
import { identify } from '@sw/shared';

/**
 * Re-checks watched premises and emails what changed.
 *
 * Runs on a slow schedule on purpose. The changes worth watching for -- a
 * planned FTTP build going live, an RFS date moving -- happen over months,
 * so checking a premises hourly would spend a day's fair-use budget to learn
 * nothing. Once a day per premises is generous for the question being asked.
 *
 * Nothing here is best-effort about the budget. A watch that cannot be paid
 * for is skipped and left for the next sweep rather than borrowing against
 * the quota a person needs for live work: somebody on the phone to a
 * customer outranks a background check every time.
 */

/** How long before a watch is due another look. */
export const CHECK_INTERVAL_MS = 20 * 60 * 60 * 1000;

/**
 * How many to check per sweep.
 *
 * A small number, because this shares a wholesale account with people doing
 * their jobs. Twenty watches spread over a few sweeps still comfortably
 * clears one check each per day.
 */
export const PER_SWEEP = 5;

const isDue = (lastCheckedAt?: string): boolean => {
  if (!lastCheckedAt) return true;
  const last = new Date(lastCheckedAt).getTime();
  if (Number.isNaN(last)) return true;
  return Date.now() - last >= CHECK_INTERVAL_MS;
};

/**
 * Which watches this sweep will look at.
 *
 * Separate from the sweep itself so the choice can be tested without
 * standing up an address provider: the ordering is the part that decides
 * whether a watch at the end of a long list ever gets checked at all.
 */
export function selectDue<T extends { watch: { lastCheckedAt?: string } }>(all: T[]): T[] {
  return all
    .filter(({ watch }) => isDue(watch.lastCheckedAt))
    // Oldest check first, so nothing at the end of the list starves. Never
    // checked sorts first, because an empty string precedes any timestamp.
    .sort((a, b) => (a.watch.lastCheckedAt ?? '').localeCompare(b.watch.lastCheckedAt ?? ''))
    .slice(0, PER_SWEEP);
}

export interface SweepOutcome {
  checked: number;
  changed: number;
  skippedForBudget: number;
  failed: number;
  emailed: number;
}

export async function sweepWatches(): Promise<SweepOutcome> {
  const outcome: SweepOutcome = { checked: 0, changed: 0, skippedForBudget: 0, failed: 0, emailed: 0 };

  const due = selectDue(allWatches());

  for (const { userId, watch } of due) {
    // Read and spend together, with no await between them -- the same
    // invariant the bulk runner needs, and for the same reason.
    if (!quotaState('availability', userId).allowed) {
      outcome.skippedForBudget += 1;
      continue;
    }
    consumeQuota('availability', userId);

    try {
      const address = await addressByUprn(watch.uprn);
      if (!address) {
        recordCheckFailure(userId, watch.id, 'The address lookup no longer resolves this UPRN.');
        outcome.failed += 1;
        continue;
      }

      const report = await buildSiteReport(address, identify(watch.uprn), { includeSiblings: false });
      const changes = applyCheck(userId, watch.id, report);
      outcome.checked += 1;
      if (!changes.length) continue;

      outcome.changed += 1;
      audit({
        action: 'watch.changed',
        actorId: userId,
        detail: { uprn: watch.uprn, changes },
      });

      // The email is the point of the feature, but a watch whose owner has
      // been deleted, or a deployment with no mailer, should still record
      // the change rather than throwing it away.
      const user = findUserById(userId);
      if (user?.email && config().resend.configured) {
        const mail = watchChangeEmail({ address: address.singleLine, uprn: watch.uprn, changes });
        const sent = await sendEmail(user.email, mail.subject, mail.html, mail.text);
        if (sent.ok) outcome.emailed += 1;
      }
    } catch (err) {
      recordCheckFailure(userId, watch.id, err instanceof Error ? err.message : String(err));
      outcome.failed += 1;
    }
  }

  return outcome;
}
