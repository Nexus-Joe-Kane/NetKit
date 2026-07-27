import type { RequestContext } from "../config";
import {
  ServerStatusSchema,
  StatusRequestSchema,
  type Channel,
  type ServerStatus,
} from "../hottub/schemas";
import { ALL_CHANNEL_ID } from "./videos";
import { activeProviderIds, listProviders } from "../providers/registry";
import { jsonResponse, parseBody } from "../utils/http";
import { enforceRateLimit, rateLimitHeaders } from "../utils/rate-limit";

/**
 * The merged channel. `/api/videos` expands it into every browsable provider,
 * so only the sorts that all of them can honour are advertised — a provider
 * that does not recognise one falls back to its own default rather than
 * failing.
 */
function allChannel(providerCount: number): Channel {
  return {
    id: ALL_CHANNEL_ID,
    name: "All channels",
    description: `Every public channel interleaved into one feed, across ${providerCount} providers.`,
    premium: false,
    status: "active",
    nsfw: true,
    default: true,
    sortOrder: 0,
    groupKey: "Public",
    cacheDuration: 900,
    tags: [
      { name: "Merged", systemImage: "square.stack.3d.up" },
      { name: "Public", systemImage: "globe" },
    ],
    options: [
      {
        id: "sort",
        title: "Sort",
        systemImage: "list.number",
        colorName: "indigo",
        options: [
          { id: "relevance", title: "Most Relevant" },
          { id: "new", title: "Newest" },
          { id: "views", title: "Most Viewed" },
        ],
      },
    ],
  };
}

export async function statusHandler(context: RequestContext): Promise<Response> {
  await parseBody(context.request, StatusRequestSchema);
  const rateLimit = await enforceRateLimit(context, "status", 120, 60);
  const providers = listProviders();
  const merged = allChannel(activeProviderIds().length);
  const publicIds = providers
    .filter((provider) => !provider.channel.premium)
    .map((provider) => provider.id);
  const premiumIds = providers
    .filter((provider) => provider.channel.premium)
    .map((provider) => provider.id);
  const degraded = providers.filter((provider) => provider.status === "degraded");

  const status: ServerStatus = {
    id: "joe-unified-hottub",
    name: context.env.SOURCE_NAME?.trim() || "Joe's Unified Hot Tub Source",
    subtitle: "Six channels with working public catalogues",
    description:
      "A self-hosted Hot Tub source using an official provider API, redundant Hot Tub-compatible sources, and ordinary public catalogue pages.",
    color: "#FF6B35",
    status: "active",
    nsfw: true,
    notices: [
      {
        status: "success",
        message: "Public browsing is enabled",
        details:
          "xHamster, XVideos, Pornhub, fpo.xxx, and Eporner provide browse and search results. Watch-page URLs are handed to Hot Tub for its normal playback extraction.",
        priority: false,
      },
      ...(degraded.length
        ? [
            {
              status: "warning" as const,
              message: "FapHouse Ultra is catalogue-only",
              details:
                "Public metadata can be browsed, but protected playback needs a provider-supported delegated account flow. Hot Tub's source API does not expose one, so subscription access is not bypassed.",
              priority: false,
            },
          ]
        : []),
    ],
    channels: [merged, ...providers.map((provider) => provider.channel)],
    channelGroups: [
      {
        id: "public",
        title: "Public",
        channelIds: [ALL_CHANNEL_ID, ...publicIds],
        systemImage: "globe",
      },
      ...(premiumIds.length
        ? [
            {
              id: "premium",
              title: "Premium",
              channelIds: premiumIds,
              systemImage: "star.circle",
            },
          ]
        : []),
    ],
    filtersFooter:
      "Favourites, history, and queues are stored by Hot Tub on this device. Provider filters vary by channel.",
  };
  const validated = ServerStatusSchema.parse(status);
  const headers = rateLimitHeaders(rateLimit);
  headers.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  return jsonResponse(validated, 200, headers);
}
