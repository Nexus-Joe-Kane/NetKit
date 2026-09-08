import type {
  CompanyCharge,
  CompanyContext,
  CompanyDetail,
  CompanyFiling,
  CompanyInsolvencyCase,
  CompanyInsolvencyPractitioner,
  CompanyOfficer,
  CompanyPsc,
  CompanyRecord,
  CompanyDisqualification,
  OfficerAppointment,
} from '@sw/shared';
import { config } from '../../config';
import { fetchJson } from '../../lib/http';
import { TtlCache } from '../../lib/cache';

/**
 * Companies House.
 *
 * Free with a registration key, and the only source here that says anything
 * about the *customer* rather than the line. A business broadband fault where
 * the company went into liquidation last month is a different conversation
 * from one where it did not, and that fact is currently found by someone
 * googling mid-call.
 *
 * Auth is HTTP Basic with the API key as the username and an empty password,
 * which is unusual enough to be worth stating.
 */

interface ChAddress {
  premises?: string | null;
  address_line_1?: string | null;
  address_line_2?: string | null;
  locality?: string | null;
  region?: string | null;
  postal_code?: string | null;
}

interface ChCompany {
  company_number?: string;
  company_name?: string;
  title?: string;
  company_status?: string;
  company_type?: string;
  date_of_creation?: string;
  date_of_cessation?: string;
  registered_office_address?: ChAddress;
  address?: ChAddress;
  sic_codes?: string[];
  accounts?: { overdue?: boolean };
  confirmation_statement?: { overdue?: boolean };
  links?: { self?: string };
}

interface ChAdvancedSearch {
  items?: ChCompany[];
  hits?: number;
}

/**
 * Statuses that should stop an operator in their tracks.
 *
 * `active` and `open` are fine. Everything else on this list means the
 * company is winding up, gone, or being struck off, and an order or a credit
 * decision needs a person to look at it.
 */
const CONCERNING = [
  'liquidation',
  'receivership',
  'administration',
  'voluntary-arrangement',
  'insolvency-proceedings',
  'dissolved',
  'converted-closed',
  'closed',
  'removed',
];

const cache = new TtlCache<CompanyContext>(6 * 60 * 60 * 1000, 500);

const clean = (v?: string | null): string | undefined => {
  const s = (v ?? '').trim();
  return s === '' ? undefined : s;
};

function addressOf(a?: ChAddress): string | undefined {
  if (!a) return undefined;
  const parts = [clean(a.premises), clean(a.address_line_1), clean(a.address_line_2), clean(a.locality), clean(a.postal_code)];
  const joined = parts.filter(Boolean).join(', ');
  return joined || undefined;
}

const samePostcode = (a?: string, b?: string): boolean =>
  Boolean(a && b) && a!.replace(/\s+/g, '').toUpperCase() === b!.replace(/\s+/g, '').toUpperCase();

function mapCompany(raw: ChCompany, postcode: string): CompanyRecord | null {
  const companyNumber = clean(raw.company_number);
  const name = clean(raw.company_name) ?? clean(raw.title);
  if (!companyNumber || !name) return null;

  const status = clean(raw.company_status) ?? 'unknown';
  const address = raw.registered_office_address ?? raw.address;
  const overdue: string[] = [
    ...(raw.accounts?.overdue ? ['Accounts overdue'] : []),
    ...(raw.confirmation_statement?.overdue ? ['Confirmation statement overdue'] : []),
  ];

  return {
    companyNumber,
    name,
    status,
    concerning: CONCERNING.some((c) => status.toLowerCase().includes(c)),
    ...(clean(raw.company_type) ? { type: clean(raw.company_type) } : {}),
    ...(clean(raw.date_of_creation) ? { incorporatedOn: clean(raw.date_of_creation) } : {}),
    ...(clean(raw.date_of_cessation) ? { dissolvedOn: clean(raw.date_of_cessation) } : {}),
    ...(addressOf(address) ? { registeredOffice: addressOf(address) } : {}),
    ...(samePostcode(address?.postal_code ?? undefined, postcode) ? { registeredHere: true } : {}),
    ...(raw.sic_codes?.length ? { sicCodes: raw.sic_codes } : {}),
    ...(overdue.length ? { overdue } : {}),
    url: `https://find-and-update.company-information.service.gov.uk/company/${encodeURIComponent(companyNumber)}`,
    source: 'companies-house',
  };
}

export function companiesHouseConfigured(): boolean {
  return config().companiesHouse.configured;
}

/** Every company registered at a postcode, worst status first. */
export async function fetchCompaniesAtPostcode(postcode: string): Promise<CompanyContext> {
  const cfg = config().companiesHouse;
  const key = postcode.replace(/\s+/g, '').toUpperCase();
  const hit = cache.get(key);
  if (hit) return hit;

  // The API key goes in as the Basic username with no password. Encoded here
  // rather than in a shared client, because nothing else authenticates this way.
  const basic = Buffer.from(`${cfg.apiKey}:`).toString('base64');
  const url = `${cfg.baseUrl}/advanced-search/companies?location=${encodeURIComponent(postcode)}&size=40`;

  const json = await fetchJson<ChAdvancedSearch>(url, {
    label: 'companies-house',
    headers: { Authorization: `Basic ${basic}` },
    timeoutMs: Math.min(config().requestTimeoutMs, 8000),
    retries: 1,
    notFoundAsNull: true,
  });

  const companies = (json?.items ?? [])
    .map((c) => mapCompany(c, postcode))
    .filter((c): c is CompanyRecord => c !== null)
    // A company in liquidation at this address is the reason someone opened
    // this panel, so it goes to the top regardless of alphabetical order.
    .sort((a, b) => Number(b.concerning) - Number(a.concerning) || a.name.localeCompare(b.name));

  const result: CompanyContext = { postcode, companies, source: 'companies-house' };
  cache.set(key, result);
  return result;
}

/** Drops the cache, for the recovery supervisor. */
export function clearCompaniesCache(): void {
  cache.clear();
}

/** Test hook. */


/* ------------------------------------------------------------------ *
 * Deep detail
 * ------------------------------------------------------------------ */

/**
 * The full picture for one company, from six endpoints at once.
 *
 * Fetched only when someone opens a company, never while building the list:
 * the list can hold forty companies and this is six calls each. Companies
 * House allow 600 requests per five minutes, which is generous for one
 * company on demand and would not survive 240 on every postcode lookup.
 *
 * A 404 on charges, PSC or insolvency is the normal answer for most
 * companies -- the resource only exists when there is something in it -- so
 * those are read as "none" rather than as failures. Anything that genuinely
 * fails is named in `unavailable` so the panel can say which part is missing
 * instead of quietly showing an empty tab.
 */

interface ChOfficerItem {
  name?: string;
  officer_role?: string;
  appointed_on?: string;
  resigned_on?: string;
  nationality?: string;
  occupation?: string;
  country_of_residence?: string;
  address?: ChAddress;
  date_of_birth?: { month?: number; year?: number };
  identification?: { identification_type?: string };
  links?: { officer?: { appointments?: string }; self?: string };
}

interface ChPscItem {
  name?: string;
  kind?: string;
  notified_on?: string;
  ceased_on?: string;
  natures_of_control?: string[];
  nationality?: string;
  country_of_residence?: string;
  address?: ChAddress;
}

interface ChFilingItem {
  date?: string;
  category?: string;
  type?: string;
  description?: string;
  pages?: number;
  description_values?: Record<string, string>;
}

interface ChChargeItem {
  charge_number?: number;
  status?: string;
  created_on?: string;
  delivered_on?: string;
  satisfied_on?: string;
  persons_entitled?: Array<{ name?: string }>;
  classification?: { description?: string; type?: string };
  particulars?: { description?: string };
}

interface ChInsolvencyCase {
  type?: string;
  dates?: Array<{ type?: string; date?: string }>;
  practitioners?: Array<{
    name?: string;
    role?: string;
    appointed_on?: string;
    ceased_to_act_on?: string;
    address?: ChAddress;
  }>;
  notes?: string[];
}

interface ChProfile extends ChCompany {
  jurisdiction?: string;
  has_charges?: boolean;
  has_insolvency_history?: boolean;
  registered_office_is_in_dispute?: boolean;
  previous_company_names?: Array<{ name?: string }>;
  accounts?: {
    overdue?: boolean;
    next_due?: string;
    last_accounts?: { made_up_to?: string };
  };
  confirmation_statement?: {
    overdue?: boolean;
    next_due?: string;
    last_made_up_to?: string;
  };
}

const detailCache = new TtlCache<CompanyDetail>(60 * 60 * 1000, 200);

/** Turns `creditors-voluntary-liquidation` into something readable. */
function humanise(value?: string): string {
  const s = clean(value);
  if (!s) return '';
  return s.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/** Companies House give month and year only, which is the point. */
function bornOn(dob?: { month?: number; year?: number }): string | undefined {
  if (!dob?.year) return undefined;
  const month = dob.month ? String(dob.month).padStart(2, '0') : undefined;
  return month ? `${dob.year}-${month}` : String(dob.year);
}

export function mapOfficer(raw: ChOfficerItem): CompanyOfficer | null {
  const name = clean(raw.name);
  if (!name) return null;
  const resignedOn = clean(raw.resigned_on);
  const officerId = clean(raw.links?.officer?.appointments)?.match(/officers\/([^/]+)\//)?.[1];

  return {
    name,
    role: humanise(raw.officer_role) || 'Officer',
    ...(clean(raw.appointed_on) ? { appointedOn: clean(raw.appointed_on) } : {}),
    ...(resignedOn ? { resignedOn } : {}),
    active: !resignedOn,
    ...(clean(raw.nationality) ? { nationality: clean(raw.nationality) } : {}),
    ...(clean(raw.occupation) ? { occupation: clean(raw.occupation) } : {}),
    ...(clean(raw.country_of_residence) ? { countryOfResidence: clean(raw.country_of_residence) } : {}),
    ...(addressOf(raw.address) ? { address: addressOf(raw.address) } : {}),
    ...(bornOn(raw.date_of_birth) ? { bornOn: bornOn(raw.date_of_birth) } : {}),
    // A corporate officer has no date of birth and carries an
    // identification block instead.
    ...(raw.identification?.identification_type ? { corporate: true } : {}),
    ...(officerId ? { officerId } : {}),
    ...(officerId
      ? { url: `https://find-and-update.company-information.service.gov.uk/officers/${officerId}/appointments` }
      : {}),
  };
}

export function mapPsc(raw: ChPscItem): CompanyPsc | null {
  const name = clean(raw.name);
  if (!name) return null;
  const ceasedOn = clean(raw.ceased_on);
  return {
    name,
    kind: humanise(raw.kind) || 'Person with significant control',
    ...(clean(raw.notified_on) ? { notifiedOn: clean(raw.notified_on) } : {}),
    ...(ceasedOn ? { ceasedOn } : {}),
    active: !ceasedOn,
    natureOfControl: (raw.natures_of_control ?? []).map(humanise).filter(Boolean),
    ...(clean(raw.nationality) ? { nationality: clean(raw.nationality) } : {}),
    ...(clean(raw.country_of_residence) ? { countryOfResidence: clean(raw.country_of_residence) } : {}),
    ...(addressOf(raw.address) ? { address: addressOf(raw.address) } : {}),
  };
}

export function mapFiling(raw: ChFilingItem): CompanyFiling | null {
  const date = clean(raw.date);
  if (!date) return null;

  // Companies House descriptions are template keys like
  // `accounts-with-accounts-type-small`, with the values in a side object.
  let description = clean(raw.description) ?? '';
  if (raw.description_values) {
    for (const [key, value] of Object.entries(raw.description_values)) {
      description = description.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value));
    }
  }
  description = humanise(description) || 'Filing';

  return {
    date,
    category: humanise(raw.category) || 'Other',
    ...(clean(raw.type) ? { type: clean(raw.type) } : {}),
    description,
    ...(typeof raw.pages === 'number' ? { pages: raw.pages } : {}),
  };
}

export function mapCharge(raw: ChChargeItem): CompanyCharge {
  const status = humanise(raw.status) || 'Unknown';
  return {
    ...(typeof raw.charge_number === 'number' ? { chargeNumber: raw.charge_number } : {}),
    status,
    // Only a satisfied or fully-released charge stops mattering; anything
    // else is still security held over the company's assets.
    outstanding: !/satisf|fully-?released|part-?released/i.test(raw.status ?? ''),
    ...(clean(raw.created_on) ? { createdOn: clean(raw.created_on) } : {}),
    ...(clean(raw.delivered_on) ? { deliveredOn: clean(raw.delivered_on) } : {}),
    ...(clean(raw.satisfied_on) ? { satisfiedOn: clean(raw.satisfied_on) } : {}),
    personsEntitled: (raw.persons_entitled ?? [])
      .map((p) => clean(p.name))
      .filter((n): n is string => Boolean(n)),
    ...(clean(raw.classification?.description) ? { classification: clean(raw.classification?.description) } : {}),
    ...(clean(raw.particulars?.description) ? { particulars: clean(raw.particulars?.description) } : {}),
  };
}

export function mapInsolvencyCase(raw: ChInsolvencyCase): CompanyInsolvencyCase {
  return {
    type: humanise(raw.type) || 'Insolvency case',
    dates: (raw.dates ?? [])
      .map((d) => ({ label: humanise(d.type) || 'Date', date: clean(d.date) ?? '' }))
      .filter((d) => d.date !== ''),
    practitioners: (raw.practitioners ?? [])
      .map((p) => {
        const name = clean(p.name);
        if (!name) return null;
        return {
          name,
          ...(clean(p.role) ? { role: humanise(p.role) } : {}),
          ...(clean(p.appointed_on) ? { appointedOn: clean(p.appointed_on) } : {}),
          ...(clean(p.ceased_to_act_on) ? { ceasedToActOn: clean(p.ceased_to_act_on) } : {}),
          ...(addressOf(p.address) ? { address: addressOf(p.address) } : {}),
        };
      })
      .filter((p): p is CompanyInsolvencyPractitioner => p !== null),
    notes: (raw.notes ?? []).map((n) => clean(n)).filter((n): n is string => Boolean(n)),
  };
}

/** One authenticated GET against Companies House. */
async function chGet<T>(path: string): Promise<T | null> {
  const cfg = config().companiesHouse;
  const basic = Buffer.from(`${cfg.apiKey}:`).toString('base64');
  return fetchJson<T>(`${cfg.baseUrl}${path}`, {
    label: 'companies-house',
    headers: { Authorization: `Basic ${basic}` },
    timeoutMs: Math.min(config().requestTimeoutMs, 8000),
    retries: 1,
    // Charges, PSC and insolvency resources do not exist unless the company
    // has one, so a 404 here is "none" and not an error.
    notFoundAsNull: true,
  });
}

/**
 * Runs a section fetch, recording rather than throwing on failure.
 *
 * One dead section should not lose the other five: a company profile is
 * still worth showing when the filing history times out. The caller reports
 * which sections are missing.
 */
async function section<T>(
  label: string,
  unavailable: string[],
  run: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await run();
  } catch {
    unavailable.push(label);
    return fallback;
  }
}

/** How many filings to keep. Enough to see a year of activity. */
const FILING_LIMIT = 20;

export async function fetchCompanyDetail(companyNumber: string): Promise<CompanyDetail> {
  const number = companyNumber.trim().toUpperCase();
  const hit = detailCache.get(number);
  if (hit) return hit;

  const unavailable: string[] = [];
  const base = `/company/${encodeURIComponent(number)}`;

  const [profile, officersRes, pscRes, filingsRes, chargesRes, insolvencyRes] = await Promise.all([
    section('Profile', unavailable, () => chGet<ChProfile>(base), null),
    section(
      'Officers',
      unavailable,
      () => chGet<{ items?: ChOfficerItem[]; total_results?: number }>(`${base}/officers?items_per_page=100`),
      null,
    ),
    section(
      'Ownership',
      unavailable,
      () =>
        chGet<{ items?: ChPscItem[]; total_results?: number }>(
          `${base}/persons-with-significant-control?items_per_page=100`,
        ),
      null,
    ),
    section(
      'Filing history',
      unavailable,
      () => chGet<{ items?: ChFilingItem[] }>(`${base}/filing-history?items_per_page=${FILING_LIMIT}`),
      null,
    ),
    section('Charges', unavailable, () => chGet<{ items?: ChChargeItem[] }>(`${base}/charges`), null),
    section('Insolvency', unavailable, () => chGet<{ cases?: ChInsolvencyCase[] }>(`${base}/insolvency`), null),
  ]);

  if (!profile) {
    // Without the profile there is no company, and the caller should say so
    // rather than render an empty shell.
    throw new Error(`Companies House has no profile for company ${number}.`);
  }

  const status = clean(profile.company_status) ?? 'unknown';
  const address = profile.registered_office_address ?? profile.address;

  const officers = (officersRes?.items ?? [])
    .map(mapOfficer)
    .filter((o): o is CompanyOfficer => o !== null)
    // Serving officers first, then most recently appointed: the person to
    // ring is at the top rather than buried among decades of resignations.
    .sort(
      (a, b) =>
        Number(b.active) - Number(a.active) || (b.appointedOn ?? '').localeCompare(a.appointedOn ?? ''),
    );

  // Officer depth costs a call per officer, so it runs after the six
  // parallel fetches rather than inside them.
  const officersEnriched = await enrichOfficers(officers, number);

  const psc = (pscRes?.items ?? [])
    .map(mapPsc)
    .filter((p): p is CompanyPsc => p !== null)
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));

  const filings = (filingsRes?.items ?? [])
    .map(mapFiling)
    .filter((f): f is CompanyFiling => f !== null)
    .sort((a, b) => b.date.localeCompare(a.date));

  const charges = (chargesRes?.items ?? [])
    .map(mapCharge)
    .sort((a, b) => Number(b.outstanding) - Number(a.outstanding) || (b.createdOn ?? '').localeCompare(a.createdOn ?? ''));

  const insolvency = (insolvencyRes?.cases ?? []).map(mapInsolvencyCase);

  const filingDates = {
    ...(clean(profile.accounts?.next_due) ? { accountsNextDue: clean(profile.accounts?.next_due) } : {}),
    ...(clean(profile.accounts?.last_accounts?.made_up_to)
      ? { accountsLastMadeUpTo: clean(profile.accounts?.last_accounts?.made_up_to) }
      : {}),
    ...(profile.accounts?.overdue != null ? { accountsOverdue: profile.accounts.overdue } : {}),
    ...(clean(profile.confirmation_statement?.next_due)
      ? { confirmationStatementNextDue: clean(profile.confirmation_statement?.next_due) }
      : {}),
    ...(clean(profile.confirmation_statement?.last_made_up_to)
      ? { confirmationStatementLastMadeUpTo: clean(profile.confirmation_statement?.last_made_up_to) }
      : {}),
    ...(profile.confirmation_statement?.overdue != null
      ? { confirmationStatementOverdue: profile.confirmation_statement.overdue }
      : {}),
  };

  const previousNames = (profile.previous_company_names ?? [])
    .map((n) => clean(n.name))
    .filter((n): n is string => Boolean(n));

  const detail: CompanyDetail = {
    companyNumber: clean(profile.company_number) ?? number,
    name: clean(profile.company_name) ?? clean(profile.title) ?? number,
    status,
    concerning: CONCERNING.some((c) => status.toLowerCase().includes(c)),
    ...(clean(profile.company_type) ? { type: clean(profile.company_type) } : {}),
    ...(clean(profile.date_of_creation) ? { incorporatedOn: clean(profile.date_of_creation) } : {}),
    ...(clean(profile.date_of_cessation) ? { dissolvedOn: clean(profile.date_of_cessation) } : {}),
    ...(addressOf(address) ? { registeredOffice: addressOf(address) } : {}),
    ...(profile.registered_office_is_in_dispute ? { registeredOfficeInDispute: true } : {}),
    ...(profile.sic_codes?.length ? { sicCodes: profile.sic_codes } : {}),
    ...(previousNames.length ? { previousNames } : {}),
    ...(clean(profile.jurisdiction) ? { jurisdiction: humanise(profile.jurisdiction) } : {}),
    ...(Object.keys(filingDates).length ? { filingDates } : {}),
    officers: officersEnriched,
    ...(officersRes?.total_results != null ? { officerCount: officersRes.total_results } : {}),
    psc,
    ...(pscRes?.total_results != null ? { pscCount: pscRes.total_results } : {}),
    filings,
    charges,
    ...(charges.length ? { outstandingCharges: charges.filter((c) => c.outstanding).length } : {}),
    insolvency,
    unavailable,
    url: `https://find-and-update.company-information.service.gov.uk/company/${encodeURIComponent(number)}`,
    source: 'companies-house',
    checkedAt: new Date().toISOString(),
  };

  detailCache.set(number, detail);
  return detail;
}

/** Test hook. */
export const __companiesHouseTesting = {
  mapCompany,
  CONCERNING,
  mapOfficer,
  mapPsc,
  mapFiling,
  mapCharge,
  mapInsolvencyCase,
  humanise,
  bornOn,
  mapDisqualification,
  mapAppointments,
};

/* ------------------------------------------------------------------ *
 * Officer depth: disqualification and other appointments
 * ------------------------------------------------------------------ */

/**
 * Two more free Companies House resources, both keyed on an officer.
 *
 * These are fetched only for the officers still serving, and only a handful
 * of them. Both are one call per officer, so pulling them for a company with
 * forty historic directors would cost eighty requests to answer a question
 * nobody asked -- a resigned director is not going to sign anything.
 */

interface ChDisqualification {
  disqualifications?: Array<{
    disqualified_from?: string;
    disqualified_until?: string;
    reason?: { description_identifier?: string; act?: string; section?: string };
    company_names?: string[];
    court_name?: string;
    case_identifier?: string;
  }>;
}

interface ChAppointmentList {
  items?: Array<{
    appointed_to?: { company_name?: string; company_number?: string; company_status?: string };
    officer_role?: string;
    appointed_on?: string;
    resigned_on?: string;
  }>;
}

/** How many serving officers to enrich. Beyond this the cost outruns the value. */
const ENRICH_LIMIT = 6;

export function mapDisqualification(payload: ChDisqualification | null): CompanyDisqualification | null {
  const rows = payload?.disqualifications ?? [];
  if (!rows.length) return null;

  // The most recent order is the one that matters; Companies House do not
  // guarantee an order, so pick by date rather than trusting position.
  const latest = [...rows].sort((a, b) =>
    (b.disqualified_from ?? '').localeCompare(a.disqualified_from ?? ''),
  )[0]!;

  const until = clean(latest.disqualified_until);
  // A ban with no end date is in force; one with an end date is in force
  // until that date passes.
  const active = !until || new Date(until).getTime() > Date.now();

  const reasonParts = [
    clean(latest.reason?.act),
    clean(latest.reason?.section) ? `section ${clean(latest.reason?.section)}` : undefined,
    clean(latest.reason?.description_identifier)
      ? humanise(latest.reason?.description_identifier)
      : undefined,
  ].filter(Boolean);

  return {
    active,
    ...(clean(latest.disqualified_from) ? { from: clean(latest.disqualified_from) } : {}),
    ...(until ? { to: until } : {}),
    ...(reasonParts.length ? { reason: reasonParts.join(', ') } : {}),
    ...(clean(latest.court_name) ? { authority: clean(latest.court_name) } : {}),
    ...(latest.company_names?.length ? { companies: latest.company_names } : {}),
  };
}

export function mapAppointments(
  payload: ChAppointmentList | null,
  excludeCompanyNumber: string,
): OfficerAppointment[] {
  return (payload?.items ?? [])
    .map((item) => {
      const companyNumber = clean(item.appointed_to?.company_number);
      const companyName = clean(item.appointed_to?.company_name);
      if (!companyNumber || !companyName) return null;
      // The company being viewed is not an "other" appointment.
      if (companyNumber.toUpperCase() === excludeCompanyNumber.toUpperCase()) return null;

      const status = clean(item.appointed_to?.company_status);
      const resignedOn = clean(item.resigned_on);
      return {
        companyName,
        companyNumber,
        ...(status ? { companyStatus: status } : {}),
        ...(clean(item.officer_role) ? { role: humanise(item.officer_role) } : {}),
        ...(clean(item.appointed_on) ? { appointedOn: clean(item.appointed_on) } : {}),
        ...(resignedOn ? { resignedOn } : {}),
        active: !resignedOn,
        concerning: Boolean(status && CONCERNING.some((c) => status.toLowerCase().includes(c))),
      };
    })
    .filter((a): a is OfficerAppointment => a !== null)
    // Live appointments at troubled companies first: that is the pattern
    // worth seeing -- a director of three dissolved companies and one new one.
    .sort(
      (a, b) =>
        Number(b.active) - Number(a.active) ||
        Number(b.concerning) - Number(a.concerning) ||
        a.companyName.localeCompare(b.companyName),
    );
}

/**
 * Fills in disqualification and other appointments for the serving officers.
 *
 * Failures are swallowed per officer. This is enrichment: a company record
 * without it is still the company record, and one officer's appointments
 * endpoint timing out should not lose the other five.
 */
async function enrichOfficers(officers: CompanyOfficer[], companyNumber: string): Promise<CompanyOfficer[]> {
  const candidates = officers.filter((o) => o.active && o.officerId).slice(0, ENRICH_LIMIT);
  if (!candidates.length) return officers;

  const enriched = new Map<string, { disqualification?: CompanyDisqualification; otherRoles?: OfficerAppointment[] }>();

  await Promise.all(
    candidates.map(async (officer) => {
      const id = officer.officerId!;
      const [dq, appointments] = await Promise.all([
        // A person with no disqualification is a 404 here, which is the
        // answer for almost everybody.
        chGet<ChDisqualification>(`/disqualified-officers/natural/${encodeURIComponent(id)}`).catch(() => null),
        chGet<ChAppointmentList>(`/officers/${encodeURIComponent(id)}/appointments?items_per_page=50`).catch(
          () => null,
        ),
      ]);

      const disqualification = mapDisqualification(dq);
      const otherRoles = mapAppointments(appointments, companyNumber);
      enriched.set(id, {
        ...(disqualification ? { disqualification } : {}),
        ...(otherRoles.length ? { otherRoles } : {}),
      });
    }),
  );

  return officers.map((officer) => {
    const extra = officer.officerId ? enriched.get(officer.officerId) : undefined;
    return extra ? { ...officer, ...extra } : officer;
  });
}
