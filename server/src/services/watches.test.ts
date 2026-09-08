import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SiteReport } from '@sw/shared';
import {
  WATCH_LIMIT_PER_USER,
  addWatch,
  allWatches,
  applyCheck,
  listWatches,
  recordCheckFailure,
  reloadWatches,
  removeWatch,
  resetWatches,
  snapshotOf,
} from './watches';

/**
 * Same discipline as the quota suite: `DATA_DIR` is set before anything
 * touches the config singleton, and each test file is its own process.
 */
const dir = mkdtempSync(join(tmpdir(), 'netkit-watches-'));
process.env.DATA_DIR = dir;

interface Offer {
  technology: string;
  status: string;
  serviceability?: 'confirmed' | 'footprint' | 'unknown';
}

/**
 * The smallest report `snapshotOf` reads. Cast rather than built in full,
 * because a complete `SiteReport` fixture would be a hundred lines of fields
 * this module never looks at, and every one of them would be a lie about
 * what the test is checking.
 */
function report(
  opts: {
    uprn?: string;
    offers?: Offer[];
    headline?: { technology: string; downMbps?: number };
    fttp?: { buildStatus?: string; rfsDate?: string };
  } = {},
): SiteReport {
  return {
    address: {
      uprn: opts.uprn ?? '100023253338',
      singleLine: '45 Brockley Rise, London, SE23 1JG',
      postcode: 'SE23 1JG',
    },
    uprn: opts.uprn ?? '100023253338',
    broadband: {
      offers: opts.offers ?? [],
      ...(opts.headline ? { headline: opts.headline } : {}),
      ...(opts.fttp ? { openreach: { fttp: { available: true, ...opts.fttp } } } : {}),
    },
  } as unknown as SiteReport;
}

const USER = 'user-a';

test('a snapshot counts only what can actually be sold', () => {
  const snap = snapshotOf(
    report({
      offers: [
        { technology: 'FTTP', status: 'available', serviceability: 'confirmed' },
        { technology: 'FTTC', status: 'available', serviceability: 'confirmed' },
        // Present in the area, never checked at this address. Knowing about
        // it is useful; counting it as orderable would be a lie.
        { technology: 'FTTP', status: 'available', serviceability: 'footprint' },
        { technology: 'GFAST', status: 'unavailable', serviceability: 'confirmed' },
      ],
      headline: { technology: 'FTTP', downMbps: 1000 },
      fttp: { buildStatus: 'RFS' },
    }),
  );

  assert.equal(snap.orderableCount, 2, 'footprint and unavailable rows are not orderable');
  assert.deepEqual(snap.technologies, ['FTTC', 'FTTP', 'GFAST'], 'sorted, and footprint excluded');
  assert.equal(snap.bestTechnology, 'FTTP');
  assert.equal(snap.bestDownMbps, 1000);
  assert.equal(snap.fttpBuildStatus, 'RFS');
});

test('a watch is added once and refused the second time', () => {
  resetWatches();
  const first = addWatch(USER, report());
  assert.equal(first.ok, true);
  assert.equal(listWatches(USER).length, 1);

  const second = addWatch(USER, report());
  assert.equal(second.ok, false);
  assert.equal(second.ok === false && second.reason, 'duplicate');
  assert.equal(listWatches(USER).length, 1, 'the duplicate did not land');
});

test('a premises with no UPRN is refused, because nothing could re-check it', () => {
  resetWatches();
  const nameless = { ...report(), uprn: undefined, address: { singleLine: 'A field', postcode: 'SE23 1JG' } };
  const result = addWatch(USER, nameless as unknown as SiteReport);
  assert.equal(result.ok, false);
  assert.equal(listWatches(USER).length, 0);
});

test('the per-user limit holds, and one person cannot fill another person’s list', () => {
  resetWatches();
  for (let i = 0; i < WATCH_LIMIT_PER_USER; i += 1) {
    assert.equal(addWatch(USER, report({ uprn: `1000000${i}` })).ok, true);
  }
  const over = addWatch(USER, report({ uprn: '9999999' }));
  assert.equal(over.ok, false);
  assert.equal(over.ok === false && over.reason, 'limit');

  assert.equal(addWatch('user-b', report({ uprn: '9999999' })).ok, true, 'a different user is unaffected');
  assert.equal(listWatches('user-b').length, 1);
});

test('watches survive being written and re-read', () => {
  resetWatches();
  addWatch(USER, report());
  // Drops the in-memory copy, so the next read comes off disk.
  reloadWatches();
  const reloaded = listWatches(USER);
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0]?.uprn, '100023253338');
  assert.equal(reloaded[0]?.postcode, 'SE23 1JG');
});

test('a check with nothing new records the time and no history', () => {
  resetWatches();
  const added = addWatch(USER, report({ headline: { technology: 'FTTC', downMbps: 65 } }));
  assert.equal(added.ok, true);
  const id = added.ok ? added.watch.id : '';

  const changes = applyCheck(USER, id, report({ headline: { technology: 'FTTC', downMbps: 65 } }));
  assert.deepEqual(changes, []);
  const [watch] = listWatches(USER);
  assert.ok(watch?.lastCheckedAt, 'the check is recorded even when nothing moved');
  assert.equal(watch?.lastChangedAt, undefined);
  assert.equal(watch?.history.length, 0);
});

test('a build going live is recorded as a change with history', () => {
  resetWatches();
  const added = addWatch(
    USER,
    report({
      offers: [{ technology: 'FTTC', status: 'available', serviceability: 'confirmed' }],
      headline: { technology: 'FTTC', downMbps: 65 },
      fttp: { buildStatus: 'Planned', rfsDate: '2027-09-20' },
    }),
  );
  const id = added.ok ? added.watch.id : '';

  const changes = applyCheck(
    USER,
    id,
    report({
      offers: [
        { technology: 'FTTC', status: 'available', serviceability: 'confirmed' },
        { technology: 'FTTP', status: 'available', serviceability: 'confirmed' },
      ],
      headline: { technology: 'FTTP', downMbps: 1000 },
      fttp: { buildStatus: 'RFS' },
    }),
  );

  assert.ok(changes.length > 0, 'FTTP arriving is worth an email');
  const [watch] = listWatches(USER);
  assert.ok(watch?.lastChangedAt);
  assert.equal(watch?.history.length, 1);
  assert.deepEqual(watch?.history[0]?.changes, changes);
  assert.equal(watch?.snapshot.bestTechnology, 'FTTP', 'the baseline moved forward');
});

test('a failed check is recorded, and a later good check clears it', () => {
  resetWatches();
  const added = addWatch(USER, report());
  const id = added.ok ? added.watch.id : '';

  recordCheckFailure(USER, id, 'Openreach returned 503');
  assert.equal(listWatches(USER)[0]?.lastError, 'Openreach returned 503');

  applyCheck(USER, id, report());
  assert.equal(listWatches(USER)[0]?.lastError, undefined, 'a good check clears the error');
});

test('removing a watch is idempotent and reported honestly', () => {
  resetWatches();
  const added = addWatch(USER, report());
  const id = added.ok ? added.watch.id : '';

  assert.equal(removeWatch(USER, id), true);
  assert.equal(removeWatch(USER, id), false, 'removing it twice is not a silent success');
  assert.equal(listWatches(USER).length, 0);
});

test('the sweep sees every user’s watches', () => {
  resetWatches();
  addWatch('user-a', report({ uprn: '111' }));
  addWatch('user-b', report({ uprn: '222' }));
  const all = allWatches();
  assert.equal(all.length, 2);
  assert.deepEqual([...new Set(all.map((w) => w.userId))].sort(), ['user-a', 'user-b']);
});

test('an unknown watch id is a no-op rather than a throw', () => {
  resetWatches();
  assert.deepEqual(applyCheck(USER, 'nope', report()), []);
  recordCheckFailure(USER, 'nope', 'whatever');
  assert.equal(listWatches(USER).length, 0);
});
