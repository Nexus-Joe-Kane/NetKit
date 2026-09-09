import {
  clientTokens,
  normaliseCli,
  type LookupSuggestion,
  type SimRecord,
  type LineRecord,
} from '@sw/shared';
import { providers } from '../providers/registry';
import { simEstate } from './operations';

/**
 * Finding the thing, not just the building.
 *
 * The lookup box used to answer one question — which premises is this — and
 * an engineer with a client name in front of them wanted a different one:
 * what do we sell these people. So it now searches the service inventories
 * alongside AddressBase and says which kind of thing each row is.
 *
 * The three sources are not equally searchable, and pretending otherwise
 * would be the mistake here.
 *
 * The mobile estate is already fetched whole and cached, so searching it by
 * name, site, number, ICCID or postcode costs nothing and works on all of
 * them. That is the good case.
 *
 * Broadband is not: the suppliers' service searches match a reference, a
 * postcode, a service id or a phone number — not a customer name. So a
 * client name finds their SIMs and their premises, and their circuits only
 * once there is a postcode or a reference to search by. That is a limit of
 * the upstream API rather than a decision, and the UI says so rather than
 * looking broken.
 */

/** Enough to be a search rather than a wildcard. */
const MIN_TERM = 3;

/** Per kind, so one noisy source cannot fill the list. */
const PER_KIND = 6;

const strip = (value: string): string =>
  value
    .replace(/['‘’]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Does this record answer the query?
 *
 * Every word typed has to appear somewhere in the record, which is what
 * makes "megans richmond" narrow rather than widen. Digits are compared
 * without their punctuation so `07700 900123` matches `447700900123`.
 */
function hits(haystack: string[], term: string): boolean {
  const text = strip(haystack.filter(Boolean).join(' '));
  const digits = haystack.join('').replace(/\D+/g, '');
  const wanted = strip(term).split(' ').filter(Boolean);
  if (!wanted.length) return false;

  return wanted.every((word) => {
    if (/^\d+$/.test(word)) return numberForms(word).some((form) => digits.includes(form));
    return text.includes(word);
  });
}

/**
 * The same number, written the ways people and providers write it.
 *
 * An engineer types `07700900123`; the provider stores `+44 7700 900123`.
 * Comparing digits alone is not enough, because one starts `0` and the other
 * `44`. So a leading `0` also tries `44`, and a leading `44` also tries `0`.
 *
 * Only the leading digits are touched. Rewriting a `0` anywhere inside a
 * number would match an ICCID against a phone number and put somebody
 * else's SIM in the list.
 */
function numberForms(digitsTyped: string): string[] {
  const forms = new Set([digitsTyped]);
  if (digitsTyped.startsWith('0')) forms.add(`44${digitsTyped.slice(1)}`);
  if (digitsTyped.startsWith('44')) forms.add(`0${digitsTyped.slice(2)}`);
  return [...forms];
}

function simToSuggestion(sim: SimRecord): LookupSuggestion {
  const number = sim.msisdn ? normaliseCli(sim.msisdn) ?? sim.msisdn : undefined;
  const label = number ?? sim.iccid;
  const detail = [sim.clientName, sim.site, sim.network, sim.state].filter(Boolean).join(' · ');

  return {
    kind: 'mobile',
    id: `sim:${sim.iccid}`,
    label,
    ...(detail ? { detail } : {}),
    // The ICCID, because that is what the SIM's own detail view is keyed on
    // and a number can be reassigned to a different SIM.
    query: sim.iccid,
    iccid: sim.iccid,
    ...(number ? { cli: number } : {}),
    ...(sim.clientName ? { client: sim.clientName } : {}),
    ...(sim.postcode ? { postcode: sim.postcode } : {}),
    source: sim.zenReference ? 'zen' : 'jola',
  };
}

function lineToSuggestion(line: LineRecord): LookupSuggestion {
  const reference = line.serviceId ?? line.orderRef ?? line.id;
  const detail = [line.address.singleLine, line.technology, line.status].filter(Boolean).join(' · ');

  return {
    kind: 'broadband',
    id: `line:${reference}`,
    label: line.productName ?? `${line.technology} — ${reference}`,
    ...(detail ? { detail } : {}),
    query: reference,
    serviceReference: reference,
    ...(line.cli ? { cli: line.cli } : {}),
    ...(line.address.postcode ? { postcode: line.address.postcode } : {}),
    ...(line.address.postTown ? { postTown: line.address.postTown } : {}),
    ...(line.address.uprn ? { uprn: line.address.uprn } : {}),
    source: line.discoveredVia ?? line.provider,
  };
}

/**
 * The mobile half.
 *
 * Filtered here rather than upstream because the estate is one cached
 * fetch — asking the provider per keystroke would be a request per
 * character for an answer already in memory.
 */
async function findMobiles(term: string): Promise<LookupSuggestion[]> {
  try {
    const estate = await simEstate();
    const sims: SimRecord[] = estate.data?.sims ?? [];
    return sims
      .filter((sim) =>
        hits(
          [
            sim.msisdn ?? '',
            sim.iccid,
            sim.clientName ?? '',
            sim.site ?? '',
            sim.postcode ?? '',
            ...(sim.tags ?? []),
          ],
          term,
        ),
      )
      .slice(0, PER_KIND)
      .map(simToSuggestion);
  } catch {
    // A lookup that cannot reach the mobile estate still finds premises.
    return [];
  }
}

/**
 * The broadband half.
 *
 * Only asked when the term is something a supplier's service search can
 * actually match: a postcode, a reference, or a number. A customer name
 * would return nothing and cost a request per keystroke to learn it.
 */
const SEARCHABLE_BROADBAND =
  /^([A-PR-UWYZ][A-HK-Y]?[0-9][0-9A-HJKPSTUW]?\s*[0-9][ABD-HJLNP-UW-Z]{2}|[A-Z]{2,4}\d{4,}|\d{6,})$/i;

async function findBroadband(term: string): Promise<LookupSuggestion[]> {
  if (!SEARCHABLE_BROADBAND.test(term.trim())) return [];

  const reg = providers();
  const found = new Map<string, LookupSuggestion>();

  await Promise.all(
    reg.lines.map(async (provider) => {
      if (!provider.byFreeText) return;
      try {
        for (const line of await provider.byFreeText(term.trim())) {
          const suggestion = lineToSuggestion(line);
          if (!found.has(suggestion.id)) found.set(suggestion.id, suggestion);
        }
      } catch {
        // One supplier being unreachable is not the lookup failing.
      }
    }),
  );

  return [...found.values()].slice(0, PER_KIND);
}

export interface ServiceLookupResult {
  broadband: LookupSuggestion[];
  mobile: LookupSuggestion[];
  /**
   * True when the term is a name rather than an identifier, so the broadband
   * inventories could not be searched. Said out loud on the list, because
   * "no circuits found" and "circuits cannot be searched by name" are
   * different answers and only one of them is about the customer.
   */
  broadbandNeedsIdentifier: boolean;
}

/** Services matching a typed term, for the lookup list. */
export async function findServices(term: string): Promise<ServiceLookupResult> {
  const query = term.trim();
  // A single word of two characters is not a search, and a bare name with no
  // identifying words in it cannot narrow anything.
  if (query.length < MIN_TERM) {
    return { broadband: [], mobile: [], broadbandNeedsIdentifier: false };
  }

  const [broadband, mobile] = await Promise.all([findBroadband(query), findMobiles(query)]);

  return {
    broadband,
    mobile,
    broadbandNeedsIdentifier:
      broadband.length === 0 && !SEARCHABLE_BROADBAND.test(query) && clientTokens(query).length > 0,
  };
}

/** Test hook: the two decisions worth pinning down without a network. */
export const __lookupTesting = { hits, numberForms, SEARCHABLE_BROADBAND };
