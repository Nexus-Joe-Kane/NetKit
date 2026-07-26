import { createUnavailableProvider } from "./stub";

export const xvideosProvider = createUnavailableProvider({
  id: "xvideos",
  name: "XVideos",
  description: "Awaiting an authorised, stable provider integration.",
  reason:
    "no official public API was verified and HTML scraping is outside this project's integration policy",
  sortOrder: 30,
});
