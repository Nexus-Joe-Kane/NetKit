/**
 * What should stop somebody mid-call.
 *
 * The register is full of facts and only a handful of them change what an
 * operator does. A company proposed for strike off in the Gazette, one whose
 * accounts are late, one in liquidation: those are the ones that mean "do not
 * take this order until a person has looked". Everything else is context.
 *
 * One function, used in three places — the banner above the list, the row in
 * the list, and the warning on the company's own panel — because three
 * separate judgements about the same company is how a screen ends up
 * contradicting itself.
 */

export type CompanyRiskSeverity = 'critical' | 'warning';

export interface CompanyRiskFlag {
  /** Stable key, so the UI can group and dedupe without matching on prose. */
  kind:
    | 'strike-off'
    | 'insolvent'
    | 'closed'
    | 'accounts-overdue'
    | 'confirmation-overdue'
    | 'insolvency-history'
    | 'office-disputed';
  /** Short label for a chip or a list. */
  label: string;
  /** A sentence saying why it matters. */
  detail?: string;
  severity: CompanyRiskSeverity;
}

/** The shape both the list record and the full detail record satisfy. */
export interface CompanyRiskInput {
  status?: string;
  statusDetail?: string;
  dissolvedOn?: string;
  accountsOverdue?: boolean;
  accountsNextDue?: string;
  confirmationStatementOverdue?: boolean;
  confirmationStatementNextDue?: string;
  insolvencyHistory?: boolean;
  registeredOfficeInDispute?: boolean;
  /** True when a Gazette strike-off notice has been filed. */
  strikeOffProposed?: boolean;
}

/**
 * Statuses that mean the company is finished.
 *
 * Distinct from "concerning": a company in liquidation is very much still
 * there and is the most important row on the panel, whereas a company
 * dissolved in 2019 is history. Only the second kind gets hidden by default.
 */
const CLOSED = ['dissolved', 'converted-closed', 'closed', 'removed'];

/** Statuses that mean an insolvency process is actually running. */
const INSOLVENT = [
  'liquidation',
  'receivership',
  'administration',
  'voluntary-arrangement',
  'insolvency-proceedings',
];

const has = (list: string[], status?: string): boolean => {
  const s = (status ?? '').toLowerCase();
  return s !== '' && list.some((entry) => s.includes(entry));
};

/** True for a company that has ceased to exist. */
export const isClosedStatus = (status?: string): boolean => has(CLOSED, status);

/** True while an insolvency process is running. */
export const isInsolventStatus = (status?: string): boolean => has(INSOLVENT, status);

/**
 * True when the register says a strike off has been proposed.
 *
 * Companies House express this two ways and only one of them is a status:
 * `company_status_detail` reads `active-proposal-to-strike-off`, and the
 * Gazette notice itself arrives as a `GAZ1` filing. Either is enough.
 */
export function strikeOffProposed(input: CompanyRiskInput): boolean {
  if (input.strikeOffProposed) return true;
  const detail = (input.statusDetail ?? '').toLowerCase();
  return detail.includes('strike-off') || detail.includes('strike off');
}

const formatDate = (iso?: string): string | undefined => {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};

/**
 * Everything worth warning about, worst first.
 *
 * Order matters: the first flag is what a banner leads with, and "proposed
 * for strike off" outranks "accounts are late" because the second is often
 * the reason for the first.
 */
export function companyRiskFlags(input: CompanyRiskInput): CompanyRiskFlag[] {
  const flags: CompanyRiskFlag[] = [];

  if (strikeOffProposed(input)) {
    flags.push({
      kind: 'strike-off',
      label: 'Proposed for strike off',
      detail:
        'A notice has been published in the Gazette. Unless it is challenged the company will be struck off ' +
        'and dissolved, and any contract signed with it now may be unenforceable.',
      severity: 'critical',
    });
  }

  if (isInsolventStatus(input.status)) {
    flags.push({
      kind: 'insolvent',
      label: 'Insolvency process running',
      detail:
        'An insolvency practitioner is in control, not the directors. A cease, an order or a credit decision ' +
        'needs to go through them.',
      severity: 'critical',
    });
  }

  if (isClosedStatus(input.status)) {
    const on = formatDate(input.dissolvedOn);
    flags.push({
      kind: 'closed',
      label: on ? `Closed ${on}` : 'Closed',
      detail: 'The company no longer exists. Anybody still trading under the name is doing so as somebody else.',
      severity: 'critical',
    });
  }

  if (input.accountsOverdue) {
    const due = formatDate(input.accountsNextDue);
    flags.push({
      kind: 'accounts-overdue',
      label: 'Accounts overdue',
      detail: due
        ? `Annual accounts were due ${due} and have not been filed. Late accounts are the usual first step ` +
          'towards a compulsory strike off.'
        : 'Annual accounts are late. Late accounts are the usual first step towards a compulsory strike off.',
      severity: 'critical',
    });
  }

  if (input.confirmationStatementOverdue) {
    const due = formatDate(input.confirmationStatementNextDue);
    flags.push({
      kind: 'confirmation-overdue',
      label: 'Confirmation statement overdue',
      detail: due
        ? `The annual confirmation statement was due ${due}. Nobody has confirmed who runs the company.`
        : 'The annual confirmation statement is late. Nobody has confirmed who runs the company.',
      severity: 'warning',
    });
  }

  // Only worth saying while the company is otherwise trading — on a company
  // already in liquidation it is not news.
  if (input.insolvencyHistory && !isInsolventStatus(input.status) && !isClosedStatus(input.status)) {
    flags.push({
      kind: 'insolvency-history',
      label: 'Previous insolvency',
      detail: 'The company has been through an insolvency process before and is trading now.',
      severity: 'warning',
    });
  }

  if (input.registeredOfficeInDispute) {
    flags.push({
      kind: 'office-disputed',
      label: 'Registered office disputed',
      detail: 'Somebody has told Companies House this company does not trade from this address.',
      severity: 'warning',
    });
  }

  return flags;
}

/** True when anything on the record is worth a red banner. */
export const hasCriticalRisk = (input: CompanyRiskInput): boolean =>
  companyRiskFlags(input).some((f) => f.severity === 'critical');

/**
 * One sentence naming what is wrong across several companies.
 *
 * Used for the banner over the list, which has to say what the problem is
 * before it says whose problem it is.
 */
export function summariseRisks(flags: CompanyRiskFlag[]): string {
  const seen = new Map<string, string>();
  for (const flag of flags) if (!seen.has(flag.kind)) seen.set(flag.kind, flag.label.toLowerCase());
  const labels = [...seen.values()];
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0]!;
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}
