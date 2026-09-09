import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activityNote, withTrail } from '@sw/shared';
import { audit, resetStore } from '../auth/store';
import { activityFor, toActivityEntry, __activityTesting } from './activity';

// Set before anything touches the store. `config()` caches on its first
// call, and its first call is the first read or write of the audit log.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'netkit-activity-'));

const { inScope, identifiers } = __activityTesting;

/* ---- What lands on which trail --------------------------------------- */

test('a row is on the trail of anything it names', () => {
  const entry = {
    at: '2026-09-09T09:00:00.000Z',
    action: 'diagnostics.test_run',
    detail: { zenReference: 'ZEN123456', ticketId: '48213' },
  };
  assert.equal(inScope(entry, { ticketId: '48213' }), true);
  assert.equal(inScope(entry, { zenReference: 'ZEN123456' }), true);
  // Naming the circuit is enough on its own. A profile change audits the
  // circuit and no ticket, and it is still part of the same piece of work.
  assert.equal(inScope(entry, { zenReference: 'ZEN123456', ticketId: '99999' }), true);
});

test('a row that names nothing asked for is on no trail', () => {
  const entry = { at: '2026-09-09T09:00:00.000Z', action: 'diagnostics.test_run', detail: { zenReference: 'ZEN000001' } };
  assert.equal(inScope(entry, { ticketId: '48213' }), false);
  assert.equal(inScope(entry, { zenReference: 'ZEN123456' }), false);
});

test('a scope that names nothing matches nothing rather than everything', () => {
  // The failure mode this guards: an empty scope pasting the whole audit log
  // onto a customer's ticket.
  const entry = { at: '2026-09-09T09:00:00.000Z', action: 'fault.raised', detail: { ticketId: '48213' } };
  assert.equal(inScope(entry, {}), false);
});

test('a numeric ticket id in the log matches the string one asked for', () => {
  // Zendesk ids arrive as numbers from some paths and strings from others.
  const entry = { at: '2026-09-09T09:00:00.000Z', action: 'fault.raised', detail: { ticketId: 48213 } };
  assert.equal(identifiers(entry).ticketId, '48213');
  assert.equal(inScope(entry, { ticketId: '48213' }), true);
});

/* ---- What a row is allowed to say ------------------------------------ */

test('only allow-listed detail keys reach the ticket', () => {
  // The rule that matters. `detail` is a free-form bag — `order.*` spreads a
  // whole request object into it — so a careless audit call must not be able
  // to write a secret onto a customer's ticket.
  const rendered = toActivityEntry({
    at: '2026-09-09T09:00:00.000Z',
    action: 'diagnostics.test_run',
    detail: {
      type: 'Line',
      zenReference: 'ZEN123456',
      outcome: 'No fault found',
      dslPassword: 'Sup3rSecret!',
      apiKey: 'zen-live-abc123',
    },
  });

  const text = activityNote([rendered]);
  assert.doesNotMatch(text, /Sup3rSecret/);
  assert.doesNotMatch(text, /zen-live-abc123/);
  assert.match(text, /Ran a line test\. ZEN123456/);
  assert.match(text, /No fault found/);
});

test('the supplier is not named on a visit step', () => {
  // The trail rides on customer tickets, and the supplier's name is kept off
  // customer-facing material everywhere else in this portal.
  const rendered = toActivityEntry({
    at: '2026-09-09T09:00:00.000Z',
    action: 'ticket.site_visit_notified',
    detail: { ticketId: '48213', supplier: 'Zen', reason: 'ont-no-light', slot: '2026-09-11 AM' },
  });
  const text = activityNote([rendered]);
  assert.doesNotMatch(text, /Zen/);
  assert.match(text, /ont-no-light/);
});

test('an action with no renderer contributes its phrase and nothing else', () => {
  const rendered = toActivityEntry({
    at: '2026-09-09T09:00:00.000Z',
    action: 'visit.attended',
    detail: { ticketId: '48213', engineerNotes: 'anything at all' },
  });
  assert.equal(rendered.summary, 'Recorded that the engineer attended');
  assert.doesNotMatch(activityNote([rendered]), /anything at all/);
});

/* ---- Who did it ------------------------------------------------------ */

test('an automatic row carries the flag and no person', () => {
  const rendered = toActivityEntry({
    at: '2026-09-09T03:00:00.000Z',
    action: 'watch.changed',
    automatic: true,
    // The sweep audits under the watch owner's id while running unattended.
    actorId: 'user-a',
    actorEmail: 'joe@supportwizard.net',
    detail: { uprn: '100023336956', changes: ['speed'] },
  });
  assert.equal(rendered.automatic, true);
  assert.equal(rendered.actor, undefined);
  assert.match(activityNote([rendered]), /NetKit, automatically/);
});

test('a person keeps their email where the store has no name for them', () => {
  const rendered = toActivityEntry({
    at: '2026-09-09T09:00:00.000Z',
    action: 'fault.raised',
    actorEmail: 'joe@supportwizard.net',
    detail: { ticketId: '48213', category: 'No sync', zenReference: 'ZEN123456', reference: 'ZEN-F-991' },
  });
  assert.deepEqual(rendered.actor, { email: 'joe@supportwizard.net' });
  assert.match(activityNote([rendered]), /Supplier reference ZEN-F-991/);
});

/* ---- Reading it back out of the log ---------------------------------- */

test('the trail is read back oldest first, scoped, and filtered', async () => {
  resetStore();
  audit({ action: 'auth.login', actorEmail: 'joe@supportwizard.net', detail: { ticketId: '48213' } });
  audit({
    action: 'diagnostics.test_run',
    actorEmail: 'joe@supportwizard.net',
    detail: { ticketId: '48213', type: 'Line', zenReference: 'ZEN123456', outcome: 'Fault in the network' },
  });
  audit({ action: 'diagnostics.profile_change', detail: { zenReference: 'ZEN123456', profileCode: 'ADSL-A' } });
  audit({ action: 'fault.raised', detail: { ticketId: '99999', category: 'Somebody else' } });

  const trail = activityFor({ ticketId: '48213', zenReference: 'ZEN123456' });

  assert.deepEqual(
    trail.map((t) => t.action),
    ['diagnostics.test_run', 'diagnostics.profile_change'],
    'signing in is audit business, and another ticket is another trail',
  );

  const note = withTrail('Fault raised with the supplier.', 'private', trail);
  assert.match(note.primary, /Ran a line test/);
  assert.match(note.primary, /Requested a line profile change/);
  assert.doesNotMatch(note.primary, /Somebody else/);
  assert.equal(note.followUp, undefined);
});

test('a since cutoff drops older news', async () => {
  resetStore();
  const cutoff = new Date(Date.now() + 50).toISOString();
  audit({ action: 'diagnostics.test_run', detail: { ticketId: '77777', type: 'Line' } });
  await new Promise((r) => setTimeout(r, 80));
  audit({ action: 'fault.raised', detail: { ticketId: '77777', category: 'No sync' } });

  const trail = activityFor({ ticketId: '77777', since: cutoff });
  assert.deepEqual(trail.map((t) => t.action), ['fault.raised']);
});

test('a malformed log line cannot fail the note it is decorating', () => {
  // The real work — the fault raised with the supplier — has already
  // happened by the time a trail is built, and cannot be un-raised.
  assert.doesNotThrow(() => activityFor({ ticketId: '48213', since: 'not a date' }));
  assert.doesNotThrow(() => activityFor({ ticketId: '' }));
});

/* ---- How it reads on a real ticket ----------------------------------- */

test('a line test does not say "test" twice', () => {
  // What this looked like before: "Ran a line test. Line test on ZEN123456."
  const rendered = toActivityEntry({
    at: '2026-09-09T09:00:00.000Z',
    action: 'diagnostics.test_run',
    detail: { ticketId: '48213', zenReference: 'ZEN123456', type: 'Line', outcome: 'No sync at the NTE' },
  });
  const text = activityNote([rendered]);
  assert.equal(text.match(/[Tt]est/g)?.length, 1, text);
  assert.match(text, /Ran a line test\. ZEN123456\. No sync at the NTE\./);
});

test('a test of a kind worth naming still says which kind', () => {
  const rendered = toActivityEntry({
    at: '2026-09-09T09:00:00.000Z',
    action: 'diagnostics.test_run',
    detail: { zenReference: 'ZEN123456', type: 'Broadband' },
  });
  assert.equal(rendered.summary, 'ZEN123456 (Broadband)');
});

test('a watch change says what changed rather than how many', () => {
  // "1 change" against a twelve-digit UPRN is a line nobody can act on.
  const rendered = toActivityEntry({
    at: '2026-09-09T03:00:00.000Z',
    action: 'watch.changed',
    automatic: true,
    detail: { uprn: '100023336956', address: '12 Willow Road, SE23 1AB', changes: ['sync lost', 'speed dropped'] },
  });
  assert.equal(rendered.summary, '12 Willow Road, SE23 1AB');
  assert.equal(rendered.outcome, 'sync lost; speed dropped');
});

test('a long change list is trimmed rather than pasted whole', () => {
  const rendered = toActivityEntry({
    at: '2026-09-09T03:00:00.000Z',
    action: 'watch.changed',
    detail: { uprn: '1', changes: ['a', 'b', 'c', 'd', 'e'] },
  });
  assert.equal(rendered.outcome, 'a; b; c; and 2 more');
});

test('a change stored as a record is read, not stringified', () => {
  // Older rows hold objects. `[object Object]` on a ticket is worse than a count.
  const rendered = toActivityEntry({
    at: '2026-09-09T03:00:00.000Z',
    action: 'watch.changed',
    detail: { uprn: '1', changes: [{ summary: 'the line went down' }, { kind: 'speed' }] },
  });
  assert.equal(rendered.outcome, 'the line went down; speed');

  const opaque = toActivityEntry({
    at: '2026-09-09T03:00:00.000Z',
    action: 'watch.changed',
    detail: { uprn: '1', changes: [{ nothing: 'useful' }, { also: 'nothing' }] },
  });
  assert.equal(opaque.outcome, '2 changes');
  assert.doesNotMatch(activityNote([opaque]), /object Object/);
});
