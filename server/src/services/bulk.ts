import {
  BULK_MAX_ENTRIES,
  identify,
  type AddressRecord,
  type BulkResult,
  type BulkRow,
} from '@sw/shared';
import { badRequest } from '../lib/errors';
import { quotaState, consumeQuota } from './quota';
import { addressByUprn, addressesByPostcode, buildSiteReport, findLines, searchAddresses } from './resolve';

/**
 * Bulk premises lookup.
 *
 * Every row costs a real availability check against a wholesale account, so
 * this is written around the fair-use budget rather than alongside it: the
 * budget is read before each row, a row that cannot be paid for is marked
 * `skipped` rather than attempted, and the run reports how many it left
 * undone. A bulk tool that quietly burns a day's quota on the first attempt
 * would be worse than no bulk tool.
 */

/**
 * How many premises are checked at once.
 *
 * Three, not thirty. These are somebody else's rate limits, and a bulk run
 * is background work by nature -- finishing forty rows in ninety seconds
 * without upsetting Zen beats finishing in ten and being throttled for the
 * afternoon.
 */
const CONCURRENCY = 3;

/** Resolves one input to a premises, saying what had to be assumed. */
async function premisesFor(
  input: string,
): Promise<{ address: AddressRecord | null; kind: string; note?: string }> {
  const query = identify(input);

  switch (query.kind) {
    case 'uprn': {
      const address = await addressByUprn(query.normalised);
      return { address, kind: query.kind };
    }

    case 'postcode': {
      const list = await addressesByPostcode(query.normalised);
      if (!list.length) return { address: null, kind: query.kind };
      // A postcode is not a premises. One is checked and the row says so,
      // because a bid list of postcodes still wants an answer and a silent
      // pick of one address out of sixty would be a lie by omission.
      const note =
        list.length > 1
          ? `${list.length} premises at this postcode; checked ${list[0]!.singleLine}`
          : undefined;
      return { address: list[0]!, kind: query.kind, ...(note ? { note } : {}) };
    }

    case 'cli':
    case 'lineAccessId':
    case 'serviceId':
    case 'ontSerial': {
      const { lines } = await findLines(query);
      if (!lines.length) return { address: null, kind: query.kind };
      return { address: lines[0]!.address, kind: query.kind, note: `Resolved via ${lines[0]!.provider}` };
    }

    default: {
      // Free text. The ranking that fixed name search is what picks here.
      const matches = await searchAddresses(input, 5);
      if (!matches.length) return { address: null, kind: query.kind };
      const note =
        matches.length > 1 ? `${matches.length} possible matches; took ${matches[0]!.singleLine}` : undefined;
      return { address: matches[0]!, kind: query.kind, ...(note ? { note } : {}) };
    }
  }
}

/**
 * Summarises one premises into a row.
 *
 * The budget is reserved here rather than in the worker loop, and the check
 * and the spend sit next to each other with no `await` between them. That
 * matters: with three workers running, checking the budget and then awaiting
 * before spending let all three read the same remaining count and go ahead,
 * and a run of six overspent a budget of four. JavaScript is single
 * threaded, so a synchronous check-then-spend cannot interleave.
 *
 * Nothing is reserved until a premises has actually been resolved, so an
 * input that matches nothing costs nothing.
 */
async function checkOne(input: string, userId: string): Promise<BulkRow> {
  const { address, kind, note } = await premisesFor(input);
  if (!address) {
    return { input, kind, status: 'not_found', ...(note ? { note } : {}) };
  }

  if (!quotaState('availability', userId).allowed) {
    return {
      input,
      kind,
      status: 'skipped',
      ...(address.uprn ? { uprn: address.uprn } : {}),
      address: address.singleLine,
      postcode: address.postcode,
      note: "Not checked — today's fair-use budget is spent.",
    };
  }
  consumeQuota('availability', userId);

  const base: BulkRow = {
    input,
    kind,
    status: 'ok',
    ...(address.uprn ? { uprn: address.uprn } : {}),
    address: address.singleLine,
    postcode: address.postcode,
    ...(note ? { note } : {}),
  };

  // `includeSiblings: false` because a bulk row has no use for the other
  // sixty addresses at the postcode, and fetching them per row would
  // multiply the work for nothing.
  const report = await buildSiteReport(address, identify(input), { includeSiblings: false });

  const offers = report.broadband?.offers ?? [];
  // Orderable means orderable today: a footprint row is not a sale.
  const orderable = offers.filter((o) => o.status === 'available' && o.serviceability !== 'footprint');
  const headline = report.broadband?.headline;

  const notes = [
    note,
    report.status.broadband.ok ? undefined : `Availability: ${report.status.broadband.error ?? 'no answer'}`,
  ].filter(Boolean);

  return {
    ...base,
    // A premises that resolved but whose availability check failed is not a
    // checked premises. Calling it `ok` with the speed columns blank would
    // read, on a bid list, as "nothing available here".
    ...(report.status.broadband.ok ? {} : { status: 'error' as const }),
    ...(headline?.technology ? { bestTechnology: headline.technology } : {}),
    ...(headline?.operatorLabel ? { bestOperator: headline.operatorLabel } : {}),
    ...(headline?.downMbps != null ? { downMbps: headline.downMbps } : {}),
    ...(headline?.upMbps != null ? { upMbps: headline.upMbps } : {}),
    orderableCount: orderable.length,
    optionCount: offers.length,
    lineCount: report.lines.length,
    ...(notes.length ? { note: notes.join('. ') } : {}),
  };
}

export async function runBulkLookup(entries: string[], userId: string): Promise<BulkResult> {
  if (!entries.length) throw badRequest('Nothing to look up.');
  if (entries.length > BULK_MAX_ENTRIES) {
    throw badRequest(`Too many at once. ${BULK_MAX_ENTRIES} is the limit; this run had ${entries.length}.`);
  }

  const startedAt = new Date().toISOString();
  const started = Date.now();
  const rows: BulkRow[] = new Array(entries.length);
  let skippedForBudget = 0;
  let completed = 0;

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= entries.length) return;
      const input = entries[index]!;

      try {
        const row = await checkOne(input, userId);
        rows[index] = row;
        if (row.status === 'skipped') skippedForBudget += 1;
        else if (row.status === 'ok') completed += 1;
      } catch (err) {
        rows[index] = {
          input,
          kind: identify(input).kind,
          status: 'error',
          note: err instanceof Error ? err.message : String(err),
        };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker));

  const quota = quotaState('availability', userId);
  return {
    rows,
    requested: entries.length,
    completed,
    skippedForBudget,
    quota: {
      used: quota.used,
      limit: quota.limit,
      remaining: Number.isFinite(quota.remaining) ? quota.remaining : -1,
    },
    startedAt,
    durationMs: Date.now() - started,
  };
}
