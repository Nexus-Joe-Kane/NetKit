import { createFederatedProvider } from "./federated";

export const xhamsterProvider = createFederatedProvider({
  id: "xhamster",
  name: "xHamster",
  description: "Public catalogue federated through redundant Hot Tub-compatible sources.",
  favicon: "https://www.google.com/s2/favicons?sz=64&domain=xhamster.com",
  sortOrder: 10,
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
