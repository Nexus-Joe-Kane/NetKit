import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assign,
  assignmentByUprn,
  assignmentsForClient,
  listAssignments,
  reloadAssignments,
  resetAssignments,
  unassign,
} from './assignments';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'netkit-assign-'));

const market = {
  uprn: '100023336956',
  clientKey: 'market halls',
  clientName: 'Market Halls Ltd',
  addressLine: '191 Victoria Street',
  postcode: 'SW1E 5NE',
};

test('an address is claimed and found again by UPRN', () => {
  resetAssignments();
  const result = assign({ ...market, assignedBy: 'Joe Kane' });
  assert.equal(result.ok, true);
  assert.equal(assignmentByUprn('100023336956')?.clientName, 'Market Halls Ltd');
  assert.equal(assignmentByUprn('100023336956')?.assignedBy, 'Joe Kane');
});

test('an address without a UPRN is refused', () => {
  // Two of our customers share a business park, so a postcode cannot say
  // whose building it is.
  resetAssignments();
  const result = assign({ ...market, uprn: 'SW1E 5NE' });
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /needs a UPRN/);
});

test('reassigning replaces rather than accumulating', () => {
  // A building changes hands. A lookup must never have to choose between
  // two owners of the same address.
  resetAssignments();
  assign(market);
  assign({ ...market, clientKey: 'willow', clientName: 'Willow Cafe' });
  assert.equal(listAssignments().length, 1);
  assert.equal(assignmentByUprn('100023336956')?.clientName, 'Willow Cafe');
});

test('every address for one client is listed together', () => {
  resetAssignments();
  assign(market);
  assign({ ...market, uprn: '100023336957', siteName: 'Oxford Street' });
  assign({ uprn: '100023336958', clientKey: 'willow', clientName: 'Willow Cafe' });
  assert.equal(assignmentsForClient('market halls').length, 2);
  assert.equal(assignmentsForClient('willow').length, 1);
});

test('unassigning is idempotent and reported honestly', () => {
  resetAssignments();
  assign(market);
  assert.equal(unassign('100023336956'), true);
  assert.equal(unassign('100023336956'), false, 'nothing was there the second time');
});

test('assignments survive a restart', () => {
  // Losing these means every address goes back to being an anonymous
  // building, and somebody has to do the joining again.
  resetAssignments();
  assign({ ...market, note: 'Confirmed with the site manager' });
  reloadAssignments();
  assert.equal(assignmentByUprn('100023336956')?.note, 'Confirmed with the site manager');
});

test('a stale worker cannot drop another worker’s assignment', () => {
  // The same failure the credential vault had: a whole-file write from a
  // copy that predates somebody else's entry.
  resetAssignments();
  assign(market);
  reloadAssignments(); // a second worker, whose memory is now stale
  assign({ uprn: '100023336999', clientKey: 'willow', clientName: 'Willow Cafe' });

  reloadAssignments();
  assert.equal(listAssignments().length, 2);
});
