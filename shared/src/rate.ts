/**
 * Openreach-derived availability APIs quote line rates in kbit/s, and have
 * done since ADSL: an 80/20 FTTC line is published as 80000 and 20000. Zen
 * pass those figures through in fields named only `...SpeedValue`, with no
 * companion unit field to read, so a premises rendered as "80 Gb down /
 * 18.2 Gb up" was really 80000 and 18200 kbit/s -- the right line, off by
 * three orders of magnitude.
 *
 * With no unit to trust, magnitude is the only signal left. The threshold is
 * chosen so that every rate a UK premises can actually be sold stays
 * untouched: the fastest thing quoted at a single address is a 10 Gb
 * Ethernet tail, which is 10000 Mbit/s. Anything above that in a field
 * claiming to be Mbit/s is a kbit/s figure -- 10 Gb is not off by a factor
 * of a thousand from anything orderable.
 *
 * Deliberately not applied to `...Kbps` fields, which say what they are and
 * are correct as they stand.
 */

/** Above this, a value calling itself Mbit/s must really be kbit/s. */
const MAX_PLAUSIBLE_MBPS = 10000;

/**
 * Normalises a rate that claims to be Mbit/s but might be kbit/s.
 *
 * Returns undefined for absent or nonsensical input so callers can keep
 * omitting the field rather than showing a zero.
 */
export function mbpsFromRate(value?: number | null): number | undefined {
  if (value == null || !Number.isFinite(value) || value <= 0) return undefined;
  if (value <= MAX_PLAUSIBLE_MBPS) return value;
  // Two decimals: 18200 kbit/s is exactly 18.2, and rounding keeps binary
  // floating point from rendering it as 18.200000000000003.
  return Math.round((value / 1000) * 100) / 100;
}
