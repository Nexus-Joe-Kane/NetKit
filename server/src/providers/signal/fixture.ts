import {
  bestGrade,
  gradeScore,
  type AddressRecord,
  type MobileCoverage,
  type MobileOperator,
  type SignalBand,
  type SignalGrade,
  type SignalReport,
} from '@sw/shared';
import { Seeded } from '../../lib/seeded';
import type { SignalProvider } from '../types';

/**
 * Fixture mobile coverage.
 *
 * Modelled the way coverage actually behaves: an area has an underlying
 * signal environment (dense urban through to rural), each operator has its
 * own site density on top of that, and indoor coverage is derived from
 * outdoor by applying a building penetration loss — so indoor is never
 * better than outdoor, and 5G is never better than 4G.
 */

const OPERATORS: Array<{ operator: MobileOperator; mvnos: string[]; strength: number }> = [
  { operator: 'EE', mvnos: ['BT Mobile', '1pMobile', 'Lycamobile'], strength: 1.08 },
  { operator: 'Vodafone', mvnos: ['VOXI', 'Lebara', 'Talkmobile', 'Asda Mobile'], strength: 1.0 },
  { operator: 'O2', mvnos: ['Giffgaff', 'Tesco Mobile', 'Sky Mobile'], strength: 0.98 },
  { operator: 'Three', mvnos: ['SMARTY', 'iD Mobile'], strength: 0.9 },
];

const GRADES: SignalGrade[] = ['none', 'poor', 'variable', 'good', 'excellent'];

function gradeFromScore(score: number): SignalGrade {
  const clamped = Math.max(0, Math.min(4, Math.round(score)));
  return GRADES[clamped] ?? 'unknown';
}

/** 4G bands by operator, so the band list is plausible rather than generic. */
const BANDS_4G: Record<MobileOperator, string[]> = {
  EE: ['B1 (2100)', 'B3 (1800)', 'B7 (2600)', 'B20 (800)', 'B32 (1500 SDL)'],
  Vodafone: ['B1 (2100)', 'B3 (1800)', 'B7 (2600)', 'B8 (900)', 'B20 (800)'],
  O2: ['B1 (2100)', 'B3 (1800)', 'B8 (900)', 'B20 (800)', 'B40 (2300)'],
  Three: ['B1 (2100)', 'B3 (1800)', 'B20 (800)'],
};

const BANDS_5G: Record<MobileOperator, string[]> = {
  EE: ['n78 (3500)', 'n28 (700)'],
  Vodafone: ['n78 (3500)', 'n1 (2100)'],
  O2: ['n78 (3500)', 'n28 (700)'],
  Three: ['n78 (3500)', 'n77 (3900)'],
};

function buildOperator(rng: Seeded, base: number, spec: (typeof OPERATORS)[number], urban: boolean): MobileCoverage {
  // Outdoor is the base environment scaled by this operator's site density.
  const outdoorScore = base * spec.strength + rng.float(-0.35, 0.35, 2);
  // Building penetration loss: modern/urban buildings are worse for low bands.
  const penetration = urban ? rng.float(0.9, 1.6, 2) : rng.float(0.5, 1.2, 2);
  const indoorScore = outdoorScore - penetration;

  const outdoor4g = gradeFromScore(outdoorScore);
  const indoor4g = gradeFromScore(indoorScore);
  // Voice rides low bands, so it penetrates better than data.
  const voice: SignalBand = {
    outdoor: gradeFromScore(outdoorScore + 0.4),
    indoor: gradeFromScore(indoorScore + 0.6),
    inVehicle: gradeFromScore(outdoorScore + 0.1),
  };

  // 5G is deployed on higher bands, so it reaches less far than 4G.
  const has5g = urban ? rng.bool(0.88) : rng.bool(0.45);
  const data5g: SignalBand | undefined = has5g
    ? {
        outdoor: gradeFromScore(outdoorScore - rng.float(0.4, 1.1, 2)),
        indoor: gradeFromScore(indoorScore - rng.float(0.8, 1.6, 2)),
      }
    : undefined;

  const notes: string[] = [];
  if (gradeScore(indoor4g) <= gradeScore('poor') && gradeScore(outdoor4g) >= gradeScore('good')) {
    notes.push('Strong outdoors but weak indoors — a good candidate for Wi-Fi calling or a signal repeater.');
  }
  if (!has5g) notes.push('No 5G reported in this area on this network.');

  const planned = !has5g && rng.bool(0.35);

  return {
    operator: spec.operator,
    mvnos: spec.mvnos,
    voice,
    data4g: { outdoor: outdoor4g, indoor: indoor4g },
    ...(data5g ? { data5g } : {}),
    data3g: { outdoor: 'none', indoor: 'none' },
    volte: true,
    wifiCalling: rng.bool(0.9),
    bands: [
      ...rng.sample(BANDS_4G[spec.operator], rng.int(2, BANDS_4G[spec.operator].length)),
      ...(has5g ? rng.sample(BANDS_5G[spec.operator], 1) : []),
    ],
    nearestSite: {
      distanceMetres: Math.round(rng.int(180, urban ? 900 : 4200) / (spec.strength || 1)),
      bearingDegrees: rng.int(0, 359),
      technologies: ['4G', ...(has5g ? ['5G'] : [])],
    },
    ...(planned ? { plannedUpgrade: { technology: '5G n78', date: rng.dateOffset(90, 540) } } : {}),
    source: 'mock',
    notes,
  };
}

export function buildFixtureSignal(address: AddressRecord): SignalReport {
  const seed = address.uprn ?? address.postcode;
  const rng = new Seeded(`signal:${seed}`);
  const urban = address.premisesType === 'business' || Boolean(address.subBuilding) || rng.bool(0.55);
  // 0 = deep rural notspot, 4 = dense urban.
  const base = urban ? rng.float(2.8, 4.2, 2) : rng.float(1.2, 3.4, 2);

  const operators = OPERATORS.map((spec) => buildOperator(new Seeded(`signal:${seed}:${spec.operator}`), base, spec, urban));

  const bestBy = (pick: (c: MobileCoverage) => SignalGrade): MobileOperator | undefined => {
    let winner: MobileCoverage | undefined;
    for (const c of operators) {
      if (!winner || gradeScore(pick(c)) > gradeScore(pick(winner))) winner = c;
    }
    return winner?.operator;
  };

  return {
    ...(address.uprn ? { uprn: address.uprn } : {}),
    address,
    operators,
    headline: {
      ...(bestBy((c) => c.voice.indoor) ? { bestIndoorVoice: bestBy((c) => c.voice.indoor) } : {}),
      ...(bestBy((c) => bestGrade(c.data4g.indoor, c.data5g?.indoor ?? 'unknown'))
        ? { bestIndoorData: bestBy((c) => bestGrade(c.data4g.indoor, c.data5g?.indoor ?? 'unknown')) }
        : {}),
    },
    checkedAt: new Date().toISOString(),
    sources: ['fixture:signal'],
  };
}

export function createFixtureSignalProvider(): SignalProvider {
  return {
    name: 'fixture-signal',
    label: 'Demo mobile coverage',
    configured: true,
    mode: 'mock',
    async forAddress(address) {
      return buildFixtureSignal(address);
    },
  };
}
