import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  LICENCE_MARGIN,
  assignmentFor,
  assignmentProblem,
  failedSources,
  headcount,
  profileIsEmpty,
  ticketRate,
  unassignedSites,
  type AddressAssignment,
  type ClientIndexEntry,
  type ClientProfile,
} from './index';

/* ---- How many people work there ------------------------------------- */

test('Office 365 licences are quotable, with a margin', () => {
  const staff = headcount({ licences: 48 });
  assert.equal(staff.value, 48);
  assert.equal(staff.basis, 'licences');
  assert.equal(staff.unreliable, false);
  assert.equal(staff.margin, LICENCE_MARGIN);
  assert.match(staff.because, /shared mailboxes/);
});

test('a helpdesk contact count is offered and flagged loudly', () => {
  // Two numbers that look like the same number. A fifty-person company
  // where six people raise all the tickets counts as six, and quoting that
  // as a headcount is how a proposal gets priced wrong.
  const staff = headcount({ helpdeskContacts: 6 });
  assert.equal(staff.value, 6);
  assert.equal(staff.basis, 'contacts');
  assert.equal(staff.unreliable, true);
  assert.match(staff.because, /not a headcount/);
});

test('licences win over contacts when both exist', () => {
  assert.equal(headcount({ licences: 48, helpdeskContacts: 6 }).basis, 'licences');
});

test('nothing to estimate from says so rather than guessing zero', () => {
  const staff = headcount({});
  assert.equal(staff.value, undefined);
  assert.equal(staff.basis, 'none');
  assert.equal(headcount({ licences: 0 }).basis, 'none', 'zero licences is no answer, not an answer of zero');
});

/* ---- Is this client noisy? ------------------------------------------ */

const stats = { open: 3, raisedRecently: 40, solvedRecently: 38 };

test('ticket load is per head, because forty tickets means two different things', () => {
  // Forty from a four-hundred person firm is quiet. Forty from six people
  // means something is badly wrong.
  assert.equal(ticketRate(stats, headcount({ licences: 400 }))?.verdict, 'quiet');
  assert.equal(ticketRate(stats, headcount({ licences: 60 }))?.verdict, 'normal');
  assert.equal(ticketRate(stats, headcount({ licences: 40 }))?.verdict, 'busy');
  assert.equal(ticketRate(stats, headcount({ licences: 20 }))?.verdict, 'heavy');
});

test('a rate is not computed from a contact count', () => {
  // It would be dividing the tickets by the same people who raised them.
  assert.equal(ticketRate(stats, headcount({ helpdeskContacts: 6 })), undefined);
  assert.equal(ticketRate(stats, headcount({})), undefined);
});

/* ---- An empty page, and why -----------------------------------------*/

const profile = (over: Partial<ClientProfile> = {}): ClientProfile => ({
  entry: { key: 'market halls', name: 'Market Halls Ltd', aliases: [], sites: [], serviceRefs: [], sources: [], seenAt: '2026-09-09T08:00:00.000Z' },
  display: 'Market Halls Ltd',
  staff: headcount({}),
  sources: [],
  generatedAt: '2026-09-09T08:00:00.000Z',
  ...over,
});

test('an empty profile is recognised as empty', () => {
  assert.equal(profileIsEmpty(profile()), true);
  assert.equal(profileIsEmpty(profile({ devices: [{ id: 'd1', name: 'AP' }] })), false);
  assert.equal(profileIsEmpty(profile({ tickets: stats })), false);
});

test('an empty page can say which source failed', () => {
  // A client whose every source failed and a client we hold nothing about
  // look identical, and only one is a reason to go and fix a credential.
  const p = profile({
    sources: [
      { name: 'IT Glue', ok: false, detail: '401' },
      { name: 'UniFi', ok: true },
      { name: 'Jola', ok: false },
    ],
  });
  assert.deepEqual(failedSources(p), ['IT Glue', 'Jola']);
  assert.deepEqual(failedSources(profile({ sources: [{ name: 'IT Glue', ok: true }] })), []);
});

/* ---- Claiming an address -------------------------------------------- */

test('an assignment needs a UPRN, not a postcode', () => {
  // Two of our customers share a business park, so a postcode cannot
  // identify whose building it is.
  assert.match(assignmentProblem({ clientKey: 'k', clientName: 'n' }) ?? '', /needs a UPRN/);
  assert.match(assignmentProblem({ uprn: 'SE23 1AB', clientKey: 'k', clientName: 'n' }) ?? '', /needs a UPRN/);
  assert.match(assignmentProblem({ uprn: '12345', clientKey: 'k', clientName: 'n' }) ?? '', /needs a UPRN/);
  assert.equal(assignmentProblem({ uprn: '100023336956', clientKey: 'k', clientName: 'n' }), undefined);
});

test('an assignment needs a client', () => {
  assert.match(assignmentProblem({ uprn: '100023336956' }) ?? '', /which client/);
  assert.match(assignmentProblem({ uprn: '100023336956', clientKey: 'k' }) ?? '', /which client/);
});

test('an address already claimed is found by UPRN', () => {
  const assignments: AddressAssignment[] = [
    { uprn: '100023336956', clientKey: 'market halls', clientName: 'Market Halls Ltd', assignedAt: '2026-09-09T08:00:00.000Z' },
  ];
  assert.equal(assignmentFor(assignments, '100023336956')?.clientName, 'Market Halls Ltd');
  assert.equal(assignmentFor(assignments, '999'), undefined);
  assert.equal(assignmentFor(assignments, undefined), undefined);
});

test('the sites worth chasing are the ones with no UPRN', () => {
  // A site the index knows about but nothing can be asked about. Postcode-
  // only ones are one click from useful; name-only ones matter most.
  const entry: ClientIndexEntry = {
    key: 'market halls',
    name: 'Market Halls Ltd',
    aliases: [],
    sites: [
      { name: 'Victoria', uprn: '100023336956', postcode: 'SW1E 5NE' },
      { name: 'Oxford Street', postcode: 'W1D 1AN' },
      { name: 'The new one' },
    ],
    serviceRefs: [],
    sources: [],
    seenAt: '2026-09-09T08:00:00.000Z',
  };
  assert.deepEqual(unassignedSites(entry).map((s) => s.name), ['Oxford Street', 'The new one']);
});

test('the bands describe what an office actually generates', () => {
  // A ticket per person per quarter is a business that barely needs us; one
  // a month is ordinary. An earlier version put 0.67 in `busy`, which would
  // have flagged a perfectly normal sixty-person firm as a problem.
  const rate = (tickets: number, staff: number) =>
    ticketRate({ open: 0, raisedRecently: tickets, solvedRecently: 0 }, headcount({ licences: staff }))?.verdict;

  assert.equal(rate(3, 50), 'quiet', 'once a quarter each');
  assert.equal(rate(25, 50), 'normal', 'every other month each');
  assert.equal(rate(60, 50), 'busy', 'more than one each');
  assert.equal(rate(120, 50), 'heavy', 'something is wrong with the estate, not the users');
});
