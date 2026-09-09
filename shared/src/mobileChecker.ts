import type { MobileOperator, SignalBand, SignalGrade } from './types';

/**
 * Ofcom's mobile coverage rating, as of the June 2025 methodology.
 *
 * This is a per-UPRN, per-operator figure, which matters: everything else in
 * this portal's mobile picture comes from Connected Nations area files at
 * parliamentary-constituency resolution, and a constituency contains both a
 * city centre and a valley with no signal. This says something about the
 * doorstep.
 *
 * The scale replaced the old one and does not mean the same thing, which is
 * the trap worth spelling out. Ofcom's own definitions:
 *
 *   0  poor to none (outdoor only)
 *   1  variable (outdoor only)
 *   2  good (outdoor only)
 *   3  variable in-home, good outdoor
 *   4  good in-home and outdoor
 *
 * So `2` is not "middling everywhere" — it is *good outside and nothing
 * indoors*. Reading it with the old 0/3/4 mapper, which treated the number
 * as a single quality grade, would report indoor coverage at an address that
 * Ofcom is explicitly saying has none. That is the difference between
 * telling a customer their phone will work at their desk and telling them it
 * will not.
 *
 * Two other things the new methodology removed, and which must therefore not
 * be invented from it: the split between voice and data (one figure now
 * covers typical use), and 2G and 3G (the figure is a blend of 4G and 5G).
 */
export type MobileRating = 0 | 1 | 2 | 3 | 4;

/** Ofcom's own wording for each rating. */
const RATING_LABEL: Record<MobileRating, string> = {
  0: 'Poor to none, outdoors only',
  1: 'Variable outdoors, nothing indoors',
  2: 'Good outdoors, nothing indoors',
  3: 'Variable indoors, good outdoors',
  4: 'Good indoors and outdoors',
};

export const mobileRatingLabel = (rating: MobileRating): string => RATING_LABEL[rating];

/** A rating from whatever the API sent, or nothing. */
export function toMobileRating(value: unknown): MobileRating | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value.trim(), 10) : NaN;
  if (!Number.isFinite(n)) return undefined;
  const clamped = Math.trunc(n);
  if (clamped < 0 || clamped > 4) return undefined;
  return clamped as MobileRating;
}

/**
 * The rating as an indoor/outdoor pair.
 *
 * `none` indoors for 0 to 2 is the whole point: Ofcom are saying there is no
 * in-home coverage at those levels, and softening it to `poor` would put a
 * number on something they have declined to.
 */
export function bandFromRating(rating: MobileRating): SignalBand {
  const table: Record<MobileRating, SignalBand> = {
    0: { indoor: 'none', outdoor: 'poor' },
    1: { indoor: 'none', outdoor: 'variable' },
    2: { indoor: 'none', outdoor: 'good' },
    3: { indoor: 'variable', outdoor: 'good' },
    4: { indoor: 'good', outdoor: 'good' },
  };
  return table[rating];
}

/** Higher is better, for picking a headline operator. */
const GRADE_RANK: Record<SignalGrade, number> = {
  unknown: -1,
  none: 0,
  poor: 1,
  variable: 2,
  good: 3,
  excellent: 4,
};

export const gradeRank = (grade: SignalGrade): number => GRADE_RANK[grade];

/**
 * Which operator to recommend, and for what.
 *
 * Indoor first, because a business asking about mobile coverage is asking
 * whether it works at their desk. Ties go to the better outdoor figure, and
 * where nothing has indoor coverage the answer says so rather than naming a
 * winner of a contest nobody won.
 */
export function bestOperator(
  ratings: Partial<Record<MobileOperator, MobileRating>>,
): { operator?: MobileOperator; indoor: boolean; because: string } {
  const entries = (Object.entries(ratings) as Array<[MobileOperator, MobileRating]>).filter(
    ([, r]) => r !== undefined,
  );
  if (!entries.length) return { indoor: false, because: 'No operator coverage was reported for this address.' };

  const indoorCapable = entries.filter(([, r]) => r >= 3);
  if (indoorCapable.length) {
    const [operator, rating] = indoorCapable.sort((a, b) => b[1] - a[1])[0]!;
    return {
      operator,
      indoor: true,
      because: `${operator}: ${mobileRatingLabel(rating).toLowerCase()}.`,
    };
  }

  const [operator, rating] = entries.sort((a, b) => b[1] - a[1])[0]!;
  return {
    operator,
    indoor: false,
    because:
      `No operator is predicted to work indoors here. Best outdoors is ${operator} — ` +
      `${mobileRatingLabel(rating).toLowerCase()}. A 5G unit would need an external aerial.`,
  };
}

/**
 * Ofcom's field names, mapped to operators.
 *
 * `TH` for Three and `VO` for Vodafone, which are not guessable from the
 * operator names.
 */
export const OFCOM_MOBILE_FIELDS: ReadonlyArray<{ field: string; operator: MobileOperator }> = [
  { field: 'Mc_EE', operator: 'EE' },
  { field: 'Mc_TH', operator: 'Three' },
  { field: 'Mc_O2', operator: 'O2' },
  { field: 'Mc_VO', operator: 'Vodafone' },
];

/**
 * What the rating means for a 5G backup unit.
 *
 * The question actually being asked when somebody looks this up: will a
 * router in a comms cupboard hold a connection. A cupboard is indoors and
 * usually the worst room in the building, so anything without in-home
 * coverage needs an aerial and should be sold that way rather than
 * discovered on site.
 */
export function backupVerdict(rating: MobileRating | undefined): {
  usable: boolean;
  needsAerial: boolean;
  advice: string;
} {
  if (rating === undefined) {
    return { usable: false, needsAerial: false, advice: 'No coverage figure for this address, so nothing can be promised.' };
  }
  if (rating >= 4) {
    return { usable: true, needsAerial: false, advice: 'Should hold indoors, cupboard included.' };
  }
  if (rating === 3) {
    return {
      usable: true,
      needsAerial: true,
      advice: 'Indoor coverage is variable, so a comms cupboard is a gamble. Quote an external aerial.',
    };
  }
  if (rating >= 1) {
    return {
      usable: false,
      needsAerial: true,
      advice: 'Outdoor only. It will not work in a cupboard — an external aerial is not optional here.',
    };
  }
  return { usable: false, needsAerial: false, advice: 'No usable coverage. A mobile backup on this network is not a solution.' };
}
