/**
 * Comparing a retyped confirmation against the value it must match.
 *
 * The point of asking someone to retype an address is to make them read it.
 * Being strict about a comma or a capital letter does not serve that — it
 * just makes a careful operator retype three times and start copy-pasting,
 * which defeats the guard entirely. So punctuation, case and repeated
 * whitespace are all forgiven, and everything that carries meaning is not:
 * `Flat 3` and `Flat 4` still differ, and so do `12 High Street` and
 * `12A High Street`.
 */
export function confirmKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** True when a retyped value is close enough to count as confirmation. */
export function confirmMatches(typed: string, expected: string): boolean {
  const key = confirmKey(expected);
  return key.length > 0 && confirmKey(typed) === key;
}
