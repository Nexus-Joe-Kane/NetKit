import type { RequestContext } from "../config";
import { ServerStatusSchema, StatusRequestSchema, type ServerStatus } from "../hottub/schemas";
import { listProviders } from "../providers/registry";
import { jsonResponse, parseBody } from "../utils/http";
import { enforceRateLimit, rateLimitHeaders } from "../utils/rate-limit";

export async function statusHandler(context: RequestContext): Promise<Response> {
  await parseBody(context.request, StatusRequestSchema);
  const rateLimit = await enforceRateLimit(context, "status", 120, 60);
  const providers = listProviders();
  const publicIds = providers
    .filter((provider) => !provider.channel.premium)
    .map((provider) => provider.id);
  const premiumIds = providers
    .filter((provider) => provider.channel.premium)
    .map((provider) => provider.id);
  const restricted = providers.filter((provider) => provider.status !== "active");

  const status: ServerStatus = {
    id: "joe-unified-hottub",
    name: context.env.SOURCE_NAME?.trim() || "Joe's Unified Hot Tub Source",
    subtitle: "One source, transparent provider capabilities",
    description:
      "A self-hosted Hot Tub source that uses official integrations only and reports unsupported providers honestly.",
    color: "#FF6B35",
    status: "active",
    nsfw: true,
    notices: [
      {
        status: "info",
        message: "Official public integration available",
        details: "Eporner public browsing and search use the official Eporner Webmaster API v2.",
        priority: false,
      },
      ...(restricted.length
        ? [
            {
              status: "warning" as const,
              message: `${restricted.length} providers are intentionally unavailable`,
              details:
                "No authorised stable integration was verified for xHamster, FapHouse Ultra, XVideos, Pornhub, or fpo.xxx. No anti-bot, paywall, DRM, or subscription bypass is attempted.",
              priority: false,
            },
          ]
        : []),
    ],
    channels: providers.map((provider) => provider.channel),
    channelGroups: [
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
      "Filter availability is provider-specific. Unsupported account and premium features are never simulated.",
  };
  const validated = ServerStatusSchema.parse(status);
  const headers = rateLimitHeaders(rateLimit);
  headers.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  return jsonResponse(validated, 200, headers);
}
