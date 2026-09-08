/**
 * CSV export.
 *
 * Every table in NetKit answers a question, and some of those answers end up
 * in a spreadsheet — a WIP report chased in a Monday meeting, a fault list
 * pasted into a customer update, twelve months of call records reconciled
 * against a bill. Retyping them is the alternative, so each table offers both
 * a download and a copy: download for a spreadsheet, copy for a ticket or a
 * chat window where a file attachment is more friction than it is worth.
 */

export interface CsvColumn<T> {
  header: string;
  /** Anything falsy other than `0` and `false` becomes an empty cell. */
  value: (row: T) => string | number | boolean | undefined | null;
}

/**
 * Quotes a field for RFC 4180.
 *
 * The leading-character guard is the important bit: a value starting with
 * `=`, `+`, `-` or `@` is executed as a formula by Excel and Sheets, so an
 * address like `-- Flat 3` or a note someone typed with a leading `=` becomes
 * a live cell. Prefixing a tab neutralises it while still reading correctly.
 */
function field(value: string | number | boolean | undefined | null): string {
  if (value === undefined || value === null) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `\t${text}`;
  if (/[",\n\r\t]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv<T>(rows: T[], columns: Array<CsvColumn<T>>): string {
  const lines = [columns.map((c) => field(c.header)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => field(c.value(row))).join(','));
  // CRLF, because that is what the format says and what Excel expects.
  return `${lines.join('\r\n')}\r\n`;
}

/** `orders-2026-09-08.csv` — dated, so two exports never collide. */
export function csvFilename(prefix: string): string {
  return `${prefix}-${new Date().toISOString().slice(0, 10)}.csv`;
}
