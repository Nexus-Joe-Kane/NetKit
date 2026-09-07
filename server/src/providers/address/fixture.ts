import {
  finaliseAddress,
  formatPostcode,
  isFullPostcode,
  premisesTypeFor,
  scoreAddress,
  sortAddresses,
  type AddressRecord,
} from '@sw/shared';
import { Seeded } from '../../lib/seeded';
import { BUILDING_NAMES, DEMO_POSTCODES, ORGANISATIONS, STREETS } from '../../fixtures/uk';
import { lookupPostcodeMeta } from './postcodesIo';
import type { AddressProvider } from '../types';

/**
 * Fixture address provider.
 *
 * Generates a stable, plausible set of premises for any valid UK postcode,
 * enriched with *real* geography from postcodes.io where the postcode exists.
 * UPRNs are derived from the postcode so they round-trip: look one up and you
 * land back on the same premises.
 */

/** Derives a stable 12-digit UPRN from a postcode and premises index. */
function uprnFor(postcode: string, index: number): string {
  const rng = new Seeded(`uprn:${postcode}:${index}`);
  // Real UPRNs are up to 12 digits; 1000-prefixed ranges are typical.
  return `1${rng.digits(11)}`;
}

interface Classification {
  code: string;
  label: string;
}

const CLASSIFICATIONS: Classification[] = [
  { code: 'RD04', label: 'Residential — Terraced' },
  { code: 'RD03', label: 'Residential — Semi-detached' },
  { code: 'RD02', label: 'Residential — Detached' },
  { code: 'RD06', label: 'Residential — Self-contained flat' },
  { code: 'CO01', label: 'Commercial — Retail' },
  { code: 'CO02', label: 'Commercial — Office' },
];

function buildPremises(postcode: string): AddressRecord[] {
  const pc = formatPostcode(postcode);
  const rng = new Seeded(`premises:${pc}`);
  const streetCount = rng.int(1, 2);
  const streets = rng.sample(STREETS, streetCount);
  const out: AddressRecord[] = [];
  let index = 0;

  for (const street of streets) {
    // A mix of numbered houses, a named building with flats, and the odd
    // business — which is what a real postcode looks like.
    const houses = rng.int(4, 9);
    const startNumber = rng.weighted([
      [1, 5],
      [2, 3],
      [rng.int(10, 60), 2],
    ]);

    for (let i = 0; i < houses; i += 1) {
      const number = String(startNumber + i * (startNumber % 2 === 0 ? 2 : 2));
      const cls = rng.weighted<Classification>([
        [CLASSIFICATIONS[0]!, 4],
        [CLASSIFICATIONS[1]!, 3],
        [CLASSIFICATIONS[2]!, 2],
        [CLASSIFICATIONS[4]!, 1],
      ]);
      const isBusiness = cls.code.startsWith('CO');
      out.push(
        finaliseAddress({
          uprn: uprnFor(pc, index),
          udprn: new Seeded(`udprn:${pc}:${index}`).digits(8),
          ...(isBusiness ? { organisation: rng.pick(ORGANISATIONS) } : {}),
          buildingNumber: number,
          thoroughfare: street,
          postTown: '',
          postcode: pc,
          classificationCode: cls.code,
          classificationLabel: cls.label,
          premisesType: premisesTypeFor(cls.code),
          source: 'mock',
        }),
      );
      index += 1;
    }

    // One block of flats per postcode, so the "pick the exact address"
    // dropdown has genuinely ambiguous entries to disambiguate.
    if (rng.bool(0.6)) {
      const name = rng.pick(BUILDING_NAMES);
      const flats = rng.int(3, 8);
      for (let f = 1; f <= flats; f += 1) {
        out.push(
          finaliseAddress({
            uprn: uprnFor(pc, index),
            udprn: new Seeded(`udprn:${pc}:${index}`).digits(8),
            subBuilding: `Flat ${f}`,
            buildingName: name,
            thoroughfare: street,
            postTown: '',
            postcode: pc,
            classificationCode: 'RD06',
            classificationLabel: 'Residential — Self-contained flat',
            premisesType: 'residential',
            source: 'mock',
          }),
        );
        index += 1;
      }
    }
  }

  return out;
}

/** Applies real postcode geography to generated premises. */
async function enrich(records: AddressRecord[], postcode: string): Promise<AddressRecord[]> {
  const meta = await lookupPostcodeMeta(postcode);
  const fallbackTown = postcode.replace(/\d.*/, '').trim().toUpperCase() || 'UNKNOWN';
  return records.map((r, i) => {
    // Scatter premises slightly around the postcode centroid so map/geo
    // fields differ per premises rather than being identical.
    const jitter = new Seeded(`jitter:${r.uprn ?? i}`);
    return finaliseAddress({
      ...r,
      postTown: meta?.postTown || fallbackTown,
      ...(meta?.county ? { county: meta.county } : {}),
      ...(meta?.country ? { country: meta.country } : {}),
      ...(meta?.ward ? { ward: meta.ward } : {}),
      ...(meta?.constituency ? { constituency: meta.constituency } : {}),
      ...(meta?.localAuthority ? { localAuthority: meta.localAuthority } : {}),
      ...(meta?.latitude != null ? { latitude: Number((meta.latitude + jitter.float(-0.0012, 0.0012, 6)).toFixed(6)) } : {}),
      ...(meta?.longitude != null ? { longitude: Number((meta.longitude + jitter.float(-0.0018, 0.0018, 6)).toFixed(6)) } : {}),
      ...(meta?.eastings != null ? { easting: meta.eastings + jitter.int(-90, 90) } : {}),
      ...(meta?.northings != null ? { northing: meta.northings + jitter.int(-90, 90) } : {}),
      lines: [],
      singleLine: '',
    });
  });
}

/** Postcode → premises, memoised for the process lifetime. */
const byPostcodeCache = new Map<string, Promise<AddressRecord[]>>();

function premisesFor(postcode: string): Promise<AddressRecord[]> {
  const pc = formatPostcode(postcode);
  let hit = byPostcodeCache.get(pc);
  if (!hit) {
    hit = enrich(buildPremises(pc), pc).then(sortAddresses);
    byPostcodeCache.set(pc, hit);
  }
  return hit;
}

/**
 * Reverses `uprnFor` by scanning the demo postcodes, then giving up and
 * synthesising a premises so *any* UPRN typed into the portal resolves to
 * something rather than a dead end.
 */
async function findByUprn(uprn: string): Promise<AddressRecord | null> {
  for (const pc of DEMO_POSTCODES) {
    const list = await premisesFor(pc);
    const hit = list.find((a) => a.uprn === uprn);
    if (hit) return hit;
  }
  // Synthesise: derive a postcode-shaped premises from the UPRN itself.
  const rng = new Seeded(`synth:${uprn}`);
  const pc = rng.pick(DEMO_POSTCODES);
  const list = await premisesFor(pc);
  const base = list[rng.int(0, list.length - 1)];
  if (!base) return null;
  return finaliseAddress({ ...base, uprn, lines: [], singleLine: '' });
}

export function createFixtureAddressProvider(): AddressProvider {
  return {
    name: 'fixture-address',
    label: 'Demo address data',
    configured: true,
    mode: 'mock',

    byPostcode: (postcode) => premisesFor(postcode),

    byUprn: (uprn) => findByUprn(uprn),

    async search(query, limit) {
      // A postcode typed into the free-text box still resolves properly.
      if (isFullPostcode(query)) return (await premisesFor(query)).slice(0, limit);

      const results: Array<{ score: number; record: AddressRecord }> = [];
      for (const pc of DEMO_POSTCODES) {
        for (const record of await premisesFor(pc)) {
          const score = scoreAddress(query, record);
          if (score > 0) results.push({ score, record });
        }
      }
      results.sort((a, b) => b.score - a.score);
      return results.slice(0, limit).map((r) => r.record);
    },
  };
}

/** Exposed so the line fixtures can attach real premises to a line. */
export { premisesFor as fixturePremisesFor, findByUprn as fixtureFindByUprn, uprnFor as fixtureUprnFor };
