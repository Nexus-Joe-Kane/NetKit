/**
 * Sending a document to a ticket.
 *
 * The gap: a report gets printed or exported and then re-typed into a ticket
 * by hand, or worse, attached with no explanation so the next person opening
 * the ticket finds a PDF called `report.pdf` and no idea who asked for it.
 *
 * Two destinations with different rules, and the difference is the point.
 *
 * An internal note is a filing action. It needs the file, who asked, and
 * when — nothing else. Prose on an internal note about a document is prose
 * nobody reads, and a sign-off on one reads like a letter to yourself.
 *
 * A public reply is a message to a customer. It needs something written by a
 * person, and it needs the sign-off every other customer-facing message in
 * this portal carries — a reply that trails off unsigned reads as a
 * fragment, and one signed differently reads as a different company.
 */

/**
 * The sign-off, in one place.
 *
 * The same wording as the visit messages and the event notes. A customer who
 * gets three messages from us in a morning should not be able to tell they
 * came from three different screens.
 */
export const NETWORK_TEAM_SIGN_OFF = 'Kind regards,\nThe Network Team\nSupportWizard';

/** What a public reply starts with, so nobody has to type it. */
export const PUBLIC_REPLY_OPENER = 'Thanks,';

export type NoteVisibility = 'private' | 'public';

export interface HandoffDocument {
  /** What the file is called, which is what somebody will look for. */
  filename: string;
  /** `Site report`, `Line handover`, and so on. */
  kind: string;
  /** The premises or client it is about. */
  about?: string;
  /** Anything the engineer typed onto the document itself. */
  engineerNotes?: string;
}

/**
 * The internal note.
 *
 * Deliberately four lines. It answers "what is this and why is it here",
 * which is the only question an internal note about a document has to
 * answer, and it does not pretend to be a summary of the document — the
 * document is attached.
 */
export function internalHandoffNote(input: {
  document: HandoffDocument;
  by?: string;
  at?: string;
}): string {
  const lines = [`${input.document.kind} attached: ${input.document.filename}`];
  if (input.document.about) lines.push(input.document.about);
  lines.push('');
  lines.push(
    `Produced by ${input.by ?? 'NetKit'}${input.at ? ` on ${formatWhen(input.at)}` : ''} from the NetKit portal.`,
  );

  if (input.document.engineerNotes?.trim()) {
    lines.push('');
    lines.push('Notes on the document');
    lines.push(input.document.engineerNotes.trim());
  }

  return lines.join('\n');
}

/**
 * The public reply.
 *
 * The body is whatever the engineer wrote — this only frames it. Two rules:
 * the sign-off is added rather than typed, so it cannot drift; and the
 * engineer's own notes are *not* included, because notes written on an
 * internal document are written for the desk and putting them in front of a
 * customer is how "the customer is being difficult about the wiring" ends up
 * in an inbox.
 */
export function publicHandoffNote(input: {
  document: HandoffDocument;
  body: string;
  /** Whether to mention the attachment by name. */
  mentionFile?: boolean;
}): string {
  const parts = [input.body.trim()];
  if (input.mentionFile !== false) {
    parts.push(`I have attached ${describeFile(input.document)}.`);
  }
  parts.push(NETWORK_TEAM_SIGN_OFF);
  return parts.filter(Boolean).join('\n\n');
}

/** `the site report for 14 Oxford Street`, or just `the site report`. */
function describeFile(document: HandoffDocument): string {
  const kind = document.kind.toLowerCase();
  return document.about ? `the ${kind} for ${document.about}` : `the ${kind}`;
}

/** Day, month, year and a 24-hour clock in London. */
function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/London',
  });
}

/**
 * Why this cannot be sent, or nothing.
 *
 * A public reply with nothing written in it is the failure worth guarding:
 * the sign-off would be added, the file mentioned, and a customer would
 * receive a message consisting of a signature.
 */
export function handoffProblem(input: {
  visibility: NoteVisibility;
  body?: string;
  ticketId?: string;
}): string | undefined {
  if (!(input.ticketId ?? '').trim()) return 'Choose a ticket.';
  if (input.visibility === 'public' && !(input.body ?? '').replace(PUBLIC_REPLY_OPENER, '').trim()) {
    return 'Write something for the customer. A reply of just a sign-off is worse than no reply.';
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Choosing the ticket
 * ------------------------------------------------------------------ */

/**
 * One ticket to pick from.
 *
 * Whose it is matters as much as what it is about: sending a document to
 * somebody else's ticket without noticing is how two people end up replying
 * to the same customer.
 */
export interface TicketOption {
  id: string;
  subject: string;
  status: string;
  requesterName?: string;
  requesterEmail?: string;
  requesterPhone?: string;
  organisation?: string;
  assigneeName?: string;
  updatedAt?: string;
}

/** An engineer whose queue can be searched. */
export interface QueueOption {
  id: string;
  name: string;
  email?: string;
  /** True for the signed-in user, so their own queue can be pre-selected. */
  me?: boolean;
}

/**
 * How a ticket reads in the picker.
 *
 * The number first, because that is what people say out loud, then the
 * requester, then the subject. Subject-first sorts alphabetically into
 * nonsense and buries the only two facts that identify a ticket.
 */
export function ticketLabel(ticket: TicketOption): string {
  const who = ticket.requesterName ?? ticket.organisation ?? ticket.requesterEmail;
  return [`#${ticket.id}`, who, ticket.subject].filter(Boolean).join(' · ');
}

/** Newest first, because a document is nearly always about recent work. */
export function sortTickets(tickets: readonly TicketOption[]): TicketOption[] {
  return [...tickets].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.id.localeCompare(b.id));
}

/**
 * What the confirmation screen shows before anything is sent.
 *
 * Everything needed to notice a mistake: the number, who will receive it,
 * and whether they will see it at all. A confirmation that only repeats the
 * ticket number confirms nothing — the mistake being guarded against is the
 * right document on the wrong customer's ticket.
 */
export function handoffSummary(input: {
  ticket: TicketOption;
  visibility: NoteVisibility;
  document: HandoffDocument;
}): { heading: string; rows: Array<{ label: string; value: string }>; warning?: string } {
  const rows: Array<{ label: string; value: string }> = [
    { label: 'Ticket', value: `#${input.ticket.id}` },
    { label: 'Subject', value: input.ticket.subject },
  ];
  if (input.ticket.requesterName) rows.push({ label: 'Requester', value: input.ticket.requesterName });
  if (input.ticket.requesterEmail) rows.push({ label: 'Email', value: input.ticket.requesterEmail });
  if (input.ticket.requesterPhone) rows.push({ label: 'Phone', value: input.ticket.requesterPhone });
  if (input.ticket.organisation) rows.push({ label: 'Organisation', value: input.ticket.organisation });
  if (input.ticket.assigneeName) rows.push({ label: 'Assigned to', value: input.ticket.assigneeName });
  rows.push({ label: 'Document', value: input.document.filename });

  return {
    heading: input.visibility === 'public' ? 'This goes to the customer' : 'This stays internal',
    rows,
    ...(input.visibility === 'public'
      ? {
          warning:
            `${input.ticket.requesterName ?? 'The requester'} will be emailed this, and the document with it. ` +
            'Nothing you have written on the document as a note is included.',
        }
      : {}),
  };
}
