import { z } from "zod";
import type { Channel, Uploader, UploadersRequest, Video, VideosRequest } from "../hottub/schemas";
import { assertAllowedHttpsUrl, postProviderJson } from "../utils/urls";
import { firstNonEmptyPage } from "./race";
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderContext,
  ProviderVideoPage,
} from "./types";

const UPSTREAMS = [
  {
    id: "official",
    url: new URL("https://hottubapp.io/api/videos"),
    hosts: ["hottubapp.io"] as const,
  },
  {
    id: "community",
    url: new URL("https://hottub.spacemoehre.de/api/videos"),
    hosts: ["hottub.spacemoehre.de"] as const,
  },
] as const;

/**
 * Only the five fields Hot Tub actually requires are strict. Every optional
 * field degrades to `undefined` instead of failing, because a single odd value
 * in decorative metadata should never discard an otherwise usable video — that
 * mistake has now cost this source three separate outages (an empty `thumb`
 * rejecting a whole page, and `uploadedAt` arriving as an epoch number, which
 * silently emptied several channels).
 */
const optional = <T extends z.ZodTypeAny>(schema: T) => schema.optional().catch(undefined);

const upstreamVideoSchema = z
  .object({
    id: optional(z.union([z.string(), z.number()])),
    title: z.string().trim().min(1),
    url: z.string().url(),
    duration: z.coerce.number().int().nonnegative(),
    channel: z.string(),
    thumb: z.string().url(),
    views: optional(z.coerce.number().int().nonnegative()),
    rating: optional(z.coerce.number().min(0).max(100)),
    uploader: optional(z.string().trim()),
    uploaderUrl: optional(z.string().url()),
    uploaderId: optional(z.string().trim()),
    verified: optional(z.boolean()),
    isVR: optional(z.boolean()),
    tags: optional(z.array(z.string())),
    categories: optional(z.array(z.string())),
    // Documented as `Date|String`; upstreams send epoch seconds or milliseconds.
    uploadedAt: optional(z.union([z.string(), z.number()])),
    preview: optional(z.string().url()),
    aspectRatio: optional(z.coerce.number().positive()),
    isLive: optional(z.boolean()),
    liveStatus: optional(z.enum(["live", "not_live", "was_live", "post_live"])),
    availability: optional(z.string()),
    uploaderProfile: optional(
      z.object({
        id: z.string(),
        name: z.string(),
        normalizedName: z.string().optional(),
        avatar: z.string().url().nullable().optional(),
        videoCount: z.coerce.number().int().nonnegative().optional(),
        totalViews: z.coerce.number().int().nonnegative().optional(),
      }),
    ),
  })
  .passthrough();

/**
 * Trims decorative label lists and drops the blanks.
 *
 * The output schema requires each tag to be non-empty, and at least one
 * upstream channel returns an array of empty strings, which failed validation
 * and silently discarded every video on the page. Decorative metadata must
 * never be able to do that — the same mistake previously cost a page to an
 * empty `thumb` and several channels to a numeric `uploadedAt`.
 */
function cleanLabels(values: string[] | undefined, limit: number): string[] | undefined {
  if (!values) return undefined;
  const cleaned = [
    ...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
  ]
    .map((value) => value.slice(0, 120))
    .slice(0, limit);
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Upstreams send ISO strings, epoch seconds, or epoch milliseconds. */
function normaliseUploadedAt(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value.slice(0, 100);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const millis = value < 1e12 ? value * 1000 : value;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

// Items are deliberately left unvalidated here and checked one at a time
// below. Validating them as `z.array(upstreamVideoSchema)` is all-or-nothing:
// upstreams routinely emit a few records with an empty `thumb`, and that was
// enough to reject an otherwise good page of results.
const upstreamResponseSchema = z.object({
  pageInfo: z
    .object({
      hasNextPage: z.boolean(),
      recommendations: z.array(z.string()).optional(),
      message: z.string().nullish(),
      error: z.string().nullish(),
    })
    .passthrough(),
  items: z.array(z.unknown()),
});

interface FederatedProviderDefinition {
  id: string;
  name: string;
  description: string;
  favicon: string;
  sortOrder: number;
  watchHostnames: readonly string[];
  assetHostnames: readonly string[];
  sortOptions: ReadonlyArray<{ id: string; title: string }>;
  /**
   * Upstreams to query. Defaults to both; community-only channels name just
   * the community one so a subrequest is not spent asking the official source
   * about a channel it does not carry.
   */
  upstreams?: ReadonlyArray<(typeof UPSTREAMS)[number]["id"]>;
  /**
   * Set where an upstream ignores `page` and answers every request with the
   * same first results. Scrolling then repeats the same videos forever, and in
   * a merged feed those repeats crowd out channels that can page.
   *
   * Such a channel serves page 1 and reports no next page; later pages return
   * empty without a request, which is both honest and one fewer subrequest.
   */
  singlePageOnly?: boolean;
}

const capabilities: ProviderCapabilities = {
  publicBrowse: true,
  publicSearch: true,
  uploaderBrowse: true,
  authenticatedAccess: false,
  history: false,
  likes: false,
  playlists: false,
  premiumAccess: false,
};

function optionalAllowedUrl(
  value: string | undefined,
  allowedHostnames: readonly string[],
): string | undefined {
  if (!value) return undefined;
  try {
    return assertAllowedHttpsUrl(value, allowedHostnames).toString();
  } catch {
    return undefined;
  }
}

function normaliseVideo(
  definition: FederatedProviderDefinition,
  input: z.infer<typeof upstreamVideoSchema>,
): Video {
  const watchUrl = assertAllowedHttpsUrl(input.url, definition.watchHostnames);
  const thumbUrl = assertAllowedHttpsUrl(input.thumb, definition.assetHostnames);
  const uploaderUrl = optionalAllowedUrl(input.uploaderUrl, definition.watchHostnames);
  const preview = optionalAllowedUrl(input.preview, definition.assetHostnames);

  return {
    id: input.id === undefined ? undefined : String(input.id),
    title: input.title,
    url: watchUrl.toString(),
    duration: input.duration,
    channel: definition.id,
    thumb: thumbUrl.toString(),
    views: input.views,
    rating: input.rating,
    uploader: input.uploader || undefined,
    uploaderUrl,
    uploaderId: input.uploaderId || undefined,
    verified: input.verified,
    isVR: input.isVR,
    tags: cleanLabels(input.tags, 200),
    categories: cleanLabels(input.categories, 100),
    uploadedAt: normaliseUploadedAt(input.uploadedAt),
    preview,
    aspectRatio: input.aspectRatio,
    uploaderProfile: input.uploaderProfile,
    isLive: input.isLive,
    liveStatus: input.liveStatus,
    availability: input.availability,
  };
}

function uploaderFallbackName(request: UploadersRequest): string {
  if (request.uploaderName) return request.uploaderName;
  const finalPart = request.uploaderId?.split(":").at(-1) ?? "Creator";
  return finalPart.replace(/[-_]+/g, " ").trim() || "Creator";
}

function buildUpstreamPayload(
  definition: FederatedProviderDefinition,
  request: VideosRequest,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { channel: definition.id };
  const privateOrRoutingFields = new Set([
    "channel",
    "channels",
    "server",
    "blockedKeywords",
    "blockedUploaders",
  ]);
  for (const [key, value] of Object.entries(request)) {
    if (privateOrRoutingFields.has(key) || value === undefined) continue;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      (Array.isArray(value) &&
        value.length <= 100 &&
        value.every((entry) => ["string", "number", "boolean"].includes(typeof entry)))
    ) {
      payload[key] = value;
    }
  }
  return payload;
}

export function createFederatedProvider(definition: FederatedProviderDefinition): ProviderAdapter {
  const channel: Channel = {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    premium: false,
    favicon: definition.favicon,
    status: "active",
    nsfw: true,
    // The merged "all" channel is the source default now.
    default: false,
    sortOrder: definition.sortOrder,
    groupKey: "Public",
    cacheDuration: 1_800,
    tags: [
      { name: "Public", systemImage: "globe" },
      { name: "Federated", systemImage: "point.3.connected.trianglepath.dotted" },
    ],
    // Only the upstreams this channel is actually served by.
    maintainers: (definition.upstreams ?? ["official", "community"]).map((id) =>
      id === "official"
        ? { id: "hottubapp", name: "Hot Tub", role: "upstream" }
        : { id: "spacemoehre", name: "SpaceMoehre Hot Tub", role: "upstream" },
    ),
    // An upstream that declares no sort gets no sort control, rather than an
    // empty picker.
    options: definition.sortOptions.length
      ? [
          {
            id: "sort",
            title: "Sort",
            systemImage: "list.number",
            colorName: "indigo",
            options: [...definition.sortOptions],
          },
        ]
      : [],
  };

  async function getVideos(
    request: VideosRequest,
    context: ProviderContext,
  ): Promise<ProviderVideoPage> {
    // Asking again would return page one a second time, so the honest answer
    // is that there is nothing further.
    if (definition.singlePageOnly && request.page > 1) {
      return { items: [], hasNextPage: false };
    }
    const selected = definition.upstreams
      ? UPSTREAMS.filter((upstream) => definition.upstreams!.includes(upstream.id))
      : UPSTREAMS;
    const calls: Array<Promise<ProviderVideoPage>> = selected.map(async (upstream) => {
      const payload = await postProviderJson(
        definition.id,
        context.fetch,
        upstream.url,
        upstream.hosts,
        buildUpstreamPayload(definition, request),
        8_000,
      );
      const parsed = upstreamResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error(`${definition.name} upstream returned an incompatible response.`);
      }

      const items: Video[] = [];
      for (const input of parsed.data.items) {
        const record = upstreamVideoSchema.safeParse(input);
        if (!record.success) continue;
        try {
          items.push(normaliseVideo(definition, record.data));
        } catch {
          // Drop off-domain or malformed upstream records.
        }
      }
      if (parsed.data.pageInfo.error && items.length === 0) {
        throw new Error(`${definition.name} upstream reported a provider failure.`);
      }

      return {
        items: items.slice(0, request.pageSize),
        // An upstream that cannot page still reports a next page; believing it
        // would make the app fetch the same results again.
        hasNextPage: definition.singlePageOnly ? false : parsed.data.pageInfo.hasNextPage,
        message: parsed.data.pageInfo.message ?? undefined,
      };
    });

    return firstNonEmptyPage(calls, `${definition.name} has no available Hot Tub upstream.`);
  }

  async function getUploader(
    request: UploadersRequest,
    context: ProviderContext,
  ): Promise<Uploader> {
    const name = uploaderFallbackName(request);
    const id = request.uploaderId || `${definition.id}:${name.toLowerCase().replace(/\s+/g, "-")}`;
    let matches: Video[] = [];

    if (request.profileContent) {
      try {
        const page = await getVideos(
          {
            query: request.uploaderName || name,
            channel: definition.id,
            sort: request.profileVideosSort === "views" ? "views" : "new",
            page: 1,
            pageSize: 40,
            blockedKeywords: [],
            blockedUploaders: [],
          },
          context,
        );
        const normalisedName = name.toLocaleLowerCase();
        matches = page.items.filter(
          (video) =>
            (request.uploaderId && video.uploaderId === request.uploaderId) ||
            video.uploader?.toLocaleLowerCase() === normalisedName,
        );
      } catch {
        // A profile page still renders with the stable ID/name if optional content is down.
      }
    }

    const example = matches[0];
    return {
      id,
      name: example?.uploader || name,
      normalizedName: (example?.uploader || name).toLocaleLowerCase(),
      url: example?.uploaderUrl,
      channel: definition.id,
      verified: example?.verified,
      avatar: example?.uploaderProfile?.avatar,
      videoCount: matches.length || undefined,
      videos: request.profileContent ? matches : undefined,
    };
  }

  return {
    id: definition.id,
    name: definition.name,
    channel,
    capabilities,
    status: "active",
    integration: "federated",
    listVideos: getVideos,
    searchVideos: getVideos,
    getUploader,
  };
}
