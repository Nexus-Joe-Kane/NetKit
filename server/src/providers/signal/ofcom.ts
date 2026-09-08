import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { gradeFromOfcom, type MobileOperator, type SignalGrade, type SignalReport } from '@sw/shared';
import { config } from '../../config';
import { fetchJson } from '../../lib/http';
import type { SignalProvider } from '../types';

/**
 * Ofcom mobile coverage.
 *
 * Ofcom publish predicted coverage per operator as **Connected Nations open
 * data** — a postcode-level file, refreshed periodically, free and with no
 * account. That file is the source this reads: point `OFCOM_DATASET_PATH` at
 * it and the coverage panel stops being modelled and starts being Ofcom's
 * published prediction.
 *
 * Column names in that file have changed between releases, so rather than
 * hard-coding them the header is *interpreted*: each column is matched for an
 * operator, a service and indoor/outdoor, and anything unrecognised is
 * ignored. A new release with renamed columns therefore keeps working.
 *
 * `OFCOM_API_BASE_URL` is an optional override for accounts that have a live
 * endpoint; the dataset is the dependable route.
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

/** Reads a header row and works out what each column means. */
export function interpretHeader(headers: string[]): { postcodeIndex: number; columns: ColumnMeaning[] } {
  let postcodeIndex = -1;
  const columns: ColumnMeaning[] = [];

  headers.forEach((raw, index) => {
    const header = raw.trim().replace(/^"|"$/g, '');

    const tokens = tokenise(header);
    if (postcodeIndex < 0 && (tokens.join('') === 'POSTCODE' || ['PCD', 'PCDS'].includes(tokens[0] ?? ''))) {
      postcodeIndex = index;
      return;
    }

    const operator = operatorFrom(header);
    const service = serviceFrom(header);
    const placement = placementFrom(header);
    if (operator && service && placement) columns.push({ index, operator, service, placement });
  });

  // Some releases label the first column something else entirely.
  if (postcodeIndex < 0) {
    const guess = headers.findIndex((h) => /postcode/i.test(h));
    postcodeIndex = guess >= 0 ? guess : 0;
  }

  return { postcodeIndex, columns };
}

/* ------------------------------------------------------------------ *
 * Dataset index
 * ------------------------------------------------------------------ */

interface CoverageRow {
  [operator: string]: Partial<Record<`${Service}_${Placement}`, SignalGrade>>;
}

interface DatasetIndex {
  byPostcode: Map<string, CoverageRow>;
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
export function loadDataset(force = false): DatasetIndex | null {
  const path = config().ofcom.datasetPath;
  if (!path) return null;

  const absolute = resolve(path);
  if (!existsSync(absolute)) return null;

  const { mtimeMs } = statSync(absolute);
  if (!force && index && index.path === absolute && index.mtimeMs === mtimeMs) return index;

  const text = readFileSync(absolute, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return null;

  const { postcodeIndex, columns } = interpretHeader(splitCsvLine(lines[0]!));
  const byPostcode = new Map<string, CoverageRow>();

  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]!);
    const postcode = normalisePostcode(cells[postcodeIndex] ?? '');
    if (!postcode) continue;

    const row: CoverageRow = {};
    for (const column of columns) {
      const grade = gradeFromOfcom(cells[column.index]);
      if (grade === 'unknown') continue;
      (row[column.operator] ??= {})[`${column.service}_${column.placement}`] = grade;
    }
    if (Object.keys(row).length) byPostcode.set(postcode, row);
  }

  index = {
    byPostcode,
    path: absolute,
    loadedAt: new Date().toISOString(),
    rows: byPostcode.size,
    columnsUnderstood: columns.length,
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

function buildReport(address: SignalReport['address'], row: CoverageRow, source: string): SignalReport {
  const operators = OPERATORS.filter((operator) => row[operator]).map((operator) => {
    const cells = row[operator]!;
    const grade = (key: `${Service}_${Placement}`): SignalGrade => cells[key] ?? 'unknown';
    const has5g = cells.data5g_outdoor !== undefined || cells.data5g_indoor !== undefined;

    const notes: string[] = [
      'Ofcom predicted coverage, not a measurement — local obstructions are not modelled.',
    ];
    if (!has5g) notes.push('No 5G prediction published for this operator at this postcode.');

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
          'Ofcom coverage is not available: set OFCOM_DATASET_PATH to a Connected Nations postcode file, or OFCOM_API_BASE_URL.',
        );
      }

      const row = dataset.byPostcode.get(normalisePostcode(address.postcode));
      if (!row) {
        throw new Error(`No Ofcom coverage row for ${address.postcode} in ${dataset.path}.`);
      }
      return buildReport(address, row, 'ofcom:dataset');
    },
  };
}

/** Test hook. */
export function resetDataset(): void {
  index = null;
}
