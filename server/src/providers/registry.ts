import type { HealthResponse } from '@sw/shared';
import { config, shouldRunLive } from '../config';
import { isProviderEnabled } from '../auth/store';
import { createFixtureAddressProvider } from './address/fixture';
import { createOsPlacesProvider } from './address/osPlaces';
import { createFixtureAvailabilityProvider } from './availability/fixture';
import { createFixtureSignalProvider } from './signal/fixture';
import { createFixtureLineProvider } from './lines/fixture';
import { createZenAddressProvider, createZenAvailabilityProvider, createZenLineProvider } from './zen/adapters';
import type { AddressProvider, AvailabilityProvider, LineProvider, ProviderMeta, SignalProvider } from './types';

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
  const allowFixtures = cfg.dataMode !== 'live';

  const address: AddressProvider[] = [];
  const availability: AvailabilityProvider[] = [];
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

  // Fixtures sit last so the portal always has something to show.
  if (allowFixtures && isProviderEnabled('fixtures')) {
    address.push(createFixtureAddressProvider());
    availability.push(createFixtureAvailabilityProvider());
    signal.push(createFixtureSignalProvider());
    lines.push(createFixtureLineProvider());
  }

  const all: ProviderMeta[] = [...address, ...availability, ...signal, ...lines];

  return {
    address,
    availability,
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
