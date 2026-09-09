import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressRecord, BroadbandOffer, LineRecord } from '@sw/shared';
import { __resolveTesting } from './resolve';

const { dedupeKey, sellRank, sortOffers, headlineFrom, belongsToPremises } = __resolveTesting;

const offer = (over: Partial<BroadbandOffer>): BroadbandOffer => ({
  id: 'o',
  operator: 'openreach',
  operatorLabel: 'Openreach',
  technology: 'SOGEA',
  status: 'available',
  speeds: {},
  notes: [],
  source: 'test',
  ...over,
});

/* ---- Ordering ------------------------------------------------------ */

test('an unchecked footprint never sorts above something sellable', () => {
  // The bug this pins: wholesale offers carry no `serviceability` at all,
  // because a wholesale availability answer *is* an address check. Ranking
  // absent below `footprint` put unchecked alt-nets at the top of the table.
  const sellable = offer({ id: 'sell', technology: 'SOGEA', status: 'available' });
  const footprint = offer({
    id: 'foot',
    operator: 'community-fibre',
    technology: 'XGS-PON',
    status: 'available',
    serviceability: 'footprint',
  });

  assert.ok(sellRank(sellable) > sellRank(footprint));
  const sorted = sortOffers([footprint, sellable]);
  assert.equal(sorted[0]?.id, 'sell', 'the orderable row must lead');
});

test('a confirmed second-supplier offer sorts with the sellable rows', () => {
  const giacom = offer({ id: 'gia', retailer: 'giacom', serviceability: 'confirmed', technology: 'FTTP' });
  const zen = offer({ id: 'zen', technology: 'ADSL2+' });
  const sorted = sortOffers([zen, giacom]);
  // Both sellable, so technology decides — and FTTP beats ADSL2+.
  assert.equal(sorted[0]?.id, 'gia');
});

/* ---- Dedupe -------------------------------------------------------- */

test('two suppliers selling the same technology both survive', () => {
  // The whole point of a second wholesale account: SOGEA through BT
  // Wholesale and SOGEA through TalkTalk are different prices, and
  // collapsing them deletes the comparison.
  const viaBtw = offer({ retailer: 'giacom', productCode: 'SOGEA-BTW', technology: 'SOGEA' });
  const viaTalkTalk = offer({ retailer: 'giacom', productCode: 'SOGEA-TTB', technology: 'SOGEA' });
  assert.notEqual(dedupeKey(viaBtw), dedupeKey(viaTalkTalk));
});

test('two coverage feeds reporting the same network still merge', () => {
  // Same fact from two sources is one row.
  const a = offer({ operator: 'cityfibre', technology: 'XGS-PON', serviceability: 'footprint', source: 'a' });
  const b = offer({ operator: 'cityfibre', technology: 'XGS-PON', serviceability: 'footprint', source: 'b' });
  assert.equal(dedupeKey(a), dedupeKey(b));
});

/* ---- Headline ------------------------------------------------------ */

test('the headline is recomputed so a second supplier can win it', () => {
  const best = headlineFrom([
    offer({ technology: 'ADSL2+', speeds: { downMbpsHigh: 12 } }),
    offer({ operator: 'cityfibre', operatorLabel: 'CityFibre', retailer: 'giacom', technology: 'XGS-PON', serviceability: 'confirmed', speeds: { downMbpsHigh: 2000, upMbpsHigh: 2000 } }),
  ]);
  assert.equal(best?.technology, 'XGS-PON');
  assert.equal(best?.operatorLabel, 'CityFibre');
  assert.equal(best?.downMbps, 2000);
});

test('an unchecked footprint is never the headline', () => {
  // "Best available" must mean best *sellable*, or it is a quote waiting to
  // go wrong.
  const best = headlineFrom([
    offer({ technology: 'SOGEA', speeds: { downMbpsHigh: 80 } }),
    offer({ operator: 'community-fibre', technology: 'XGS-PON', serviceability: 'footprint', speeds: { downMbpsHigh: 3000 } }),
  ]);
  assert.equal(best?.technology, 'SOGEA');
});

test('nothing sellable means no headline rather than a misleading one', () => {
  assert.equal(headlineFrom([offer({ status: 'build_planned' })]), undefined);
  assert.equal(headlineFrom([]), undefined);
});

/* ---- Premises membership ------------------------------------------- */

const address = (over: Partial<AddressRecord> = {}): AddressRecord => ({
  singleLine: '6 High Street, MANCHESTER, M1 1AE',
  lines: [],
  postTown: 'MANCHESTER',
  postcode: 'M1 1AE',
  source: 'os-places',
  ...over,
});

const line = (over: Partial<LineRecord>): LineRecord => ({
  id: 'l',
  status: 'active',
  technology: 'SOGEA',
  provider: 'test',
  address: address(),
  discoveredVia: 'zen',
  notes: [],
  ...over,
});

test('a UPRN match wins outright', () => {
  assert.equal(
    belongsToPremises(line({ address: address({ uprn: '123' }) }), address({ uprn: '123' })),
    true,
  );
});

test('UPRNs that disagree about the same doorstep no longer lose the line', () => {
  // A supplier carries whatever UPRN it was handed at order time, which is
  // routinely the parent shell record for a building whose units are the real
  // addresses. This used to be decisive and it cost us a live circuit at the
  // right address, so a mismatch now falls through to the address comparison.
  assert.equal(
    belongsToPremises(line({ address: address({ uprn: '999' }) }), address({ uprn: '123' })),
    true,
  );
});

test('a different address is still a different premises, whatever the UPRN', () => {
  const elsewhere = line({
    address: address({
      uprn: '999',
      singleLine: '12 Deansgate, MANCHESTER, M3 2BW',
      buildingNumber: '12',
      thoroughfare: 'Deansgate',
      postcode: 'M3 2BW',
    }),
  });
  assert.equal(belongsToPremises(elsewhere, address({ uprn: '123' })), false);
});

test('the Openreach address key ties a line with no UPRN to the premises', () => {
  // Without this, every Giacom line was dropped from every site report,
  // because their inventory carries no UPRN and no address breakdown.
  const giacomLine = line({
    lineAccessId: 'A74320372042',
    address: address({ singleLine: '', postTown: '' }),
    discoveredVia: 'giacom',
  });
  assert.equal(belongsToPremises(giacomLine, address({ addressKey: 'A74320372042' })), true);
  assert.equal(belongsToPremises(giacomLine, address({ addressKey: 'A00000000000' })), false);
});

test('a line that matches nothing is excluded rather than guessed at', () => {
  // A neighbour's circuit on a site report is worse than a missing one.
  const orphan = line({ address: address({ singleLine: '', postTown: '' }) });
  assert.equal(belongsToPremises(orphan, address({ uprn: '123' })), false);
  assert.equal(belongsToPremises(orphan, address()), false);
});

test('a wholesale offer states its serviceability instead of leaving it blank', () => {
  // The detail panel showed SERVICEABILITY "—" and ORDERABLE "—" for a
  // GEA-FTTP product that was genuinely address-checked and had an enabled
  // Order button beside it.
  const [marked] = __resolveTesting.markConfirmed([
    {
      operator: 'Openreach',
      technology: 'FTTP',
      status: 'available',
      retailer: 'ZEN',
      speeds: { downMbpsHigh: 1800, upMbpsHigh: 120 },
      source: 'zen:availability',
    } as never,
  ]);
  assert.equal(marked?.serviceability, 'confirmed');
  assert.equal(marked?.orderable, true);
  assert.equal(marked?.orderableReason, undefined);
});

test('an unavailable wholesale row is confirmed but not orderable', () => {
  const [marked] = __resolveTesting.markConfirmed([
    { operator: 'Openreach', technology: 'FTTC', status: 'not_available', speeds: {}, source: 'zen:availability' } as never,
  ]);
  assert.equal(marked?.serviceability, 'confirmed', 'the check still happened');
  assert.equal(marked?.orderable, false);
  assert.match(marked?.orderableReason ?? '', /not_available/);
});

test('a footprint row is never promoted to confirmed', () => {
  const [marked] = __resolveTesting.markConfirmed([
    {
      operator: 'Community Fibre',
      technology: 'FTTP',
      status: 'available',
      serviceability: 'footprint',
      speeds: {},
      source: 'thinkbroadband',
    } as never,
  ]);
  assert.equal(marked?.serviceability, 'footprint');
  assert.equal(marked?.orderable, undefined, 'must not gain an orderable flag');
});

test('a line whose supplier address differs still matches the premises', () => {
  // Willow Estate Agents: a real Openreach circuit through Zen that the
  // premises report said did not exist, because matching demanded byte
  // equality of the whole formatted address.
  const premises = {
    uprn: '100023253338',
    organisation: 'Willow Estate Agents Ltd',
    buildingNumber: '45',
    thoroughfare: 'Brockley Rise',
    postTown: 'LONDON',
    postcode: 'SE23 1JG',
    lines: ['Willow Estate Agents Ltd', '45 Brockley Rise', 'LONDON'],
    singleLine: 'Willow Estate Agents Ltd, 45 Brockley Rise, LONDON, SE23 1JG',
    source: 'os-places',
  } as never;

  const line = {
    id: 'x',
    address: {
      buildingNumber: '45',
      thoroughfare: 'BROCKLEY RISE',
      postTown: 'LONDON',
      postcode: 'SE23 1JG',
      lines: ['45 BROCKLEY RISE', 'LONDON'],
      singleLine: '45 BROCKLEY RISE, LONDON, SE23 1JG',
      source: 'zen',
    },
    provider: 'Zen Internet',
  } as never;

  assert.equal(__resolveTesting.belongsToPremises(line, premises), true);
});

test('a neighbour is still excluded from the premises', () => {
  const premises = {
    uprn: '100023253338',
    buildingNumber: '45',
    thoroughfare: 'Brockley Rise',
    postTown: 'LONDON',
    postcode: 'SE23 1JG',
    lines: [],
    singleLine: '45 Brockley Rise, LONDON, SE23 1JG',
    source: 'os-places',
  } as never;
  const neighbour = {
    id: 'y',
    address: {
      buildingNumber: '47',
      thoroughfare: 'Brockley Rise',
      postTown: 'LONDON',
      postcode: 'SE23 1JG',
      lines: [],
      singleLine: '47 Brockley Rise, LONDON, SE23 1JG',
      source: 'zen',
    },
    provider: 'Zen Internet',
  } as never;
  assert.equal(__resolveTesting.belongsToPremises(neighbour, premises), false);
});
