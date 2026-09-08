import type { SignalGrade, AccessTechnology, AvailabilityStatus } from './types';

const GRADE_ORDER: SignalGrade[] = ['unknown', 'none', 'poor', 'variable', 'good', 'excellent'];

export function gradeScore(g: SignalGrade): number {
  const i = GRADE_ORDER.indexOf(g);
  return i < 0 ? 0 : i;
}

export function bestGrade(a: SignalGrade, b: SignalGrade): SignalGrade {
  return gradeScore(a) >= gradeScore(b) ? a : b;
}

/** Maps an Ofcom 0–4 confidence figure onto our grade vocabulary. */
export function gradeFromOfcom(value: number | string | undefined | null): SignalGrade {
  if (value === undefined || value === null || value === '') return 'unknown';
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  if (Number.isNaN(n)) return 'unknown';
  if (n <= 0) return 'none';
  if (n === 1) return 'poor';
  if (n === 2) return 'variable';
  if (n === 3) return 'good';
  return 'excellent';
}

/**
 * Ranking used to pick the headline technology at a premises. Higher wins.
 */
const TECH_RANK: Record<AccessTechnology, number> = {
  'XGS-PON': 100,
  FTTP: 95,
  'Leased Line': 90,
  EAD: 85,
  'DOCSIS3.1': 80,
  SOGFAST: 70,
  GFAST: 68,
  SOGEA: 60,
  FTTC: 55,
  EoFTTC: 50,
  '4G/5G Fixed Wireless': 40,
  FWA: 38,
  'ADSL2+': 30,
  'WLR+ADSL': 22,
  ADSL: 20,
  Satellite: 10,
  Unknown: 0,
};

export function technologyRank(t: AccessTechnology): number {
  return TECH_RANK[t] ?? 0;
}

const STATUS_RANK: Record<AvailabilityStatus, number> = {
  available: 6,
  available_soon: 5,
  on_demand: 4,
  build_planned: 3,
  waiting_list: 2,
  not_available: 1,
  unknown: 0,
};

export function statusRank(s: AvailabilityStatus): number {
  return STATUS_RANK[s] ?? 0;
}

export function statusLabel(s: AvailabilityStatus): string {
  switch (s) {
    case 'available':
      return 'Available';
    case 'available_soon':
      return 'Available soon';
    case 'waiting_list':
      return 'Waiting list';
    case 'build_planned':
      return 'Build planned';
    case 'on_demand':
      return 'On demand';
    case 'not_available':
      return 'Not available';
    default:
      return 'Unknown';
  }
}
