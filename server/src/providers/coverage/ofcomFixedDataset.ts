import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { AddressRecord, PredictedSpeeds } from '@sw/shared';
import { config } from '../../config';

/**
 * Ofcom's fixed broadband coverage file, as a failover for their API.
 *
 * Unlike mobile, Ofcom *do* publish this per postcode -- the Connected
 * Nations "fixed postcode" release -- so the failover is a real per-postcode
 * answer rather than an area average. It is still a snapshot months old and
 * still a prediction rather than a wholesale check, which is why every figure
 * it produces is stamped `basis: 'dataset'` with the release, and the UI says
 * so in amber.
 *
 * Used only when the live API has no key or does not answer. When both are
 * available the API wins: it is the same publisher, more recent.
 *
 * The header is read rather than assumed. Ofcom rename these columns between
 * releases -- "SFBB availability (% premises)" has also been
 * "% of premises with SFBB availability" -- so matching is on the words that
 * carry the meaning, and a column that cannot be understood is left out
 * instead of guessed at.
 */

interface Row {
  premises?: number;
  maxDownMbps?: number;
  maxUpMbps?: number;
  medianDownMbps?: number;
  superfastPercent?: number;
  ultrafastPercent?: number;
  gigabitPercent?: number;
  fttpPercent?: number;
  belowUsoPercent?: number;
}

interface FixedIndex {
  byPostcode: Map<string, Row>;
  path: string;
  files: string[];
  release?: string;
  loadedAt: string;
  columnsUnderstood: number;
  mtimeMs: number;
}

let index: FixedIndex | null = null;

const normalisePostcode = (raw: string): string => raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

/** Splits a CSV line, honouring quoted fields. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
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

const num = (raw?: string): number | undefined => {
  const v = Number.parseFloat((raw ?? '').replace(/[,%\s]/g, ''));
  return Number.isFinite(v) ? v : undefined;
};

interface HeaderMap {
  postcode: number;
  premises: number;
  maxDown: number;
  maxUp: number;
  medianDown: number;
  superfast: number;
  ultrafast: number;
  gigabit: number;
  fttp: number;
  belowUso: number;
}

const words = (header: string): string => header.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Works out which column is which.
 *
 * Order matters in two places. A "maximum download" column has to be tested
 * before a plain "download" one or the maximum is read as the median, and
 * "upload" before "download" is wrong for the same reason in reverse -- so
 * each field is matched on its own distinguishing words rather than by
 * scanning for a shared one.
 */
export function mapFixedHeader(headers: string[]): HeaderMap {
  const map: HeaderMap = {
    postcode: -1,
    premises: -1,
    maxDown: -1,
    maxUp: -1,
    medianDown: -1,
    superfast: -1,
    ultrafast: -1,
    gigabit: -1,
    fttp: -1,
    belowUso: -1,
  };

  headers.forEach((raw, i) => {
    const h = words(raw);
    const has = (...needles: string[]): boolean => needles.every((n) => h.includes(n));

    // `postcode_space` is Ofcom's formatted variant and is preferred, but
    // either normalises to the same key.
    if (map.postcode < 0 && (h === 'postcode' || h === 'postcode space' || h === 'pcds' || h === 'pcd')) {
      map.postcode = i;
      return;
    }
    if (map.premises < 0 && has('all', 'premises') && !h.includes('matched')) {
      map.premises = i;
      return;
    }
    if (map.maxDown < 0 && (has('maximum', 'download') || has('max', 'download'))) {
      map.maxDown = i;
      return;
    }
    if (map.maxUp < 0 && (has('maximum', 'upload') || has('max', 'upload'))) {
      map.maxUp = i;
      return;
    }
    if (map.medianDown < 0 && (has('median', 'download') || has('average', 'download'))) {
      map.medianDown = i;
      return;
    }
    if (map.superfast < 0 && (h.includes('sfbb') || h.includes('superfast'))) {
      map.superfast = i;
      return;
    }
    // Ultrafast before gigabit: the labels overlap in some releases and
    // ultrafast is the broader tier.
    if (map.ultrafast < 0 && (h.includes('ufbb') || h.includes('ultrafast'))) {
      map.ultrafast = i;
      return;
    }
    if (map.gigabit < 0 && h.includes('gigabit')) {
      map.gigabit = i;
      return;
    }
    if (map.fttp < 0 && (h.includes('fttp') || has('full', 'fibre'))) {
      map.fttp = i;
      return;
    }
    // The universal service obligation is 10 Mb. Ofcom word this as
    // "% of premises unable to receive 10Mbit/s".
    if (map.belowUso < 0 && h.includes('unable to receive')) {
      map.belowUso = i;
    }
  });

  return map;
}

const understood = (map: HeaderMap): number =>
  Object.values(map).filter((v) => typeof v === 'number' && v >= 0).length;

/** The release, from the file name: `Fixed-postcode-202507.csv` is July 2025. */
function releaseOf(file: string): string | undefined {
  const m = /(20\d{2})[-_]?(0[1-9]|1[0-2])/.exec(basename(file));
  return m ? `${m[1]}-${m[2]}` : undefined;
}

function datasetFiles(absolute: string): string[] {
  if (!statSync(absolute).isDirectory()) return [absolute];
  return readdirSync(absolute)
    .filter((f) => f.toLowerCase().endsWith('.csv'))
    .sort()
    .map((f) => join(absolute, f));
}

/** Loads and indexes the fixed dataset, reloading when the file changes. */
export function loadFixedDataset(force = false): FixedIndex | null {
  const path = config().ofcomBroadband.datasetPath;
  if (!path) return null;

  const absolute = resolve(path);
  if (!existsSync(absolute)) return null;

  const { mtimeMs } = statSync(absolute);
  if (!force && index && index.path === absolute && index.mtimeMs === mtimeMs) return index;

  const byPostcode = new Map<string, Row>();
  const files: string[] = [];
  let columnsUnderstood = 0;
  let release: string | undefined;

  for (const file of datasetFiles(absolute)) {
    const text = readFileSync(file, 'utf8').replace(/^﻿/, '');
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
    if (lines.length < 2) continue;

    const map = mapFixedHeader(splitCsvLine(lines[0]!));
    // A file with no postcode column is not the fixed postcode release --
    // most likely a local-authority summary from the same zip. Skipped rather
    // than indexed under something meaningless.
    if (map.postcode < 0) continue;

    files.push(basename(file));
    columnsUnderstood = Math.max(columnsUnderstood, understood(map));
    release = release ?? releaseOf(file);

    for (let i = 1; i < lines.length; i += 1) {
      const cells = splitCsvLine(lines[i]!);
      const postcode = normalisePostcode(cells[map.postcode] ?? '');
      if (!postcode) continue;

      const at = (idx: number): number | undefined => (idx >= 0 ? num(cells[idx]) : undefined);
      const row: Row = {
        ...(at(map.premises) !== undefined ? { premises: at(map.premises)! } : {}),
        ...(at(map.maxDown) !== undefined ? { maxDownMbps: at(map.maxDown)! } : {}),
        ...(at(map.maxUp) !== undefined ? { maxUpMbps: at(map.maxUp)! } : {}),
        ...(at(map.medianDown) !== undefined ? { medianDownMbps: at(map.medianDown)! } : {}),
        ...(at(map.superfast) !== undefined ? { superfastPercent: at(map.superfast)! } : {}),
        ...(at(map.ultrafast) !== undefined ? { ultrafastPercent: at(map.ultrafast)! } : {}),
        ...(at(map.gigabit) !== undefined ? { gigabitPercent: at(map.gigabit)! } : {}),
        ...(at(map.fttp) !== undefined ? { fttpPercent: at(map.fttp)! } : {}),
        ...(at(map.belowUso) !== undefined ? { belowUsoPercent: at(map.belowUso)! } : {}),
      };
      if (Object.keys(row).length) byPostcode.set(postcode, row);
    }
  }

  if (byPostcode.size === 0) return null;

  index = {
    byPostcode,
    path: absolute,
    files,
    ...(release ? { release } : {}),
    loadedAt: new Date().toISOString(),
    columnsUnderstood,
    mtimeMs,
  };
  return index;
}

export const fixedDatasetConfigured = (): boolean => Boolean(config().ofcomBroadband.datasetPath);

/**
 * Predicted speeds for a postcode, from the file.
 *
 * `premisesMatched` is always false: this is a postcode row, so it describes
 * the postcode and not the doorstep, and claiming otherwise is the one thing
 * this must never do.
 */
export function predictedFromDataset(address: AddressRecord): PredictedSpeeds | null {
  const dataset = loadFixedDataset();
  if (!dataset) return null;

  const row = dataset.byPostcode.get(normalisePostcode(address.postcode));
  if (!row) return null;

  return {
    ...(row.maxDownMbps !== undefined ? { maxDownMbps: row.maxDownMbps } : {}),
    ...(row.maxUpMbps !== undefined ? { maxUpMbps: row.maxUpMbps } : {}),
    ...(row.superfastPercent !== undefined ? { superfastPercent: row.superfastPercent } : {}),
    ...(row.ultrafastPercent !== undefined ? { ultrafastPercent: row.ultrafastPercent } : {}),
    ...(row.gigabitPercent !== undefined ? { gigabitPercent: row.gigabitPercent } : {}),
    ...(row.fttpPercent !== undefined ? { fttpPercent: row.fttpPercent } : {}),
    ...(row.belowUsoPercent !== undefined ? { belowUsoPercent: row.belowUsoPercent } : {}),
    premisesMatched: false,
    ...(row.premises !== undefined ? { premisesInPostcode: row.premises } : {}),
    basis: 'dataset',
    ...(dataset.release ? { release: dataset.release } : {}),
    source: `ofcom:${dataset.files[0] ?? 'fixed-dataset'}`,
  };
}

/** Dataset state, for the admin status board. */
export function fixedDatasetStatus(): {
  configured: boolean;
  loaded: boolean;
  path?: string;
  postcodes?: number;
  columnsUnderstood?: number;
  release?: string;
  loadedAt?: string;
} {
  const path = config().ofcomBroadband.datasetPath;
  if (!path) return { configured: false, loaded: false };
  const dataset = loadFixedDataset();
  if (!dataset) return { configured: true, loaded: false, path };
  return {
    configured: true,
    loaded: true,
    path: dataset.path,
    postcodes: dataset.byPostcode.size,
    columnsUnderstood: dataset.columnsUnderstood,
    ...(dataset.release ? { release: dataset.release } : {}),
    loadedAt: dataset.loadedAt,
  };
}

/** Test hook. */
export function resetFixedDataset(): void {
  index = null;
}
