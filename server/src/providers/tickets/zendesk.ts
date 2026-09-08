import type { SiteContact } from '@sw/shared';
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
