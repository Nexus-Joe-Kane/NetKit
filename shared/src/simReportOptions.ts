import type { SimEstate, SimRecord } from './operations';

/**
 * What goes on a mobile estate report.
 *
 * Same discipline as the site report's print picker, and for the same reason:
 * one report cannot serve a bill query, a client review and an engineer
 * chasing an offline 5G backup. So it is a choice, and a section with no data
 * behind it is offered as unavailable rather than hidden — "the provider
 * gives us no cost" is itself worth knowing before somebody promises a client
 * a cost breakdown.
 */

export type SimReportSection =
  | 'summary'
  | 'clients'
  | 'sims'
  | 'usage'
  | 'cost'
  | 'overage'
  | 'barred'
  | 'suspended'
  | 'offline'
  | 'unassigned';

export interface SimReportSectionDef {
  id: SimReportSection;
  label: string;
  /** One line on what it puts on the page. */
  hint: string;
  group: 'Overview' | 'The estate' | 'Money' | 'Needs attention';
}

export const SIM_REPORT_SECTIONS: readonly SimReportSectionDef[] = [
  { id: 'summary', label: 'Summary', hint: 'Totals: SIMs, active, offline, over allowance', group: 'Overview' },
  { id: 'clients', label: 'By client', hint: 'One row per client with their SIM count and data use', group: 'Overview' },
  { id: 'sims', label: 'Every SIM', hint: 'The full table: number, ICCID, client, site, state, network', group: 'The estate' },
  { id: 'usage', label: 'Data used', hint: 'Used against allowance and the percentage, per SIM', group: 'The estate' },
  { id: 'cost', label: 'Cost', hint: 'Tariff and monthly cost, where the provider publishes it', group: 'Money' },
  { id: 'overage', label: 'Near or over allowance', hint: 'SIMs at 90% or more — the ones that cost money', group: 'Needs attention' },
  { id: 'barred', label: 'Barred', hint: 'Live SIMs with a restriction on them', group: 'Needs attention' },
  { id: 'suspended', label: 'Suspended and ceased', hint: 'SIMs no longer passing traffic', group: 'Needs attention' },
  { id: 'offline', label: 'Offline', hint: 'Active SIMs not attached to the network', group: 'Needs attention' },
  {
    id: 'unassigned',
    label: 'Not assigned to a client',
    hint: 'SIMs with no client on the provider record — usually stock',
    group: 'Needs attention',
  },
] as const;

/** Used against allowance including any bolt-on, as a percentage. */
export function simUsedPercent(sim: SimRecord): number | undefined {
  const allowance = sim.allowanceBytes == null ? undefined : sim.allowanceBytes + (sim.boltOnBytes ?? 0);
  if (allowance == null || allowance <= 0 || sim.usedBytes == null) return undefined;
  return Math.round((sim.usedBytes / allowance) * 100);
}

/**
 * Which sections this estate can actually fill.
 *
 * A tick that prints nothing is the fault this whole picker exists to avoid,
 * so every section is tested against the data rather than against whether the
 * integration is connected.
 */
export function availableSimSections(estate: SimEstate): Set<SimReportSection> {
  const sims = estate.sims;
  const out = new Set<SimReportSection>(['summary', 'sims']);

  if (sims.some((s) => s.clientName)) out.add('clients');
  if (sims.some((s) => s.usedBytes != null)) out.add('usage');
  if (sims.some((s) => s.monthlyCostPence != null || s.tariff)) out.add('cost');
  if (sims.some((s) => (simUsedPercent(s) ?? 0) >= 90)) out.add('overage');
  if (sims.some((s) => (s.bars?.length ?? 0) > 0 && s.state !== 'ceased')) out.add('barred');
  if (sims.some((s) => s.state === 'suspended' || s.state === 'ceased')) out.add('suspended');
  if (sims.some((s) => s.attached === false && s.state === 'active')) out.add('offline');
  if (sims.some((s) => !s.clientName)) out.add('unassigned');

  return out;
}

/**
 * What a report opens with.
 *
 * The whole estate and the money, because that is the common ask. The
 * attention groups are off by default: they are the interesting pages and
 * they are also the ones that make a client-facing report read as a telling
 * off, so they get ticked on purpose rather than by accident.
 */
export const DEFAULT_SIM_SECTIONS: readonly SimReportSection[] = ['summary', 'clients', 'sims', 'usage', 'cost'];

/** One client's slice of the estate, for the "by client" page. */
export interface ClientRollup {
  clientName: string;
  simCount: number;
  activeCount: number;
  usedBytes?: number;
  allowanceBytes?: number;
  monthlyCostPence?: number;
  /** Sites seen under this client, so a report can say where they are. */
  sites: string[];
}

/**
 * Groups the estate by client, heaviest data use first.
 *
 * Sums are only produced from SIMs that actually carried a figure, and a
 * client whose SIMs carried none gets `undefined` rather than nought — a
 * zero next to a client's name reads as "they used nothing", which is a very
 * different claim from "the provider did not tell us".
 */
export function rollupByClient(sims: SimRecord[]): ClientRollup[] {
  const groups = new Map<string, SimRecord[]>();
  for (const sim of sims) {
    const key = sim.clientName ?? 'Not assigned';
    const list = groups.get(key);
    if (list) list.push(sim);
    else groups.set(key, [sim]);
  }

  const sum = (list: SimRecord[], pick: (s: SimRecord) => number | undefined): number | undefined => {
    const values = list.map(pick).filter((v): v is number => v != null);
    return values.length ? values.reduce((a, b) => a + b, 0) : undefined;
  };

  return [...groups.entries()]
    .map(([clientName, list]) => ({
      clientName,
      simCount: list.length,
      activeCount: list.filter((s) => s.state === 'active').length,
      ...(sum(list, (s) => s.usedBytes) != null ? { usedBytes: sum(list, (s) => s.usedBytes)! } : {}),
      ...(sum(list, (s) => (s.allowanceBytes == null ? undefined : s.allowanceBytes + (s.boltOnBytes ?? 0))) != null
        ? {
            allowanceBytes: sum(list, (s) =>
              s.allowanceBytes == null ? undefined : s.allowanceBytes + (s.boltOnBytes ?? 0),
            )!,
          }
        : {}),
      ...(sum(list, (s) => s.monthlyCostPence) != null
        ? { monthlyCostPence: sum(list, (s) => s.monthlyCostPence)! }
        : {}),
      sites: [...new Set(list.map((s) => s.site).filter((v): v is string => Boolean(v)))].sort(),
    }))
    .sort((a, b) => (b.usedBytes ?? 0) - (a.usedBytes ?? 0) || b.simCount - a.simCount);
}

/** Pounds and pence from a pence figure, for a report line. */
export const formatPence = (pence?: number): string | undefined =>
  pence == null ? undefined : `£${(pence / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
