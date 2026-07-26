import type { Channel } from "../hottub/schemas";
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderContext,
  ProviderVideoPage,
} from "./types";

const unavailableCapabilities: ProviderCapabilities = {
  publicBrowse: false,
  publicSearch: false,
  uploaderBrowse: false,
  authenticatedAccess: false,
  history: false,
  likes: false,
  playlists: false,
  premiumAccess: false,
};

interface StubDefinition {
  id: string;
  name: string;
  description: string;
  reason: string;
  premium?: boolean;
  sortOrder: number;
}

export function createUnavailableProvider(definition: StubDefinition): ProviderAdapter {
  const channel: Channel = {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    premium: definition.premium ?? false,
    status: "restricted",
    nsfw: true,
    sortOrder: definition.sortOrder,
    groupKey: definition.premium ? "Premium" : "Public",
    tags: [{ name: "Adapter unavailable", systemImage: "exclamationmark.triangle" }],
    cacheDuration: 300,
  };

  const unavailable = async (
    _request: unknown,
    _context: ProviderContext,
  ): Promise<ProviderVideoPage> => ({
    items: [],
    hasNextPage: false,
    error: `${definition.name} is unavailable: ${definition.reason}`,
  });

  return {
    id: definition.id,
    name: definition.name,
    channel,
    capabilities: { ...unavailableCapabilities },
    status: "restricted",
    integration: "unavailable",
    unavailableReason: definition.reason,
    listVideos: unavailable,
    searchVideos: unavailable,
  };
}
