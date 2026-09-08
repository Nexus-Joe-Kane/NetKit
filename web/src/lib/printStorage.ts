import { DEFAULT_SECTIONS, PRINT_SECTIONS, type PrintSection } from '@sw/shared';

/**
 * Remembers the last print selection, per browser.
 *
 * Whoever prints these prints the same shape every time, and re-ticking six
 * boxes on every job would be its own small tax. Browser storage only: it is
 * a personal preference, not something to sync or to keep server-side.
 */

const STORAGE_KEY = 'netkit.print.sections';

export function loadSections(): Set<PrintSection> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set(DEFAULT_SECTIONS);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set(DEFAULT_SECTIONS);
    const valid = parsed.filter((v): v is PrintSection => PRINT_SECTIONS.some((s) => s.id === v));
    // An empty stored selection would print a blank page; treat it as unset.
    return valid.length ? new Set(valid) : new Set(DEFAULT_SECTIONS);
  } catch {
    // Private browsing, cleared storage, or storage disabled entirely.
    return new Set(DEFAULT_SECTIONS);
  }
}

export function saveSections(sections: Set<PrintSection>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...sections]));
  } catch {
    // Not worth surfacing: the print still works, it just will not be
    // remembered next time.
  }
}
