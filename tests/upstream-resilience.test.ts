import { firstNonEmptyPage } from "../src/providers/race";
import type { ProviderVideoPage } from "../src/providers/types";
import { xhamsterProvider } from "../src/providers/xhamster";
import { isChallengePage } from "../src/utils/urls";
import { upstreamFixture } from "./fixtures/upstream";
import { createEnv } from "./helpers/context";

function page(items: number, extra: Partial<ProviderVideoPage> = {}): ProviderVideoPage {
  return {
    items: Array.from({ length: items }, () => ({}) as never),
    hasNextPage: false,
    ...extra,
  };
}

function delayed<T>(value: T, ms: number): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function rejected(ms: number): Promise<ProviderVideoPage> {
  return new Promise((_resolve, reject) => setTimeout(() => reject(new Error("down")), ms));
}

describe("firstNonEmptyPage", () => {
  it("prefers a slower source with results over a fast empty one", async () => {
    const result = await firstNonEmptyPage(
      [delayed(page(0), 0), delayed(page(7), 20)],
      "no source",
    );
    expect(result.items).toHaveLength(7);
  });

  it("returns an empty page when every source agrees there are no results", async () => {
    const result = await firstNonEmptyPage([delayed(page(0), 0), delayed(page(0), 5)], "no source");
    expect(result.items).toHaveLength(0);
  });

  it("reports a failure when a source errored and the rest were empty", async () => {
    // Otherwise an outage renders as an empty channel and the caller never
    // falls back to its last-known-good page.
    await expect(
      firstNonEmptyPage([delayed(page(0), 0), rejected(5)], "no source"),
    ).rejects.toThrow("no source");
  });

  it("reports a failure when every source is down", async () => {
    await expect(firstNonEmptyPage([rejected(0), rejected(5)], "no source")).rejects.toThrow(
      "no source",
    );
  });
});

describe("federated upstream tolerance", () => {
  it("keeps the valid records when an upstream mixes in malformed ones", async () => {
    const fixture = upstreamFixture("xhamster");
    const good = fixture.items[0]!;
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            pageInfo: { hasNextPage: false },
            // Upstreams routinely emit records with an empty thumb; those must
            // not discard the whole page.
            items: [{ ...good, thumb: "" }, good, { ...good, url: "not-a-url" }],
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    ) as unknown as typeof fetch;

    const result = await xhamsterProvider.listVideos(
      {
        channel: "xhamster",
        sort: "new",
        page: 1,
        pageSize: 10,
        blockedKeywords: [],
        blockedUploaders: [],
      } as never,
      { env: createEnv(), fetch: fetcher, requestId: "test", now: new Date() },
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.title).toBe(good.title);
  });

  it("does not re-serve page one for a channel that cannot page", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            // The upstream claims a next page even though it ignores `page`.
            pageInfo: { hasNextPage: true },
            items: upstreamFixture("xhamster").items,
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    ) as unknown as typeof fetch;

    const base = {
      channel: "xhamster",
      sort: "new",
      pageSize: 10,
      blockedKeywords: [],
      blockedUploaders: [],
    };
    const context = { env: createEnv(), fetch: fetcher, requestId: "test", now: new Date() };

    const first = await xhamsterProvider.listVideos({ ...base, page: 1 } as never, context);
    expect(first.items.length).toBeGreaterThan(0);
    // Believing the upstream's hasNextPage would make the app fetch the same
    // ten videos forever.
    expect(first.hasNextPage).toBe(false);

    const callsAfterFirst = vi.mocked(fetcher).mock.calls.length;
    const second = await xhamsterProvider.listVideos({ ...base, page: 2 } as never, context);
    expect(second.items).toEqual([]);
    expect(second.hasNextPage).toBe(false);
    // And the request is not even made, which saves a subrequest.
    expect(vi.mocked(fetcher).mock.calls.length).toBe(callsAfterFirst);
  });

  it("survives an upstream that sends blank tags", async () => {
    const fixture = upstreamFixture("xhamster");
    const good = fixture.items[0]!;
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            pageInfo: { hasNextPage: false },
            // Exactly what one channel returns: a tag array of empty strings.
            // The output schema requires each tag to be non-empty, so this
            // silently discarded every video on the page.
            items: [{ ...good, tags: ["", "", ""], categories: ["  ", "Real"] }],
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    ) as unknown as typeof fetch;

    const result = await xhamsterProvider.listVideos(
      {
        channel: "xhamster",
        sort: "new",
        page: 1,
        pageSize: 10,
        blockedKeywords: [],
        blockedUploaders: [],
      } as never,
      { env: createEnv(), fetch: fetcher, requestId: "test", now: new Date() },
    );

    expect(result.items).toHaveLength(1);
    // Blank labels are dropped rather than passed on to fail validation.
    expect(result.items[0]?.tags).toBeUndefined();
    expect(result.items[0]?.categories).toEqual(["Real"]);
  });
});

describe("isChallengePage", () => {
  it("does not treat an ordinary page carrying a Turnstile widget as a challenge", () => {
    // Both fpo.xxx and FapHouse serve this script on normal catalogue pages.
    const html = `<html><body><div class="video"></div>
      <script src="https://challenges.cloudflare.com/turnstile/v0/api.js?compat=recaptcha"></script>
      </body></html>`;
    expect(isChallengePage(html)).toBe(false);
  });

  it("still detects a real interstitial", () => {
    expect(isChallengePage("<title>Just a moment...</title>")).toBe(true);
    expect(
      isChallengePage('<script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script>'),
    ).toBe(true);
    expect(isChallengePage("Please verify you are human before continuing")).toBe(true);
    expect(isChallengePage("<h1>Access Denied</h1>")).toBe(true);
  });
});
