import { z } from "zod";
import type { Channel, Uploader, UploadersRequest, Video, VideosRequest } from "../hottub/schemas";
import { assertAllowedHttpsUrl, postProviderJson } from "../utils/urls";
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

const upstreamVideoSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    title: z.string().trim().min(1),
    url: z.string().url(),
    duration: z.coerce.number().int().nonnegative(),
    channel: z.string(),
    thumb: z.string().url(),
    views: z.coerce.number().int().nonnegative().optional(),
    rating: z.coerce.number().min(0).max(100).optional(),
    uploader: z.string().trim().optional(),
    uploaderUrl: z.string().url().optional(),
    uploaderId: z.string().trim().optional(),
    verified: z.boolean().optional(),
    isVR: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    categories: z.array(z.string()).optional(),
    uploadedAt: z.string().optional(),
    preview: z.string().url().optional(),
    aspectRatio: z.coerce.number().positive().optional(),
    isLive: z.boolean().optional(),
    liveStatus: z.enum(["live", "not_live", "was_live", "post_live"]).optional(),
    availability: z.string().optional(),
    uploaderProfile: z
      .object({
        id: z.string(),
        name: z.string(),
        normalizedName: z.string().optional(),
        avatar: z.string().url().nullable().optional(),
        videoCount: z.coerce.number().int().nonnegative().optional(),
        totalViews: z.coerce.number().int().nonnegative().optional(),
      })
      .optional(),
  })
  .passthrough();

const upstreamResponseSchema = z.object({
  pageInfo: z
    .object({
      hasNextPage: z.boolean(),
      recommendations: z.array(z.string()).optional(),
      message: z.string().nullish(),
      error: z.string().nullish(),
    })
    .passthrough(),
  items: z.array(upstreamVideoSchema),
});

interface FederatedProviderDefinition {
  id: "xhamster" | "xvideos" | "pornhub" | "eporner";
  name: string;
  description: string;
  favicon: string;
  sortOrder: number;
  watchHostnames: readonly string[];
  assetHostnames: readonly string[];
  sortOptions: ReadonlyArray<{ id: string; title: string }>;
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
    tags: input.tags?.slice(0, 200),
    categories: input.categories?.slice(0, 100),
    uploadedAt: input.uploadedAt,
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
    default: definition.id === "xhamster",
    sortOrder: definition.sortOrder,
    groupKey: "Public",
    cacheDuration: 1_800,
    tags: [
      { name: "Public", systemImage: "globe" },
      { name: "Federated", systemImage: "point.3.connected.trianglepath.dotted" },
    ],
    maintainers: [
      {
        id: "hottubapp",
        name: "Hot Tub",
        role: "upstream",
      },
      {
        id: "spacemoehre",
        name: "SpaceMoehre Hot Tub",
        role: "upstream",
      },
    ],
    options: [
      {
        id: "sort",
        title: "Sort",
        systemImage: "list.number",
        colorName: "indigo",
        options: [...definition.sortOptions],
      },
    ],
  };

  async function getVideos(
    request: VideosRequest,
    context: ProviderContext,
  ): Promise<ProviderVideoPage> {
    const calls = UPSTREAMS.map(async (upstream): Promise<ProviderVideoPage> => {
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
        try {
          items.push(normaliseVideo(definition, input));
        } catch {
          // Drop off-domain or malformed upstream records.
        }
      }
      if (parsed.data.pageInfo.error && items.length === 0) {
        throw new Error(`${definition.name} upstream reported a provider failure.`);
      }

      return {
        items: items.slice(0, request.pageSize),
        hasNextPage: parsed.data.pageInfo.hasNextPage,
        message: parsed.data.pageInfo.message ?? undefined,
      };
    });

    try {
      return await Promise.any(calls);
    } catch {
      throw new Error(`${definition.name} has no available Hot Tub upstream.`);
    }
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
