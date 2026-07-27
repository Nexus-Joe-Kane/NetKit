import { createHtmlCatalogProvider } from "./html-catalog";

export const faphouseProvider = createHtmlCatalogProvider({
  id: "faphouse-ultra",
  name: "FapHouse Ultra",
  description:
    "Public catalogue metadata only. Protected playback still requires a provider-supported delegated login.",
  favicon: "https://www.google.com/s2/favicons?sz=64&domain=faphouse.com",
  premium: true,
  status: "degraded",
  sortOrder: 20,
  pageSize: 40,
  hostnames: ["faphouse.com", "faphouse2.com", "faphouse4k.com"],
  assetHostnames: ["faphouse.com", "faphouse2.com", "faphouse4k.com", "flixcdn.com"],
  // FapHouse dropped its `/en/` locale prefix; those paths now 404.
  buildUrls(request) {
    const page = Math.max(1, request.page);
    if (request.query) {
      const primary = new URL("https://faphouse.com/search/videos");
      primary.searchParams.set("q", request.query);
      primary.searchParams.set("page", String(page));
      primary.searchParams.set("sort", request.sort);
      return [primary];
    }
    const primary = new URL("https://faphouse.com/videos");
    primary.searchParams.set("page", String(page));
    primary.searchParams.set("sort", request.sort);
    const fallback = new URL("https://faphouse.com/videos");
    fallback.searchParams.set("page", String(page));
    return [primary, fallback];
  },
  isWatchUrl(url) {
    return /\/(?:[a-z]{2}\/)?videos?\//i.test(url.pathname);
  },
  availability: "offline",
  tags: [
    { name: "Catalog only", systemImage: "rectangle.stack" },
    { name: "Premium", systemImage: "star.fill" },
  ],
});
