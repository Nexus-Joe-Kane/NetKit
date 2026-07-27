import { resolveSortForChannel } from "../src/providers/sort-dialect";

const declared = (...entries: Array<[string, string]>) =>
  entries.map(([id, title]) => ({ id, title }));

describe("resolveSortForChannel", () => {
  it("passes through an ID the channel already declares", () => {
    const options = declared(["new", "Latest"], ["popular", "Most Viewed"]);
    expect(resolveSortForChannel(options, "new")).toBe("new");
  });

  it("translates a generic intent into each catalogue's own dialect", () => {
    // Real declarations, taken from the channels themselves.
    expect(resolveSortForChannel(declared(["video_viewed", "Most Viewed"]), "views")).toBe(
      "video_viewed",
    );
    expect(resolveSortForChannel(declared(["most-viewed", "Most Viewed"]), "views")).toBe(
      "most-viewed",
    );
    expect(resolveSortForChannel(declared(["post_date", "Newest"]), "new")).toBe("post_date");
    expect(resolveSortForChannel(declared(["latest-updates", "Latest"]), "new")).toBe(
      "latest-updates",
    );
    expect(resolveSortForChannel(declared(["top_rated", "Top Rated"]), "rated")).toBe("top_rated");
    expect(resolveSortForChannel(declared(["rating", "Top Rated"]), "rated")).toBe("rating");
  });

  it("prefers the most specific match when a catalogue offers several", () => {
    const options = declared(
      ["trending", "Trending"],
      ["hot", "Hottest"],
      ["viewed", "Most Viewed"],
    );
    // "Most Viewed" is a truer reading of the intent than "Trending", even
    // though "Trending" is listed first.
    expect(resolveSortForChannel(options, "views")).toBe("viewed");
  });

  it("falls back to trending-style sorts only when nothing better exists", () => {
    expect(resolveSortForChannel(declared(["trending", "Trending"]), "views")).toBe("trending");
    expect(resolveSortForChannel(declared(["hot", "Hot"]), "views")).toBe("hot");
  });

  it("returns undefined rather than inventing a sort the channel lacks", () => {
    // Eporner declares no relevance ordering, so the caller keeps its own value
    // instead of being handed an unrelated one.
    const eporner = declared(
      ["popular", "Most Popular"],
      ["new", "Newest"],
      ["rating", "Top Rated"],
      ["longest", "Longest"],
    );
    expect(resolveSortForChannel(eporner, "relevance")).toBeUndefined();
    expect(resolveSortForChannel(declared(["new", "Latest"]), "longest")).toBeUndefined();
  });

  it("returns undefined for a channel that declares no sorts at all", () => {
    expect(resolveSortForChannel([], "views")).toBeUndefined();
  });

  it("returns undefined for an unknown intent", () => {
    expect(resolveSortForChannel(declared(["new", "Latest"]), "sideways")).toBeUndefined();
  });
});
