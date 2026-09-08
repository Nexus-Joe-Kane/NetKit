import type { IdentifierKind, ResolvedIdentifier } from './types';

/* ------------------------------------------------------------------ *
 * Postcodes
 * ------------------------------------------------------------------ */

/** Full UK postcode, incode + outcode, whitespace optional. Includes GIR 0AA. */
const FULL_POSTCODE =
  /^(GIR ?0AA|(?:[A-PR-UWYZ][0-9]{1,2}|[A-PR-UWYZ][A-HK-Y][0-9]{1,2}|[A-PR-UWYZ][0-9][A-HJKPSTUW]|[A-PR-UWYZ][A-HK-Y][0-9][ABEHMNPRVWXY]) ?[0-9][ABD-HJLNP-UW-Z]{2})$/i;

/** Outcode only, e.g. `M1`, `SW1A`, `EC1A`. */
const OUTCODE = /^(?:[A-PR-UWYZ][0-9]{1,2}|[A-PR-UWYZ][A-HK-Y][0-9]{1,2}|[A-PR-UWYZ][0-9][A-HJKPSTUW]|[A-PR-UWYZ][A-HK-Y][0-9][ABEHMNPRVWXY])$/i;

const strip = (s: string) => s.replace(/[\s-]+/g, '').toUpperCase();

export function isFullPostcode(input: string): boolean {
  return FULL_POSTCODE.test(input.trim());
}

export function isOutcode(input: string): boolean {
  return OUTCODE.test(strip(input));
}

/** `sw1a1aa` → `SW1A 1AA`. Returns the trimmed upper-case input if unparseable. */
export function formatPostcode(input: string): string {
  const bare = strip(input);
  if (bare === 'GIR0AA') return 'GIR 0AA';
  if (bare.length < 5 || bare.length > 7) return input.trim().toUpperCase();
  return `${bare.slice(0, bare.length - 3)} ${bare.slice(-3)}`;
}

/** `SW1A 1AA` → `SW1A`. */
export function outcodeOf(postcode: string): string {
  const bare = strip(postcode);
  return bare.length > 3 ? bare.slice(0, bare.length - 3) : bare;
}

/* ------------------------------------------------------------------ *
 * UPRN
 * ------------------------------------------------------------------ */

/**
 * UPRNs are numeric, up to 12 digits, and never start with `0` — which is
 * what lets us tell them apart from UK phone numbers.
 */
export function isUprn(input: string): boolean {
  const bare = strip(input);
  return /^[1-9][0-9]{3,11}$/.test(bare);
}

/* ------------------------------------------------------------------ *
 * Telephone numbers (CLI)
 * ------------------------------------------------------------------ */

/** Strips `+44`, `0044`, `44` and punctuation down to a national `0…` form. */
export function normaliseCli(input: string): string | null {
  let n = input.replace(/[^\d+]/g, '');
  if (n.startsWith('+44')) n = `0${n.slice(3)}`;
  else if (n.startsWith('0044')) n = `0${n.slice(4)}`;
  else if (n.startsWith('44') && n.length >= 11) n = `0${n.slice(2)}`;
  if (!n.startsWith('0')) return null;
  // UK national numbers are 10 digits (a few 01x areas) or 11 digits.
  if (!/^0[1-9]\d{8,9}$/.test(n)) return null;
  return n;
}

export function isCli(input: string): boolean {
  return normaliseCli(input) !== null;
}

/** Coarse classification, used to label the CLI in the UI. */
export function cliType(cli: string): 'geographic' | 'mobile' | 'non-geographic' | 'other' {
  if (/^0(1|2)/.test(cli)) return 'geographic';
  if (/^07/.test(cli)) return 'mobile';
  if (/^0(3|8|9)/.test(cli)) return 'non-geographic';
  return 'other';
}

/* ------------------------------------------------------------------ *
 * Openreach / provider service identifiers
 * ------------------------------------------------------------------ */

/**
 * Openreach and provider reference formats. These are deliberately tolerant:
 * the exact prefix set differs per product family and per reseller, so we
 * match on shape and let the provider adapter reject anything it can't find.
 */
const SERVICE_ID_PATTERNS: Array<{ kind: IdentifierKind; re: RegExp; label: string; confidence: number }> = [
  // Access Line ID — the Openreach "line access id" / ALID.
  { kind: 'lineAccessId', re: /^AL[A-Z]?[0-9]{6,12}$/, label: 'Openreach Access Line ID', confidence: 0.95 },
  // Broadband service identifiers: BBEU/BBFB/BBIP + digits.
  { kind: 'serviceId', re: /^BB[A-Z]{2}[0-9]{6,12}$/, label: 'Openreach broadband service ID', confidence: 0.95 },
  // WLR / analogue service references.
  { kind: 'serviceId', re: /^(?:ANN|WLR|EAD|EU)[0-9]{6,12}$/, label: 'Openreach service ID', confidence: 0.9 },
  // ONT serials are vendor-prefixed and hex-tailed.
  { kind: 'ontSerial', re: /^(?:ALCL|HWTC|ZTEG|NOKG|SMBS|CXNK|ADTN)[0-9A-F]{6,12}$/, label: 'ONT serial number', confidence: 0.9 },
  // Zen-style service references.
  { kind: 'serviceId', re: /^(?:ZEN|ZN)[-]?[0-9]{5,12}$/, label: 'Zen service reference', confidence: 0.9 },
  // Generic alphanumeric reference: letters then digits, no spaces.
  { kind: 'serviceId', re: /^[A-Z]{2,6}[0-9]{5,14}$/, label: 'provider service reference', confidence: 0.55 },
];

export function matchServiceId(
  input: string,
): { kind: IdentifierKind; normalised: string; label: string; confidence: number } | null {
  const bare = strip(input);
  for (const p of SERVICE_ID_PATTERNS) {
    if (p.re.test(bare)) {
      return { kind: p.kind, normalised: bare, label: p.label, confidence: p.confidence };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * The classifier
 * ------------------------------------------------------------------ */

type Candidate = { kind: IdentifierKind; normalised: string; confidence: number; reason: string };

/**
 * Works out what the user typed. Ordering matters: postcodes and phone
 * numbers are unambiguous, so they win; everything digit-only that isn't a
 * phone number is a UPRN; anything with spaces and letters is an address.
 */
export function identify(rawInput: string): ResolvedIdentifier {
  const raw = rawInput ?? '';
  const trimmed = raw.trim();
  const candidates: Candidate[] = [];

  if (!trimmed) {
    return { raw, normalised: '', kind: 'unknown', confidence: 0, alternatives: [], reason: 'Empty search' };
  }

  // 1. Full postcode — highest signal.
  if (isFullPostcode(trimmed)) {
    candidates.push({
      kind: 'postcode',
      normalised: formatPostcode(trimmed),
      confidence: 0.99,
      reason: 'Valid UK postcode',
    });
  }

  const digitsOnly = /^[\d\s+()-]+$/.test(trimmed);

  // 2. Telephone number.
  if (digitsOnly) {
    const cli = normaliseCli(trimmed);
    if (cli) {
      candidates.push({
        kind: 'cli',
        normalised: cli,
        confidence: 0.93,
        reason: `UK ${cliType(cli)} number`,
      });
    }
  }

  // 3. UPRN.
  if (digitsOnly && isUprn(trimmed)) {
    // A 12-digit number starting 1-9 is almost certainly a UPRN; shorter ones
    // are less certain because they overlap with account numbers.
    const len = strip(trimmed).length;
    candidates.push({
      kind: 'uprn',
      normalised: strip(trimmed),
      confidence: len >= 9 ? 0.96 : 0.7,
      reason: `${len}-digit UPRN`,
    });
  }

  // 4. Service / line identifiers.
  const svc = matchServiceId(trimmed);
  if (svc && !isFullPostcode(trimmed)) {
    candidates.push({
      kind: svc.kind,
      normalised: svc.normalised,
      confidence: svc.confidence,
      reason: `Looks like an ${svc.label}`,
    });
  }

  // 5. Outcode — a partial postcode. Treated as an address search because on
  //    its own it is far too broad to resolve a premises.
  if (isOutcode(trimmed)) {
    candidates.push({
      kind: 'address',
      normalised: strip(trimmed),
      confidence: 0.5,
      reason: 'Postcode district only — add more detail',
    });
  }

  // 6. Fall back to a free-text address search.
  if (/[a-z]/i.test(trimmed)) {
    candidates.push({
      kind: 'address',
      normalised: trimmed.replace(/\s+/g, ' '),
      confidence: candidates.length ? 0.35 : 0.6,
      reason: 'Free-text address search',
    });
  }

  if (!candidates.length) {
    return {
      raw,
      normalised: trimmed,
      kind: 'unknown',
      confidence: 0,
      alternatives: [],
      reason: 'Not recognised as a postcode, address, UPRN, CLI or line ID',
    };
  }

  candidates.sort((a, b) => b.confidence - a.confidence);
  const [best, ...rest] = candidates as [Candidate, ...Candidate[]];
  return {
    raw,
    normalised: best.normalised,
    kind: best.kind,
    confidence: best.confidence,
    reason: best.reason,
    alternatives: rest.map((c) => ({ kind: c.kind, normalised: c.normalised, confidence: c.confidence })),
  };
}

/** Human label for a kind, used on the chip next to the search box. */
export function kindLabel(kind: IdentifierKind): string {
  switch (kind) {
    case 'postcode':
      return 'Postcode';
    case 'uprn':
      return 'UPRN';
    case 'address':
      return 'Address';
    case 'cli':
      return 'CLI';
    case 'lineAccessId':
      return 'Access Line ID';
    case 'serviceId':
      return 'Service ID';
    case 'ontSerial':
      return 'ONT Serial';
    default:
      return 'Unknown';
  }
}
