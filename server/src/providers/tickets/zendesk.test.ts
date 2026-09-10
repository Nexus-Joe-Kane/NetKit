import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normaliseTicketId, searchOrganisations } from './zendesk';

const dir = mkdtempSync(join(tmpdir(), 'netkit-zd-'));
process.env.DATA_DIR = dir;

test('a ticket number is accepted with or without a hash', () => {
  assert.equal(normaliseTicketId('48213'), '48213');
  assert.equal(normaliseTicketId('#48213'), '48213');
  assert.equal(normaliseTicketId('  48213  '), '48213');
});

test('anything that is not a ticket number is refused rather than sent', () => {
  // A bad id would otherwise become a request to /tickets/<junk>.json and
  // come back as "no such ticket", which reads like the ticket was deleted.
  assert.equal(normaliseTicketId('SW-48213'), null);
  assert.equal(normaliseTicketId(''), null);
  assert.equal(normaliseTicketId('48213/comments'), null);
  assert.equal(normaliseTicketId('../../users/me'), null);
});

/* ---- Live organisation search -------------------------------------- */

test('a one-character search is not sent to Zendesk at all', async () => {
  // Autocomplete needs two characters and answers nothing useful below
  // that, so a single letter is not worth a round trip on every keystroke.
  const before = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    assert.deepEqual(await searchOrganisations('a'), []);
    assert.deepEqual(await searchOrganisations('  '), []);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = before;
  }
});
