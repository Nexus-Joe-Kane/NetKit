import type { CompanyContext, CompanyRecord } from '@sw/shared';
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
export const __companiesHouseTesting = { mapCompany, CONCERNING };
