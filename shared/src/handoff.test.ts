import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  NETWORK_TEAM_SIGN_OFF,
  PUBLIC_REPLY_OPENER,
  handoffProblem,
  handoffSummary,
  internalHandoffNote,
  publicHandoffNote,
  sortTickets,
  ticketLabel,
  type HandoffDocument,
  type TicketOption,
} from './index';

const doc: HandoffDocument = {
  filename: 'site-report-100023336956.pdf',
  kind: 'Site report',
  about: '14 Oxford Street, London, W1D 1AN',
};

const ticket: TicketOption = {
  id: '48213',
  subject: 'Broadband keeps dropping',
  status: 'open',
  requesterName: 'Megan Doyle',
  requesterEmail: 'megan@markethalls.example',
  requesterPhone: '020 7000 0000',
  organisation: 'Market Halls Ltd',
  assigneeName: 'Joe Kane',
  updatedAt: '2026-09-09T08:00:00.000Z',
};

/* ---- The internal note is a filing action --------------------------- */

test('an internal note says what the document is, who made it and when', () => {
  // The only question an internal note about a document has to answer.
  const note = internalHandoffNote({ document: doc, by: 'Joe Kane', at: '2026-09-09T08:00:00.000Z' });
  assert.match(note, /Site report attached: site-report-100023336956\.pdf/);
  assert.match(note, /14 Oxford Street/);
  assert.match(note, /Produced by Joe Kane on 9 September 2026/);
});

test('an internal note is not signed off', () => {
  // A sign-off on an internal note reads like a letter to yourself.
  const note = internalHandoffNote({ document: doc, by: 'Joe Kane' });
  assert.doesNotMatch(note, /Kind regards/);
});

test('the engineer’s notes go on the internal note', () => {
  const note = internalHandoffNote({
    document: { ...doc, engineerNotes: 'Customer will not replace the switch.' },
    by: 'Joe Kane',
  });
  assert.match(note, /Notes on the document/);
  assert.match(note, /will not replace the switch/);
});

/* ---- The public reply is a message ---------------------------------- */

test('a public reply carries the sign-off, added rather than typed', () => {
  // So it cannot drift from every other customer-facing message we send.
  const note = publicHandoffNote({ document: doc, body: 'Thanks,\n\nHere is the report you asked for.' });
  assert.ok(note.endsWith(NETWORK_TEAM_SIGN_OFF));
  assert.match(note, /Here is the report you asked for/);
  assert.match(note, /attached the site report for 14 Oxford Street/);
});

test('the engineer’s notes never reach a customer', () => {
  // Notes written on an internal document are written for the desk. Putting
  // them in front of a customer is how "the customer is being difficult
  // about the wiring" ends up in an inbox.
  const note = publicHandoffNote({
    document: { ...doc, engineerNotes: 'Customer is being difficult about the wiring.' },
    body: 'Thanks, here is the report.',
  });
  assert.doesNotMatch(note, /difficult/);
});

test('the attachment can be left unmentioned', () => {
  const note = publicHandoffNote({ document: doc, body: 'As discussed.', mentionFile: false });
  assert.doesNotMatch(note, /attached/);
});

/* ---- What cannot be sent -------------------------------------------- */

test('a public reply of just a sign-off is refused', () => {
  // The failure worth guarding: the opener is pre-filled, so an untouched
  // box would send a customer a message consisting of a signature.
  assert.match(
    handoffProblem({ visibility: 'public', ticketId: '48213', body: PUBLIC_REPLY_OPENER }) ?? '',
    /Write something for the customer/,
  );
  assert.match(handoffProblem({ visibility: 'public', ticketId: '48213', body: '   ' }) ?? '', /Write something/);
  assert.equal(
    handoffProblem({ visibility: 'public', ticketId: '48213', body: 'Thanks, here it is.' }),
    undefined,
  );
});

test('an internal note needs no words, only a ticket', () => {
  assert.equal(handoffProblem({ visibility: 'private', ticketId: '48213' }), undefined);
  assert.match(handoffProblem({ visibility: 'private' }) ?? '', /Choose a ticket/);
});

/* ---- The confirmation ----------------------------------------------- */

test('the confirmation shows who will receive it, not just the number', () => {
  // The mistake being guarded against is the right document on the wrong
  // customer's ticket, and a confirmation that repeats the number confirms
  // nothing.
  const summary = handoffSummary({ ticket, visibility: 'public', document: doc });
  const labels = summary.rows.map((r) => r.label);
  assert.ok(labels.includes('Requester'));
  assert.ok(labels.includes('Email'));
  assert.ok(labels.includes('Phone'));
  assert.ok(labels.includes('Organisation'));
  assert.equal(summary.heading, 'This goes to the customer');
  assert.match(summary.warning ?? '', /Megan Doyle will be emailed/);
});

test('an internal send is headed as internal and carries no warning', () => {
  const summary = handoffSummary({ ticket, visibility: 'private', document: doc });
  assert.equal(summary.heading, 'This stays internal');
  assert.equal(summary.warning, undefined);
});

test('the warning says the engineer’s notes are not included', () => {
  const summary = handoffSummary({ ticket, visibility: 'public', document: doc });
  assert.match(summary.warning ?? '', /Nothing you have written on the document as a note is included/);
});

/* ---- Picking a ticket ----------------------------------------------- */

test('a ticket reads number first, then who, then what', () => {
  // The number is what people say out loud. Subject-first sorts into
  // nonsense and buries the two facts that identify a ticket.
  assert.equal(ticketLabel(ticket), '#48213 · Megan Doyle · Broadband keeps dropping');
});

test('a ticket with no requester still reads usefully', () => {
  assert.equal(
    ticketLabel({ id: '1', subject: 'Something', status: 'open', organisation: 'Willow Cafe' }),
    '#1 · Willow Cafe · Something',
  );
  assert.equal(ticketLabel({ id: '2', subject: 'Something', status: 'open' }), '#2 · Something');
});

test('tickets sort newest first, because a document is about recent work', () => {
  const sorted = sortTickets([
    { id: '1', subject: 'a', status: 'open', updatedAt: '2026-09-01T00:00:00Z' },
    { id: '2', subject: 'b', status: 'open', updatedAt: '2026-09-09T00:00:00Z' },
    { id: '3', subject: 'c', status: 'open' },
  ]);
  assert.deepEqual(sorted.map((t) => t.id), ['2', '1', '3']);
});
