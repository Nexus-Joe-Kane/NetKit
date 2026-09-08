import { useEffect, useState, type ReactElement } from 'react';
import {
  DEFAULT_SIM_SECTIONS,
  SIM_REPORT_SECTIONS,
  availableSimSections,
  rollupByClient,
  type SimEstate,
  type SimReportSection,
  type SimReportSectionDef,
} from '@sw/shared';
import { Alert, Chip, Label } from './ui';
import { Modal } from './overlay';

/**
 * Build an estate report, then print it.
 *
 * Same shape as the site report's picker, for the same reason: one report
 * cannot serve a bill query, a client review and an engineer chasing an
 * offline backup SIM. Tick what the report is for.
 *
 * A section with no data behind it is shown greyed rather than removed —
 * "the provider publishes no cost" is worth seeing before somebody promises
 * a client a cost breakdown.
 *
 * Nothing here calls the provider. The report is built from the estate
 * already on screen, so producing one costs no requests however many times
 * it is run.
 */

const GROUP_ORDER: Array<SimReportSectionDef['group']> = ['Overview', 'The estate', 'Money', 'Needs attention'];

const STORAGE_KEY = 'netkit.simReport.sections';

function loadChosen(): Set<SimReportSection> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set(DEFAULT_SIM_SECTIONS);
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set(DEFAULT_SIM_SECTIONS);
    const valid = parsed.filter((id): id is SimReportSection =>
      SIM_REPORT_SECTIONS.some((s) => s.id === id),
    );
    // An empty stored set is a deliberate "nothing", but a corrupt one is
    // not — so only a well-formed empty array survives.
    return new Set(valid);
  } catch {
    return new Set(DEFAULT_SIM_SECTIONS);
  }
}

function saveChosen(sections: Set<SimReportSection>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...sections]));
  } catch {
    // A refused write costs the next report its remembered ticks and nothing
    // more. Not worth failing over.
  }
}

export function SimReportDialog({
  estate,
  open,
  onClose,
  onApply,
  title,
  onTitleChange,
  clientFilter,
  onClientFilterChange,
}: {
  estate: SimEstate;
  open: boolean;
  onClose: () => void;
  onApply: (sections: Set<SimReportSection>) => void;
  /** The report's heading, so it can be a client's name. */
  title: string;
  onTitleChange: (next: string) => void;
  /** Limits the report to one client, or '' for the whole estate. */
  clientFilter: string;
  onClientFilterChange: (next: string) => void;
}): ReactElement {
  const available = availableSimSections(estate);
  const [chosen, setChosen] = useState<Set<SimReportSection>>(() => loadChosen());

  useEffect(() => {
    if (open) setChosen(loadChosen());
  }, [open]);

  const toggle = (id: SimReportSection): void => {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const effective = [...chosen].filter((id) => available.has(id));
  const clients = rollupByClient(estate.sims).map((r) => r.clientName);

  const print = (): void => {
    saveChosen(chosen);
    onApply(new Set(effective));
    onClose();
    // The browser dialog is modal and synchronous, so React has to commit the
    // selection first.
    requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
  };

  const setAll = (value: boolean): void => setChosen(value ? new Set(available) : new Set());

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="Mobile estate"
      title="Build a report"
      subtitle={`${effective.length} of ${available.size} available ${
        available.size === 1 ? 'section' : 'sections'
      } — the layout adapts to how many you pick`}
      width="wide"
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

        <div className="two-col">
          <label className="field">
            <Label>Report title</Label>
            <input
              className="field__input"
              value={title}
              onChange={(e) => onTitleChange(e.target.value)}
              placeholder="Mobile estate"
            />
            <span className="field__hint">Goes at the top of the page. A client's name if it is for them.</span>
          </label>

          <label className="field">
            <Label>Limit to one client</Label>
            <select
              className="field__input"
              value={clientFilter}
              onChange={(e) => onClientFilterChange(e.target.value)}
            >
              <option value="">The whole estate</option>
              {clients.map((client) => (
                <option key={client} value={client}>
                  {client}
                </option>
              ))}
            </select>
            <span className="field__hint">
              A client-facing report should not carry another client's SIMs. Picking one filters every section.
            </span>
          </label>
        </div>

        {GROUP_ORDER.map((group) => {
          const sections = SIM_REPORT_SECTIONS.filter((s) => s.group === group);
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
                            <Chip tone="idle" title="This estate has no data for it">
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
      </div>
    </Modal>
  );
}
