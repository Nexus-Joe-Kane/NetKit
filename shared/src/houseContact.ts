/**
 * The contact details every supplier ticket carries.
 *
 * Fixed on purpose, and enforced on the server rather than defaulted in the
 * form. A supplier who has an engineer's direct line rings the engineer at
 * six in the evening; one who has the desk number reaches whoever is on. The
 * same goes for email — an update sitting in one person's inbox is an update
 * the rest of the team cannot see.
 *
 * These are the company's published details, the same ones in the page
 * footer, so there is nothing here to keep out of the repository.
 */
/**
 * How every site-visit message signs off.
 *
 * One constant, because these go out under a team name rather than a
 * person's and a template that signs off differently from its siblings reads
 * as though it came from somewhere else.
 */
export const SITE_VISIT_SIGN_OFF = 'SupportWizard Network Support Team';

export const HOUSE_CONTACT = {
  name: 'SupportWizard Support Desk',
  email: 'help@supportwizard.net',
  phone: '020 7043 3171',
} as const;

/** A site contact at the customer's premises, for the picker. */
export interface SiteContact {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  /** The organisation they belong to, so a picker can say whose they are. */
  organisation?: string;
}

/** "Jane Okafor — jane@example.co.uk", which is what the dropdown shows. */
export const siteContactLabel = (contact: SiteContact): string =>
  contact.email ? `${contact.name} — ${contact.email}` : contact.name;

/* ------------------------------------------------------------------ *
 * Ticket notes
 * ------------------------------------------------------------------ */

/**
 * The private note left on a ticket when a fault is raised.
 *
 * Private, always. What was sent to a supplier and what came back is
 * engineering detail: useful to whoever picks the ticket up next, and not
 * something a customer should read raw. The one thing a customer *does* need
 * — that a visit is booked — is a separate, deliberately public message
 * below.
 */
export function faultRaisedNote(input: {
  reference?: string;
  serviceReference: string;
  category: string;
  frequency: string;
  summary: string;
  testsCarriedOut?: string;
  siteContact?: SiteContact;
  raisedBy?: string;
  supplier?: string;
}): string {
  const lines = [
    `Fault raised with ${input.supplier ?? 'the supplier'}.`,
    '',
    ...(input.reference ? [`Supplier reference: ${input.reference}`] : []),
    `Service reference: ${input.serviceReference}`,
    `Category: ${input.category} / ${input.frequency}`,
    '',
    'Reported as:',
    input.summary,
  ];

  if (input.testsCarriedOut) {
    lines.push('', 'Tests already carried out:', input.testsCarriedOut);
  }

  if (input.siteContact) {
    lines.push(
      '',
      `Site contact given to the supplier: ${siteContactLabel(input.siteContact)}`,
      ...(input.siteContact.phone ? [`Site contact number: ${input.siteContact.phone}`] : []),
    );
  }

  lines.push(
    '',
    `Supplier contact on the fault: ${HOUSE_CONTACT.email} / ${HOUSE_CONTACT.phone}`,
    ...(input.raisedBy ? [`Raised in NetKit by ${input.raisedBy}.`] : []),
  );

  return lines.join('\n');
}

/**
 * The private note left on a ticket when a line test is run.
 *
 * Readings that the provider itself called a problem are marked, because a
 * column of numbers with no verdict is a column nobody reads — and the whole
 * value of this note to the next engineer is "here is what was already
 * measured, and here is what was wrong with it".
 */
export function lineTestNote(input: {
  testType: string;
  serviceReference: string;
  outcome: string;
  summary?: string;
  faultLocation?: string;
  detail?: Array<{ label: string; value: string; verdict?: 'ok' | 'warn' | 'fail' }>;
  recommendations?: string[];
  runBy?: string;
}): string {
  const lines = [
    `Line test run: ${input.testType} on ${input.serviceReference}.`,
    '',
    `Outcome: ${input.outcome}`,
    ...(input.faultLocation ? [`Fault located: ${input.faultLocation}`] : []),
    ...(input.summary ? ['', input.summary] : []),
  ];

  if (input.detail?.length) {
    lines.push(
      '',
      'Readings:',
      ...input.detail.map((d) => {
        const flag = d.verdict === 'fail' ? '  ← FAIL' : d.verdict === 'warn' ? '  ← warning' : '';
        return `· ${d.label}: ${d.value}${flag}`;
      }),
    );
  }

  if (input.recommendations?.length) {
    lines.push('', 'Provider recommends:', ...input.recommendations.map((r) => `· ${r}`));
  }

  if (input.runBy) lines.push('', `Run in NetKit by ${input.runBy}.`);
  return lines.join('\n');
}

/**
 * The customer-facing message when a site visit is booked.
 *
 * Public, unlike everything else here, because it is the one thing the
 * customer has to act on: somebody has to be there.
 *
 * Vague about who is coming, on purpose. Naming Openreach or a particular
 * alt-net invites the customer to ring them directly, which loses us the
 * thread and gets them nowhere — the supplier will not talk to an end
 * customer about a wholesale fault.
 *
 * Both charges are stated plainly. A missed appointment is billed to us and
 * passed on, and a customer who learns that afterwards is a customer who
 * disputes it.
 */
export function siteVisitBookedMessage(input: { supplier?: string; contactName?: string } = {}): string {
  const supplier = input.supplier?.trim() || 'the network supplier';
  const greeting = input.contactName?.trim() ? `Hello ${input.contactName.trim()},` : 'Hello,';

  return [
    greeting,
    '',
    `We have booked an engineer visit with ${supplier} for this fault. We will come back to you shortly with the ` +
      'date and time slot as soon as they confirm it.',
    '',
    'Two things worth knowing before then:',
    '',
    '· If the appointment turns out to be inconvenient, please let us know as early as you can. We need at least ' +
      '24 hours’ notice to move or cancel a booked visit — inside that window the supplier treats it as an ' +
      'attended appointment and charges for it.',
    '',
    '· Somebody will need to be on site to let the engineer in and to be there for the duration of the visit. If ' +
      'nobody is available when they arrive, the visit is charged as a missed appointment and we will have to ' +
      'book another one.',
    '',
    'We will be in touch with the slot as soon as we have it. If anything changes at your end in the meantime, ' +
      'just reply to this ticket.',
    '',
    'Kind regards',
    SITE_VISIT_SIGN_OFF,
  ].join('\n');
}
