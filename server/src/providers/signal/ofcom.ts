import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { gradeFromOfcom, type MobileOperator, type SignalGrade, type SignalReport } from '@sw/shared';
import type {
  AreaCoverage,
  AreaCoverageRow,
  AreaKind,
  CoverageMeasure,
  CoveragePlacement,
  CoverageTechnology,
} from '@sw/shared';
import { config } from '../../config';
import { fetchJson } from '../../lib/http';
import type { SignalProvider } from '../types';
import { lookupPostcodeMeta } from '../address/postcodesIo';

/**
 * Ofcom mobile coverage, from Connected Nations open data.
 *
 * **There is no postcode-level mobile file.** This is the single most
 * important thing to know about this provider, and the reason it works the
 * way it does. Ofcom publish mobile coverage per parliamentary constituency
 * (`pcon`), per local or unitary authority (`laua`), per devolved
 * constituency (`devcon`) and per nation -- and nothing finer. Postcode-unit
 * files exist only for *fixed broadband*. Three releases were checked
 * (Connected Nations 2022, 2025 and the Spring 2026 update) and no CSV in
 * any mobile zip carries a postcode column.
 *
 * So a postcode is answered in two hops: postcodes.io maps it to its
 * constituency and local authority -- free, no key, and already integrated
 * here for address metadata -- and that area is looked up in Ofcom's file.
 *
 * The cost of that is honesty about resolution, and it is stated on every
 * operator rather than buried: the figure describes the area, not the
 * doorstep. A constituency contains both a city centre and a valley with no
 * signal, and this cannot tell them apart. It is Ofcom's published
 * prediction for the area the premises sits in, which is a different and
 * weaker claim than a per-premises measurement.
 *
 * Postcode-keyed files are still read if one is supplied, so a future
 * release at finer resolution needs no change here.
 *
 * Column names change between releases, so the header is *interpreted*
 * rather than hard-coded: each column is matched for an operator, a service
 * and indoor/outdoor, and anything unrecognised is ignored.
 */

/* ------------------------------------------------------------------ *
 * Header interpretation
 * ------------------------------------------------------------------ */

type Service = 'voice' | 'data4g' | 'data5g' | 'data3g';
type Placement = 'indoor' | 'outdoor';

interface ColumnMeaning {
  index: number;
  operator: MobileOperator;
  service: Service;
  placement: Placement;
}

/**
 * Column headers are tokenised rather than regex-matched.
 *
 * Ofcom separate words with underscores, and an underscore is a *word*
 * character — so `\bEE\b` never fires in `EE_Voice_Indoor`. Splitting on
 * non-alphanumerics and comparing tokens avoids that trap entirely and
 * copes with the naming changing between releases.
 */
function tokenise(header: string): string[] {
  return header
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

/** Ofcom use short codes; these are the ones seen across releases. */
const OPERATOR_TOKENS: Array<[MobileOperator, string[]]> = [
  ['EE', ['EE', 'EEL', 'BTEE']],
  ['Vodafone', ['VO', 'VF', 'VODAFONE']],
  ['O2', ['O2', 'TF', 'TELEFONICA']],
  ['Three', ['H3', 'TH', 'THREE', 'HUTCHISON']],
];

const SERVICE_TOKENS: Array<[Service, string[]]> = [
  ['data5g', ['5G', 'NR']],
  ['data4g', ['4G', 'LTE']],
  ['data3g', ['3G', 'UMTS']],
  ['voice', ['VOICE', 'CALL', 'CALLS', 'TELEPHONY', '2G', 'GSM']],
];

const PLACEMENT_TOKENS: Array<[Placement, string[]]> = [
  ['indoor', ['INDOOR', 'INDOORS', 'IN', 'INTERNAL']],
  ['outdoor', ['OUTDOOR', 'OUTDOORS', 'OUT', 'EXTERNAL', 'EXT']],
];

/**
 * Matches by exact token first, then by containment for headers that run
 * words together (`EEVoiceIndoor`).
 *
 * `minSubstring` is per-table because the risk differs sharply. Operator
 * short codes (`EE`, `VO`, `TF`) appear inside ordinary words, so only the
 * full names may be matched as substrings. Service codes (`4G`, `LTE`) are
 * distinctive enough to be safe short. Placement short forms (`IN`, `OUT`)
 * are the most dangerous of all — `IN` occurs in a great many words — so
 * only the long forms qualify.
 */
function matchTokens<T>(tokens: string[], table: Array<[T, string[]]>, minSubstring: number): T | null {
  for (const [value, candidates] of table) {
    if (tokens.some((token) => candidates.includes(token))) return value;
  }
  const joined = tokens.join('');
  for (const [value, candidates] of table) {
    if (candidates.some((c) => c.length >= minSubstring && joined.includes(c))) return value;
  }
  return null;
}

function operatorFrom(header: string): MobileOperator | null {
  return matchTokens(tokenise(header), OPERATOR_TOKENS, 4);
}

function serviceFrom(header: string): Service | null {
  return matchTokens(tokenise(header), SERVICE_TOKENS, 2);
}

function placementFrom(header: string): Placement | null {
  return matchTokens(tokenise(header), PLACEMENT_TOKENS, 6);
}

export interface HeaderMeaning {
  /** -1 when the file is not keyed on postcode, which is the usual case. */
  postcodeIndex: number;
  /** The human-readable area name, e.g. "Richmond Park". */
  areaNameIndex: number;
  /** The ONS code, e.g. `E14000898`. Preferred when present: names collide. */
  areaCodeIndex: number;
  /**
   * The publication a row belongs to, where the file carries more than one.
   *
   * A single Ofcom release has one row per area, but a file combining
   * releases -- which is the practical way to keep pcon and laua together --
   * has the same area several times over. Without reading this, whichever
   * row happened to sit last in the file would win, and the answer would
   * depend on sort order rather than on which figures are newest.
   */
  releaseIndex: number;
  /** -1 when the file does not state how many premises an area holds. */
  premisesIndex: number;
  columns: ColumnMeaning[];
  /**
   * The columns Ofcom actually publish.
   *
   * The per-operator columns above are for a file that names operators.
   * Connected Nations does not: it publishes `4G_prem_in_3` — the percentage
   * of premises where exactly three of the four networks give indoor 4G. A
   * reader that only understood the per-operator shape found nothing in the
   * real file and the tab read "No provider returned a result" with a
   * perfectly good dataset on disk.
   */
  bands: BandColumn[];
}

/** One `<tech>_<measure>_<placement>_<operators>` column. */
export interface BandColumn {
  index: number;
  technology: CoverageTechnology;
  measure: CoverageMeasure;
  placement: CoveragePlacement;
  /** Ofcom's confidence qualifier, present on the 5G columns only. */
  confidence?: 'high' | 'very-high';
  /** How many operators this column counts, 0 to 4. */
  operators: number;
}

/**
 * Reads one of Ofcom's band column names.
 *
 * `4G_prem_in_3`, `5G_geo_out_0`, `2G_prem_out_2`. Anchored and whole-string
 * on purpose: a substring match here would swallow `4G_abrd_in_1` (A and B
 * roads) and `4G_mway_in_2` (motorways), which measure something else
 * entirely and would otherwise be mixed into the premises figures.
 */
export function bandColumn(header: string, index: number): BandColumn | null {
  // 5G carries a confidence qualifier -- `5G_very_high_confidence_prem_out_3`
  // -- and 2G/3G/4G do not. `very_high` is matched before `high` because the
  // shorter alternative would otherwise consume it and silently merge the two
  // into one row.
  const m = /^([2345]G)(?:_(very_high|high)_confidence)?_(prem|geo)_(in|out)_([0-4])$/i.exec(header.trim());
  if (!m) return null;
  const confidence = m[2]?.toLowerCase();
  return {
    index,
    technology: m[1]!.toUpperCase() as CoverageTechnology,
    measure: m[3]!.toLowerCase() === 'prem' ? 'premises' : 'geographic',
    placement: m[4]!.toLowerCase() === 'in' ? 'indoor' : 'outdoor',
    ...(confidence === 'very_high' ? { confidence: 'very-high' as const } : {}),
    ...(confidence === 'high' ? { confidence: 'high' as const } : {}),
    operators: Number(m[5]),
  };
}

/** Column names Ofcom and the combining script use for the area key. */
/*
 * Ofcom's own column names are in here, verbatim.
 *
 * They were not, and the consequence was quiet: the constituency file keys on
 * `parl_const` / `parl_const_name`, neither of which was on either list, so
 * the reader found no area key at all — fell through to its
 * "guess a postcode column" branch, indexed six hundred and fifty
 * constituencies under column zero as though they were postcodes, and
 * declared the whole dataset postcode-keyed. Every lookup then missed, and
 * the tab read "No provider returned a result" with the right file on disk.
 *
 * Only the local-authority file happened to use a name already on the list,
 * which is why it looked like it half worked.
 */
const AREA_NAME_HEADERS = [
  'AREANAME',
  'AREA',
  'PCONNAME',
  'PARLCONSTNAME',
  'LAUANAME',
  'DEVCONNAME',
  'DEVOLVEDCONSTNAME',
  'LOCATION',
  'NAME',
  'CONSTITUENCY',
  'LOCALAUTHORITY',
];
const AREA_CODE_HEADERS = [
  'AREACODE',
  'PCON',
  'PCONCODE',
  'PARLCONST',
  'LAUA',
  'LAUACODE',
  'DEVCON',
  'DEVCONCODE',
  'DEVOLVEDCONST',
  'LOCATIONCODE',
  'CODE',
  'ONSCODE',
  'GSSCODE',
];
const RELEASE_HEADERS = ['RELEASE', 'PUBLICATION', 'EDITION', 'VERSION', 'PERIOD', 'REPORTDATE'];

/**
 * Reads a header row and works out what each column means.
 *
 * Exact joined-token matching for the key columns, not substring: `AREA`
 * appears inside plenty of measure column names, and a measure column
 * mistaken for the key would index the whole file under a coverage
 * percentage.
 */
export function interpretHeader(headers: string[]): HeaderMeaning {
  let postcodeIndex = -1;
  let areaNameIndex = -1;
  let areaCodeIndex = -1;
  let releaseIndex = -1;
  const columns: ColumnMeaning[] = [];
  const bands: BandColumn[] = [];
  // Premises count is the denominator, and worth carrying so the UI can say
  // how big the area is rather than quoting a percentage of nothing named.
  let premisesIndex = -1;

  headers.forEach((raw, index) => {
    const header = raw.trim().replace(/^"|"$/g, '');
    const tokens = tokenise(header);
    const joined = tokens.join('');

    if (postcodeIndex < 0 && (joined === 'POSTCODE' || ['PCD', 'PCDS'].includes(tokens[0] ?? ''))) {
      postcodeIndex = index;
      return;
    }
    if (areaCodeIndex < 0 && AREA_CODE_HEADERS.includes(joined)) {
      areaCodeIndex = index;
      return;
    }
    if (areaNameIndex < 0 && AREA_NAME_HEADERS.includes(joined)) {
      areaNameIndex = index;
      return;
    }
    if (releaseIndex < 0 && RELEASE_HEADERS.includes(joined)) {
      releaseIndex = index;
      return;
    }

    const band = bandColumn(header, index);
    if (band) {
      bands.push(band);
      return;
    }

    if (premisesIndex < 0 && ['PREMCOUNT', 'PREMISES', 'PREMISECOUNT'].includes(joined)) {
      premisesIndex = index;
      return;
    }

    const operator = operatorFrom(header);
    const service = serviceFrom(header);
    const placement = placementFrom(header);
    if (operator && service && placement) columns.push({ index, operator, service, placement });
  });

  // Only fall back to guessing a postcode column when there is no area key
  // at all -- otherwise an area-keyed file gets read as postcode-keyed and
  // every lookup misses.
  if (postcodeIndex < 0 && areaNameIndex < 0 && areaCodeIndex < 0) {
    const guess = headers.findIndex((h) => /postcode/i.test(h));
    postcodeIndex = guess >= 0 ? guess : 0;
  }

  return { postcodeIndex, areaNameIndex, areaCodeIndex, releaseIndex, premisesIndex, columns, bands };
}

/** Area names are compared case- and punctuation-insensitively. */
export function normaliseArea(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .trim();
}

/* ------------------------------------------------------------------ *
 * Dataset index
 * ------------------------------------------------------------------ */

interface CoverageRow {
  [operator: string]: Partial<Record<`${Service}_${Placement}`, SignalGrade>>;
}

interface DatasetIndex {
  byPostcode: Map<string, CoverageRow>;
  /**
   * Area-level coverage from Ofcom's own column shape, keyed the same way as
   * `byArea` — by ONS code and by name.
   */
  coverageByArea: Map<string, AreaCoverage>;
  /** Keyed by normalised area name and, where published, by ONS code. */
  byArea: Map<string, CoverageRow>;
  /** Which key the file actually carries, so lookups know what to try. */
  keyedBy: 'postcode' | 'area';
  /** Where it came from and when, for the admin status board. */
  path: string;
  loadedAt: string;
  rows: number;
  columnsUnderstood: number;
  /** File mtime, so a refreshed dataset is picked up without a restart. */
  mtimeMs: number;
}

let index: DatasetIndex | null = null;

const normalisePostcode = (raw: string): string => raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

/** Splits a CSV line, honouring quoted fields. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      // A doubled quote inside a quoted field is a literal quote.
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      out.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  out.push(current);
  return out;
}

/**
 * Loads and indexes the dataset. Reloads when the file changes on disk, so
 * dropping in a new Ofcom release needs no restart.
 */
/**
 * Which CSVs make up the dataset.
 *
 * `OFCOM_DATASET_PATH` may point at a single CSV or at the folder the
 * Connected Nations zip extracts to. The folder is the useful case: the zip
 * holds the constituency, local-authority and devolved-constituency files
 * together, and asking somebody to pick one and rename it is how the wrong
 * one ends up configured.
 *
 * Ordered finest area first, because that is the order the lookup wants to
 * try them in.
 */
function datasetFiles(absolute: string): string[] {
  if (!statSync(absolute).isDirectory()) return [absolute];

  const rank = (name: string): number => {
    const n = name.toLowerCase();
    if (n.includes('pcon')) return 0;
    if (n.includes('devcon')) return 1;
    if (n.includes('laua')) return 2;
    return 3;
  };

  return readdirSync(absolute)
    .filter((f) => f.toLowerCase().endsWith('.csv'))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((f) => join(absolute, f));
}

/** Which kind of area a Connected Nations file is keyed on. */
function areaKindOf(file: string, headers: string[]): AreaKind {
  const joined = `${file} ${headers.join(' ')}`.toLowerCase();
  if (joined.includes('pcon') || joined.includes('parl_const')) return 'constituency';
  if (joined.includes('devcon') || joined.includes('devolved')) return 'devolved-constituency';
  if (joined.includes('laua')) return 'local-authority';
  return 'area';
}

/**
 * The Ofcom release, from the file name.
 *
 * `202507_mobile_coverage_pcon_r01.csv` is July 2025. Taken from the name
 * because the rows carry no date of their own, and the release is what a
 * person needs to judge how stale the answer is.
 */
function releaseOf(file: string): string | undefined {
  const m = /(20\d{2})(0[1-9]|1[0-2])/.exec(file.replace(/[\\/]/g, ' '));
  return m ? `${m[1]}-${m[2]}` : undefined;
}

const numberOrUndefined = (raw?: string): number | undefined => {
  const v = Number.parseFloat((raw ?? '').replace(/[,%\s]/g, ''));
  return Number.isFinite(v) ? v : undefined;
};

/**
 * Loads and indexes the dataset. Reloads when anything changes on disk, so
 * dropping in a new Ofcom release needs no restart.
 */
export function loadDataset(force = false): DatasetIndex | null {
  const path = config().ofcom.datasetPath;
  if (!path) return null;

  const absolute = resolve(path);
  if (!existsSync(absolute)) return null;

  const { mtimeMs } = statSync(absolute);
  if (!force && index && index.path === absolute && index.mtimeMs === mtimeMs) return index;

  const byPostcode = new Map<string, CoverageRow>();
  const byArea = new Map<string, CoverageRow>();
  const coverageByArea = new Map<string, AreaCoverage>();
  /** Which release each area key currently holds, so newer rows win. */
  const releaseByArea = new Map<string, string>();
  let keyedBy: 'postcode' | 'area' = 'area';
  let rowCount = 0;
  let columnsUnderstood = 0;
  let bandsUnderstood = 0;

  for (const file of datasetFiles(absolute)) {
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
    if (lines.length < 2) continue;

    const headers = splitCsvLine(lines[0]!);
    const { postcodeIndex, areaNameIndex, areaCodeIndex, releaseIndex, premisesIndex, columns, bands } =
      interpretHeader(headers);
    columnsUnderstood += columns.length;
    bandsUnderstood += bands.length;
    if (postcodeIndex >= 0) keyedBy = 'postcode';

    const kind = areaKindOf(file, headers);
    const fileRelease = releaseOf(file);

    for (let i = 1; i < lines.length; i += 1) {
      const cells = splitCsvLine(lines[i]!);
      rowCount += 1;

      /* ---- Per-operator columns, where a file has them --------------- */
      const row: CoverageRow = {};
      for (const column of columns) {
        const grade = gradeFromOfcom(cells[column.index]);
        if (grade === 'unknown') continue;
        (row[column.operator] ??= {})[`${column.service}_${column.placement}`] = grade;
      }

      /* ---- Ofcom's own band columns ---------------------------------- */
      const grouped = new Map<string, AreaCoverageRow>();
      for (const band of bands) {
        const percent = numberOrUndefined(cells[band.index]);
        // Ofcom leave a band empty rather than writing 0. An empty cell is
        // "none in this band", so it is skipped rather than read as a gap in
        // the data.
        if (percent === undefined) continue;
        const key = `${band.technology}|${band.confidence ?? ''}|${band.measure}|${band.placement}`;
        const existing = grouped.get(key) ?? {
          technology: band.technology as CoverageTechnology,
          measure: band.measure as CoverageMeasure,
          placement: band.placement as CoveragePlacement,
          ...(band.confidence ? { confidence: band.confidence } : {}),
          bands: [],
        };
        existing.bands.push({ operators: band.operators, percent });
        grouped.set(key, existing);
      }

      const areaName = (cells[areaNameIndex] ?? '').trim();
      const areaCode = (cells[areaCodeIndex] ?? '').trim();
      const coverage: AreaCoverage | null = grouped.size
        ? {
            areaName: areaName || areaCode,
            ...(areaCode ? { areaCode } : {}),
            kind,
            ...(premisesIndex >= 0 && numberOrUndefined(cells[premisesIndex]) !== undefined
              ? { premisesCount: numberOrUndefined(cells[premisesIndex])! }
              : {}),
            rows: [...grouped.values()].map((r) => ({
              ...r,
              bands: [...r.bands].sort((a, b) => a.operators - b.operators),
            })),
            ...(fileRelease ? { release: fileRelease } : {}),
            file: basename(file),
          }
        : null;

      if (postcodeIndex >= 0) {
        const postcode = normalisePostcode(cells[postcodeIndex] ?? '');
        if (postcode && Object.keys(row).length) byPostcode.set(postcode, row);
      }

      // Indexed under both the code and the name. The code is unambiguous;
      // the name is what postcodes.io returns, and the two disagree often
      // enough (boundary reviews rename constituencies) that keeping both
      // costs nothing and saves a miss.
      //
      // Where a key already has a row, the newer release keeps it. Release
      // labels sort lexically in the form Ofcom use (`2025-07`, `2026-01`).
      const release = releaseIndex >= 0 ? (cells[releaseIndex] ?? '').trim() : (fileRelease ?? '');
      const claim = (key: string): void => {
        if (!key) return;
        const held = releaseByArea.get(key);
        if (held !== undefined && release <= held) return;
        if (Object.keys(row).length) byArea.set(key, row);
        if (coverage) coverageByArea.set(key, coverage);
        releaseByArea.set(key, release);
      };
      claim(normaliseArea(areaCode));
      claim(normaliseArea(areaName));
    }
  }

  if (byArea.size === 0 && byPostcode.size === 0 && coverageByArea.size === 0) return null;

  index = {
    byPostcode,
    byArea,
    coverageByArea,
    keyedBy,
    path: absolute,
    loadedAt: new Date().toISOString(),
    rows: rowCount,
    columnsUnderstood: columnsUnderstood + bandsUnderstood,
    mtimeMs,
  };
  return index;
}

/** Dataset state, surfaced on the admin status board. */
export function datasetStatus(): {
  configured: boolean;
  loaded: boolean;
  path?: string;
  rows?: number;
  columnsUnderstood?: number;
  loadedAt?: string;
} {
  const path = config().ofcom.datasetPath;
  if (!path) return { configured: false, loaded: false };

  const loaded = loadDataset();
  if (!loaded) return { configured: true, loaded: false, path: resolve(path) };
  return {
    configured: true,
    loaded: true,
    path: loaded.path,
    rows: loaded.rows,
    columnsUnderstood: loaded.columnsUnderstood,
    loadedAt: loaded.loadedAt,
  };
}

/* ------------------------------------------------------------------ *
 * Provider
 * ------------------------------------------------------------------ */

const OPERATORS: MobileOperator[] = ['EE', 'Vodafone', 'O2', 'Three'];

const MVNOS: Record<MobileOperator, string[]> = {
  EE: ['BT Mobile', '1pMobile', 'Lycamobile'],
  Vodafone: ['VOXI', 'Lebara', 'Talkmobile', 'Asda Mobile'],
  O2: ['Giffgaff', 'Tesco Mobile', 'Sky Mobile'],
  Three: ['SMARTY', 'iD Mobile'],
};

function buildReport(
  address: SignalReport['address'],
  row: CoverageRow,
  source: string,
  /** The area the figures describe, when they are not postcode-level. */
  area?: string,
): SignalReport {
  const operators = OPERATORS.filter((operator) => row[operator]).map((operator) => {
    const cells = row[operator]!;
    const grade = (key: `${Service}_${Placement}`): SignalGrade => cells[key] ?? 'unknown';
    const has5g = cells.data5g_outdoor !== undefined || cells.data5g_indoor !== undefined;

    const notes: string[] = [
      'Ofcom predicted coverage, not a measurement — local obstructions are not modelled.',
    ];
    // Said on every operator rather than once at the top, because this is
    // the caveat someone quoting a figure to a customer needs in front of
    // them: Ofcom publish no mobile data finer than this.
    if (area) {
      notes.push(
        `Published for ${area}, not for this postcode — Ofcom do not publish mobile coverage below area level, so one figure covers the whole area.`,
      );
    }
    if (!has5g) {
      notes.push(
        area
          ? `No 5G prediction published for this operator in ${area}.`
          : 'No 5G prediction published for this operator at this postcode.',
      );
    }

    return {
      operator,
      mvnos: MVNOS[operator],
      voice: { indoor: grade('voice_indoor'), outdoor: grade('voice_outdoor') },
      data4g: { indoor: grade('data4g_indoor'), outdoor: grade('data4g_outdoor') },
      ...(has5g ? { data5g: { indoor: grade('data5g_indoor'), outdoor: grade('data5g_outdoor') } } : {}),
      ...(cells.data3g_indoor || cells.data3g_outdoor
        ? { data3g: { indoor: grade('data3g_indoor'), outdoor: grade('data3g_outdoor') } }
        : {}),
      source: 'ofcom' as const,
      notes,
    };
  });

  const best = (pick: (o: (typeof operators)[number]) => SignalGrade): MobileOperator | undefined => {
    const order: SignalGrade[] = ['unknown', 'none', 'poor', 'variable', 'good', 'excellent'];
    let winner: (typeof operators)[number] | undefined;
    for (const candidate of operators) {
      if (!winner || order.indexOf(pick(candidate)) > order.indexOf(pick(winner))) winner = candidate;
    }
    return winner?.operator;
  };

  return {
    ...(address.uprn ? { uprn: address.uprn } : {}),
    address,
    operators,
    headline: {
      ...(best((o) => o.voice.indoor) ? { bestIndoorVoice: best((o) => o.voice.indoor) } : {}),
      ...(best((o) => o.data4g.indoor) ? { bestIndoorData: best((o) => o.data4g.indoor) } : {}),
    },
    checkedAt: new Date().toISOString(),
    sources: [source],
  };
}

export function createOfcomSignalProvider(): SignalProvider {
  const cfg = config();

  return {
    name: 'ofcom-coverage',
    label: 'Ofcom mobile coverage (Connected Nations)',
    configured: Boolean(cfg.ofcom.datasetPath),
    mode: 'live',

    async forAddress(address) {
      // Dataset only. There was a speculative live-endpoint branch here for a
      // mobile coverage API, written before anyone had an Ofcom account —
      // Ofcom sell no such product (their developer portal offers Broadband
      // Coverage Basic and Premium and nothing else), and it used the wrong
      // subscription header. Code that can never run is worse than no code:
      // it made OFCOM_API_KEY look like it did something.

      const dataset = loadDataset();
      if (!dataset) {
        throw new Error(
          'Ofcom coverage is not available: point OFCOM_DATASET_PATH at the ' +
            'folder a Connected Nations mobile coverage zip extracts to, or at ' +
            'one of its CSVs. Ofcom publish these per parliamentary ' +
            'constituency and per local authority — there is no postcode-level ' +
            'mobile file.',
        );
      }

      // A postcode-keyed file, if one is ever published, is used directly.
      if (dataset.keyedBy === 'postcode') {
        const row = dataset.byPostcode.get(normalisePostcode(address.postcode));
        if (!row) throw new Error(`No Ofcom coverage row for ${address.postcode} in ${dataset.path}.`);
        return buildReport(address, row, 'ofcom:dataset');
      }

      // Otherwise the two hops: postcode -> area, area -> coverage.
      const meta = await lookupPostcodeMeta(address.postcode);
      if (!meta) {
        throw new Error(
          `Could not resolve ${address.postcode} to a constituency or local authority, ` +
            'so Ofcom\'s area-level mobile coverage cannot be looked up.',
        );
      }

      // Constituency first: it is the finer of the two areas Ofcom publish.
      const candidates: Array<{ label: string; key?: string }> = [
        { label: meta.constituency ?? '', key: meta.constituency },
        { label: meta.localAuthority ?? '', key: meta.localAuthority },
        { label: meta.county ?? '', key: meta.county },
      ];

      for (const candidate of candidates) {
        if (!candidate.key) continue;
        const key = normaliseArea(candidate.key);

        // A file that names operators is the better answer, so it is tried
        // first even though Ofcom do not currently publish one.
        const row = dataset.byArea.get(key);
        if (row) return buildReport(address, row, 'ofcom:dataset', candidate.label);

        // Otherwise Ofcom's own shape: how many of the four networks cover
        // the area. Returned with no `operators` at all, because inventing
        // per-operator rows from a count is exactly the lie this avoids.
        const coverage = dataset.coverageByArea.get(key);
        if (coverage) {
          return {
            ...(address.uprn ? { uprn: address.uprn } : {}),
            address,
            operators: [],
            areaCoverage: coverage,
            checkedAt: new Date().toISOString(),
            sources: [`ofcom:${coverage.file ?? 'dataset'}`],
          };
        }
      }

      throw new Error(
        `No Ofcom coverage row for ${
          [meta.constituency, meta.localAuthority].filter(Boolean).join(' or ') || address.postcode
        } in ${dataset.path}.`,
      );
    },
  };
}

/** Test hook. */
export function resetDataset(): void {
  index = null;
}
