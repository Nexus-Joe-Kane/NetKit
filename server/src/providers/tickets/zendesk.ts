import type { AccountStanding, SiteContact } from '@sw/shared';
import { readStanding } from '@sw/shared';
import { config } from '../../config';
import { fetchJson } from '../../lib/http';
import { TtlCache } from '../../lib/cache';

/**
 * Zendesk Support, for the ticket side of a fault.
 *
 * Two jobs. Leaving a note on the ticket that a fault or a line test belongs
 * to, so the next engineer to open it can see what was already sent to the
 * supplier and what came back. And reading the customer's own contacts, so
 * the site contact given to a supplier is chosen from a list rather than
 * typed from memory and misspelled.
 *
 * Notes are private by default and the type makes that a required choice
 * rather than an option somebody has to remember: a raw supplier exchange is
 * engineering detail. The one exception is the site-visit message, which is
 * deliberately public because the customer has to act on it.
 *
 * Auth is HTTP Basic with `email/token` as the username -- Zendesk's own
 * scheme, unusual enough to be worth stating.
 */

interface ZendeskUser {
  id?: number;
  name?: string;
  email?: string;
  phone?: string;
  organization_id?: number;
  role?: string;
  active?: boolean;
  suspended?: boolean;
}

interface ZendeskTicket {
  id?: number;
  subject?: string;
  status?: string;
  created_at?: string;
  requester_id?: number;
  organization_id?: number;
  url?: string;
}

const contactsCache = new TtlCache<SiteContact[]>(10 * 60 * 1000, 200);

export const zendeskConfigured = (): boolean => config().zendesk.configured;

const auth = (): string => {
  const cfg = config().zendesk;
  // Zendesk want the literal string "/token" appended to the email address.
  return Buffer.from(`${cfg.email}/token:${cfg.apiToken}`).toString('base64');
};

const base = (): string => {
  const raw = config().zendesk.subdomain.trim().replace(/\/+$/, '');

  // An explicit scheme is honoured, so the integration can be pointed at a
  // stand-in or an internal proxy. Anything else gets https, which is what a
  // real Zendesk host needs and the only thing it accepts.
  if (/^https?:\/\//i.test(raw)) return `${raw}/api/v2`;

  // A bare subdomain or a full host, because both get pasted in.
  const host = raw.includes('.') ? raw : `${raw}.zendesk.com`;
  return `https://${host}/api/v2`;
};

async function zdGet<T>(path: string): Promise<T | null> {
  return fetchJson<T>(`${base()}${path}`, {
    label: 'Zendesk',
    headers: { Authorization: `Basic ${auth()}` },
    timeoutMs: Math.min(config().requestTimeoutMs, 8000),
    retries: 1,
    notFoundAsNull: true,
  });
}

async function zdPut<T>(path: string, body: unknown): Promise<T | null> {
  return fetchJson<T>(`${base()}${path}`, {
    label: 'Zendesk',
    method: 'PUT',
    headers: { Authorization: `Basic ${auth()}` },
    body,
    timeoutMs: Math.min(config().requestTimeoutMs, 8000),
    // Never retried. A retry after a timeout that actually succeeded posts the
    // note twice, and a duplicated supplier exchange on a customer's ticket is
    // worse than one that has to be re-sent by hand.
    retries: 0,
    notFoundAsNull: true,
  });
}

/** A ticket id as Zendesk want it: digits, with any leading `#` dropped. */
export function normaliseTicketId(raw: string): string | null {
  const digits = (raw ?? '').trim().replace(/^#/, '');
  return /^\d{1,12}$/.test(digits) ? digits : null;
}

export interface NoteResult {
  ticketId: string;
  url?: string;
  public: boolean;
  ccEmails: string[];
}

/**
 * Adds a comment to a ticket.
 *
 * `visibility` is required rather than defaulted, because the difference
 * between a private engineering note and a message the customer receives is
 * not something to get wrong by omission.
 */
export async function comment(input: {
  ticketId: string;
  body: string;
  visibility: 'private' | 'public';
  /** Addresses to add as collaborators, e.g. the engineer who raised it. */
  ccEmails?: string[];
}): Promise<NoteResult> {
  const id = normaliseTicketId(input.ticketId);
  if (!id) throw new Error(`"${input.ticketId}" is not a Zendesk ticket number.`);

  const ccEmails = [...new Set((input.ccEmails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean))];

  const response = await zdPut<{ ticket?: ZendeskTicket }>(`/tickets/${id}.json`, {
    ticket: {
      comment: { body: input.body, public: input.visibility === 'public' },
      // `additional_collaborators` adds without removing whoever is already
      // on the ticket. `collaborators` replaces the list, which would quietly
      // drop the customer's other contacts.
      ...(ccEmails.length ? { additional_collaborators: ccEmails } : {}),
    },
  });

  if (!response?.ticket) {
    throw new Error(`Zendesk has no ticket ${id}, or the API user cannot see it.`);
  }

  return {
    ticketId: id,
    ...(response.ticket.url ? { url: response.ticket.url } : {}),
    public: input.visibility === 'public',
    ccEmails,
  };
}

const mapContact = (user: ZendeskUser, organisation?: string): SiteContact | null => {
  if (!user.id || !user.name) return null;
  return {
    id: String(user.id),
    name: user.name,
    ...(user.email ? { email: user.email } : {}),
    ...(user.phone ? { phone: user.phone } : {}),
    ...(organisation ? { organisation } : {}),
  };
};

/**
 * The contacts at the customer a ticket belongs to.
 *
 * Deliberately narrow: the requester, plus everybody in the same
 * organisation. Not every user in the helpdesk -- the point of the picker is
 * that it cannot offer somebody from a different customer, which is the one
 * mistake that matters when handing a name and number to an engineer who is
 * about to knock on a door.
 */
export async function siteContactsForTicket(ticketId: string): Promise<SiteContact[]> {
  const id = normaliseTicketId(ticketId);
  if (!id) throw new Error(`"${ticketId}" is not a Zendesk ticket number.`);

  const cached = contactsCache.get(id);
  if (cached) return cached;

  const ticket = await zdGet<{ ticket?: ZendeskTicket }>(`/tickets/${id}.json`);
  if (!ticket?.ticket) throw new Error(`Zendesk has no ticket ${id}, or the API user cannot see it.`);

  const orgId = ticket.ticket.organization_id;
  const contacts = new Map<string, SiteContact>();
  let organisation: string | undefined;

  if (orgId) {
    const org = await zdGet<{ organization?: { name?: string } }>(`/organizations/${orgId}.json`);
    organisation = org?.organization?.name;

    const users = await zdGet<{ users?: ZendeskUser[] }>(`/organizations/${orgId}/users.json?per_page=100`);
    for (const user of users?.users ?? []) {
      // End users only, and only ones who can actually be contacted. A
      // suspended account is somebody who has left.
      if (user.suspended || user.active === false) continue;
      if (user.role && user.role !== 'end-user') continue;
      const contact = mapContact(user, organisation);
      if (contact) contacts.set(contact.id, contact);
    }
  }

  // The requester is added only if the organisation sweep missed them, so a
  // ticket with no organisation still offers somebody.
  if (ticket.ticket.requester_id && !contacts.has(String(ticket.ticket.requester_id))) {
    const requester = await zdGet<{ user?: ZendeskUser }>(`/users/${ticket.ticket.requester_id}.json`);
    const contact = requester?.user ? mapContact(requester.user, organisation) : null;
    if (contact) contacts.set(contact.id, contact);
  }

  const list = [...contacts.values()].sort((a, b) => a.name.localeCompare(b.name));
  contactsCache.set(id, list);
  return list;
}

/** Probe for the admin status board: proves auth without changing anything. */
export async function zendeskPing(): Promise<{ ok: boolean; detail: string }> {
  try {
    const me = await zdGet<{ user?: ZendeskUser }>('/users/me.json');
    if (!me?.user?.id) return { ok: false, detail: 'Authenticated but Zendesk returned no user.' };
    return {
      ok: true,
      detail: `Authenticated as ${me.user.email ?? me.user.name ?? 'the API user'}${
        me.user.role ? ` (${me.user.role})` : ''
      }.`,
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Recovery hook — drops cached contact lists. */
export function clearZendeskCache(): void {
  contactsCache.clear();
}

/* ------------------------------------------------------------------ *
 * Organisations: whose client is this, and what terms are they on
 * ------------------------------------------------------------------ */

interface ZendeskOrganisation {
  id?: number;
  name?: string;
  organization_fields?: Record<string, unknown>;
  tags?: string[];
  notes?: string;
  details?: string;
}

export interface ClientContext {
  organisationId: string;
  name: string;
  standing: AccountStanding;
  /** The text the standing was read from, so a wrong reading is traceable. */
  standingSource?: string;
  /** Open tickets, newest first, capped. */
  openTickets: ClientTicket[];
  /** How many are open in total, where more exist than were fetched. */
  openTicketCount: number;
}

export interface ClientTicket {
  id: string;
  subject: string;
  status: string;
  createdAt?: string;
  requesterName?: string;
  requesterEmail?: string;
}

/**
 * How many open tickets to fetch.
 *
 * Twice the picker limit, so the count can honestly say "more than five"
 * without paging the whole queue.
 */
const TICKET_FETCH = 25;

/**
 * Where a client's terms might be written.
 *
 * Nobody agrees on this. Some tenants use an organisation field, some a tag,
 * some the notes box. All three are read and the first that yields a
 * recognisable standing wins — with the text kept, so a wrong reading can be
 * traced to what it read rather than argued about.
 */
function standingOf(org: ZendeskOrganisation): { standing: AccountStanding; source?: string } {
  const candidates: string[] = [];

  for (const [key, value] of Object.entries(org.organization_fields ?? {})) {
    if (typeof value !== 'string' || !value.trim()) continue;
    // Only fields that look like they are about terms, so a "region" field
    // reading "Support" does not decide billing.
    if (/term|standing|billing|contract|support|account|status/i.test(key)) candidates.push(value);
  }

  candidates.push(...(org.tags ?? []));
  if (org.notes) candidates.push(org.notes);
  if (org.details) candidates.push(org.details);

  for (const candidate of candidates) {
    const standing = readStanding(candidate);
    if (standing !== 'unknown') return { standing, source: candidate };
  }
  return { standing: 'unknown' };
}

const mapTicket = (raw: ZendeskTicket, users: Map<number, ZendeskUser>): ClientTicket | null => {
  if (!raw.id) return null;
  const requester = raw.requester_id ? users.get(raw.requester_id) : undefined;
  return {
    id: String(raw.id),
    subject: raw.subject?.trim() || `Ticket ${raw.id}`,
    status: raw.status ?? 'unknown',
    ...(raw.created_at ? { createdAt: raw.created_at } : {}),
    ...(requester?.name ? { requesterName: requester.name } : {}),
    ...(requester?.email ? { requesterEmail: requester.email } : {}),
  };
};

/**
 * Everything about a client that decides whether to start work.
 *
 * Looked up by name, because that is what every other system holds — IT Glue,
 * UniFi and Zendesk all name a client the same way, so a name is the join.
 * An exact match wins; where several organisations match loosely, none is
 * chosen, because starting a payment conversation with the wrong customer is
 * worse than asking which one.
 */
export async function clientContextByName(name: string): Promise<ClientContext | null> {
  const query = name.trim();
  if (!query) return null;

  const found = await zdGet<{ organizations?: ZendeskOrganisation[] }>(
    `/organizations/autocomplete.json?name=${encodeURIComponent(query)}`,
  );
  const matches = found?.organizations ?? [];
  if (matches.length === 0) return null;

  const exact = matches.find((o) => (o.name ?? '').trim().toLowerCase() === query.toLowerCase());
  const org = exact ?? (matches.length === 1 ? matches[0] : undefined);
  if (!org?.id) return null;

  const { standing, source } = standingOf(org);

  // `side_load` the requesters, so a picker can show who asked without a
  // request per ticket.
  const tickets = await zdGet<{ tickets?: ZendeskTicket[]; users?: ZendeskUser[] }>(
    `/organizations/${org.id}/tickets.json?include=users&per_page=${TICKET_FETCH}`,
  );

  const users = new Map<number, ZendeskUser>();
  for (const user of tickets?.users ?? []) if (user.id) users.set(user.id, user);

  const open = (tickets?.tickets ?? [])
    .filter((t) => ['new', 'open', 'pending', 'hold'].includes((t.status ?? '').toLowerCase()))
    .map((t) => mapTicket(t, users))
    .filter((t): t is ClientTicket => t !== null)
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));

  return {
    organisationId: String(org.id),
    name: org.name ?? query,
    standing,
    ...(source ? { standingSource: source } : {}),
    openTickets: open,
    openTicketCount: open.length,
  };
}
