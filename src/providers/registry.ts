import { epornerProvider } from "./eporner";
import { faphouseProvider } from "./faphouse";
import { fpoProvider } from "./fpo";
import { pornhubProvider } from "./pornhub";
import type { ProviderAdapter } from "./types";
import { xhamsterProvider } from "./xhamster";
import { xvideosProvider } from "./xvideos";

const providers = [
  xhamsterProvider,
  faphouseProvider,
  xvideosProvider,
  pornhubProvider,
  fpoProvider,
  epornerProvider,
] as const;

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
