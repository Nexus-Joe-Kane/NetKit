import { csvFilename, toCsv, type CsvColumn } from '@sw/shared';

/**
 * The browser half of CSV export. The formatting and escaping live in
 * `@sw/shared` so they can be tested; only the part that needs a DOM is here.
 */

export type { CsvColumn };
export { csvFilename, toCsv };

/**
 * Hands the browser a file.
 *
 * A blob URL rather than a data URL: data URLs are capped in some browsers,
 * and a year of call records will exceed the cap.
 */
export function downloadCsv(filename: string, contents: string): void {
  // The BOM is what makes Excel on Windows read UTF-8 rather than mangling
  // the pound signs and accented street names.
  const blob = new Blob([`﻿${contents}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Revoking immediately can cancel the download in Safari; a tick is enough.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
