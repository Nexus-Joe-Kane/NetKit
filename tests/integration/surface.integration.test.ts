import { listBundles } from "../../src/providers/bundles";
import { listProviders } from "../../src/providers/registry";
import { handleRequest } from "../../src/router";
import type { Env } from "../../src/config";
import { createEnv, createExecutionContext } from "../helpers/context";
import { FakeD1Database } from "../helpers/fake-d1";

/**
 * Drives the whole app-facing surface against live upstreams.
 *
 * The unit suite runs on fixtures and stays green through a total outage.
 * `providers.integration` proves each adapter lists. Neither answers the
 * question that actually matters — "does everything in the app work" — because
 * that spans discovery, every advertised control, and every channel together.
 *
 * Reports rather than asserts wherever a third party is involved: one upstream
 * having a bad night is not a reason to fail a run. Only invariants this source
 * is responsible for are asserted.
 *
 *   RUN_INTEGRATION_TESTS=1 npm run test:integration
 */

const ORIGIN = "https://hottub.joekane.org";
const VPN_IP = "92.71.54.161";

function env(): Env {
  return { ...createEnv(new FakeD1Database()), ADMIN_ALLOWED_IPS: VPN_IP };
}

async function post(path: string, body: unknown) {
  const response = await handleRequest(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": VPN_IP },
      body: JSON.stringify(body),
    }),
    env(),
    createExecutionContext(),
    fetch,
  );
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) as Record<string, never> };
  } catch {
    return { status: response.status, body: undefined };
  }
}

interface Item {
  channel: string;
  title: string;
  url: string;
  thumb: string;
  duration: number;
}

async function videos(request: Record<string, unknown>): Promise<Item[]> {
  const result = await post("/api/videos", request);
  return ((result.body as unknown as { items?: Item[] })?.items ?? []) as Item[];
}

describe("whole surface", () => {
  it("advertises a coherent channel list", async () => {
    const { status, body } = await post("/api/status", {});
    expect(status).toBe(200);
    const channels = (body as unknown as { channels: Array<Record<string, never>> }).channels;
    const groups = (body as unknown as { channelGroups: Array<{ channelIds: string[] }> })
      .channelGroups;
    console.log(`channels=${channels.length} groups=${groups.length}`);

    const grouped = new Set(groups.flatMap((group) => group.channelIds));
    for (const channel of channels as unknown as Array<{
      id: string;
      favicon?: string;
      default?: boolean;
      options?: Array<{ id: string }>;
    }>) {
      // Anything the picker can show has to be reachable, drawn, and filterable.
      expect(grouped.has(channel.id), `${channel.id} is in no group`).toBe(true);
      expect(Boolean(channel.favicon), `${channel.id} has no artwork`).toBe(true);
      expect(
        channel.options?.some((option) => option.id === "durationSecondsRange"),
        `${channel.id} has no duration control`,
      ).toBe(true);
    }
    const defaults = (channels as unknown as Array<{ default?: boolean }>).filter(
      (channel) => channel.default,
    );
    expect(defaults).toHaveLength(1);
  }, 60_000);

  it("returns items for every bundle, never labelled with the bundle", async () => {
    for (const bundle of listBundles()) {
      const items = await videos({ channel: bundle.id, page: 1, pageSize: 12 });
      const served = [...new Set(items.map((item) => item.channel))];
      console.log(
        `bundle ${bundle.id.padEnd(11)} ${String(items.length).padStart(3)} items ${served.join(",")}`,
      );
      // Playback routes by an item's channel, so a bundle ID on an item would
      // be unplayable.
      expect(served, `${bundle.id} labelled items with itself`).not.toContain(bundle.id);
    }
  }, 300_000);

  it("returns usable items for every individual channel", async () => {
    const ids = listProviders().map((provider) => provider.id);
    const empty: string[] = [];
    for (let index = 0; index < ids.length; index += 4) {
      const batch = await Promise.all(
        ids.slice(index, index + 4).map(async (id) => {
          const items = await videos({ channel: id, page: 1, pageSize: 8 });
          const usable = items.filter(
            (item) => item.title && item.url && item.thumb && item.channel === id,
          );
          return { id, usable: usable.length, total: items.length };
        }),
      );
      for (const row of batch) {
        console.log(`  ${row.id.padEnd(18)} ${String(row.usable).padStart(3)}/${row.total}`);
        if (row.usable === 0) empty.push(row.id);
      }
    }
    // Reported, not asserted: a live catalogue is allowed a bad night, and
    // failing the run here would make the check something people switch off.
    console.log(empty.length === 0 ? "every channel returned items" : `EMPTY: ${empty.join(", ")}`);
  }, 900_000);

  it("honours the duration range it advertises", async () => {
    const items = await videos({
      channel: "all",
      page: 1,
      pageSize: 12,
      durationSecondsRange: "600,3600",
    });
    // Items reporting 0 mean "unknown" and are deliberately kept.
    const violating = items.filter((item) => item.duration > 0 && item.duration < 600);
    console.log(`duration>=10min ${items.length} items, ${violating.length} violations`);
    expect(violating).toHaveLength(0);
  }, 120_000);

  it("changes the feed for each orientation", async () => {
    const feeds: Record<string, string[]> = {};
    for (const gender of ["straight", "gay", "none"]) {
      const items = await videos({ channel: "all", page: 1, pageSize: 12, gender });
      feeds[gender] = [...new Set(items.map((item) => item.channel))];
      console.log(
        `gender=${gender.padEnd(9)} ${String(items.length).padStart(3)} items ${feeds[gender].join(",")}`,
      );
      expect(items.length, `${gender} returned nothing`).toBeGreaterThan(0);
    }
    // Gay must reach a dedicated gay catalogue rather than reusing the default.
    expect(feeds.gay).toContain("homoxxx");
  }, 180_000);

  it("reorders the merged feed when the sort changes", async () => {
    const newest = await videos({ channel: "all", page: 1, pageSize: 10, sort: "new" });
    const viewed = await videos({ channel: "all", page: 1, pageSize: 10, sort: "views" });
    const same =
      JSON.stringify(newest.map((item) => item.url)) ===
      JSON.stringify(viewed.map((item) => item.url));
    console.log(`sort new vs views: ${same ? "IDENTICAL" : "different"}`);
    expect(same, "the sort control produced an identical feed").toBe(false);
  }, 120_000);

  it("searches, pages, and reports uploaders", async () => {
    const search = await videos({ channel: "all", query: "amateur", page: 1, pageSize: 10 });
    console.log(`search ${search.length} items`);
    expect(search.length).toBeGreaterThan(0);

    const first = await videos({ channel: "all", page: 1, pageSize: 8 });
    const second = await videos({ channel: "all", page: 2, pageSize: 8 });
    const repeated = first.filter((item) => second.some((other) => other.url === item.url));
    console.log(`page2 ${second.length} items, ${repeated.length} repeated from page 1`);
    expect(second.length).toBeGreaterThan(0);

    const uploaders = await post("/api/uploaders", { channel: "eporner", uploaderName: "test" });
    expect(uploaders.status).toBe(200);
  }, 180_000);

  it("rejects a channel that does not exist", async () => {
    const result = await post("/api/videos", { channel: "not-a-channel" });
    expect(result.status).toBe(400);
  }, 60_000);
});
