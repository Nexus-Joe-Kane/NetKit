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
  //
  // Sorting is by listing path too, and only two exist — `/new-1/` and
  // `/popular-1/`. `/top-rated-1/`, `/most-viewed-1/` and `/longest-1/` all
  // 404, so anything other than "new" maps to popular rather than pretending
  // to be a distinct order.
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
    const listing = request.sort === "new" ? "new-1" : "popular-1";
    return [
      new URL(`https://www.fpo.xxx/${listing}/${suffix}`),
      new URL(`https://www.fpo.xxx/new-1/${suffix}`),
      new URL("https://www.fpo.xxx/"),
    ];
  },
  sortOptions: [
    { id: "new", title: "Newest" },
    { id: "popular", title: "Popular" },
  ],
  isWatchUrl(url) {
    return /\/video\/\d+\/[^/]+\/?$/i.test(url.pathname);
  },
  tags: [
    { name: "Public", systemImage: "globe" },
    { name: "Server HTML", systemImage: "doc.text.magnifyingglass" },
  ],
});
