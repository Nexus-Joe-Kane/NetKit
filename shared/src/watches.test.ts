import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { describeChanges, type WatchSnapshot } from './watches';

const snap = (over: Partial<WatchSnapshot> = {}): WatchSnapshot => ({
  orderableCount: 1,
  technologies: ['SOGEA'],
  takenAt: '2026-09-01T00:00:00Z',
  ...over,
});

test('nothing changed means nothing to say', () => {
  assert.deepEqual(describeChanges(snap(), snap()), []);
});

test('a planned build becoming orderable is the headline case', () => {
  const before = snap({ technologies: ['SOGEA'], fttpBuildStatus: 'Build planned', fttpRfsDate: '2027-09-20', orderableCount: 1 });
  const after = snap({ technologies: ['SOGEA', 'FTTP'], bestTechnology: 'FTTP', fttpBuildStatus: 'RFS', orderableCount: 2 });
  const changes = describeChanges(before, after);
  assert.ok(changes.some((c) => /Best available is now FTTP/.test(c)));
  assert.ok(changes.some((c) => /Now offered: FTTP/.test(c)));
  assert.ok(changes.some((c) => /Orderable options: 2 \(was 1\)/.test(c)));
  assert.ok(changes.some((c) => /build state is now "RFS"/.test(c)));
  assert.ok(changes.some((c) => /ready-for-service date has been withdrawn/.test(c)));
});

test('an RFS date moving is reported with both dates', () => {
  const changes = describeChanges(
    snap({ fttpRfsDate: '2027-09-20' }),
    snap({ fttpRfsDate: '2027-03-31' }),
  );
  assert.equal(changes.length, 1);
  assert.match(changes[0]!, /now 2027-03-31 \(was 2027-09-20\)/);
});

test('a technology being withdrawn is reported', () => {
  const changes = describeChanges(
    snap({ technologies: ['SOGEA', 'FTTC'] }),
    snap({ technologies: ['SOGEA'] }),
  );
  assert.ok(changes.some((c) => /No longer offered: FTTC/.test(c)));
});

test('losing availability entirely is stated plainly', () => {
  const changes = describeChanges(
    snap({ bestTechnology: 'FTTP' }),
    snap({ bestTechnology: undefined }),
  );
  assert.ok(changes.some((c) => /No technology is available any more \(was FTTP\)/.test(c)));
});

test('a speed wobble is not worth an email', () => {
  // Openreach estimates drift between checks. A watch that emails on noise
  // gets muted, which is the same as not having it.
  assert.deepEqual(describeChanges(snap({ bestDownMbps: 80 }), snap({ bestDownMbps: 78 })), []);
  assert.deepEqual(describeChanges(snap({ bestDownMbps: 1000 }), snap({ bestDownMbps: 960 })), []);
});

test('a real speed jump is reported', () => {
  const changes = describeChanges(snap({ bestDownMbps: 80 }), snap({ bestDownMbps: 1000 }));
  assert.equal(changes.length, 1);
  assert.match(changes[0]!, /now 1000 Mb \(was 80 Mb\)/);
});

test('a small absolute change on a slow line still counts', () => {
  // 8 Mb to 20 Mb is small in megabits and large to the customer.
  const changes = describeChanges(snap({ bestDownMbps: 8 }), snap({ bestDownMbps: 20 }));
  assert.equal(changes.length, 1);
});

test('gaining a speed estimate where there was none is reported', () => {
  const changes = describeChanges(snap({ bestDownMbps: undefined }), snap({ bestDownMbps: 330 }));
  assert.ok(changes.some((c) => /Best speed is now 330 Mb/.test(c)));
});
