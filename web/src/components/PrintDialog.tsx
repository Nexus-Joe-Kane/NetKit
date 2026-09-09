import { useEffect, useState, type ReactElement } from 'react';
import type { SiteReport } from '@sw/shared';
import { PRINT_SECTIONS, availableSections, type PrintSection, type PrintSectionDef } from '@sw/shared';
import { Alert, Chip, Label } from './ui';
import { Modal } from './overlay';
import { loadSections, saveSections } from '../lib/printStorage';

/**
 * Choose what goes on the page, then print it.
 *
 * Printing was all-or-nothing, which suits neither of the two things people
 * print for. A quote wants the address and what can be sold there and
 * nothing about the neighbours; an engineer's job sheet wants the line and
 * the way in. Same report, different pages.
 *
 * Sections the report has no data for are shown greyed rather than removed,
 * because "no mobile coverage was returned for this premises" is worth
 * knowing before you hand the sheet over.
 */

const GROUP_ORDER: Array<PrintSectionDef['group']> = ['Premises', 'Broadband', 'Mobile', 'Lines'];

export function PrintDialog({
  report,
  open,
  onClose,
  onApply,
  onNotes,
}: {
  report: SiteReport;
  open: boolean;
  onClose: () => void;
  /** Called with the chosen sections just before the print dialog opens. */
  onApply: (sections: Set<PrintSection>) => void;
  /** Called with what the engineer typed, or an empty string for none. */
  onNotes?: (notes: string) => void;
}): ReactElement {
  const available = availableSections(report);
  const [chosen, setChosen] = useState<Set<PrintSection>>(() => loadSections());
  const [wantNotes, setWantNotes] = useState(false);
  const [notes, setNotes] = useState('');

  // Re-read on open so a change made in another tab is picked up, and so a
  // stale selection from a previous premises does not linger.
  useEffect(() => {
    if (open) setChosen(loadSections());
  }, [open]);

  const toggle = (id: PrintSection): void => {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Only what is both ticked and actually present ends up on the page.
  const effective = [...chosen].filter((id) => available.has(id));

  const print = (): void => {
    saveSections(chosen);
    onApply(new Set(effective));
    onNotes?.(wantNotes ? notes.trim() : '');
    onClose();
    // The browser dialog is modal and synchronous, so it has to wait for
    // React to commit the new selection first.
    requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
  };

  const setAll = (value: boolean): void => {
    setChosen(value ? new Set(available) : new Set());
  };

  /*
   * Notes on the document.
   *
   * Opt-in rather than always shown: most prints are a straight copy, and an
   * empty box on every one of them is a box people learn to scroll past —
   * which is exactly when the one that needed filling in gets missed.
   *
   * Deliberately absent from CSV exports. A CSV is rows for a spreadsheet,
   * and a paragraph in a cell breaks whatever it is opened in.
   */

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="Print"
      title="What goes on the page"
      subtitle={`${effective.length} of ${available.size} available ${
        available.size === 1 ? 'section' : 'sections'
      } — the layout adapts to how many you pick`}
      width="default"
      footer={
        <>
          <button type="button" className="btn btn--ghost btn--small" onClick={() => setAll(true)}>
            Everything
          </button>
          <button type="button" className="btn btn--ghost btn--small" onClick={() => setAll(false)}>
            Nothing
          </button>
          <span className="grow" />
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" onClick={print} disabled={effective.length === 0}>
            Print {effective.length > 0 ? `${effective.length} ${effective.length === 1 ? 'section' : 'sections'}` : ''}
          </button>
        </>
      }
    >
      <div className="stack stack--tight">
        {effective.length === 0 && (
          <Alert tone="warn">Nothing ticked — there would be nothing on the page but the letterhead.</Alert>
        )}

        {GROUP_ORDER.map((group) => {
          const sections = PRINT_SECTIONS.filter((s) => s.group === group);
          if (!sections.length) return null;
          return (
            <div key={group}>
              <Label>{group}</Label>
              <div className="print-picker">
                {sections.map((section) => {
                  const has = available.has(section.id);
                  return (
                    <label
                      key={section.id}
                      className={`print-picker__item${has ? '' : ' print-picker__item--empty'}`}
                    >
                      <input
                        type="checkbox"
                        checked={chosen.has(section.id)}
                        onChange={() => toggle(section.id)}
                        disabled={!has}
                      />
                      <span>
                        <span className="print-picker__label">
                          {section.label}
                          {!has && (
                            <Chip tone="idle" title="This report has no data for it">
                              nothing to print
                            </Chip>
                          )}
                        </span>
                        <span className="print-picker__hint">{section.hint}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}

        {/*
          Notes on the document.

          Opt-in rather than always shown: most prints are a straight copy,
          and an empty box on every one of them is a box people learn to
          scroll past — which is exactly when the one that needed filling in
          gets missed. Not offered on CSV exports, where a paragraph in a
          cell breaks whatever opens it.
        */}
        <div className="printnotes">
          <label className="printnotes__toggle">
            <input type="checkbox" checked={wantNotes} onChange={(e) => setWantNotes(e.target.checked)} />
            <span>Add notes to this document</span>
          </label>
          {wantNotes && (
            <>
              <textarea
                className="field__input"
                rows={4}
                value={notes}
                placeholder="What somebody reading this needs to know that the data does not say."
                onChange={(e) => setNotes(e.target.value)}
              />
              <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>
                These print on the document itself. They go on an internal note if you send it to a ticket, and
                never on a customer reply.
              </p>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
