import { communityProviders } from "./community";
import { epornerProvider } from "./eporner";
import { faphouseProvider } from "./faphouse";
import { fpoProvider } from "./fpo";
import { pornhubProvider } from "./pornhub";
import type { ProviderAdapter } from "./types";
import { xhamsterProvider } from "./xhamster";
import { xvideosProvider } from "./xvideos";

/**
 * The six channels this source implements or federates directly. They lead the
 * channel list and are the ones the merged feed fans out to.
 */
const primaryProviders = [
  xhamsterProvider,
  faphouseProvider,
  xvideosProvider,
  pornhubProvider,
  fpoProvider,
  epornerProvider,
] as const;

const providers = [...primaryProviders, ...communityProviders];

const providerMap = new Map<string, ProviderAdapter>(
  providers.map((provider) => [provider.id, provider]),
);

export function getProvider(id: string): ProviderAdapter | undefined {
  return providerMap.get(id);
}

export function getProviderForUploaderId(id: string): ProviderAdapter | undefined {
  const prefix = id.split(":", 1)[0];
  return prefix ? providerMap.get(prefix) : undefined;
}

export function listProviders(): readonly ProviderAdapter[] {
  return providers;
}

export function activeProviderIds(): string[] {
  return providers
    .filter((provider) => provider.capabilities.publicBrowse || provider.capabilities.publicSearch)
    .map((provider) => provider.id);
}

/**
 * Channels the merged feed queries. Deliberately not every channel: each one
 * costs at least one upstream subrequest, and a Worker request has a hard
 * subrequest budget, so fanning out across all of them would fail outright.
 * The rest remain selectable individually.
 */
export function featuredProviderIds(): string[] {
  return primaryProviders
    .filter((provider) => provider.capabilities.publicBrowse || provider.capabilities.publicSearch)
    .map((provider) => provider.id);
}
