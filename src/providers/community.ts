import { createFederatedProvider } from "./federated";
import type { ProviderAdapter } from "./types";

/**
 * Channels served by the community Hot Tub-compatible upstream.
 *
 * These are definitions, not scrapers: the upstream already exposes them, and
 * this source federates through it exactly as it does for xHamster, XVideos
 * and Pornhub. Every entry below was verified by requesting a page and reading
 * the hostnames it actually returned, so the URL allowlists reflect observed
 * behaviour rather than a guess from the domain name. Channels whose responses
 * were empty, timed out, or pointed at unrelated third-party hosts were left
 * out rather than shipped broken.
 *
 * Sort options mirror what the upstream declares for each channel, so no
 * control is offered that the upstream cannot honour.
 *
 * Generated against the upstream catalogue on 2026-07-27.
 */
interface CommunityChannel {
  id: string;
  name: string;
  favicon: string;
  watch: readonly string[];
  assets: readonly string[];
  sorts: ReadonlyArray<{ id: string; title: string }>;
}

const COMMUNITY_CHANNELS: readonly CommunityChannel[] = [
  {
    id: "beeg",
    name: "Beeg",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=beeg.com",
    watch: ["beeg.com", "externulls.com"],
    assets: ["beeg.com", "externulls.com"],
    sorts: [],
  },
  {
    id: "chaturbate",
    name: "Chaturbate",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=chaturbate.com",
    watch: ["chaturbate.com"],
    assets: ["chaturbate.com", "mmcdn.com"],
    sorts: [
      { id: "latest-updates", title: "Latest" },
      { id: "most-popular", title: "Most Viewed" },
      { id: "top-rated", title: "Top Rated" },
    ],
  },
  {
    id: "erome",
    name: "EroMe",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=erome.com",
    watch: ["erome.com"],
    assets: ["erome.com"],
    sorts: [
      { id: "new", title: "New" },
      { id: "hot", title: "Hot" },
    ],
  },
  {
    id: "freeuseporn",
    name: "FreeusePorn",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=freeuseporn.com",
    watch: ["freeuseporn.com"],
    assets: ["freeuseporn.com"],
    sorts: [
      { id: "recent", title: "Most Recent" },
      { id: "viewed", title: "Most Viewed" },
      { id: "rated", title: "Top Rated" },
      { id: "favorites", title: "Top Favorites" },
      { id: "watched", title: "Being Watched" },
    ],
  },
  {
    id: "heavyfetish",
    name: "HeavyFetish",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=heavyfetish.com",
    watch: ["heavyfetish.com"],
    assets: ["heavyfetish.com"],
    sorts: [
      { id: "new", title: "Latest" },
      { id: "popular", title: "Most Popular" },
      { id: "rated", title: "Top Rated" },
      { id: "longest", title: "Longest" },
      { id: "commented", title: "Most Commented" },
      { id: "recommended", title: "Most Favorited" },
    ],
  },
  {
    id: "hentaihaven",
    name: "Hentai Haven",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=hentaihaven.xxx",
    watch: ["hentaihaven.xxx"],
    assets: ["hentaihaven.xxx", "master-lengs.org", "octopusmanifest.org"],
    sorts: [],
  },
  {
    id: "homoxxx",
    name: "Homo.xxx",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=homo.xxx",
    watch: ["homo.xxx"],
    assets: ["homo.xxx"],
    sorts: [
      { id: "new", title: "New" },
      { id: "popular", title: "Popular" },
      { id: "trending", title: "Trending" },
    ],
  },
  {
    id: "hsex",
    name: "Hsex",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=hsex.tv",
    watch: ["hsex.tv"],
    assets: ["hdcdn.online", "hsex.tv"],
    sorts: [
      { id: "new", title: "Latest" },
      { id: "hot", title: "Hottest" },
      { id: "weekly", title: "Weekly Top" },
      { id: "monthly", title: "Monthly Top" },
      { id: "five_min_new", title: "5-10 Min Latest" },
      { id: "five_min_hot", title: "5-10 Min Hot" },
      { id: "ten_min_new", title: "10+ Min Latest" },
      { id: "ten_min_hot", title: "10+ Min Hot" },
    ],
  },
  {
    id: "hypnotube",
    name: "Hypnotube",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=hypnotube.com",
    watch: ["hypnotube.com"],
    assets: ["hypnotube.com"],
    sorts: [
      { id: "most recent", title: "Most Recent" },
      { id: "most viewed", title: "Most Viewed" },
      { id: "top rated", title: "Top Rated" },
      { id: "longest", title: "Longest" },
    ],
  },
  {
    id: "javtiful",
    name: "Javtiful",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=javtiful.com",
    watch: ["javtiful.com", "spacemoehre.de"],
    assets: ["jav.si", "javtiful.com", "spacemoehre.de"],
    sorts: [
      { id: "relevance", title: "Relevance" },
      { id: "latest", title: "Latest" },
      { id: "popular", title: "Popular" },
    ],
  },
  {
    id: "noodlemagazine",
    name: "Noodlemagazine",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=noodlemagazine.com",
    watch: ["noodlemagazine.com", "spacemoehre.de"],
    assets: ["noodlemagazine.com", "pvvstream.pro", "spacemoehre.de"],
    sorts: [
      { id: "views", title: "Views" },
      { id: "date", title: "Newest" },
      { id: "duration", title: "Duration" },
    ],
  },
  {
    id: "omgxxx",
    name: "OMG XXX",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=www.omg.xxx",
    watch: ["omg.xxx"],
    assets: ["omg.xxx"],
    sorts: [
      { id: "latest-updates", title: "Latest" },
      { id: "most-popular", title: "Most Viewed" },
      { id: "top-rated", title: "Top Rated" },
    ],
  },
  {
    id: "perfectgirls",
    name: "Perfectgirls",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=perfectgirls.xxx",
    watch: ["perfectgirls.xxx"],
    assets: ["perfectgirls.xxx"],
    sorts: [
      { id: "new", title: "New" },
      { id: "popular", title: "Popular" },
      { id: "trending", title: "Trending" },
    ],
  },
  {
    id: "ph-shorties",
    name: "PH Shorties",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=pornhub.com",
    watch: ["pornhub.com"],
    assets: ["phncdn.com", "pornhub.com"],
    sorts: [
      { id: "new", title: "New" },
      { id: "trending", title: "Trending" },
      { id: "mostviewed", title: "Most Viewed" },
      { id: "top_rated", title: "Top Rated" },
      { id: "hottest", title: "Hottest" },
    ],
  },
  {
    id: "pmvhaven",
    name: "PMVHaven",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=pmvhaven.com",
    watch: ["ovh.net", "pmvhaven.com"],
    assets: ["ovh.net", "pmvhaven.com"],
    sorts: [
      { id: "relevance", title: "Relevance" },
      { id: "newest", title: "Newest" },
      { id: "oldest", title: "Oldest" },
      { id: "most viewed", title: "Most Viewed" },
      { id: "most liked", title: "Most Liked" },
      { id: "most disliked", title: "Most Disliked" },
    ],
  },
  {
    id: "porn00",
    name: "Porn00",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=www.porn00.org",
    watch: ["porn00.org"],
    assets: ["porn00.org"],
    sorts: [
      { id: "new", title: "New" },
      { id: "popular", title: "Popular" },
      { id: "top-rated", title: "Top Rated" },
    ],
  },
  {
    id: "pornhat",
    name: "Pornhat",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=pornhat.com",
    watch: ["pornhat.com"],
    assets: ["pornhat.com"],
    sorts: [
      { id: "new", title: "New" },
      { id: "popular", title: "Popular" },
      { id: "trending", title: "Trending" },
    ],
  },
  {
    id: "pornhd3x",
    name: "PornHD3X",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=www.pornhd3x.tv",
    watch: ["pornhd3x.tv", "spacemoehre.de"],
    assets: ["pornhd3x.tv", "spacemoehre.de"],
    sorts: [{ id: "new", title: "Latest" }],
  },
  {
    id: "porntrex",
    name: "PornTrex",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=porntrex.com",
    watch: ["porntrex.com"],
    assets: ["cdntrex.com", "porntrex.com"],
    sorts: [
      { id: "new", title: "Latest" },
      { id: "popular", title: "Most Viewed" },
      { id: "rated", title: "Top Rated" },
    ],
  },
  {
    id: "pornxp",
    name: "PornXP",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=pornxp.ph",
    watch: ["pornxp.ph"],
    assets: ["pornxp.ph", "pornxp.sh"],
    sorts: [
      { id: "new", title: "New" },
      { id: "best", title: "Best" },
    ],
  },
  {
    id: "pornzog",
    name: "Pornzog",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=pornzog.com",
    watch: ["pornzog.com"],
    assets: ["pornzog.com"],
    sorts: [
      { id: "recent", title: "Recent" },
      { id: "relevance", title: "Relevance" },
      { id: "viewed", title: "Most Viewed" },
      { id: "rated", title: "Most Rated" },
      { id: "longest", title: "Longest" },
    ],
  },
  {
    id: "redgifs",
    name: "RedGifs",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=redgifs.com",
    watch: ["redgifs.com"],
    assets: ["redgifs.com"],
    sorts: [
      { id: "popular", title: "Popular" },
      { id: "established", title: "Established Creators" },
    ],
  },
  {
    id: "redtube",
    name: "Redtube",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=www.redtube.com",
    watch: ["redtube.com"],
    assets: ["rdtcdn.com", "redtube.com"],
    sorts: [],
  },
  {
    id: "rule34video",
    name: "Rule34Video",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=rule34video.com",
    watch: ["rule34video.com"],
    assets: ["rule34video.com"],
    sorts: [
      { id: "post_date", title: "Newest" },
      { id: "video_viewed", title: "Most Viewed" },
      { id: "rating", title: "Top Rated" },
      { id: "duration", title: "Longest" },
      { id: "pseudo_random", title: "Random" },
    ],
  },
  {
    id: "shooshtime",
    name: "Shooshtime",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=shooshtime.com",
    watch: ["shooshtime.com"],
    assets: ["shooshtime.com"],
    sorts: [
      { id: "new", title: "Newest" },
      { id: "viewed", title: "Most Viewed" },
      { id: "rated", title: "Top Rated" },
      { id: "comments", title: "Most Commented" },
      { id: "recommended", title: "Recommended" },
    ],
  },
  {
    id: "thepornbunny",
    name: "ThePornBunny",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=thepornbunny.com",
    watch: ["thepornbunny.com"],
    assets: ["thepornbunny.com"],
    sorts: [
      { id: "new", title: "Latest" },
      { id: "popular", title: "Most Viewed" },
      { id: "rated", title: "Top Rated" },
    ],
  },
  {
    id: "tikporn",
    name: "Tik Porn",
    favicon: "https://tik.porn/favicon.ico",
    watch: ["tik.porn"],
    assets: ["tik.porn"],
    sorts: [
      { id: "new", title: "Newest" },
      { id: "trending", title: "Trending" },
    ],
  },
  {
    id: "tnaflix",
    name: "TnAflix",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=www.tnaflix.com",
    watch: ["tnaflix.com"],
    assets: ["tnaflix.com"],
    sorts: [
      { id: "new", title: "New" },
      { id: "featured", title: "Featured" },
      { id: "toprated", title: "Top Rated" },
    ],
  },
  {
    id: "tokyomotion",
    name: "Tokyo Motion",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=www.tokyomotion.net",
    watch: ["tokyomotion.net"],
    assets: ["tokyo-motion.net", "tokyomotion.net"],
    sorts: [
      { id: "being-watched", title: "Being Watched" },
      { id: "most-recent", title: "Most Recent" },
      { id: "most-viewed", title: "Most Viewed" },
      { id: "most-commented", title: "Most Commented" },
      { id: "top-rated", title: "Top Rated" },
      { id: "top-favorites", title: "Top Favorites" },
      { id: "longest", title: "Longest" },
    ],
  },
  {
    id: "tube8",
    name: "Tube8",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=tube8.com",
    watch: ["tube8.com"],
    assets: ["spacemoehre.de", "t8cdn.com", "tube8.com"],
    sorts: [
      { id: "new", title: "Newest" },
      { id: "popular", title: "Most Viewed" },
      { id: "rated", title: "Top Rated" },
    ],
  },
  {
    id: "viralxxxporn",
    name: "Viralxxxporn",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=viralxxxporn.com",
    watch: ["viralxxxporn.com"],
    assets: ["viralxxxporn.com"],
    sorts: [],
  },
  {
    id: "vjav",
    name: "VJAV",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=vjav.com",
    watch: ["vjav.com"],
    assets: ["vjav.com"],
    sorts: [
      { id: "new", title: "Latest" },
      { id: "popular", title: "Popular" },
      { id: "views", title: "Most Viewed" },
      { id: "top", title: "Top Rated" },
      { id: "long", title: "Longest" },
      { id: "commented", title: "Most Commented" },
    ],
  },
  {
    id: "vrporn",
    name: "VRPorn",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=vrporn.com",
    watch: ["vrporn.com"],
    assets: ["vrporn.com"],
    sorts: [
      { id: "hot", title: "Hot Right Now" },
      { id: "new", title: "New" },
      { id: "popular", title: "Popular" },
    ],
  },
  {
    id: "wowxxx",
    name: "WOW.XXX",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=wow.xxx",
    watch: ["wow.xxx"],
    assets: ["wow.xxx"],
    sorts: [
      { id: "new", title: "Latest" },
      { id: "popular", title: "Most Viewed" },
      { id: "rated", title: "Top Rated" },
    ],
  },
  {
    id: "xfree",
    name: "XFree",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=xfree.com",
    watch: ["xfree.com"],
    assets: ["xfree.com"],
    sorts: [],
  },
  {
    id: "xgroovy",
    name: "XGroovy",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=xgroovy.com",
    watch: ["xgroovy.com"],
    assets: ["xgroovy.com"],
    sorts: [],
  },
  {
    id: "xnxx",
    name: "XNXX",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=xnxx.com",
    watch: ["xnxx.com"],
    assets: ["xnxx-cdn.com", "xnxx.com"],
    sorts: [
      { id: "popular", title: "Most Viewed" },
      { id: "new", title: "Latest (Most Viewed)" },
    ],
  },
  {
    id: "yesporn",
    name: "YesPorn",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=yesporn.vip",
    watch: ["yesporn.vip"],
    assets: ["b-cdn.net", "yesporn.vip"],
    sorts: [
      { id: "new", title: "Latest" },
      { id: "popular", title: "Most Viewed" },
      { id: "rated", title: "Top Rated" },
      { id: "longest", title: "Longest" },
      { id: "commented", title: "Most Commented" },
      { id: "recommended", title: "Most Favorited" },
      { id: "random", title: "Random" },
    ],
  },
  {
    id: "youjizz",
    name: "YouJizz",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=www.youjizz.com",
    watch: ["youjizz.com"],
    assets: ["youjizz.com"],
    sorts: [
      { id: "new", title: "New" },
      { id: "popular", title: "Popular" },
      { id: "top-rated", title: "Top Rated" },
      { id: "top-rated-week", title: "Top Rated (Week)" },
      { id: "top-rated-month", title: "Top Rated (Month)" },
      { id: "trending", title: "Trending" },
      { id: "random", title: "Random" },
    ],
  },
  {
    id: "youporn",
    name: "YouPorn",
    favicon: "https://www.google.com/s2/favicons?sz=64&domain=youporn.com",
    watch: ["youporn.com"],
    assets: ["youporn.com", "ypncdn.com"],
    sorts: [{ id: "new", title: "Most Recent" }],
  },
];

export const communityProviders: readonly ProviderAdapter[] = COMMUNITY_CHANNELS.map(
  (channel, index) =>
    createFederatedProvider({
      id: channel.id,
      name: channel.name,
      description: `Public catalogue federated through the community Hot Tub source.`,
      favicon: channel.favicon,
      // After the six primary channels, in the upstream's own order.
      sortOrder: 100 + index,
      watchHostnames: channel.watch,
      assetHostnames: channel.assets,
      sortOptions: channel.sorts,
      // Only the community upstream carries these; asking the official one
      // would spend a subrequest on a channel it does not know.
      upstreams: ["community"],
    }),
);
