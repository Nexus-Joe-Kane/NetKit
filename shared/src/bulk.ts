/**
 * Many premises at once.
 *
 * The per-premises report is the right tool for one site and useless for a
 * bid across forty: nobody is pasting forty postcodes into a search box one
 * at a time. This is the same data, one row per input, exportable.
 *
 * Deliberately a summary rather than a full report. A bulk run is asking
 * "which of these can I sell FTTP to", and the answer is a technology, a
 * speed and whether anything is orderable. Anyone who needs the detail for
 * one row opens that premises properly.
 */

export type BulkRowStatus =
  /** Resolved and checked. */
  | 'ok'
  /** Nothing matched the input. */
  | 'not_found'
  /** Not attempted: the day's fair-use budget ran out first. */
  | 'skipped'
  /** Attempted and the provider failed. */
  | 'error';

export interface BulkRow {
  /** Exactly what was typed, so a row can be matched back to the source list. */
  input: string;
  /** How the input was read: postcode, uprn, address, cli, and so on. */
  kind: string;
  status: BulkRowStatus;

  uprn?: string;
  address?: string;
  postcode?: string;

  /** Best orderable technology, or the best available if none is orderable. */
  bestTechnology?: string;
  bestOperator?: string;
  downMbps?: number;
  upMbps?: number;
  /** How many options can actually be ordered today. */
  orderableCount?: number;
  /** How many options were returned at all, orderable or not. */
  optionCount?: number;
  /** Lines already in place at the premises. */
  lineCount?: number;

  /**
   * Anything the row needs qualified — an ambiguous address, a postcode
   * where one premises of many was checked, or why it failed.
   */
  note?: string;
}

export interface BulkResult {
  rows: BulkRow[];
  /** Unique inputs accepted after trimming and de-duplication. */
  requested: number;
  /** How many were actually checked. */
  completed: number;
  /** How many were not attempted because the budget ran out. */
  skippedForBudget: number;
  quota: { used: number; limit: number; remaining: number };
  startedAt: string;
  durationMs: number;
}

/** The most inputs one run will accept. */
export const BULK_MAX_ENTRIES = 100;

/**
 * Splits pasted text into inputs.
 *
 * People paste columns out of a spreadsheet, so newlines are the primary
 * separator, but commas and semicolons are accepted too -- and a postcode
 * has a space in it, which is why whitespace alone is not a separator.
 */
export function parseBulkInput(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of text.split(/[\n\r;,\t]+/)) {
    const entry = raw.trim();
    if (!entry) continue;
    // De-duplicated case-insensitively: the same postcode twice is one
    // lookup, and charging the budget twice for it would be wrong.
    const key = entry.toUpperCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }

  return out;
}
