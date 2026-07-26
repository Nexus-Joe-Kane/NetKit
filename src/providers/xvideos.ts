import { createFederatedProvider } from "./federated";

export const xvideosProvider = createFederatedProvider({
  id: "xvideos",
  name: "XVideos",
  description: "Public catalogue federated through redundant Hot Tub-compatible sources.",
  favicon: "https://www.google.com/s2/favicons?sz=64&domain=xvideos.com",
  sortOrder: 30,
  watchHostnames: ["xvideos.com"],
  assetHostnames: ["xvideos.com", "xvideos-cdn.com"],
  sortOptions: [
    { id: "relevance", title: "Most Relevant" },
    { id: "new", title: "Newest" },
    { id: "rating", title: "Top Rated" },
    { id: "duration", title: "Longest" },
    { id: "views", title: "Most Viewed" },
    { id: "random", title: "Random" },
  ],
});
