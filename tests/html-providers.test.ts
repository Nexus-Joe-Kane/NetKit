import { VideosResponseSchema } from "../src/hottub/schemas";
import { handleRequest } from "../src/router";
import { createEnv, createExecutionContext, post } from "./helpers/context";

function htmlFetch(html: string, expectedHost: string): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    expect(url.hostname).toBe(expectedHost);
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }) as typeof fetch;
}

describe("public HTML catalogue providers", () => {
  it("normalizes fpo.xxx server-rendered cards", async () => {
    const html = `
      <main>
        <article class="video-card">
          <a href="/video/420467/public-fixture/" title="Public fixture">
            <img data-src="https://cdn.fpo.xxx/thumb.jpg" alt="Public fixture">
            <span class="duration">12:34</span>
            <span class="views">1.2K views</span>
          </a>
        </article>
      </main>`;
    const response = await handleRequest(
      post("/api/videos", { channel: "fpo", page: "1" }),
      createEnv(),
      createExecutionContext(),
      htmlFetch(html, "www.fpo.xxx"),
    );
    expect(response.status).toBe(200);
    const body = VideosResponseSchema.parse(await response.json());
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      channel: "fpo",
      duration: 754,
      views: 1_200,
    });
    expect(body.items[0]?.availability).toBeUndefined();
  });

  it("shows FapHouse public metadata as unavailable for protected playback", async () => {
    const html = `
      <main>
        <article class="video-tile">
          <a href="/en/video/fixture-title" data-title="Premium fixture">
            <img src="https://ic-nss.flixcdn.com/video/fixture/screen.jpg">
            <span>4K</span><span>36:11</span>
          </a>
        </article>
      </main>`;
    const response = await handleRequest(
      post("/api/videos", { channel: "faphouse-ultra", page: 1 }),
      createEnv(),
      createExecutionContext(),
      htmlFetch(html, "faphouse.com"),
    );
    expect(response.status).toBe(200);
    const body = VideosResponseSchema.parse(await response.json());
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.availability).toBe("offline");
    expect(body.pageInfo.message).toContain("protected playback");
  });
});
