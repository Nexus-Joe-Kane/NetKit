import type { AddressRecord, AddressSuggestion } from './types';
import { formatPostcode } from './identify';

/** The pieces of an address that make up the street-level lines. */
type AddressParts = Pick<
  AddressRecord,
  | 'organisation'
  | 'subBuilding'
  | 'buildingName'
  | 'buildingNumber'
  | 'dependentThoroughfare'
  | 'thoroughfare'
  | 'doubleDependentLocality'
  | 'dependentLocality'
  | 'postTown'
  | 'postcode'
  | 'county'
>;

const clean = (v?: string) => (v && v.trim() ? v.trim() : undefined);

/**
 * Builds PAF-style display lines. The number is joined to the street rather
 * than sitting on its own line, which is what makes `12 High Street` read
 * correctly instead of `12` / `High Street`.
 */
export function addressLines(p: AddressParts): string[] {
  const lines: string[] = [];
  const push = (v?: string) => {
    const c = clean(v);
    if (c) lines.push(c);
  };

  push(p.organisation);

  const sub = clean(p.subBuilding);
  const name = clean(p.buildingName);
  const number = clean(p.buildingNumber);
  const street = clean(p.thoroughfare);
  const depStreet = clean(p.dependentThoroughfare);

  // Sub-building and building name go on their own lines, unless the
  // sub-building is a simple `Flat 3` that reads better joined to the name.
  if (sub && name) push(`${sub}, ${name}`);
  else if (sub && !number) push(sub);
  else push(name);

  const streetLine = [number, depStreet ?? street].filter(Boolean).join(' ');
  if (streetLine) {
    push(sub && number && !name ? `${sub}, ${streetLine}` : streetLine);
  } else if (sub && number) {
    push(`${sub}, ${number}`);
  }

  // When both thoroughfare levels exist, the parent street is its own line.
  if (depStreet && street) push(street);

  push(p.doubleDependentLocality);
  push(p.dependentLocality);
  push(p.postTown);
  return lines;
}

/** `Flat 3, 12 High Street, Manchester, M1 1AA` */
export function singleLineAddress(p: AddressParts): string {
  const parts = addressLines(p);
  const pc = clean(p.postcode);
  return [...parts, pc ? formatPostcode(pc) : undefined].filter(Boolean).join(', ');
}

/**
 * Fills in `lines` and `singleLine` from the structured fields, so adapters
 * only have to populate what their upstream actually returns.
 */
export function finaliseAddress(a: Omit<AddressRecord, 'lines' | 'singleLine'> & Partial<AddressRecord>): AddressRecord {
  const lines = a.lines?.length ? a.lines : addressLines(a);
  const singleLine = a.singleLine?.trim()
    ? a.singleLine.trim()
    : [...lines, a.postcode ? formatPostcode(a.postcode) : undefined].filter(Boolean).join(', ');
  return {
    ...a,
    postcode: a.postcode ? formatPostcode(a.postcode) : '',
    lines,
    singleLine,
  } as AddressRecord;
}

/**
 * The dropdown label: the whole address, post town included.
 *
 * It used to stop before the post town, which made two premises with the
 * same building name in different towns look identical -- and the only thing
 * distinguishing them in the list was a UPRN, which nobody can identify a
 * building from. The postcode is shown alongside by the caller, so the two
 * together read as the address someone would recognise.
 */
export function suggestionLabel(a: AddressRecord): string {
  return a.lines.length ? a.lines.join(', ') : a.singleLine;
}

export function toSuggestion(a: AddressRecord): AddressSuggestion {
  return {
    id: a.uprn ?? a.udprn ?? a.singleLine,
    ...(a.uprn ? { uprn: a.uprn } : {}),
    label: suggestionLabel(a),
    postcode: a.postcode,
    postTown: a.postTown,
    source: a.source,
  };
}

/**
 * Orders addresses the way a human expects a dropdown: by street, then by
 * house number numerically (so 2 comes before 10), then by flat.
 */
export function sortAddresses(list: AddressRecord[]): AddressRecord[] {
  const numOf = (v?: string) => {
    const m = v?.match(/\d+/);
    return m ? Number.parseInt(m[0], 10) : Number.MAX_SAFE_INTEGER;
  };
  return [...list].sort((a, b) => {
    const street = (a.thoroughfare ?? '').localeCompare(b.thoroughfare ?? '');
    if (street !== 0) return street;
    const num = numOf(a.buildingNumber) - numOf(b.buildingNumber);
    if (num !== 0) return num;
    const name = (a.buildingName ?? '').localeCompare(b.buildingName ?? '');
    if (name !== 0) return name;
    return (a.subBuilding ?? '').localeCompare(b.subBuilding ?? '', undefined, { numeric: true });
  });
}

/**
 * Scores a free-text query against an address for typeahead ranking.
 * Returns 0 when it doesn't match at all.
 */
export function scoreAddress(query: string, a: AddressRecord): number {
  const q = query.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!q) return 0;
  const hay = a.singleLine.toLowerCase();
  const terms = q.split(' ').filter(Boolean);
  let score = 0;
  for (const t of terms) {
    if (!hay.includes(t)) return 0;
    score += hay.startsWith(t) ? 3 : 1;
  }
  // Prefer shorter addresses on equal matches — they're the more general hit.
  return score + Math.max(0, 40 - a.singleLine.length) / 100;
}

/** OS AddressBase classification prefix → premises type. */
export function premisesTypeFor(classificationCode?: string): AddressRecord['premisesType'] {
  if (!classificationCode) return 'unknown';
  const c = classificationCode.toUpperCase();
  if (c.startsWith('RD') || c.startsWith('RH') || c.startsWith('RI')) return 'residential';
  if (c.startsWith('C')) return 'business';
  if (c.startsWith('M') || c.startsWith('X')) return 'mixed';
  return 'other';
}
