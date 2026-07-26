import { epornerProvider } from "../../src/providers/eporner";

describe("Eporner live integration", () => {
  it("accepts the current official API response", async () => {
    const page = await epornerProvider.listVideos(
      {
        channel: "eporner",
        query: "all",
        sort: "new",
        page: 1,
        pageSize: 1,
        blockedKeywords: [],
        blockedUploaders: [],
      },
      {
        env: {} as never,
        fetch,
        requestId: crypto.randomUUID(),
        now: new Date(),
      },
    );
    expect(page.error).toBeUndefined();
    expect(page.items.length).toBeGreaterThan(0);
  });
});
