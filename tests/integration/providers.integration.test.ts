import { listProviders } from "../../src/providers/registry";
import type { ProviderContext } from "../../src/providers/types";
import type { VideosRequest } from "../../src/hottub/schemas";

/**
 * Exercises every adapter against its live provider. This is the only check
 * that catches a provider changing its URLs or response shape; the rest of the
 * suite runs on fixtures and would stay green through a total outage.
 *
 *   RUN_INTEGRATION_TESTS=1 npm run test:integration
 */

const context: ProviderContext = {
  env: {} as never,
  fetch,
  requestId: "integration",
  now: new Date(),
};

function request(overrides: Partial<VideosRequest>): VideosRequest {
  return {
    sort: "new",
    page: 1,
    pageSize: 5,
    blockedKeywords: [],
    blockedUploaders: [],
    ...overrides,
  } as VideosRequest;
}

describe.each(listProviders().map((provider) => [provider.name, provider] as const))(
  "%s live catalogue",
  (_name, provider) => {
    it("returns usable browse results", async () => {
      const page = await provider.listVideos(request({ channel: provider.id }), context);
      expect(page.error).toBeUndefined();
      expect(page.items.length).toBeGreaterThan(0);
      for (const item of page.items) {
        expect(item.channel).toBe(provider.id);
        expect(item.url).toMatch(/^https:\/\//);
        expect(item.thumb).toMatch(/^https:\/\//);
        expect(item.title.trim().length).toBeGreaterThan(0);
      }
    }, 60_000);

    it("returns usable search results", async () => {
      const page = await provider.searchVideos(
        request({ channel: provider.id, query: "beach" }),
        context,
      );
      expect(page.error).toBeUndefined();
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items.every((item) => item.url.startsWith("https://"))).toBe(true);
    }, 60_000);
  },
);
