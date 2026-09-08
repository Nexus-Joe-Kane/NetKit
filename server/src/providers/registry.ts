import type { HealthResponse } from '@sw/shared';
import { config } from '../config';
import { isProviderEnabled } from '../auth/store';
import { createOsPlacesProvider } from './address/osPlaces';
import { createOfcomSignalProvider } from './signal/ofcom';
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
 * usable answer wins, and a failure falls through to the next. A capability
 * with no configured provider is simply empty, and the panel for it says so
 * -- there is no fixture engine behind these any more, because invented data
 * on a live deployment is worse than a panel that names what is missing.
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
export function providers(): Registry {
  const cfg = config();

  const address: AddressProvider[] = [];
  const availability: AvailabilityProvider[] = [];
  const offers: OfferProvider[] = [];
  const signal: SignalProvider[] = [];
  const lines: LineProvider[] = [];

  // Zen first: it is the system of record for the services we sell.
  if (cfg.zen.configured && isProviderEnabled('zen-availability')) {
    address.push(createZenAddressProvider());
    availability.push(createZenAvailabilityProvider());
  }
  if (cfg.zen.configured && isProviderEnabled('zen-service')) {
    lines.push(createZenLineProvider());
  }

  // OS Places is the authority for address + UPRN, so it backs up Zen —
  // and is the only provider that can resolve a bare UPRN.
  if (cfg.osPlaces.configured && isProviderEnabled('os-places')) {
    address.push(createOsPlacesProvider());
  }

  // Giacom is the second wholesale account. Its serviceability answers merge
  // alongside Zen's rather than replacing them, because the same premises can
  // be sellable through both at different prices — and its service inventory
  // is the only way a Giacom-supplied line shows up at a premises at all.
  const giacomOffers = createGiacomOfferProvider();
  if (giacomOffers.configured && isProviderEnabled('giacom-qualification')) {
    offers.push(giacomOffers);
  }
  const giacomLines = createGiacomLineProvider();
  if (giacomLines.configured && isProviderEnabled('giacom-services')) {
    lines.push(giacomLines);
  }

  // thinkbroadband aggregate the alt-nets and cable, which is the one thing
  // the wholesale chain cannot answer.
  const tbb = createThinkbroadbandProvider();
  if (tbb.configured && isProviderEnabled('thinkbroadband')) {
    offers.push(tbb);
  }

  // Ofcom's published prediction beats a model, so it leads the chain.
  const ofcom = createOfcomSignalProvider();
  if (ofcom.configured && isProviderEnabled('ofcom-coverage')) {
    signal.push(ofcom);
  }

  // Fixtures sit last so the portal always has something to show.
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
): Promise<{ value: T; provider: P; mode: 'live' } | { value: null; provider: null; mode: 'skipped'; errors: Error[] }> {
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
