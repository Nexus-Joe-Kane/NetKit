import type { HealthResponse } from '@sw/shared';
import { config, shouldRunLive } from '../config';
import { isProviderEnabled } from '../auth/store';
import { createFixtureAddressProvider } from './address/fixture';
import { createOsPlacesProvider } from './address/osPlaces';
import { createFixtureAvailabilityProvider } from './availability/fixture';
import { createFixtureSignalProvider } from './signal/fixture';
import { createOfcomSignalProvider } from './signal/ofcom';
import { createFixtureLineProvider } from './lines/fixture';
import { createFixtureOfferProvider } from './altnet/fixture';
import { createThinkbroadbandProvider } from './altnet/thinkbroadband';
import { createGiacomLineProvider, createGiacomOfferProvider } from './giacom/adapters';
import { createZenAddressProvider, createZenAvailabilityProvider, createZenLineProvider } from './zen/adapters';
import type {
  AddressProvider,
  OfferProvider,
  AvailabilityProvider,
  LineProvider,
  ProviderMeta,
  SignalProvider,
} from './types';

/**
 * Provider chains.
 *
 * Each capability is an ordered list: the first provider that returns a
 * usable answer wins, and a failure falls through to the next. Fixtures sit
 * at the end of every chain so the portal is never a blank page — except in
 * `DATA_MODE=live`, where a failure is surfaced rather than papered over.
 */
export interface Registry {
  address: AddressProvider[];
  availability: AvailabilityProvider[];
  /**
   * Extra options at a premises: alt-net coverage, and any wholesale
   * supplier beyond the primary chain. Unlike the others this chain is
   * *merged* rather than first-wins — a second answer adds options instead
   * of contradicting the first.
   */
  offers: OfferProvider[];
  signal: SignalProvider[];
  lines: LineProvider[];
  describe(): HealthResponse['providers'];
}

/**
 * Built on every call rather than memoised, because an administrator can
 * toggle a provider off at any moment and the next lookup must respect it.
 * Construction is only a handful of object literals.
 */
/**
 * True when a premises search would be answered from fixtures.
 *
 * The lookup page used to offer worked examples -- a postcode, a UPRN, a CLI
 * -- taken from the fixture set. On a live deployment those UPRNs and CLIs do
 * not exist, so the one thing offered as a guaranteed starting point answered
 * "No premises found". The examples are only shown when they can actually
 * work, and this is how the client is told.
 */
export function addressLookupsAreFixtures(): boolean {
  // The first provider in the chain is the one that answers, so it is the one
  // that decides. An empty chain means no examples are safe either -- that is
  // DATA_MODE=live with no credentials, where nothing resolves at all.
  return providers().address[0]?.mode === 'mock';
}

export function providers(): Registry {
  const cfg = config();
  const allowFixtures = cfg.dataMode !== 'live';

  const address: AddressProvider[] = [];
  const availability: AvailabilityProvider[] = [];
  const offers: OfferProvider[] = [];
  const signal: SignalProvider[] = [];
  const lines: LineProvider[] = [];

  // Zen first: it is the system of record for the services we sell.
  if (shouldRunLive(cfg.zen.configured) && isProviderEnabled('zen-availability')) {
    address.push(createZenAddressProvider());
    availability.push(createZenAvailabilityProvider());
  }
  if (shouldRunLive(cfg.zen.configured) && isProviderEnabled('zen-service')) {
    lines.push(createZenLineProvider());
  }

  // OS Places is the authority for address + UPRN, so it backs up Zen —
  // and is the only provider that can resolve a bare UPRN.
  if (shouldRunLive(cfg.osPlaces.configured) && isProviderEnabled('os-places')) {
    address.push(createOsPlacesProvider());
  }

  // Giacom is the second wholesale account. Its serviceability answers merge
  // alongside Zen's rather than replacing them, because the same premises can
  // be sellable through both at different prices — and its service inventory
  // is the only way a Giacom-supplied line shows up at a premises at all.
  const giacomOffers = createGiacomOfferProvider();
  if (shouldRunLive(giacomOffers.configured) && isProviderEnabled('giacom-qualification')) {
    offers.push(giacomOffers);
  }
  const giacomLines = createGiacomLineProvider();
  if (shouldRunLive(giacomLines.configured) && isProviderEnabled('giacom-services')) {
    lines.push(giacomLines);
  }

  // thinkbroadband aggregate the alt-nets and cable, which is the one thing
  // the wholesale chain cannot answer.
  const tbb = createThinkbroadbandProvider();
  if (shouldRunLive(tbb.configured) && isProviderEnabled('thinkbroadband')) {
    offers.push(tbb);
  }

  // Ofcom's published prediction beats a model, so it leads the chain.
  const ofcom = createOfcomSignalProvider();
  if (shouldRunLive(ofcom.configured) && isProviderEnabled('ofcom-coverage')) {
    signal.push(ofcom);
  }

  // Fixtures sit last so the portal always has something to show.
  if (allowFixtures && isProviderEnabled('fixtures')) {
    address.push(createFixtureAddressProvider());
    availability.push(createFixtureAvailabilityProvider());
    // Only when nothing live can answer: two sources of alt-net coverage
    // would merge, and merging demo footprints into real ones would be worse
    // than showing neither.
    if (!offers.length) offers.push(createFixtureOfferProvider());
    signal.push(createFixtureSignalProvider());
    lines.push(createFixtureLineProvider());
  }

  const all: ProviderMeta[] = [...address, ...availability, ...offers, ...signal, ...lines];

  return {
    address,
    availability,
    offers,
    signal,
    lines,
    describe() {
      const out: HealthResponse['providers'] = {};
      for (const p of all) {
        out[p.name] = { configured: p.configured, mode: p.mode, label: p.label };
      }
      return out;
    },
  };
}

/**
 * Runs a chain until one provider yields a non-empty result.
 * Returns which provider answered so the UI can show data provenance.
 */
export async function firstResult<P extends ProviderMeta, T>(
  chain: P[],
  run: (provider: P) => Promise<T>,
  isUsable: (value: T) => boolean,
): Promise<{ value: T; provider: P; mode: 'live' | 'mock' } | { value: null; provider: null; mode: 'skipped'; errors: Error[] }> {
  const errors: Error[] = [];
  for (const provider of chain) {
    try {
      const value = await run(provider);
      if (isUsable(value)) return { value, provider, mode: provider.mode };
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }
  }
  return { value: null, provider: null, mode: 'skipped', errors };
}
