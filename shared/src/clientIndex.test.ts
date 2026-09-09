import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  CLIENT_INDEX_MAX_AGE_MS,
  buildIndex,
  clientIndexStale,
  emptyClientIndex,
  foldContribution,
  lookupableSites,
  searchClients,
  siteIdentifier,
  type ClientContribution,
  type ClientIndexEntry,
} from './index';

const NOW = '2026-09-09T09:00:00.000Z';

const contribution = (over: Partial<ClientContribution> & { name: string }): ClientContribution => ({
  source: 'itglue',
  ...over,
});

/* ---- Merging what the sources say ----------------------------------- */

test('the same client from two systems is one entry, not two', () => {
  // "Willow Estate Agents Ltd" in IT Glue and "Willow Estate Agents" in
  // Zendesk. Merging on the string would give two clients; merging on the
  // key gives one with both spellings searchable.
  const { entries } = buildIndex(
    [],
    [
      contribution({ name: 'Willow Estate Agents Ltd', source: 'itglue' }),
      contribution({ name: 'Willow Estate Agents', source: 'zendesk' }),
    ],
    NOW,
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.name, 'Willow Estate Agents Ltd', 'the fuller name is the display name');
  assert.deepEqual(entries[0]?.aliases, ['Willow Estate Agents']);
  assert.deepEqual(entries[0]?.sources.sort(), ['itglue', 'zendesk']);
});

test('a name that is nothing but legal forms is not indexed', () => {
  const { entries } = buildIndex([], [contribution({ name: 'The Company Ltd' })], NOW);
  assert.equal(entries.length, 0, 'it identifies nobody, so it would match everybody');
});

test('two sources describing one shop give one site, with the gaps filled', () => {
  const first = foldContribution(
    undefined,
    contribution({ name: 'Maru', sites: [{ name: 'Mayfair', postcode: 'W1J 5HP' }] }),
    NOW,
  );
  const second = foldContribution(
    first,
    contribution({
      name: 'Maru',
      source: 'learned',
      sites: [{ name: 'Maru Mayfair', postcode: 'w1j5hp', uprn: '100023253338' }],
    }),
    NOW,
  );
  assert.equal(second.sites.length, 1, 'the postcode is what says it is the same shop');
  assert.equal(second.sites[0]?.uprn, '100023253338', 'the more precise fact fills the gap');
  assert.equal(second.sites[0]?.name, 'Maru Mayfair', 'the fuller name wins');
});

test('a source with no postcode never blanks one that has', () => {
  const first = foldContribution(
    undefined,
    contribution({ name: 'Maru', sites: [{ name: 'Mayfair', postcode: 'W1J 5HP' }] }),
    NOW,
  );
  const second = foldContribution(first, contribution({ name: 'Maru', sites: [{ name: 'Mayfair' }] }), NOW);
  assert.equal(second.sites.length, 1);
  assert.equal(second.sites[0]?.postcode, 'W1J 5HP');
});

test('a rebuild reports what appeared and what went', () => {
  // The interesting part of a daily refresh: one appearing is usually a new
  // customer, one going is usually a cancellation nobody mentioned.
  const before = buildIndex([], [contribution({ name: 'Willow Ltd' }), contribution({ name: 'Maru Ltd' })], NOW);
  const after = buildIndex(
    before.entries,
    [contribution({ name: 'Willow Ltd' }), contribution({ name: 'Megans Ltd' })],
    NOW,
  );
  // The names as their source gives them: the legal form is stripped for
  // matching, never for display.
  assert.deepEqual(after.added, ['Megans Ltd']);
  assert.deepEqual(after.removed, ['Maru Ltd']);
});

test('what was learned from a lookup survives a rebuild', () => {
  // It was never in a source list, so its absence from one is not evidence
  // of anything.
  const learned: ClientIndexEntry = {
    key: 'megans richmond',
    name: 'Megans Richmond',
    aliases: [],
    sites: [{ name: 'Richmond', postcode: 'TW9 1LZ' }],
    serviceRefs: [],
    sources: ['learned'],
    seenAt: NOW,
  };
  const { entries, removed } = buildIndex([learned], [contribution({ name: 'Willow Ltd' })], NOW);
  assert.equal(entries.length, 2);
  assert.deepEqual(removed, []);
});

test('a client that only a source knew about is dropped when it stops listing them', () => {
  const listed: ClientIndexEntry = {
    key: 'gone away',
    name: 'Gone Away',
    aliases: [],
    sites: [],
    serviceRefs: [],
    sources: ['itglue'],
    seenAt: NOW,
  };
  const { entries, removed } = buildIndex([listed], [contribution({ name: 'Willow Ltd' })], NOW);
  assert.deepEqual(entries.map((e) => e.name), ['Willow Ltd']);
  assert.deepEqual(removed, ['Gone Away']);
});

/* ---- Searching it locally ------------------------------------------- */

const INDEX: ClientIndexEntry[] = buildIndex(
  [],
  [
    contribution({
      name: 'Willow Estate Agents Ltd',
      sites: [
        { name: 'Brockley Rise', postcode: 'SE23 1JG', uprn: '100023253338' },
        { name: 'Head Office', postcode: 'EC4Y 1AA' },
      ],
      serviceRefs: ['ZW1234567'],
    }),
    contribution({ name: 'Willow Interiors', sites: [{ name: 'Shoreditch', postcode: 'E1 6AN' }] }),
    contribution({ name: "Megan's Restaurants Ltd", sites: [{ name: 'Richmond', postcode: 'TW9 1LZ' }] }),
  ],
  NOW,
).entries;

test('a name finds the client with no network call at all', () => {
  const found = searchClients(INDEX, 'willow');
  assert.equal(found.length, 2);
  assert.ok(found.every((e) => e.name.startsWith('Willow')));
});

test('a second word narrows rather than widens', () => {
  const found = searchClients(INDEX, 'willow brockley');
  assert.deepEqual(found.map((e) => e.name), ['Willow Estate Agents Ltd']);
});

test('a possessive matches either way round', () => {
  assert.equal(searchClients(INDEX, 'megans').length, 1);
  assert.equal(searchClients(INDEX, "megan's richmond").length, 1);
});

test('a postcode or a reference finds the client too', () => {
  assert.deepEqual(searchClients(INDEX, 'SE23 1JG').map((e) => e.name), ['Willow Estate Agents Ltd']);
  assert.deepEqual(searchClients(INDEX, 'ZW1234567').map((e) => e.name), ['Willow Estate Agents Ltd']);
});

test('a name match ranks above a site match', () => {
  // Somebody typing "willow" means the client; somebody typing a site name
  // means the shop. Putting the client first costs the second case one row.
  const found = searchClients(INDEX, 'willow');
  assert.equal(found[0]?.name, 'Willow Estate Agents Ltd');
});

test('an empty or one-character term matches nothing', () => {
  assert.deepEqual(searchClients(INDEX, ''), []);
  assert.deepEqual(searchClients(INDEX, 'w'), []);
});

/* ---- What gets sent upstream ---------------------------------------- */

test('a UPRN is preferred over a postcode, and a bare name is refused', () => {
  assert.deepEqual(siteIdentifier({ name: 'x', uprn: '123', postcode: 'SE23 1JG' }), {
    kind: 'uprn',
    value: '123',
  });
  assert.deepEqual(siteIdentifier({ name: 'x', postcode: 'SE23 1JG' }), {
    kind: 'postcode',
    value: 'SE23 1JG',
  });
  // A site name is not something an API can be asked about, and sending it
  // would quietly find nothing.
  assert.equal(siteIdentifier({ name: 'Head Office' }), null);
});

test('only sites that can be looked up are offered, UPRNs first', () => {
  const entry = INDEX.find((e) => e.name === 'Willow Estate Agents Ltd')!;
  const sites = lookupableSites(entry);
  assert.deepEqual(sites.map((s) => s.name), ['Brockley Rise', 'Head Office']);

  const noneUseful = lookupableSites({ ...entry, sites: [{ name: 'Somewhere' }] });
  assert.deepEqual(noneUseful, []);
});

/* ---- Staleness ------------------------------------------------------ */

test('a never-built index is stale, and one built today is not', () => {
  const now = new Date('2026-09-09T09:00:00Z');
  assert.equal(clientIndexStale(emptyClientIndex(), now), true);
  assert.equal(clientIndexStale({ ...emptyClientIndex(), builtAt: NOW }, now), false);
  assert.equal(
    clientIndexStale({ ...emptyClientIndex(), builtAt: new Date(now.getTime() - CLIENT_INDEX_MAX_AGE_MS - 1).toISOString() }, now),
    true,
  );
  assert.equal(clientIndexStale({ ...emptyClientIndex(), builtAt: 'not a date' }, now), true);
});

test('a client you can look up outranks one with no known address', () => {
  // Alphabetical alone put an addressless entry above one with three sites,
  // which is the wrong way round: a row that cannot be looked up is the last
  // thing to offer first.
  const entries = buildIndex(
    [],
    [
      contribution({ name: 'Willow Aardvark' }),
      contribution({ name: 'Willow Zebra', sites: [{ name: 'Shop', postcode: 'SE23 1JG' }] }),
    ],
    NOW,
  ).entries;
  assert.deepEqual(searchClients(entries, 'willow').map((e) => e.name), ['Willow Zebra', 'Willow Aardvark']);
});
