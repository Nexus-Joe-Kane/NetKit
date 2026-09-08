import { gradeScore } from './grade';
import type { MastSite, MobileCoverage, MobileOperator, SignalGrade } from './types';

/**
 * Which network to put a phone on, from whatever we actually know.
 *
 * Three sources, none of which answers on its own:
 *
 * - **Ofcom** predict per-operator coverage, but only through their mobile
 *   API. The Connected Nations file counts networks rather than naming them,
 *   so it cannot say "EE is best here" and this module never lets it pretend
 *   to. Where the API is not connected, an engineer can type in what Ofcom's
 *   own public checker showed, which is per-operator and is treated as such.
 * - **OpenCelliD** give mast positions. A prediction says what a model thinks;
 *   a distance is a physical fact, and in central London a site four hundred
 *   metres away behind two office blocks beats one two kilometres away with a
 *   clear run.
 * - **BT footfall** says how crowded the area is. A cell has finite capacity,
 *   so a busy high street degrades a good prediction in a way a model of
 *   propagation does not capture — and that makes distance matter more.
 *
 * Every conclusion carries what it was based on and what was missing. An
 * educated guess offered as a guess is useful; the same guess offered as a
 * fact gets an engineer sent to the wrong network.
 */

export const OPERATORS: readonly MobileOperator[] = ['EE', 'Vodafone', 'O2', 'Three'] as const;

/** How close two predictions have to be before they count as tied. */
export const CLOSE_CALL_POINTS = 5;

/**
 * A mast advantage worth acting on.
 *
 * Both thresholds have to be met. A proportional one alone calls 120 m
 * against 100 m a win, which is inside OpenCelliD's own positional error; an
 * absolute one alone calls 4.3 km against 4.0 km a win, which is noise at
 * that range.
 */
export const MAST_EDGE_RATIO = 0.25;
export const MAST_EDGE_METRES = 300;

export type AdviceQuality =
  /** A source that names operators: Ofcom's API, or the engineer's own reading. */
  | 'per-operator'
  /** Ofcom's area file: it counts networks and cannot name one. */
  | 'area-only'
  | 'none';

export type FootfallLevel = 'low' | 'medium' | 'high';

export interface OperatorEvidence {
  operator: MobileOperator;
  /**
   * 0–100. From a percentage where a source gives one, otherwise derived
   * from the grade.
   */
  score?: number;
  /** The grade this came from, for the wording. */
  grade?: SignalGrade;
  nearestMastMetres?: number;
  mastCount?: number;
}

export interface NetworkAdviceInput {
  /** Per-operator coverage, when a source names operators. */
  coverage?: MobileCoverage[];
  /** What the engineer read off Ofcom's public checker. */
  manualGrades?: Partial<Record<MobileOperator, SignalGrade>>;
  /**
   * Per-operator percentages, where a source gives them.
   *
   * Nothing supplies these yet: Ofcom's grades are four coarse steps, so a
   * gap of one to five points cannot arise from them and the close-call rule
   * currently only ever fires on an exact tie. Their mobile API is expected
   * to carry real percentages, and this is where they go — so the rule is
   * written, tested and ready rather than added in a hurry later.
   */
  scores?: Partial<Record<MobileOperator, number>>;
  masts?: MastSite[];
  footfall?: FootfallLevel;
  /** True when the only Ofcom data is the area file. */
  areaOnly?: boolean;
}

export interface NetworkAdvice {
  /** The recommendation, where there is enough to make one. */
  best?: MobileOperator;
  /** Everything scored, best first. */
  ranked: OperatorEvidence[];
  quality: AdviceQuality;
  /** How much weight to put on it. */
  confidence: 'high' | 'medium' | 'low';
  /** One line each, in the order they should be read. */
  reasons: string[];
  /** Sources that contributed, for the panel to name. */
  sourcesUsed: string[];
  /** What would make this better, so the gap is visible. */
  missing: string[];
  /**
   * Set when two predictions were within `CLOSE_CALL_POINTS` and mast
   * distance was used to separate them.
   */
  closeCall?: {
    operators: MobileOperator[];
    /** True when the prediction's winner also had the nearer mast. */
    predictionHeld: boolean;
    settledBy: 'masts' | 'nothing';
  };
  /**
   * Set when the masts point somewhere the prediction does not. Always a
   * suggestion, never the headline — a model and a mast position disagreeing
   * is a reason for an engineer to look, not a reason to overrule Ofcom.
   */
  mastSuggestion?: {
    operator: MobileOperator;
    nearestMastMetres: number;
    /** The operator the prediction favoured. */
    against: MobileOperator;
    againstMastMetres?: number;
  };
}

/** A grade on the same 0–100 scale as a percentage, so the two compare. */
export const scoreFromGrade = (grade: SignalGrade): number => Math.round((gradeScore(grade) / 5) * 100);

/**
 * The one figure that matters for "which network works in this building".
 *
 * Indoor data, because that is what a phone is doing and where a building
 * eats the signal. Voice is the fallback: a site with no data prediction but
 * a voice one still tells you something.
 */
function scoreOf(coverage: MobileCoverage): { score: number; grade: SignalGrade } {
  const candidates: SignalGrade[] = [
    coverage.data5g?.indoor ?? 'unknown',
    coverage.data4g.indoor,
    coverage.voice.indoor,
  ];
  const grade = candidates.find((g) => g !== 'unknown') ?? 'unknown';
  return { score: scoreFromGrade(grade), grade };
}

/** Nearest mast per operator, from the sites OpenCelliD returned. */
export function nearestByOperator(masts: MastSite[]): Map<MobileOperator, { metres: number; count: number }> {
  const out = new Map<MobileOperator, { metres: number; count: number }>();
  for (const mast of masts) {
    if (!mast.operator) continue;
    const held = out.get(mast.operator);
    if (!held) out.set(mast.operator, { metres: mast.distanceMetres, count: 1 });
    else out.set(mast.operator, { metres: Math.min(held.metres, mast.distanceMetres), count: held.count + 1 });
  }
  return out;
}

/** True when one mast is enough closer than another to matter. */
export function mastEdge(closer: number, further: number): boolean {
  return further - closer >= MAST_EDGE_METRES && closer <= further * (1 - MAST_EDGE_RATIO);
}

const metres = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(1)} km` : `${Math.round(v)} m`);

export function recommendNetwork(input: NetworkAdviceInput): NetworkAdvice {
  const sourcesUsed: string[] = [];
  const missing: string[] = [];
  const reasons: string[] = [];

  const masts = nearestByOperator(input.masts ?? []);
  if (masts.size > 0) sourcesUsed.push('OpenCelliD cell sites');
  else missing.push('No cell sites near this premises — set an OpenCelliD token, or there are none recorded here.');

  if (input.footfall) sourcesUsed.push('BT footfall');
  else missing.push('No footfall figure — BT Location Insights covers Greater London only.');

  /* ---- Per-operator predictions, from whichever source names them ---- */
  const manual = input.manualGrades ?? {};
  const hasManual = OPERATORS.some((op) => manual[op] && manual[op] !== 'unknown');
  const fromCoverage = new Map<MobileOperator, { score: number; grade: SignalGrade }>();
  for (const coverage of input.coverage ?? []) {
    const scored = scoreOf(coverage);
    if (scored.grade !== 'unknown') fromCoverage.set(coverage.operator, scored);
  }

  const hasScores = OPERATORS.some((op) => {
    const v = input.scores?.[op];
    return v != null && Number.isFinite(v);
  });

  let quality: AdviceQuality = 'none';
  if (hasScores) {
    quality = 'per-operator';
    sourcesUsed.push('Ofcom per-operator prediction');
  } else if (fromCoverage.size > 0) {
    quality = 'per-operator';
    sourcesUsed.push('Ofcom per-operator prediction');
  } else if (hasManual) {
    quality = 'per-operator';
    sourcesUsed.push("Ofcom's public checker, as read by the engineer");
  } else if (input.areaOnly) {
    quality = 'area-only';
    sourcesUsed.push('Ofcom Connected Nations area file');
    missing.push(
      'The area file counts how many networks cover the area, not which — so it cannot rank operators. ' +
        "Read the four networks off Ofcom's own checker and enter them here.",
    );
  } else {
    missing.push('No mobile coverage prediction at all.');
  }

  /* ---- Score every operator ----------------------------------------- */
  const evidence: OperatorEvidence[] = OPERATORS.map((operator) => {
    const predicted = fromCoverage.get(operator);
    const typed = manual[operator];
    const grade = predicted?.grade ?? (typed && typed !== 'unknown' ? typed : undefined);
    const mast = masts.get(operator);
    // A percentage beats a grade derived from one: it is the finer figure.
    const exact = input.scores?.[operator];
    const score = exact != null && Number.isFinite(exact) ? exact : grade ? scoreFromGrade(grade) : undefined;
    return {
      operator,
      ...(grade ? { grade } : {}),
      ...(score != null ? { score } : {}),
      ...(mast ? { nearestMastMetres: mast.metres, mastCount: mast.count } : {}),
    };
  });

  /*
   * Two orderings, deliberately.
   *
   * `byPrediction` is what the prediction alone says, tie-broken
   * alphabetically. Sorting it by mast distance -- which an earlier version
   * did -- meant that on an exact tie the operator with the nearer mast
   * became "the prediction's winner", and the advice then claimed the
   * prediction had held when the masts had in fact decided it. The reasoning
   * has to stay true even when the answer is the same.
   */
  const byPrediction = [...evidence].sort(
    (a, b) => (b.score ?? -1) - (a.score ?? -1) || a.operator.localeCompare(b.operator),
  );

  // What the panel lists: prediction first, then the nearer mast, so an
  // operator with no prediction still sorts on the only thing known about it.
  const ranked = [...evidence].sort(
    (a, b) =>
      (b.score ?? -1) - (a.score ?? -1) ||
      (a.nearestMastMetres ?? Number.POSITIVE_INFINITY) - (b.nearestMastMetres ?? Number.POSITIVE_INFINITY) ||
      a.operator.localeCompare(b.operator),
  );

  const scored = byPrediction.filter((r) => r.score != null);

  /* ---- No prediction: masts alone ----------------------------------- */
  if (scored.length === 0) {
    const byMast = ranked.filter((r) => r.nearestMastMetres != null);
    if (byMast.length === 0) {
      return { ranked, quality, confidence: 'low', reasons, sourcesUsed, missing };
    }
    const nearest = byMast[0]!;
    reasons.push(
      `No coverage prediction is available, so this is on mast distance alone: ${nearest.operator} has the ` +
        `nearest recorded site at ${metres(nearest.nearestMastMetres!)}.`,
    );
    reasons.push(
      'Distance is not coverage. A nearer mast can still be pointed the wrong way or be a different ' +
        'technology, so treat this as where to try first rather than as an answer.',
    );
    if (quality === 'area-only') {
      reasons.push(
        "These rankings are not Ofcom's: the area file names no operator. Everything above comes from mast " +
          'distance and what you entered.',
      );
    }
    return {
      best: nearest.operator,
      ranked,
      quality,
      confidence: 'low',
      reasons,
      sourcesUsed,
      missing,
    };
  }

  /* ---- A prediction exists ------------------------------------------ */
  const leader = scored[0]!;
  const second = scored[1];
  let best = leader.operator;
  let confidence: 'high' | 'medium' | 'low' = quality === 'per-operator' ? 'medium' : 'low';
  const advice: NetworkAdvice = { ranked, quality, confidence, reasons, sourcesUsed, missing };

  reasons.push(
    `${leader.operator} has the best predicted indoor signal here${leader.grade ? ` (${leader.grade})` : ''}.`,
  );

  /* ---- The close call ----------------------------------------------- */
  const gap = second?.score != null ? leader.score! - second.score : Number.POSITIVE_INFINITY;
  if (second && gap <= CLOSE_CALL_POINTS) {
    const leaderMast = leader.nearestMastMetres;
    const secondMast = second.nearestMastMetres;

    if (leaderMast != null && secondMast != null) {
      // On an exact tie the nearer mast simply wins; where the prediction did
      // separate them, it takes a real mast edge to overturn it.
      const predictionHeld = gap === 0 ? leaderMast <= secondMast : !mastEdge(secondMast, leaderMast);
      advice.closeCall = {
        operators: [leader.operator, second.operator],
        predictionHeld,
        settledBy: 'masts',
      };

      if (predictionHeld) {
        // A dead heat is not the prediction "holding" — it never picked one.
        // Saying it held would credit Ofcom with a call they did not make.
        reasons.push(
          gap === 0
            ? `${leader.operator} and ${second.operator} have the same predicted grade, so the masts decided ` +
              `it: ${leader.operator} has a site at ${metres(leaderMast)} against ${metres(secondMast)}.`
            : `${leader.operator} and ${second.operator} are within ${CLOSE_CALL_POINTS} points of each other, ` +
              `so the masts were used to separate them — and ${leader.operator} holds it, with a site at ` +
              `${metres(leaderMast)} against ${metres(secondMast)}.`,
        );
        confidence = 'high';
      } else {
        best = second.operator;
        advice.mastSuggestion = {
          operator: second.operator,
          nearestMastMetres: secondMast,
          against: leader.operator,
          againstMastMetres: leaderMast,
        };
        reasons.push(
          `${leader.operator} and ${second.operator} are within ${CLOSE_CALL_POINTS} points, and ` +
            `${second.operator} has a much nearer site — ${metres(secondMast)} against ${metres(leaderMast)}. ` +
            `On a tie, take the shorter path: try ${second.operator} first.`,
        );
        confidence = 'medium';
      }
    } else {
      advice.closeCall = {
        operators: [leader.operator, second.operator],
        predictionHeld: true,
        settledBy: 'nothing',
      };
      reasons.push(
        `${leader.operator} and ${second.operator} are within ${CLOSE_CALL_POINTS} points and there is no mast ` +
          'data to separate them. Either could be the better network in this building.',
      );
      confidence = 'low';
    }
  }

  /* ---- Masts pointing elsewhere ------------------------------------- */
  if (!advice.mastSuggestion) {
    const nearer = ranked
      .filter((r) => r.operator !== best && r.nearestMastMetres != null)
      .sort((a, b) => a.nearestMastMetres! - b.nearestMastMetres!)[0];
    const bestMast = ranked.find((r) => r.operator === best)?.nearestMastMetres;

    if (nearer?.nearestMastMetres != null && bestMast != null && mastEdge(nearer.nearestMastMetres, bestMast)) {
      advice.mastSuggestion = {
        operator: nearer.operator,
        nearestMastMetres: nearer.nearestMastMetres,
        against: best,
        againstMastMetres: bestMast,
      };
      reasons.push(
        `Worth knowing: ${nearer.operator} has a much nearer site — ${metres(nearer.nearestMastMetres)} against ` +
          `${metres(bestMast)} for ${best} — even though the prediction puts it lower. ` +
          'Predictions model propagation; they do not know which way an antenna is pointed.',
      );
    }
  }

  /* ---- Footfall: crowding makes distance matter more ----------------- */
  if (input.footfall === 'high') {
    reasons.push(
      'This is a busy area. A cell has finite capacity, so a good prediction can still perform badly at ' +
        'peak times — which is why the nearer site is worth trying even where the prediction disagrees.',
    );
    // A mast suggestion in a crowded area is worth more, so it stops being
    // a footnote.
    if (advice.mastSuggestion && advice.mastSuggestion.operator !== best) {
      reasons.push(
        `In an area this busy, ${advice.mastSuggestion.operator}'s shorter path is the stronger argument. ` +
          'Test both before committing a customer to a contract.',
      );
    }
  } else if (input.footfall === 'low') {
    reasons.push('A quiet area, so congestion is unlikely to be the problem — the prediction is the better guide.');
  }

  if (quality === 'area-only') {
    reasons.push(
      "These rankings are not Ofcom's: the area file names no operator. Everything above comes from mast " +
        'distance and what you entered.',
    );
  }

  advice.best = best;
  advice.confidence = confidence;
  return advice;
}

/**
 * Ofcom's public coverage checker, for a postcode.
 *
 * The postcode is appended as a query parameter on a best-effort basis --
 * Ofcom do not document one, and the checker may well ignore it. Which is
 * why the UI puts the postcode on the clipboard as well and says to paste it:
 * a link that promises to prefill and does not is worse than one that does
 * not promise.
 */
export function ofcomCheckerUrl(postcode: string): string {
  const clean = postcode.trim().toUpperCase();
  const base = 'https://www.ofcom.org.uk/mobile-coverage-checker';
  return clean ? `${base}?postcode=${encodeURIComponent(clean)}` : base;
}

/**
 * Turns a visitor count into a level.
 *
 * The thresholds are a judgement, not a published standard, and they are here
 * rather than buried in a component so they can be argued with in one place.
 * Daily visitors in a London retail catchment: a quiet residential street is
 * hundreds, a high street is thousands, Oxford Street is tens of thousands.
 */
export function footfallLevel(dailyVisitors?: number): FootfallLevel | undefined {
  if (dailyVisitors == null || !Number.isFinite(dailyVisitors) || dailyVisitors <= 0) return undefined;
  if (dailyVisitors >= 10_000) return 'high';
  if (dailyVisitors >= 2_000) return 'medium';
  return 'low';
}
