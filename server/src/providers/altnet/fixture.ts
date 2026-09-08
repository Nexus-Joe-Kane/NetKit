import type { AddressRecord, AvailabilityStatus, BroadbandOffer, NetworkOperator } from '@sw/shared';
import { Seeded } from '../../lib/seeded';
import { ALTNETS } from '../../fixtures/uk';
import type { AltnetProvider } from '../types';

/**
 * Demo alt-net coverage.
 *
 * This exists so the panel has a shape before a thinkbroadband licence lands,
 * and it is deliberately more cautious than the rest of the fixture set.
 *
 * Everywhere else in NetKit, invented data is harmless because the real
 * thing replaces it: point Zen at the portal and modelled Openreach detail
 * becomes measured Openreach detail. Alt-net coverage had no such
 * replacement, which made a row reading *"Community Fibre — Available —
 * network already passes this premises"* the single most quotable falsehood
 * in the tool. Somebody would have read it to a customer.
 *
 * So every row here is `serviceability: 'footprint'` and says so in its
 * notes, no row ever claims a premises is serviceable, and the UI labels the
 * lot as unchecked. The honest claim is "this network builds around here",
 * which is genuinely useful and happens to be true of the real footprints.
 */

export function buildFixtureAltnetOffers(address: AddressRecord): BroadbandOffer[] {
  const seed = address.uprn ?? address.singleLine;
  const rng = new Seeded(`altnet:${seed}`);

  const count = rng.weighted([
    [0, 3],
    [1, 4],
    [2, 3],
    [3, 1],
  ]);

  const offers: BroadbandOffer[] = [];
  let index = 0;

  for (const alt of rng.sample(ALTNETS, count)) {
    const isCable = alt.operator === 'virgin-media';
    // No `available` here on purpose. A footprint is a build area, not a
    // serviceable address, and the status must not imply otherwise.
    const status = rng.weighted<AvailabilityStatus>([
      ['build_planned', 6],
      ['waiting_list', 2],
    ]);

    offers.push({
      id: `fixture-altnet-${(index += 1)}`,
      operator: alt.operator as NetworkOperator,
      operatorLabel: alt.label,
      technology: isCable ? 'DOCSIS3.1' : 'XGS-PON',
      status,
      serviceability: 'footprint',
      speeds: isCable
        ? { downMbpsHigh: rng.pick([500, 1130, 1808]), upMbpsHigh: rng.pick([50, 104, 120]), basis: 'headline' }
        : { downMbpsHigh: rng.pick([900, 1000, 2000]), upMbpsHigh: rng.pick([900, 1000, 2000]), basis: 'headline' },
      rfsDate: rng.dateOffset(60, 540),
      productName: isCable ? 'Virgin Media cable (DOCSIS 3.1)' : `${alt.label} full fibre`,
      notes: [
        'Demo footprint data — nobody has checked this address.',
        'Coverage data only — not resellable through our wholesale account.',
        'Connect a thinkbroadband licence (THINKBROADBAND_API_KEY) for real coverage.',
      ],
      source: 'fixture:altnet',
    });
  }

  return offers;
}

export function createFixtureAltnetProvider(): AltnetProvider {
  return {
    name: 'fixture-altnet',
    label: 'Demo alt-net footprint',
    configured: true,
    mode: 'mock',
    forAddress: async (address) => buildFixtureAltnetOffers(address),
  };
}
