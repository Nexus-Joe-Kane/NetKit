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
  // fpo.xxx paginates with trailing path segments, not query parameters:
  // `/new-1/` and `/new-1/3/` for browse, `/search/<query>/` and
  // `/search/<query>/3/` for search. The old `/videos/` and `?page=` forms
  // return 404.
  buildUrls(request) {
    const page = Math.max(1, request.page);
    const suffix = page === 1 ? "" : `${page}/`;
    if (request.query) {
      const encoded = encodeURIComponent(request.query);
      return [
        new URL(`https://www.fpo.xxx/search/${encoded}/${suffix}`),
        new URL(`https://www.fpo.xxx/search/${encoded}/`),
      ];
    }
    return [new URL(`https://www.fpo.xxx/new-1/${suffix}`), new URL("https://www.fpo.xxx/")];
  },
  isWatchUrl(url) {
    return /\/video\/\d+\/[^/]+\/?$/i.test(url.pathname);
  },
  tags: [
    { name: "Public", systemImage: "globe" },
    { name: "Server HTML", systemImage: "doc.text.magnifyingglass" },
  ],
});
