/**
 * What the supplier charges us, and what we pass on.
 *
 * Its own module with no imports, deliberately. It was a constant in
 * `lineHandover`, which `lineTestAdvice` cannot import because
 * `lineHandover` imports `lineTestAdvice` — so the one file that needed the
 * figure had it written out by hand, and a price change updated everywhere
 * except there. A leaf module makes "change it in one place" true.
 */

/**
 * A visit that finds nothing wrong with the network.
 *
 * Quoted to the customer before anything is booked, in the gate questions,
 * on the visit message and on the cancellation window — the whole point
 * being that nobody learns the number after the fact.
 */
export const NO_SHOW_CHARGE_PENCE = 19_900;

export const NO_SHOW_CHARGE = '£199 + VAT';

/**
 * The same charge with VAT added, which must never appear anywhere.
 *
 * Not a figure to show: the customer is quoted ex-VAT like every other line
 * on their bill, and quoting one number inclusive and the rest exclusive is
 * how an invoice query starts. Exported so a test can assert it is absent
 * rather than hard-coding a number that goes stale the next time the price
 * moves.
 */
export const VAT_RATE = 0.2;

export const chargeWithVat = (): string =>
  `£${((NO_SHOW_CHARGE_PENCE * (1 + VAT_RATE)) / 100).toFixed(2).replace(/\.00$/, '')}`;
