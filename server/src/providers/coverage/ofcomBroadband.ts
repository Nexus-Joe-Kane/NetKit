import type { AddressRecord, PredictedSpeeds } from '@sw/shared';
import { config } from '../../config';
import { fetchJson } from '../../lib/http';
import { TtlCache } from '../../lib/cache';

/**
 * Ofcom's Connected Nations Broadband API.
 *
 * Free with a developer account — 50,000 requests a month on the Basic tier —
 * and the only free source that gives a *per-premises* answer about what
 * broadband a UK address can actually get.
 *
 * What it is good for: an independent check. Zen's estimate for an Openreach
 * line and Ofcom's prediction for the same premises are two different models,
 * and when they disagree sharply that is worth knowing before promising
 * anything to a customer. It is also the honest free answer to "is there
 * gigabit here at all" when no wholesale account is connected yet.
 *
 * What it will never do: **name an operator.** Ofcom withhold the
 * per-provider split as commercially confidential, and their schema has no
 * operator field at all — only speed tiers. So this can say "1000 Mb is
 * predicted at this premises" and never "Community Fibre serves it". That
 * limit is the whole reason it sits beside the offers table rather than
 * adding rows to it: a row with no operator is not something anyone can buy.
 *
 * Unlike the other integrations here, the response shape is **known** rather
 * than guessed — Ofcom publish an OpenAPI document, and these are their field
 * names verbatim.
 */

/** `BroadbandProvision` in Ofcom's schema, one entry per premises. */
interface BroadbandProvision {
  UPRN?: number;
  AddressShortDescription?: string;
  PostCode?: string;
  /** Basic broadband. */
  MaxBbPredictedDown?: number;
  MaxBbPredictedUp?: number;
  /** Superfast: 30 Mb and above. */
  MaxSfbbPredictedDown?: number;
  MaxSfbbPredictedUp?: number;
  /** Ultrafast: 300 Mb and above. */
  MaxUfbbPredictedDown?: number;
  MaxUfbbPredictedUp?: number;
  /** Best of any technology. */
  MaxPredictedDown?: number;
  MaxPredictedUp?: number;
}

/** `FixedAvailability` in Ofcom's schema. */
interface FixedAvailability {
  PostCode?: string;
  Availability?: BroadbandProvision[];
  Count?: number;
}

/**
 * Ofcom's model is revised on a publication cycle measured in months, so a
 * long cache costs nothing and keeps well inside the monthly quota.
 */
const cache = new TtlCache<FixedAvailability | null>(24 * 60 * 60 * 1000, 3000);

const positive = (v?: number): number | undefined => (typeof v === 'number' && v > 0 ? v : undefined);

/**
 * Turns the postcode's premises list into one answer for one address.
 *
 * A UPRN match is the point of the API and is used whenever it is there. The
 * postcode fallback is the *maximum* across premises rather than the mean,
 * with `premisesMatched: false` so the UI can say which it is — an average
 * would understate a premises that can get fibre because its neighbours
 * cannot, and this figure is only ever read as "what is possible here".
 */
export function summarise(payload: FixedAvailability | null, uprn?: string): PredictedSpeeds | null {
  const rows = payload?.Availability ?? [];
  if (!rows.length) return null;

  const exact = uprn ? rows.find((r) => r.UPRN != null && String(r.UPRN) === uprn) : undefined;

  if (exact) {
    const predicted: PredictedSpeeds = {
      premisesMatched: true,
      premisesInPostcode: payload?.Count ?? rows.length,
      source: 'ofcom:broadband-api',
    };
    const down = positive(exact.MaxPredictedDown) ?? positive(exact.MaxUfbbPredictedDown) ?? positive(exact.MaxSfbbPredictedDown) ?? positive(exact.MaxBbPredictedDown);
    const up = positive(exact.MaxPredictedUp) ?? positive(exact.MaxUfbbPredictedUp) ?? positive(exact.MaxSfbbPredictedUp) ?? positive(exact.MaxBbPredictedUp);
    if (down != null) predicted.maxDownMbps = down;
    if (up != null) predicted.maxUpMbps = up;
    const sf = positive(exact.MaxSfbbPredictedDown);
    const uf = positive(exact.MaxUfbbPredictedDown);
    if (sf != null) predicted.superfastDownMbps = sf;
    if (uf != null) predicted.ultrafastDownMbps = uf;
    return predicted;
  }

  const best = (get: (r: BroadbandProvision) => number | undefined): number | undefined => {
    const values = rows.map(get).filter((v): v is number => typeof v === 'number' && v > 0);
    return values.length ? Math.max(...values) : undefined;
  };

  const down = best((r) => r.MaxPredictedDown) ?? best((r) => r.MaxUfbbPredictedDown) ?? best((r) => r.MaxSfbbPredictedDown) ?? best((r) => r.MaxBbPredictedDown);
  const up = best((r) => r.MaxPredictedUp) ?? best((r) => r.MaxUfbbPredictedUp) ?? best((r) => r.MaxSfbbPredictedUp) ?? best((r) => r.MaxBbPredictedUp);
  if (down == null && up == null) return null;

  const predicted: PredictedSpeeds = {
    premisesMatched: false,
    premisesInPostcode: payload?.Count ?? rows.length,
    source: 'ofcom:broadband-api',
  };
  if (down != null) predicted.maxDownMbps = down;
  if (up != null) predicted.maxUpMbps = up;
  const sf = best((r) => r.MaxSfbbPredictedDown);
  const uf = best((r) => r.MaxUfbbPredictedDown);
  if (sf != null) predicted.superfastDownMbps = sf;
  if (uf != null) predicted.ultrafastDownMbps = uf;
  return predicted;
}

export function ofcomBroadbandConfigured(): boolean {
  return config().ofcomBroadband.configured;
}

/** Predicted speeds for one premises, or null when Ofcom have nothing. */
export async function predictedSpeedsFor(address: AddressRecord): Promise<PredictedSpeeds | null> {
  const cfg = config().ofcomBroadband;
  if (!cfg.configured) return null;

  // Ofcom require the postcode uppercase with spaces removed.
  const postcode = address.postcode.replace(/\s+/g, '').toUpperCase();
  if (!postcode) return null;

  let payload = cache.get(postcode);
  if (payload === undefined) {
    payload = await fetchJson<FixedAvailability>(`${cfg.baseUrl.replace(/\/$/, '')}/coverage/${encodeURIComponent(postcode)}`, {
      label: 'Ofcom broadband API',
      headers: { 'Ocp-Apim-Subscription-Key': cfg.apiKey },
      timeoutMs: Math.min(config().requestTimeoutMs, 8000),
      retries: 1,
      // A postcode Ofcom have no record of is a 404, and a legitimate answer.
      notFoundAsNull: true,
    });
    cache.set(postcode, payload);
  }

  return summarise(payload, address.uprn);
}

/** Recovery hook — drops cached predictions. */
export function clearOfcomBroadbandCache(): void {
  cache.clear();
}

/** Test hook. */
export const __ofcomBroadbandTesting = { summarise };
