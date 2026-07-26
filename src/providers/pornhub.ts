import { createFederatedProvider } from "./federated";

export const pornhubProvider = createFederatedProvider({
  id: "pornhub",
  name: "Pornhub",
  description: "Public catalogue federated through redundant Hot Tub-compatible sources.",
  favicon: "https://www.google.com/s2/favicons?sz=64&domain=pornhub.com",
  sortOrder: 40,
  watchHostnames: ["pornhub.com"],
  assetHostnames: ["pornhub.com", "phncdn.com"],
  sortOptions: [
    { id: "relevance", title: "Most Relevant" },
    { id: "recent", title: "Newest" },
    { id: "rating", title: "Top Rated" },
    { id: "views", title: "Most Viewed" },
    { id: "longest", title: "Longest" },
  ],
});
