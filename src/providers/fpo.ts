import { createHtmlCatalogProvider } from "./html-catalog";

export const fpoProvider = createHtmlCatalogProvider({
  id: "fpo",
  name: "fpo.xxx",
  description: "Public browse and search from fpo.xxx's server-rendered catalogue.",
  favicon: "https://www.google.com/s2/favicons?sz=64&domain=fpo.xxx",
  premium: false,
  status: "active",
  sortOrder: 50,
  pageSize: 24,
  hostnames: ["fpo.xxx"],
  assetHostnames: ["fpo.xxx"],
  buildUrls(request) {
    const page = Math.max(1, request.page);
    if (request.query) {
      const encoded = encodeURIComponent(request.query);
      const primary = new URL(`https://www.fpo.xxx/search/${encoded}/`);
      primary.searchParams.set("page", String(page));
      primary.searchParams.set("sort", request.sort);
      const fallback = new URL("https://www.fpo.xxx/");
      fallback.searchParams.set("s", request.query);
      fallback.searchParams.set("page", String(page));
      return [primary, fallback];
    }
    const primary = new URL(
      page === 1 ? "https://www.fpo.xxx/videos/" : `https://www.fpo.xxx/videos/page/${page}/`,
    );
    primary.searchParams.set("sort", request.sort);
    const fallback = new URL("https://www.fpo.xxx/");
    fallback.searchParams.set("page", String(page));
    fallback.searchParams.set("sort", request.sort);
    return [primary, fallback];
  },
  isWatchUrl(url) {
    return /\/video\/\d+\/[^/]+\/?$/i.test(url.pathname);
  },
  tags: [
    { name: "Public", systemImage: "globe" },
    { name: "Server HTML", systemImage: "doc.text.magnifyingglass" },
  ],
});
