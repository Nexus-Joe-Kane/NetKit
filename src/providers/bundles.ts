import type { ChannelOptionChoice } from "../hottub/schemas";
import { featuredProviderIds } from "./registry";
import { BUNDLE_SORT_OPTIONS } from "./sort-dialect";

/**
 * A bundle is a virtual channel that fans out to several real ones. It is not a
 * `ProviderAdapter`: `/api/videos` expands it into its members so the existing
 * per-channel validation, blocking and round-robin merging all apply unchanged,
 * and every item keeps the channel that actually served it — which is what the
 * app needs for playback and branding.
 *
 * Membership is deliberately small. Each member costs at least one upstream
 * subrequest and a Worker request has a hard subrequest budget, so a bundle
 * spanning every channel would fail outright rather than return a bigger feed.
 * Six members is the cap.
 */
export interface ChannelBundle {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Key into the embedded artwork; served at `/assets/icon-<icon>.png`. */
  readonly icon: string;
  readonly systemImage: string;
  readonly sortOrder: number;
  /** Resolved lazily so the merged feed tracks the registry. */
  readonly members: () => readonly string[];
  readonly sortOptions: readonly ChannelOptionChoice[];
  /** Only bundles containing an orientation-aware channel offer the control. */
  readonly orientation: boolean;
  readonly default?: boolean;
}

export const ALL_BUNDLE_ID = "all";

/**
 * Bundle membership is editorial, so it is kept to groupings a viewer would
 * recognise from the sites themselves rather than invented taxonomies, and
 * every member was confirmed to return a live catalogue page before being
 * listed. Channels may appear in more than one bundle.
 *
 * There is no "Popular" bundle. Popularity is a sort, not a set of channels —
 * every bundle already offers `Most Viewed`, translated into each member's own
 * dialect — so a fixed "popular" channel list would just be a second Mainstream
 * under a name that promised more than it delivered.
 */
const BUNDLES: readonly ChannelBundle[] = [
  {
    id: ALL_BUNDLE_ID,
    name: "All channels",
    description: "The featured channels interleaved into a single feed.",
    icon: "all",
    systemImage: "square.stack.3d.up",
    sortOrder: 0,
    members: () => featuredProviderIds(),
    // The featured set includes Eporner and xHamster, which declare their own
    // rich sorts, plus Eporner and FapHouse, which honour orientation.
    sortOptions: [{ id: "relevance", title: "Most Relevant" }, ...BUNDLE_SORT_OPTIONS],
    orientation: true,
    default: true,
  },
  {
    id: "mainstream",
    name: "Mainstream tubes",
    description: "The largest general-audience tube sites in one feed.",
    icon: "mainstream",
    systemImage: "square.grid.2x2",
    sortOrder: 1,
    members: () => ["pornhub", "xvideos", "xhamster", "xnxx", "redtube", "youporn"],
    sortOptions: BUNDLE_SORT_OPTIONS,
    orientation: false,
  },
  {
    id: "amateur",
    name: "Amateur & creators",
    description: "Creator-uploaded and amateur catalogues.",
    icon: "amateur",
    systemImage: "person.crop.square",
    sortOrder: 2,
    members: () => ["erome", "redgifs", "sxyprn", "shooshtime", "tokyomotion"],
    sortOptions: BUNDLE_SORT_OPTIONS,
    orientation: false,
  },
  {
    id: "shorts",
    name: "Shorts & vertical",
    description: "Short-form, vertical-video catalogues.",
    icon: "shorts",
    systemImage: "rectangle.portrait",
    sortOrder: 3,
    members: () => ["fikfap", "fyptt", "ph-shorties", "tikporn", "viralxxxporn"],
    sortOptions: BUNDLE_SORT_OPTIONS,
    orientation: false,
  },
  {
    id: "anime",
    name: "Animated & hentai",
    description: "Animated, hentai, and rule-34 catalogues.",
    icon: "anime",
    systemImage: "sparkles",
    sortOrder: 4,
    members: () => ["hentaihaven", "hentaitv", "rule34video"],
    sortOptions: BUNDLE_SORT_OPTIONS,
    orientation: false,
  },
  {
    id: "asian",
    name: "Asian & JAV",
    description: "Japanese and wider Asian catalogues.",
    icon: "asian",
    systemImage: "circle.circle",
    sortOrder: 5,
    members: () => ["javtiful", "vjav", "hsex", "paradisehill", "tokyomotion"],
    sortOptions: BUNDLE_SORT_OPTIONS,
    orientation: false,
  },
];

const bundleMap = new Map(BUNDLES.map((bundle) => [bundle.id, bundle]));

export function listBundles(): readonly ChannelBundle[] {
  return BUNDLES;
}

export function getBundle(id: string): ChannelBundle | undefined {
  return bundleMap.get(id);
}

export function isBundleId(id: string): boolean {
  return bundleMap.has(id);
}
