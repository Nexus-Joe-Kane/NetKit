import type { RequestContext } from "../config";
import {
  ServerStatusSchema,
  StatusRequestSchema,
  type Channel,
  type ChannelOption,
  type ServerStatus,
} from "../hottub/schemas";
import { listBundles, type ChannelBundle } from "../providers/bundles";
import { getProvider, listProviders } from "../providers/registry";
import { jsonResponse, parseBody } from "../utils/http";
import { getPublicBaseUrl } from "../utils/urls";
import { enforceRateLimit, rateLimitHeaders } from "../utils/rate-limit";

/**
 * A bundle rendered as a channel. `/api/videos` expands it into its members, so
 * the sort control advertises a generic intent that is translated into each
 * member's own dialect before the request goes out — the members disagree on
 * naming, and forwarding one catalogue's ID to another simply gets ignored.
 */
function bundleChannel(bundle: ChannelBundle, memberCount: number, baseUrl: URL): Channel {
  return {
    id: bundle.id,
    name: bundle.name,
    favicon: new URL(`/assets/icon-${bundle.icon}.png`, baseUrl).toString(),
    description: `${bundle.description} Interleaved across ${memberCount} channels.`,
    premium: false,
    status: "active",
    nsfw: true,
    default: bundle.default ?? false,
    sortOrder: bundle.sortOrder,
    groupKey: "Bundles",
    cacheDuration: 900,
    tags: [
      { name: "Merged", systemImage: bundle.systemImage },
      { name: "Public", systemImage: "globe" },
    ],
    options: [
      {
        id: "sort",
        title: "Sort",
        systemImage: "list.number",
        colorName: "indigo",
        options: [...bundle.sortOptions],
      },
      ...(bundle.orientation
        ? [
            {
              id: "orientation",
              title: "Catalogue",
              systemImage: "person.2",
              colorName: "purple",
              multiSelect: false,
              options: [
                { id: "straight", title: "Straight" },
                { id: "all", title: "All" },
                { id: "gay", title: "Gay" },
              ],
            },
          ]
        : []),
    ],
  };
}

/**
 * The duration slider, mirroring the shape the official Hot Tub source ships.
 *
 * `control: "range"` and the rest of `properties` are undocumented — they were
 * read off `hottubapp.io/api/status` — and every value there is a string,
 * including `ticks`, which holds JSON encoded as text. The client-version gate
 * is copied too, so older builds that cannot render a range control simply do
 * not show it.
 *
 * It is attached to every channel because the filter is applied to merged
 * results rather than pushed down to providers, so it behaves the same
 * everywhere.
 */
function durationRangeOption(): ChannelOption {
  return {
    id: "durationSecondsRange",
    title: "Duration",
    systemImage: "timer",
    colorName: "blue",
    multiSelect: false,
    options: [],
    properties: {
      control: "range",
      min: "0",
      max: "3600",
      step: "60",
      displayDivisor: "60",
      unit: "min",
      ticks: JSON.stringify([
        { value: 0, label: "0 min" },
        { value: 120, label: "2 min" },
        { value: 600, label: "10 min" },
        { value: 1800, label: "30 min" },
        { value: 3600, label: "60+ min" },
      ]),
      minClientVersion: "2.3.0",
      minClientBuild: "41",
    },
  };
}

function withDurationSlider(channel: Channel): Channel {
  return { ...channel, options: [...(channel.options ?? []), durationRangeOption()] };
}

export async function statusHandler(context: RequestContext): Promise<Response> {
  await parseBody(context.request, StatusRequestSchema);
  const rateLimit = await enforceRateLimit(context, "status", 120, 60);
  const providers = listProviders();
  const baseUrl = getPublicBaseUrl(context.env.PUBLIC_BASE_URL);
  const bundles = listBundles().map((bundle) =>
    bundleChannel(bundle, bundle.members().filter(getProvider).length, baseUrl),
  );
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
    subtitle: `${providers.length} channels and ${bundles.length} bundles`,
    description:
      "A self-hosted Hot Tub source using an official provider API, redundant Hot Tub-compatible sources, and ordinary public catalogue pages.",
    color: "#FF6B35",
    iconUrl: new URL("/assets/icon.png", baseUrl).toString(),
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
    channels: [...bundles, ...providers.map((provider) => provider.channel)].map(
      withDurationSlider,
    ),
    channelGroups: [
      {
        id: "bundles",
        title: "Bundles",
        channelIds: bundles.map((channel) => channel.id),
        systemImage: "square.stack.3d.up",
      },
      {
        id: "public",
        title: "Public",
        channelIds: publicIds,
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
