import { createFederatedProvider } from "./federated";

export const xhamsterProvider = createFederatedProvider({
  id: "xhamster",
  name: "xHamster",
  description: "Public catalogue federated through redundant Hot Tub-compatible sources.",
  favicon: "https://www.google.com/s2/favicons?sz=64&domain=xhamster.com",
  sortOrder: 10,
  // Measured 2026-07-27: both upstreams answer every page with the same ten
  // results, and a larger pageSize does not widen them. Left alone it repeated
  // those ten on every scroll and crowded out channels that can page.
  singlePageOnly: true,
  watchHostnames: ["xhamster.com"],
  assetHostnames: ["xhamster.com", "xhcdn.com"],
  sortOptions: [
    { id: "relevance", title: "Most Relevant" },
    { id: "new", title: "Newest" },
    { id: "views", title: "Most Viewed" },
    { id: "rating", title: "Top Rated" },
    { id: "duration", title: "Longest" },
  ],
});
