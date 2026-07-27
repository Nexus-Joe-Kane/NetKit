import type { RequestContext } from "../config";
import {
  VideoSchema,
  VideosRequestSchema,
  VideosResponseSchema,
  type Video,
  type VideosRequest,
  type VideosResponse,
} from "../hottub/schemas";
import { ALL_BUNDLE_ID, getBundle, type ChannelBundle } from "../providers/bundles";
import { getProvider } from "../providers/registry";
import { resolveSortForChannel } from "../providers/sort-dialect";
import type { ProviderAdapter, ProviderContext, ProviderVideoPage } from "../providers/types";
import { HttpError } from "../utils/errors";
import {
  applyClientBlocks,
  applyDurationRange,
  mergeProviderResults,
  parseDurationRange,
} from "../utils/filters";
import { jsonResponse, parseBody } from "../utils/http";
import { logger } from "../utils/logging";
import { enforceRateLimit, rateLimitHeaders } from "../utils/rate-limit";
import { resolveOrientation } from "../utils/orientation";
import { getPublicBaseUrl } from "../utils/urls";
import {
  matchPublicCache,
  putPublicCache,
  videoCacheRequest,
  videoLastGoodCacheRequest,
} from "../utils/cache";

/**
 * The merged channel. Kept as a named export because several call sites and
 * tests refer to it directly; it is just the default bundle.
 */
export const ALL_CHANNEL_ID = ALL_BUNDLE_ID;

/**
 * Only Eporner and FapHouse can honour an orientation preference; the
 * upstreams behind the federated channels ignore it and fpo.xxx has no
 * orientation listings. When the viewer has asked for one, a bundle therefore
 * narrows to the members that can actually respect it — a smaller feed of the
 * right content beats a large feed of the wrong content.
 *
 * A bundle with no orientation-aware members is left intact rather than
 * emptied: narrowing it would return nothing at all, which is strictly worse
 * than returning a feed that ignores the preference.
 */
export const ORIENTATION_AWARE_CHANNELS = ["eporner", "faphouse-ultra"] as const;

function expandBundle(bundle: ChannelBundle, request: VideosRequest): string[] {
  const members = bundle.members().filter((id) => getProvider(id));
  const orientation = resolveOrientation(request);
  if (orientation !== "straight" && orientation !== "gay") return members;
  const aware = members.filter((id) =>
    (ORIENTATION_AWARE_CHANNELS as readonly string[]).includes(id),
  );
  return aware.length > 0 ? aware : members;
}

function requestedChannels(request: VideosRequest): string[] {
  const requested =
    request.channels && request.channels.length > 0
      ? request.channels
      : request.channel
        ? [request.channel]
        : [];
  return [
    ...new Set(
      requested.flatMap((id) => {
        const bundle = getBundle(id);
        return bundle ? expandBundle(bundle, request) : [id];
      }),
    ),
  ];
}

/**
 * Rewrites the requested sort into the dialect this channel declares, because
 * bundles advertise a generic intent and their members disagree on naming.
 *
 * When nothing matches the request is passed through untouched: `sort` carries
 * a schema default so it is never absent, and each adapter already has its own
 * fallback for a value it does not recognise.
 */
function requestForChannel(provider: ProviderAdapter, request: VideosRequest): VideosRequest {
  const declared = provider.channel.options?.find((option) => option.id === "sort")?.options ?? [];
  const sort = resolveSortForChannel(declared, request.sort);
  return sort === undefined || sort === request.sort ? request : { ...request, sort };
}

/**
 * With one channel the caller's page size is used as-is. Fanning out would
 * otherwise ask every provider for a full page and discard most of it, so the
 * per-provider size is scaled down — with headroom, because merging dedupes
 * and client-side blocking can remove items.
 */
function providerPageSize(request: VideosRequest, channelCount: number): number {
  if (channelCount <= 1) return request.pageSize;
  return Math.min(request.pageSize, Math.max(10, Math.ceil((request.pageSize / channelCount) * 2)));
}

async function callProvider(
  channelId: string,
  request: VideosRequest,
  providerContext: ProviderContext,
): Promise<ProviderVideoPage> {
  const provider = getProvider(channelId);
  if (!provider) throw new HttpError(400, `Unknown channel: ${channelId}`, "unknown_channel");
  const scoped = requestForChannel(provider, request);
  try {
    return request.query
      ? await provider.searchVideos(scoped, providerContext)
      : await provider.listVideos(scoped, providerContext);
  } catch {
    logger.warn("provider_request_failed", {
      requestId: providerContext.requestId,
      providerId: provider.id,
    });
    return {
      items: [],
      hasNextPage: false,
      error: `${provider.name} is temporarily unavailable.`,
    };
  }
}

function validateProviderItems(items: Video[], channelId: string): Video[] {
  const valid: Video[] = [];
  for (const item of items) {
    const parsed = VideoSchema.safeParse(item);
    if (parsed.success && parsed.data.channel === channelId) valid.push(parsed.data);
  }
  return valid;
}

/**
 * Hot Tub types `pageInfo.parameters` as `Record<string, string>` and the iOS
 * client decodes it strictly, so every value is serialised as a string.
 * `totalResults` is omitted unless a provider actually reported one, rather
 * than claiming a total of zero alongside a page full of results.
 */
function buildParameters(
  request: VideosRequest,
  returnedResults: number,
  pages: ProviderVideoPage[],
): Record<string, string> {
  const parameters: Record<string, string> = {
    page: String(request.page),
    pageSize: String(request.pageSize),
    returnedResults: String(returnedResults),
  };
  const totalResults = pages.reduce((sum, page) => sum + (page.totalResults ?? 0), 0);
  if (totalResults > 0) parameters.totalResults = String(totalResults);
  return parameters;
}

export async function videosHandler(
  context: RequestContext,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const request = await parseBody(context.request, VideosRequestSchema);
  const channels = requestedChannels(request);
  for (const channel of channels) {
    if (!getProvider(channel)) {
      throw new HttpError(400, `Unknown channel: ${channel}`, "unknown_channel");
    }
  }
  const rateLimit = await enforceRateLimit(context, "videos", 60, 60);
  const baseUrl = getPublicBaseUrl(context.env.PUBLIC_BASE_URL);
  const cacheKey = await videoCacheRequest(baseUrl, request);
  const cached = await matchPublicCache(cacheKey);
  if (cached) {
    const headers = new Headers(cached.headers);
    headers.set("X-Cache", "HIT");
    for (const [key, value] of rateLimitHeaders(rateLimit)) headers.set(key, value);
    return new Response(cached.body, { status: cached.status, headers });
  }

  const providerContext: ProviderContext = {
    env: context.env,
    fetch: fetcher,
    requestId: context.requestId,
    now: new Date(),
  };
  // Duration is filtered after fetching, since only some providers can express
  // it upstream. Over-fetching keeps a filtered page from looking half-empty.
  const durationRange = parseDurationRange(request.durationSecondsRange);
  const filtersLocally = durationRange.min !== undefined || durationRange.max !== undefined;
  const perProvider: VideosRequest = {
    ...request,
    pageSize: Math.min(100, providerPageSize(request, channels.length) * (filtersLocally ? 2 : 1)),
  };
  const pages = await Promise.all(
    channels.map((channelId) => callProvider(channelId, perProvider, providerContext)),
  );
  const groups = pages.map((page, index) =>
    applyDurationRange(
      applyClientBlocks(
        validateProviderItems(page.items, channels[index] ?? ""),
        request.blockedKeywords,
        request.blockedUploaders,
      ),
      durationRange,
    ),
  );
  const items = mergeProviderResults(groups, request.pageSize);
  const errors = pages
    .map((page, index) => (page.error ? `${channels[index]}: ${page.error}` : null))
    .filter((value): value is string => value !== null);
  const messages = pages
    .map((page) => page.message)
    .filter((value): value is string => Boolean(value));
  const allFailed = pages.length > 0 && pages.every((page) => Boolean(page.error));

  if (allFailed) {
    const lastGoodKey = await videoLastGoodCacheRequest(baseUrl, request);
    const lastGood = await matchPublicCache(lastGoodKey);
    if (lastGood) {
      try {
        const stale = VideosResponseSchema.parse(await lastGood.json());
        stale.pageInfo.error = undefined;
        stale.pageInfo.message =
          "Live providers are temporarily unavailable; showing the last successful result.";
        const headers = rateLimitHeaders(rateLimit);
        headers.set("Cache-Control", "public, max-age=60");
        headers.set("X-Cache", "STALE");
        return jsonResponse(stale, 200, headers);
      } catch {
        // Ignore a malformed cache record and return the current provider error below.
      }
    }
  }

  const response: VideosResponse = {
    pageInfo: {
      hasNextPage: pages.some((page) => page.hasNextPage),
      error: allFailed ? errors.join(" ") : undefined,
      message:
        !allFailed && errors.length > 0
          ? `Some providers were unavailable: ${errors.join(" ")}`
          : messages.join(" ") || undefined,
      parameters: buildParameters(request, items.length, pages),
    },
    items,
  };
  const validated = VideosResponseSchema.parse(response);
  const headers = rateLimitHeaders(rateLimit);
  headers.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  headers.set("X-Cache", "MISS");
  const result = jsonResponse(validated, 200, headers);
  if (!allFailed) {
    putPublicCache(context, cacheKey, result);
    if (items.length > 0) {
      const lastGoodKey = await videoLastGoodCacheRequest(baseUrl, request);
      putPublicCache(
        context,
        lastGoodKey,
        result,
        "public, max-age=604800, stale-while-revalidate=86400",
      );
    }
  }
  return result;
}
