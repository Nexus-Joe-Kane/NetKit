/**
 * Companies House, beyond the summary.
 *
 * The list panel answers "who is registered here and are they trading". These
 * types answer the questions that follow, and they are the ones that keep
 * someone out of the Companies House website mid-call: who can authorise a
 * cease, who actually owns the business, whether accounts are late, whether a
 * bank holds a charge over the assets, and who the insolvency practitioner is.
 *
 * Everything here is public register data. Companies House publish officers'
 * service addresses and only the month and year of birth -- residential
 * addresses are withheld at source, so there is nothing to redact here.
 */

export interface CompanyOfficer {
  name: string;
  /** `director`, `secretary`, `llp-member`, and so on. */
  role: string;
  appointedOn?: string;
  resignedOn?: string;
  /** True while the appointment stands -- the person to actually ring. */
  active: boolean;
  nationality?: string;
  occupation?: string;
  countryOfResidence?: string;
  /** Service address, not residential. */
  address?: string;
  /** Companies House publish month and year only. */
  bornOn?: string;
  /** True when the officer is another company rather than a person. */
  corporate?: boolean;
  /**
   * How many other appointments this person holds, where Companies House
   * link to them. A director of forty companies reads differently from a
   * director of one.
   */
  otherAppointments?: number;
  officerId?: string;
  url?: string;
}

/** A person or entity with significant control -- the real owner. */
export interface CompanyPsc {
  name: string;
  /** `individual-person-with-significant-control`, `corporate-entity-...`, etc. */
  kind: string;
  notifiedOn?: string;
  ceasedOn?: string;
  active: boolean;
  /** e.g. "ownership of shares 75 to 100 percent". */
  natureOfControl: string[];
  nationality?: string;
  countryOfResidence?: string;
  address?: string;
}

export interface CompanyFiling {
  date: string;
  /** `accounts`, `confirmation-statement`, `officers`, `gazette`, … */
  category: string;
  type?: string;
  description: string;
  pages?: number;
}

/** A charge or mortgage registered over the company's assets. */
export interface CompanyCharge {
  /** Sequence number Companies House assign. */
  chargeNumber?: number;
  status: string;
  /** True when the charge is still live against the company. */
  outstanding: boolean;
  createdOn?: string;
  deliveredOn?: string;
  satisfiedOn?: string;
  /** Who holds it -- usually a bank. */
  personsEntitled: string[];
  classification?: string;
  particulars?: string;
}

export interface CompanyInsolvencyPractitioner {
  name: string;
  role?: string;
  appointedOn?: string;
  ceasedToActOn?: string;
  address?: string;
}

export interface CompanyInsolvencyCase {
  /** e.g. `creditors-voluntary-liquidation`. */
  type: string;
  /** Dates Companies House attach to the case, already labelled. */
  dates: Array<{ label: string; date: string }>;
  practitioners: CompanyInsolvencyPractitioner[];
  notes: string[];
}

/** Accounts and confirmation statement timing, which is the credit signal. */
export interface CompanyFilingDates {
  accountsNextDue?: string;
  accountsLastMadeUpTo?: string;
  accountsOverdue?: boolean;
  confirmationStatementNextDue?: string;
  confirmationStatementLastMadeUpTo?: string;
  confirmationStatementOverdue?: boolean;
}

/**
 * Everything worth knowing about one company.
 *
 * Assembled from six Companies House endpoints. Each section is optional
 * because most are a 404 for most companies -- a company with no charges has
 * no charges resource, which is an answer rather than a failure.
 */
export interface CompanyDetail {
  companyNumber: string;
  name: string;
  status: string;
  concerning: boolean;
  type?: string;
  incorporatedOn?: string;
  dissolvedOn?: string;
  registeredOffice?: string;
  /** Companies House flag it when a registered office is contested. */
  registeredOfficeInDispute?: boolean;
  sicCodes?: string[];
  /** Trading names the company has had before. */
  previousNames?: string[];
  jurisdiction?: string;
  filingDates?: CompanyFilingDates;
  officers: CompanyOfficer[];
  /** Total the register holds, which can exceed the page fetched. */
  officerCount?: number;
  psc: CompanyPsc[];
  pscCount?: number;
  /** Most recent filings, newest first. */
  filings: CompanyFiling[];
  charges: CompanyCharge[];
  outstandingCharges?: number;
  insolvency: CompanyInsolvencyCase[];
  /** Sections Companies House refused or that failed, so the UI can say so. */
  unavailable: string[];
  url?: string;
  source: string;
  checkedAt: string;
}
