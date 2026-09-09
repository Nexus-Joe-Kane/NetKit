/**
 * What terms a client is on, and what that stops.
 *
 * Three standings, each of which changes what an engineer is allowed to do
 * before doing it rather than after:
 *
 * - **On support** — a contract. Work proceeds.
 * - **Pay as you go** — time has to be bought before work starts. The nudge
 *   is not a warning label, it is a question, because the answer decides
 *   whether the next hour is billable or written off.
 * - **On stop** — non-payment. Services get barred, and the reminder that
 *   they are barred deliberately has to survive somebody else opening the
 *   record a week later and "fixing" it.
 *
 * The wording is Joe's, kept as written: a template that sounds like the
 * person who wrote it lands better than one that sounds like a system.
 */

export type AccountStanding = 'support' | 'payg' | 'on-stop' | 'unknown';

export interface StandingDef {
  id: AccountStanding;
  label: string;
  /** How loudly it announces itself. */
  prominence: 'blocking' | 'quiet' | 'none';
  /** One line for a badge tooltip. */
  hint: string;
}

export const STANDINGS: readonly StandingDef[] = [
  {
    id: 'support',
    label: 'On support',
    prominence: 'quiet',
    hint: 'Covered by a support contract. Work proceeds.',
  },
  {
    id: 'payg',
    label: 'Pay as you go',
    prominence: 'blocking',
    hint: 'Time must be bought before work starts.',
  },
  {
    id: 'on-stop',
    label: 'On stop',
    prominence: 'blocking',
    hint: 'Non-payment. Services barred — do not unbar without checking with accounts.',
  },
  { id: 'unknown', label: 'Terms not recorded', prominence: 'none', hint: 'No standing found for this client.' },
] as const;

export const standingDef = (id: AccountStanding): StandingDef =>
  STANDINGS.find((s) => s.id === id) ?? STANDINGS[STANDINGS.length - 1]!;

/**
 * Reads a standing out of whatever the source calls it.
 *
 * IT Glue and Zendesk both hold this as free text on an organisation, and
 * nobody types it the same way twice. Matched on the words that carry the
 * meaning, and an unrecognised value becomes `unknown` rather than being
 * optimistically read as "on support" — assuming a contract exists is the
 * expensive direction to be wrong in.
 */
export function readStanding(raw?: string | null): AccountStanding {
  const v = (raw ?? '').toLowerCase();
  if (!v.trim()) return 'unknown';
  // On stop first: "on stop (was payg)" has to read as on stop.
  if (/\bon[- ]?stop\b|\bstopped\b|\bcredit hold\b|\bsuspended for non[- ]?payment\b/.test(v)) return 'on-stop';
  if (/\bpayg\b|\bpay[- ]as[- ]you[- ]go\b|\bad[- ]?hoc\b|\bt&m\b|\btime and materials\b/.test(v)) return 'payg';
  if (/\bsupport\b|\bcontract(ed)?\b|\bmanaged\b|\bretainer\b|\bbreak[- ]?fix\b/.test(v)) return 'support';
  return 'unknown';
}

/* ------------------------------------------------------------------ *
 * Pay as you go
 * ------------------------------------------------------------------ */

export const STORE_URL = 'https://supportwizard.net/store';

/**
 * The nudge, before an engineer starts work.
 *
 * A question rather than a banner. A banner gets read once and then stops
 * being seen; a question with a No that does something is answered.
 */
export function paygNudge(input: { clientName: string; engineerFirstName?: string }): string {
  const who = input.engineerFirstName?.trim();
  return (
    `${who ? `${who} — just` : 'Just'} a reminder that ${input.clientName} are on Pay as you go. ` +
    'Please make sure they have purchased support time before carrying on with this work.'
  );
}

/**
 * The email when the answer is no.
 *
 * Joe's wording, deliberately unchanged. Signed from the person, not the
 * team: it is a small ask about money and it reads better from a name.
 */
export function paygEmail(input: {
  contactFirstName: string;
  clientName: string;
  /** Who is sending it, so it is signed by whoever is on. */
  fromFirstName: string;
}): { subject: string; body: string } {
  return {
    subject: `${input.clientName} — support time needed before we can action this`,
    body: [
      `Hi ${input.contactFirstName},`,
      '',
      `It looks like ${input.clientName} is on PAYG terms for IT Support currently, so you would need to ` +
        'purchase time from our website before we’re able to action this request.',
      '',
      `Here's the link: ${STORE_URL}`,
      '',
      'If you have any questions, feel free to let me know!',
      '',
      'All the best,',
      '',
      input.fromFirstName,
    ].join('\n'),
  };
}

/**
 * How many open tickets make a picker worth showing.
 *
 * Under five and an engineer can recognise the right one from a title. Over
 * that and a list becomes a search problem, so the picker is not offered and
 * the ticket number is asked for instead — a wrong ticket gets a payment
 * request in front of the wrong customer.
 */
export const PAYG_PICKER_LIMIT = 5;

/** A first name from a full name, for a greeting. */
export function firstName(full?: string): string {
  const first = (full ?? '').trim().split(/\s+/)[0] ?? '';
  return first || 'there';
}

/* ------------------------------------------------------------------ *
 * On stop
 * ------------------------------------------------------------------ */

export type BarrableService = 'sim' | 'line';

export interface BarAction {
  kind: BarrableService;
  /** ICCID or service reference. */
  identifier: string;
  label: string;
  /** Set once the provider has confirmed it. */
  appliedAt?: string;
  /** Set when it could not be applied, with the reason. */
  error?: string;
}

/**
 * What goes on stop when a client does.
 *
 * Everything that carries a recurring cost we cannot recover: mobile data and
 * broadband. Deliberately not voice — barring a phone line for non-payment
 * can leave somebody unable to call 999, and that is not a decision a
 * collections process gets to make automatically.
 */
export function barsForOnStop(input: {
  sims: Array<{ iccid: string; msisdn?: string; state: string }>;
  lines: Array<{ serviceId?: string; cli?: string; technology: string; status: string }>;
}): BarAction[] {
  const out: BarAction[] = [];

  for (const sim of input.sims) {
    // Already off is already off.
    if (sim.state === 'ceased' || sim.state === 'suspended') continue;
    out.push({ kind: 'sim', identifier: sim.iccid, label: sim.msisdn ?? sim.iccid });
  }

  for (const line of input.lines) {
    if (line.status !== 'active') continue;
    const id = line.serviceId ?? line.cli;
    if (!id) continue;
    out.push({ kind: 'line', identifier: id, label: `${line.technology} ${line.cli ?? id}` });
  }

  return out;
}

/**
 * The reminder that a bar is deliberate.
 *
 * The failure this exists to stop is somebody else opening the record next
 * week, seeing a barred line, and helpfully unbarring it — so the wording
 * names the reason and who to ask, rather than just saying "barred".
 */
export function onStopReminder(input: { clientName: string; since?: string; barred: number }): string {
  const when = input.since ? ` since ${input.since}` : '';
  return (
    `${input.clientName} is ON STOP${when} for non-payment. ${input.barred} ` +
    `${input.barred === 1 ? 'service has' : 'services have'} been barred on purpose. ` +
    'Do not unbar anything without clearing it with accounts first.'
  );
}
