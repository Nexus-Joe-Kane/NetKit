import { z } from "zod";
import type { Channel, Uploader, UploadersRequest, Video, VideosRequest } from "../hottub/schemas";
import { assertAllowedHttpsUrl, fetchProviderJson } from "../utils/urls";
import { createFederatedProvider } from "./federated";
import { firstNonEmptyPage } from "./race";
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderContext,
  ProviderVideoPage,
} from "./types";

const EPORNER_HOSTS = ["eporner.com"] as const;
const API_URL = "https://www.eporner.com/api/v2/video/search/";

const thumbnailSchema = z.object({
  width: z.coerce.number().int().positive().optional(),
  height: z.coerce.number().int().positive().optional(),
  src: z.string().url(),
});

const epornerVideoSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  keywords: z.string().optional(),
  views: z.coerce.number().int().nonnegative().default(0),
  rate: z.coerce.number().min(0).max(5).optional(),
  url: z.string().url(),
  added: z.string().optional(),
  length_sec: z.coerce.number().int().nonnegative(),
  default_thumb: thumbnailSchema,
  uploader: z.string().optional(),
  uploader_url: z.string().url().optional(),
  verified: z.boolean().optional(),
});

const epornerResponseSchema = z.object({
  count: z.coerce.number().int().nonnegative(),
  page: z.coerce.number().int().positive(),
  total_count: z.coerce.number().int().nonnegative(),
  total_pages: z.coerce.number().int().nonnegative(),
  videos: z.array(epornerVideoSchema),
});

const sortMap: Record<string, string> = {
  relevance: "most-popular",
  popular: "most-popular",
  new: "latest",
  rating: "top-rated",
  weekly: "top-weekly",
  monthly: "top-monthly",
  longest: "longest",
  shortest: "shortest",
};

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

const channel: Channel = {
  id: "eporner",
  name: "Eporner",
  description: "Public catalogue through Eporner's official Webmaster API v2.",
  favicon: "https://www.google.com/s2/favicons?sz=64&domain=eporner.com",
  premium: false,
  status: "active",
  nsfw: true,
  // The merged "all" channel is the source default now.
  default: false,
  sortOrder: 60,
  groupKey: "Public",
  cacheDuration: 300,
  tags: [
    { name: "Official API", systemImage: "checkmark.seal" },
    { name: "Live fallback", systemImage: "arrow.trianglehead.2.clockwise.rotate.90" },
    { name: "Public", systemImage: "globe" },
  ],
  maintainers: [
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
      systemImage: "arrow.up.arrow.down",
      colorName: "blue",
      multiSelect: false,
      options: [
        { id: "popular", title: "Most Popular" },
        { id: "new", title: "Newest" },
        { id: "rating", title: "Top Rated" },
        { id: "weekly", title: "Popular This Week" },
        { id: "monthly", title: "Popular This Month" },
        { id: "longest", title: "Longest" },
        { id: "shortest", title: "Shortest" },
      ],
    },
    {
      id: "orientation",
      title: "Catalogue",
      systemImage: "person.2",
      colorName: "purple",
      multiSelect: false,
      options: [
        { id: "straight", title: "Exclude Gay" },
        { id: "all", title: "All" },
        { id: "gay", title: "Gay Only" },
      ],
    },
    {
      id: "quality",
      title: "Quality",
      systemImage: "4k.tv",
      colorName: "orange",
      multiSelect: false,
      options: [
        { id: "high", title: "Exclude Low Quality" },
        { id: "all", title: "All Quality" },
        { id: "low", title: "Low Quality Only" },
      ],
    },
  ],
};

/**
 * Eporner's `gay` parameter: 0 straight, 1 both, 2 gay.
 *
 * `orientation` is this channel's own filter, chosen from the options this
 * source advertises. `gender` is Hot Tub's global preference and arrives on
 * every request whether or not a channel filter is set — it was previously
 * ignored, so the app-wide preference did nothing here. The channel filter
 * wins when the user has set one.
 */
function mapOrientation(value: unknown, gender: unknown): string {
  const choice = value ?? gender;
  if (choice === "all" || choice === "both") return "1";
  if (choice === "gay" || choice === "male") return "2";
  return "0";
}

function mapQuality(value: unknown): string {
  if (value === "all") return "1";
  if (value === "low") return "2";
  return "0";
}

function normaliseVideo(input: z.infer<typeof epornerVideoSchema>): Video {
  const watchUrl = assertAllowedHttpsUrl(input.url, EPORNER_HOSTS);
  const thumbUrl = assertAllowedHttpsUrl(input.default_thumb.src, EPORNER_HOSTS);
  const tags = input.keywords
    ?.split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 200);
  const width = input.default_thumb.width;
  const height = input.default_thumb.height;
  const uploaderUrl = input.uploader_url
    ? assertAllowedHttpsUrl(input.uploader_url, EPORNER_HOSTS).toString()
    : undefined;

  return {
    id: input.id,
    title: input.title.trim(),
    url: watchUrl.toString(),
    duration: input.length_sec,
    channel: "eporner",
    thumb: thumbUrl.toString(),
    views: input.views,
    rating: input.rate === undefined ? undefined : Math.round(input.rate * 20 * 100) / 100,
    uploader: input.uploader?.trim() || undefined,
    uploaderUrl,
    uploaderId: input.uploader?.trim()
      ? `eporner:${input.uploader.trim().toLocaleLowerCase()}`
      : undefined,
    verified: input.verified,
    tags: tags?.length ? tags : undefined,
    uploadedAt: input.added,
    aspectRatio: width && height ? width / height : undefined,
  };
}

const federatedFallback = createFederatedProvider({
  id: "eporner",
  name: "Eporner",
  description: "Public Eporner catalogue through a Hot Tub-compatible upstream.",
  favicon: "https://www.google.com/s2/favicons?sz=64&domain=eporner.com",
  sortOrder: 60,
  watchHostnames: ["eporner.com"],
  assetHostnames: ["eporner.com"],
  sortOptions: [
    { id: "popular", title: "Most Popular" },
    { id: "new", title: "Newest" },
    { id: "rating", title: "Top Rated" },
    { id: "weekly", title: "Popular This Week" },
    { id: "monthly", title: "Popular This Month" },
    { id: "longest", title: "Longest" },
    { id: "shortest", title: "Shortest" },
  ],
});

async function getOfficialVideos(
  request: VideosRequest,
  context: ProviderContext,
): Promise<ProviderVideoPage> {
  const url = new URL(API_URL);
  url.searchParams.set("query", request.query || "all");
  url.searchParams.set("per_page", String(request.pageSize));
  url.searchParams.set("page", String(request.page));
  url.searchParams.set("thumbsize", "big");
  url.searchParams.set("order", sortMap[request.sort] ?? "most-popular");
  url.searchParams.set("gay", mapOrientation(request.orientation, request.gender));
  url.searchParams.set("lq", mapQuality(request.quality));
  url.searchParams.set("format", "json");

  // Eporner's own API regularly takes 5-6 seconds to answer a catalogue
  // query, so the previous 8s budget expired under normal conditions and
  // handed every request to the fallbacks.
  const payload = await fetchProviderJson("eporner", context.fetch, url, EPORNER_HOSTS, 12_000);
  const parsed = epornerResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("Eporner returned an incompatible API response.");
  }

  const items: Video[] = [];
  for (const input of parsed.data.videos) {
    try {
      items.push(normaliseVideo(input));
    } catch {
      // A malformed or off-domain item is dropped rather than weakening the allowlist.
    }
  }

  return {
    items,
    hasNextPage: parsed.data.page < parsed.data.total_pages,
    totalResults: parsed.data.total_count,
  };
}

async function getVideos(
  request: VideosRequest,
  context: ProviderContext,
): Promise<ProviderVideoPage> {
  return firstNonEmptyPage(
    [
      getOfficialVideos(request, context),
      request.query
        ? federatedFallback.searchVideos(request, context)
        : federatedFallback.listVideos(request, context),
    ],
    "Eporner has no available catalogue backend.",
  );
}

async function getUploader(request: UploadersRequest, context: ProviderContext): Promise<Uploader> {
  const rawName =
    request.uploaderName ??
    request.uploaderId?.replace(/^eporner:/i, "").replace(/[-_]+/g, " ") ??
    "Creator";
  const name = rawName.trim() || "Creator";
  let videos: Video[] | undefined;

  if (request.profileContent) {
    try {
      const page = await getVideos(
        {
          query: name,
          channel: "eporner",
          sort: request.profileVideosSort === "views" ? "popular" : "new",
          page: 1,
          pageSize: 40,
          blockedKeywords: [],
          blockedUploaders: [],
        },
        context,
      );
      videos = page.items.filter(
        (video) => video.uploader?.toLocaleLowerCase() === name.toLocaleLowerCase(),
      );
    } catch {
      videos = [];
    }
  }

  const example = videos?.[0];
  return {
    id: request.uploaderId ?? `eporner:${name.toLocaleLowerCase()}`,
    name: example?.uploader ?? name,
    normalizedName: (example?.uploader ?? name).toLocaleLowerCase(),
    url: example?.uploaderUrl,
    channel: "eporner",
    verified: example?.verified,
    videoCount: videos?.length || undefined,
    videos,
  };
}

export const epornerProvider: ProviderAdapter = {
  id: "eporner",
  name: "Eporner",
  channel,
  capabilities,
  status: "active",
  integration: "official",
  listVideos: getVideos,
  searchVideos: getVideos,
  getUploader,
};
