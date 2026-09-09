import type { ClientIndexEntry, ClientSite } from './clientIndex';

/**
 * A customer, as one page.
 *
 * The tab exists because nothing else answers "tell me about this client".
 * The lookup answers "what is at this address", which is a different
 * question and the wrong one when somebody rings up about their contract,
 * their headcount, or how many tickets they raised last month.
 */

/* ------------------------------------------------------------------ *
 * How many people work there
 * ------------------------------------------------------------------ */

/**
 * Where a headcount came from, because the two sources are not equally good.
 *
 * `licences` is the Office 365 user count from the documentation, and is
 * close enough to be worth quoting -- within about ten, because shared
 * mailboxes, service accounts and a director who left in March all sit in
 * the same list as real staff.
 *
 * `contacts` is how many people have ever emailed the helpdesk, which is a
 * different number that looks like the same number. A fifty-person company
 * where six people raise all the tickets counts as six. It is offered
 * because it is better than nothing and it is flagged, loudly, because
 * quoting it as a headcount is how a proposal gets priced wrong.
 */
export type HeadcountBasis = 'licences' | 'contacts' | 'none';

export interface Headcount {
  value?: number;
  basis: HeadcountBasis;
  /** True where the number should not be quoted without checking. */
  unreliable: boolean;
  /** Plus or minus, where we can say. */
  margin?: number;
  because: string;
}

/** Office 365 licences are within about this many of the real headcount. */
export const LICENCE_MARGIN = 10;

export function headcount(input: { licences?: number; helpdeskContacts?: number }): Headcount {
  if (input.licences !== undefined && input.licences > 0) {
    return {
      value: input.licences,
      basis: 'licences',
      unreliable: false,
      margin: LICENCE_MARGIN,
      because:
        `${input.licences} Office 365 users in the documentation. Good to within about ${LICENCE_MARGIN} — ` +
        'shared mailboxes, service accounts and leavers sit in the same list as staff.',
    };
  }

  if (input.helpdeskContacts !== undefined && input.helpdeskContacts > 0) {
    return {
      value: input.helpdeskContacts,
      basis: 'contacts',
      unreliable: true,
      because:
        `${input.helpdeskContacts} people have contacted the helpdesk. This is not a headcount and is often ` +
        'far short of one: a fifty-person company where six people raise all the tickets counts as six. Check ' +
        'before quoting it.',
    };
  }

  return {
    basis: 'none',
    unreliable: false,
    because: 'No Office 365 record and nobody has contacted the helpdesk, so there is nothing to estimate from.',
  };
}

/* ------------------------------------------------------------------ *
 * Tickets
 * ------------------------------------------------------------------ */

export interface TicketStats {
  open: number;
  /** Raised in the last 30 days. */
  raisedRecently: number;
  /** Solved in the last 30 days. */
  solvedRecently: number;
  /** Median hours to first reply, where enough tickets exist to have one. */
  medianFirstReplyHours?: number;
  /** The busiest requesters, which is who to train. */
  topRequesters?: Array<{ name: string; tickets: number }>;
}

/**
 * How many tickets is a lot, for this client.
 *
 * Per head rather than absolute, because forty tickets from a four-hundred
 * person firm is quiet and forty from a six-person firm means something is
 * badly wrong. Returns nothing where there is no reliable headcount: a rate
 * computed from a helpdesk contact count would be dividing by the same
 * people who raised the tickets.
 */
/**
 * The bands, in tickets per person per month.
 *
 * Set against what an average office actually generates rather than against
 * a round number. At 0.3 a person raises a ticket about once a quarter,
 * which is a business that barely needs us. At 1.0 it is monthly, which is
 * ordinary. Past 2.0 something is wrong with the estate rather than with the
 * users -- a failing switch, a bad line, or software nobody has been trained
 * on -- and that is worth a conversation rather than more tickets.
 *
 * An earlier version put 0.67 in `busy`, which would have flagged a
 * perfectly ordinary sixty-person firm as a problem.
 */
export const TICKET_RATE_BANDS = { normal: 0.3, busy: 1.0, heavy: 2.0 } as const;

export function ticketRate(
  stats: TicketStats,
  staff: Headcount,
): { perHeadPerMonth: number; verdict: 'quiet' | 'normal' | 'busy' | 'heavy' } | undefined {
  if (staff.basis !== 'licences' || !staff.value) return undefined;
  const rate = stats.raisedRecently / staff.value;
  const verdict =
    rate >= TICKET_RATE_BANDS.heavy
      ? 'heavy'
      : rate >= TICKET_RATE_BANDS.busy
        ? 'busy'
        : rate >= TICKET_RATE_BANDS.normal
          ? 'normal'
          : 'quiet';
  return { perHeadPerMonth: Math.round(rate * 100) / 100, verdict };
}

/* ------------------------------------------------------------------ *
 * Everything we hold
 * ------------------------------------------------------------------ */

export interface ClientProfile {
  entry: ClientIndexEntry;
  /** The name to show, `Registered (Trading)` where they differ. */
  display: string;
  staff: Headcount;
  tickets?: TicketStats;
  rate?: ReturnType<typeof ticketRate>;
  /** Documented configurations, never with a password value. */
  configurations?: Array<{ id: string; name: string; type?: string; hostname?: string; ip?: string; siteName?: string }>;
  /** How many credentials the documentation holds. Never their values. */
  credentialCount?: number;
  /** Kit on the consoles. */
  devices?: Array<{ id: string; name: string; model?: string; kind?: string; siteName?: string; status?: string }>;
  /** SIMs on this customer. */
  sims?: Array<{ msisdn?: string; iccid?: string; operator?: string; tariff?: string; state?: string; usedPercent?: number }>;
  /** Broadband and connectivity we supply. */
  services?: Array<{ reference: string; supplier?: string; product?: string; status?: string; siteName?: string }>;
  /** Which systems answered, and which did not. */
  sources: Array<{ name: string; ok: boolean; detail?: string }>;
  generatedAt: string;
}

/**
 * Is this profile worth showing, or is it an empty page with a name on it?
 *
 * Asked because a client whose every source failed and a client we genuinely
 * hold nothing about look identical on screen, and only one of them is a
 * reason to go and fix a credential.
 */
export function profileIsEmpty(profile: ClientProfile): boolean {
  return (
    !profile.configurations?.length &&
    !profile.devices?.length &&
    !profile.sims?.length &&
    !profile.services?.length &&
    !profile.tickets
  );
}

/** Sources that failed, so an empty page can say why it is empty. */
export function failedSources(profile: ClientProfile): string[] {
  return profile.sources.filter((s) => !s.ok).map((s) => s.name);
}

/* ------------------------------------------------------------------ *
 * Addresses nobody has claimed
 * ------------------------------------------------------------------ */

/**
 * An address somebody has said belongs to a client.
 *
 * The gap this fills: looking up a UPRN finds a building, and the building
 * does not know whose it is. Once somebody says "this one is Market Halls",
 * every later lookup of that address can offer their UniFi site, their Zen
 * circuits and their tickets — which is the whole promise of the portal, and
 * it cannot be inferred from a postcode because two of our customers share
 * a business park.
 *
 * Stored with who decided and when, because a wrong assignment attaches one
 * restaurant's kit to another's report and somebody will need to know who to
 * ask about it.
 */
export interface AddressAssignment {
  /** The UPRN, which is the only identifier worth keying on. */
  uprn: string;
  clientKey: string;
  clientName: string;
  /** The address as it read when it was assigned, for recognising it later. */
  addressLine?: string;
  postcode?: string;
  /** A specific site of that client, where they have more than one. */
  siteName?: string;
  assignedBy?: string;
  assignedAt: string;
  note?: string;
}

/** Why an assignment cannot be accepted, or nothing. */
export function assignmentProblem(input: Partial<AddressAssignment>): string | undefined {
  const uprn = (input.uprn ?? '').trim();
  if (!/^\d{6,12}$/.test(uprn)) {
    return 'An assignment needs a UPRN. A postcode is not enough — two of our customers share a business park.';
  }
  if (!(input.clientKey ?? '').trim() || !(input.clientName ?? '').trim()) {
    return 'Say which client this address belongs to.';
  }
  return undefined;
}

/**
 * Sites that have no UPRN, so cannot be looked up.
 *
 * What the unmatched list is actually made of: the client index knows a
 * client has a shop in SE23, and until somebody pins it to a UPRN nothing
 * can be asked about it. Postcode-only sites are included because they are
 * one click from being useful; sites with neither are included too, because
 * a site with only a name is the case most worth chasing.
 */
export function unassignedSites(entry: ClientIndexEntry): ClientSite[] {
  return entry.sites.filter((site) => !site.uprn);
}

/** True where this address already belongs to somebody. */
export function assignmentFor(
  assignments: readonly AddressAssignment[],
  uprn: string | undefined,
): AddressAssignment | undefined {
  if (!uprn) return undefined;
  return assignments.find((a) => a.uprn === uprn);
}
