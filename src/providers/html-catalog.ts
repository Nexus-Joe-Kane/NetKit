import { parse, type HTMLElement } from "node-html-parser";
import type { Channel, Video, VideosRequest } from "../hottub/schemas";
import { assertAllowedHttpsUrl, fetchProviderHtml } from "../utils/urls";
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderContext,
  ProviderVideoPage,
} from "./types";

interface HtmlCatalogDefinition {
  id: "fpo" | "faphouse-ultra";
  name: string;
  description: string;
  favicon: string;
  premium: boolean;
  status: "active" | "degraded";
  sortOrder: number;
  pageSize: number;
  hostnames: readonly string[];
  assetHostnames: readonly string[];
  buildUrls(request: VideosRequest): URL[];
  isWatchUrl(url: URL): boolean;
  availability?: string;
  tags: ReadonlyArray<{ name: string; systemImage?: string }>;
  /**
   * Sorts this catalogue genuinely honours. Omitted entirely when the site
   * offers none, so the app does not present a control that silently does
   * nothing.
   */
  sortOptions?: ReadonlyArray<{ id: string; title: string }>;
}

const capabilities: ProviderCapabilities = {
  publicBrowse: true,
  publicSearch: true,
  uploaderBrowse: false,
  authenticatedAccess: false,
  history: false,
  likes: false,
  playlists: false,
  premiumAccess: false,
};

function firstAttribute(element: HTMLElement, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = element.getAttribute(name)?.trim();
    if (value) return value;
  }
  return undefined;
}

function safeHttpsUrl(
  value: string | undefined,
  baseUrl: URL,
  allowedHostnames: readonly string[],
): string | undefined {
  if (!value || value.startsWith("data:")) return undefined;
  try {
    return assertAllowedHttpsUrl(new URL(value, baseUrl).toString(), allowedHostnames).toString();
  } catch {
    return undefined;
  }
}

function parseDuration(value: string): number {
  const match = value.match(/(?:(\d{1,2}):)?(\d{1,2}):(\d{2})/);
  if (!match) return 0;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return hours * 3_600 + minutes * 60 + seconds;
}

function parseViews(value: string): number | undefined {
  const match = value.match(/\b([\d,.]+)\s*([kmb])?\s*(?:views?|plays?)\b/i);
  if (!match) return undefined;
  const number = Number(match[1]?.replace(/,/g, ""));
  if (!Number.isFinite(number)) return undefined;
  const multiplier =
    match[2]?.toLowerCase() === "b"
      ? 1_000_000_000
      : match[2]?.toLowerCase() === "m"
        ? 1_000_000
        : match[2]?.toLowerCase() === "k"
          ? 1_000
          : 1;
  return Math.round(number * multiplier);
}

function findCard(anchor: HTMLElement): HTMLElement {
  let current = anchor;
  for (let depth = 0; depth < 4; depth += 1) {
    const classes = current.getAttribute("class") ?? "";
    if (/(?:video|thumb|tile|card|item)/i.test(classes)) return current;
    const parent = current.parentNode;
    if (!parent || parent.nodeType !== 1) break;
    current = parent as HTMLElement;
  }
  return anchor;
}

function cleanTitle(value: string, duration: number): string {
  let title = value.replace(/\s+/g, " ").trim();
  if (duration) title = title.replace(/(?:(?:\d{1,2}):)?\d{1,2}:\d{2}/g, " ");
  title = title
    .replace(/\b(?:HD|Full HD|UHD|4K|8K|VR)\b/gi, " ")
    .replace(/\b[\d,.]+\s*[kmb]?\s*(?:views?|plays?)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return title.slice(0, 500);
}

function titleFromCard(anchor: HTMLElement, card: HTMLElement, duration: number): string {
  const image = anchor.querySelector("img") ?? card.querySelector("img");
  const candidate =
    firstAttribute(anchor, ["data-title", "title", "aria-label"]) ??
    firstAttribute(image ?? anchor, ["alt", "title"]) ??
    card.querySelector('[class*="title"]')?.textContent ??
    anchor.textContent;
  return cleanTitle(candidate, duration);
}

function idFromUrl(url: URL): string {
  const match = url.pathname.match(/\/videos?\/([^/]+)/i);
  return (match?.[1] ?? url.pathname.split("/").filter(Boolean).at(-1) ?? url.pathname).slice(
    0,
    256,
  );
}

function parseItems(definition: HtmlCatalogDefinition, html: string, pageUrl: URL): Video[] {
  const root = parse(html);
  const items: Video[] = [];
  const seen = new Set<string>();

  for (const anchor of root.querySelectorAll("a[href]")) {
    let watchUrl: URL;
    try {
      watchUrl = assertAllowedHttpsUrl(
        new URL(anchor.getAttribute("href") ?? "", pageUrl).toString(),
        definition.hostnames,
      );
    } catch {
      continue;
    }
    if (!definition.isWatchUrl(watchUrl) || seen.has(watchUrl.toString())) continue;

    const card = findCard(anchor);
    const image = anchor.querySelector("img") ?? card.querySelector("img");
    if (!image) continue;
    const duration = parseDuration(card.textContent);
    if (!duration) continue;
    const title = titleFromCard(anchor, card, duration);
    if (!title) continue;
    const thumb = safeHttpsUrl(
      firstAttribute(image, ["data-src", "data-original", "data-lazy-src", "src"]),
      pageUrl,
      definition.assetHostnames,
    );
    if (!thumb) continue;

    seen.add(watchUrl.toString());
    items.push({
      id: idFromUrl(watchUrl),
      title,
      url: watchUrl.toString(),
      duration,
      channel: definition.id,
      thumb,
      views: parseViews(card.textContent),
      isVR: /\bVR\b/i.test(card.textContent),
      availability: definition.availability,
    });
  }

  return items;
}

export function createHtmlCatalogProvider(definition: HtmlCatalogDefinition): ProviderAdapter {
  const channel: Channel = {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    favicon: definition.favicon,
    premium: definition.premium,
    status: definition.status,
    nsfw: true,
    sortOrder: definition.sortOrder,
    groupKey: definition.premium ? "Premium" : "Public",
    cacheDuration: 900,
    tags: [...definition.tags],
    options: definition.sortOptions?.length
      ? [
          {
            id: "sort",
            title: "Sort",
            systemImage: "list.number",
            colorName: "indigo",
            options: [...definition.sortOptions],
          },
        ]
      : undefined,
  };

  async function getVideos(
    request: VideosRequest,
    context: ProviderContext,
  ): Promise<ProviderVideoPage> {
    let lastError: unknown;
    for (const url of definition.buildUrls(request)) {
      try {
        const html = await fetchProviderHtml(
          definition.id,
          context.fetch,
          url,
          definition.hostnames,
        );
        const items = parseItems(definition, html, url).slice(0, request.pageSize);
        if (items.length > 0) {
          return {
            items,
            hasNextPage: items.length >= Math.min(definition.pageSize, request.pageSize),
            message: definition.availability
              ? "Catalog metadata is public; protected playback still requires provider access."
              : undefined,
          };
        }
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
    return {
      items: [],
      hasNextPage: false,
      error: `${definition.name} returned no compatible public catalogue entries.`,
    };
  }

  return {
    id: definition.id,
    name: definition.name,
    channel,
    capabilities,
    status: definition.status,
    integration: "public",
    listVideos: getVideos,
    searchVideos: getVideos,
  };
}
