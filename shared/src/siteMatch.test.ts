import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { finaliseAddress, matchBanner, type AddressRecord } from './index';
import {
  clientKey,
  clientTokens,
  matchSites,
  premisesTokens,
  rankClients,
  resolveClient,
  type SiteCandidate,
} from './siteMatch';

const addr = (over: Partial<AddressRecord> & { postTown: string; postcode: string }): AddressRecord =>
  finaliseAddress({ ...over, source: 'test' } as never);

const org = (name: string): { name: string } => ({ name });
const nameOf = (o: { name: string }): string => o.name;

/* ---- Company names -------------------------------------------------- */

test('legal forms are stripped, because every third client is a Ltd', () => {
  assert.deepEqual(clientTokens('Willow Estate Agents Ltd'), ['willow', 'estate', 'agents']);
  assert.equal(clientKey('Willow Estate Agents Limited'), clientKey('Willow Estate Agents Ltd'));
  assert.equal(clientKey("Megan's Restaurants Ltd"), 'megans restaurants');
});

test('a name that is nothing but noise identifies nobody', () => {
  // Returning ['company'] here would match half the book.
  assert.deepEqual(clientTokens('The Company Ltd'), []);
  assert.deepEqual(rankClients([org('Anything')], 'The Company Ltd', nameOf), []);
});

test('the same company under two spellings is an exact match', () => {
  const ranked = rankClients([org('Willow Estate Agents Limited')], 'Willow Estate Agents Ltd', nameOf);
  assert.equal(ranked[0]?.confidence, 'exact');
});

test('a shorter name in one system still matches the longer one', () => {
  // "Willow" in Site Manager, "Willow Estate Agents Ltd" in Zendesk.
  const both = rankClients([org('Willow')], 'Willow Estate Agents Ltd', nameOf);
  assert.equal(both[0]?.confidence, 'strong');
  const other = rankClients([org('Willow Estate Agents Ltd')], 'Willow', nameOf);
  assert.equal(other[0]?.confidence, 'strong');
});

test('two companies sharing a word are a choice, not a guess', () => {
  // Attaching one customer's equipment to another's site report is worse
  // than attaching none.
  const { match, ambiguous, options } = resolveClient(
    [org('Willow Estate Agents'), org('Willow Interiors')],
    'Willow',
    nameOf,
  );
  assert.equal(match, null);
  assert.equal(ambiguous, true);
  assert.equal(options.length, 2);
});

test('one strong match is taken without asking', () => {
  const { match, ambiguous } = resolveClient(
    [org('Willow Estate Agents Ltd'), org('Maru Restaurants Ltd')],
    'Willow Estate Agents',
    nameOf,
  );
  assert.equal(match?.name, 'Willow Estate Agents Ltd');
  assert.equal(ambiguous, false);
});

test('only weak matches are never taken automatically', () => {
  const { match, options } = resolveClient([org('Willow Interiors and Design')], 'Maru Willow Mayfair', nameOf);
  assert.equal(match, null);
  assert.equal(options[0]?.confidence, 'weak');
  assert.match(options[0]!.reason, /of 3 words match/);
});

test('an exact match wins over a strong one', () => {
  const { match } = resolveClient([org('Willow'), org('Willow Estate Agents Ltd')], 'Willow Estate Agents', nameOf);
  assert.equal(match?.name, 'Willow Estate Agents Ltd');
});

test('two names that differ only by legal form are indistinguishable, so ambiguous', () => {
  // "Group" and "Ltd" are both stripped, which leaves these two identical.
  // They may well be different entities, and picking one would be guessing.
  const { match, ambiguous } = resolveClient(
    [org('Willow Estate Agents Group'), org('Willow Estate Agents Ltd')],
    'Willow Estate Agents',
    nameOf,
  );
  assert.equal(match, null);
  assert.equal(ambiguous, true);
});

/* ---- Which site ----------------------------------------------------- */

const MAYFAIR = addr({
  organisation: 'Maru Restaurants Ltd',
  buildingNumber: '12',
  thoroughfare: 'Curzon Street',
  dependentLocality: 'Mayfair',
  postTown: 'LONDON',
  postcode: 'W1J 5HP',
});

test('a matching postcode settles it', () => {
  const sites: SiteCandidate[] = [
    { id: 'a', name: 'Head Office', postcode: 'SE23 1JG' },
    { id: 'b', name: 'Site 2', postcode: 'w1j5hp' },
  ];
  const { match } = matchSites(sites, MAYFAIR);
  assert.equal(match?.site.id, 'b');
  assert.equal(match?.confidence, 'exact');
  assert.match(match!.reason, /same postcode/);
});

test('a site named after the locality is a strong match without a postcode', () => {
  const sites: SiteCandidate[] = [
    { id: 'a', name: 'Maru Mayfair' },
    { id: 'b', name: 'Maru Shoreditch' },
  ];
  const { match } = matchSites(sites, MAYFAIR);
  assert.equal(match?.site.id, 'a');
  assert.equal(match?.confidence, 'strong');
});

test('generic site words do not become the match', () => {
  // "Main Office" against an address in LONDON must not match on "office"
  // or a shared filler word.
  const sites: SiteCandidate[] = [
    { id: 'a', name: 'Main Office' },
    { id: 'b', name: 'Guest WiFi Site' },
  ];
  const { match, options } = matchSites(sites, MAYFAIR);
  assert.equal(match, null);
  assert.ok(options.every((o) => o.confidence === 'none' || o.confidence === 'weak'));
});

test('one site and one premises is not made into a choice', () => {
  // A single weak signal would normally be offered rather than taken. With
  // one site and one premises there is nothing else it could be, and making
  // somebody choose from a list of one is friction, not caution.
  const { match } = matchSites([{ id: 'only', name: 'Maru' }], MAYFAIR);
  assert.equal(match?.site.id, 'only');
  assert.match(match!.reason, /the only site on this account/);
});

test('a single site named after the place is simply a strong match', () => {
  const { match } = matchSites([{ id: 'only', name: 'Maru Mayfair' }], MAYFAIR);
  assert.equal(match?.site.id, 'only');
  assert.equal(match?.confidence, 'strong');
});

test('one site that ties to nothing is offered, not claimed', () => {
  const { match, options } = matchSites([{ id: 'only', name: 'Corporate' }], MAYFAIR);
  assert.equal(match, null);
  assert.equal(options[0]?.confidence, 'weak');
  assert.match(options[0]!.reason, /nothing ties it to this address/);
});

test('two sites at the same postcode are a choice', () => {
  // A building with two suites, each its own site. Guessing puts one
  // tenant's kit on the other's report.
  const sites: SiteCandidate[] = [
    { id: 'a', name: 'Suite 1', postcode: 'W1J 5HP' },
    { id: 'b', name: 'Suite 2', postcode: 'W1J 5HP' },
  ];
  const { match, options } = matchSites(sites, MAYFAIR);
  assert.equal(match, null);
  assert.equal(options.length, 2);
});

test('the words taken from a premises are the ones that identify it', () => {
  const tokens = premisesTokens(MAYFAIR);
  assert.ok(tokens.includes('mayfair'));
  assert.ok(tokens.includes('curzon'));
  assert.ok(tokens.includes('maru'));
  assert.ok(!tokens.includes('ltd'), 'a legal form is not a locality');
  assert.ok(!tokens.includes('the'));
});

test('an empty site list is not an error', () => {
  assert.deepEqual(matchSites([], MAYFAIR), { match: null, options: [] });
});

/* ---- Which banner the on-site panel shows ---------------------------- */

const live = { documentation: { mode: 'live' }, network: { mode: 'live' } };
const skipped = { documentation: { mode: 'skipped' }, network: { mode: 'skipped' } };

test('with nothing connected there is no name that would have worked, so say nothing', () => {
  // What it did instead: "Nothing matched “supportwizard”" plus a box to
  // retype the company name — sending somebody guessing at names to fix a
  // missing API key.
  assert.equal(matchBanner({ status: skipped }), 'none');
});

test('connected and nothing found is a real no-match, and says so', () => {
  assert.equal(matchBanner({ status: live }), 'no-match');
});

test('one system connected is enough for a no-match to mean something', () => {
  assert.equal(
    matchBanner({ status: { documentation: { mode: 'live' }, network: { mode: 'skipped' } } }),
    'no-match',
  );
});

test('a confident match is reported as one', () => {
  assert.equal(
    matchBanner({ status: live, documented: {}, documentedLocation: { confidence: 'exact' } }),
    'matched',
  );
});

test('ambiguity and weakness are worth saying even with nothing connected', () => {
  // Both mean something *was* found, so there is a decision for a person to
  // make regardless of what is switched on.
  assert.equal(matchBanner({ status: skipped, documentedOptions: [{}, {}] }), 'ambiguous');
  assert.equal(matchBanner({ status: skipped, networkSite: { confidence: 'weak' } }), 'weak');
});

test('ambiguity outranks a weak match', () => {
  // Picking from a list of real candidates beats confirming a guess.
  assert.equal(
    matchBanner({ status: live, documentedOptions: [{}], networkSite: { confidence: 'weak' } }),
    'ambiguous',
  );
});
