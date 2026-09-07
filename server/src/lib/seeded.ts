/**
 * Deterministic pseudo-randomness.
 *
 * Fixture data has to be *stable*: if support looks up the same UPRN twice
 * they must see the same exchange, the same cabinet and the same line
 * length. Seeding from the identifier gives that for free, and makes the
 * demo mode indistinguishable from a real backend in feel.
 */
export class Seeded {
  private state: number;

  constructor(seed: string) {
    // FNV-1a, which spreads short similar strings (adjacent UPRNs) well.
    let h = 0x811c9dc5;
    for (let i = 0; i < seed.length; i += 1) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    this.state = h || 0x9e3779b9;
  }

  /** mulberry32 — fast, good enough distribution, fully deterministic. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  float(min: number, max: number, dp = 1): number {
    const v = min + this.next() * (max - min);
    return Number.parseFloat(v.toFixed(dp));
  }

  pick<T>(items: readonly T[]): T {
    if (!items.length) throw new Error('Seeded.pick: empty list');
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** Picks `count` distinct items, order preserved. */
  sample<T>(items: readonly T[], count: number): T[] {
    const pool = [...items];
    const out: T[] = [];
    while (out.length < Math.min(count, items.length) && pool.length) {
      out.push(...pool.splice(Math.floor(this.next() * pool.length), 1));
    }
    return out;
  }

  bool(trueProbability = 0.5): boolean {
    return this.next() < trueProbability;
  }

  /** Weighted pick: `[['a', 3], ['b', 1]]` picks `a` three times as often. */
  weighted<T>(pairs: ReadonlyArray<readonly [T, number]>): T {
    const total = pairs.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [value, weight] of pairs) {
      r -= weight;
      if (r <= 0) return value;
    }
    return pairs[pairs.length - 1]![0];
  }

  /** Digit string of a fixed length, never leading zero. */
  digits(length: number): string {
    let s = String(this.int(1, 9));
    while (s.length < length) s += String(this.int(0, 9));
    return s;
  }

  hex(length: number): string {
    let s = '';
    while (s.length < length) s += '0123456789ABCDEF'[this.int(0, 15)];
    return s;
  }

  /** ISO date offset from today by a seeded number of days. */
  dateOffset(minDays: number, maxDays: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + this.int(minDays, maxDays));
    return d.toISOString().slice(0, 10);
  }
}
