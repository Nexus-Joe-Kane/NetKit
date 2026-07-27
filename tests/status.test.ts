import { ServerStatusSchema } from "../src/hottub/schemas";
import { listBundles } from "../src/providers/bundles";
import { getProvider } from "../src/providers/registry";
import { handleRequest } from "../src/router";
import { createEnv, createExecutionContext, post } from "./helpers/context";

describe("POST /api/status", () => {
  it("returns all requested channels and valid channel groups", async () => {
    const response = await handleRequest(
      post("/api/status", { clientVersion: "2.2.7-38" }),
      createEnv(),
      createExecutionContext(),
    );
    expect(response.status).toBe(200);
    const body = ServerStatusSchema.parse(await response.json());
    // The bundles lead, then the six primary channels, then the federated
    // community catalogue.
    expect(body.channels.slice(0, 12).map((channel) => channel.id)).toEqual([
      "all",
      "mainstream",
      "amateur",
      "shorts",
      "anime",
      "asian",
      "xhamster",
      "faphouse-ultra",
      "xvideos",
      "pornhub",
      "fpo",
      "eporner",
    ]);
    expect(body.channels.length).toBeGreaterThan(50);
    expect(new Set(body.channels.map((channel) => channel.id)).size).toBe(body.channels.length);
    expect(body.channels.find((channel) => channel.id === "eporner")?.status).toBe("active");
    expect(body.channels.filter((channel) => channel.status === "active").length).toBeGreaterThan(
      50,
    );
    expect(body.channels.find((channel) => channel.id === "faphouse-ultra")?.status).toBe(
      "degraded",
    );
    expect(body.channels.filter((channel) => channel.status === "restricted")).toHaveLength(0);
    expect(body.channels.find((channel) => channel.id === "xhamster")?.maintainers?.[0]?.role).toBe(
      "upstream",
    );

    const grouped = new Set(body.channelGroups?.flatMap((group) => group.channelIds));
    expect(grouped).toEqual(new Set(body.channels.map((channel) => channel.id)));
  });
});

describe("bundles", () => {
  it("advertises every bundle with artwork, members and a sort control", async () => {
    const response = await handleRequest(
      post("/api/status", {}),
      createEnv(),
      createExecutionContext(),
    );
    const status = ServerStatusSchema.parse(await response.json());

    for (const bundle of listBundles()) {
      const channel = status.channels.find((entry) => entry.id === bundle.id);
      expect(channel, `${bundle.id} is not advertised`).toBeDefined();
      expect(channel!.favicon).toBe(`https://hottub.joekane.org/assets/icon-${bundle.icon}.png`);
      const sort = channel!.options?.find((option) => option.id === "sort");
      expect(sort?.options.length, `${bundle.id} has no sorts`).toBeGreaterThan(0);
      // Only bundles that actually contain an orientation-aware channel offer
      // the control, so it is never a placebo.
      const orientation = channel!.options?.find((option) => option.id === "orientation");
      expect(Boolean(orientation), `${bundle.id} orientation`).toBe(bundle.orientation);
    }
  });

  it("only names members that exist in the registry", async () => {
    for (const bundle of listBundles()) {
      const members = bundle.members();
      expect(members.length, `${bundle.id} is empty`).toBeGreaterThan(1);
      // A bundle costs one subrequest per member and a Worker request has a
      // hard budget, so oversized bundles must fail here, not in production.
      expect(members.length, `${bundle.id} is too wide`).toBeLessThanOrEqual(6);
      for (const member of members) {
        expect(getProvider(member), `${bundle.id} names unknown channel ${member}`).toBeDefined();
      }
    }
  });

  it("groups the bundles separately from the individual channels", async () => {
    const response = await handleRequest(
      post("/api/status", {}),
      createEnv(),
      createExecutionContext(),
    );
    const status = ServerStatusSchema.parse(await response.json());

    const bundleGroup = status.channelGroups?.find((group) => group.id === "bundles");
    expect(bundleGroup?.channelIds).toEqual(listBundles().map((bundle) => bundle.id));
    // A bundle must never also appear as an individually selectable channel.
    const publicGroup = status.channelGroups?.find((group) => group.id === "public");
    for (const bundle of listBundles()) {
      expect(publicGroup?.channelIds).not.toContain(bundle.id);
    }
  });
});

describe("advertised filters", () => {
  it("offers the merged channel as the single default", async () => {
    const response = await handleRequest(
      post("/api/status", {}),
      createEnv(),
      createExecutionContext(),
    );
    const status = ServerStatusSchema.parse(await response.json());

    const defaults = status.channels.filter((channel) => channel.default);
    expect(defaults.map((channel) => channel.id)).toEqual(["all"]);
    expect(status.channelGroups?.[0]?.channelIds?.[0]).toBe("all");
  });

  it("only advertises sorts a channel can actually honour", async () => {
    const response = await handleRequest(
      post("/api/status", {}),
      createEnv(),
      createExecutionContext(),
    );
    const status = ServerStatusSchema.parse(await response.json());
    const sortsFor = (id: string) =>
      status.channels
        .find((channel) => channel.id === id)
        ?.options?.find((option) => option.id === "sort")
        ?.options.map((choice) => choice.id);

    // FapHouse returns identical results for every sort value, so offering a
    // sort control there would be a placebo.
    expect(sortsFor("faphouse-ultra")).toBeUndefined();
    // fpo has exactly two real listing paths; the others 404.
    expect(sortsFor("fpo")).toEqual(["new", "popular"]);
    expect(sortsFor("xhamster")?.length).toBeGreaterThan(1);
  });
});

describe("duration slider", () => {
  it("advertises a range control on every channel", async () => {
    const response = await handleRequest(
      post("/api/status", {}),
      createEnv(),
      createExecutionContext(),
    );
    const status = ServerStatusSchema.parse(await response.json());

    for (const channel of status.channels) {
      const duration = channel.options?.find((option) => option.id === "durationSecondsRange");
      expect(duration, `${channel.id} has no duration control`).toBeDefined();
      expect(duration!.options).toEqual([]);
      // Every properties value must be a string; the client decodes them that
      // way, exactly as it does pageInfo.parameters.
      for (const [key, value] of Object.entries(duration!.properties ?? {})) {
        expect(typeof value, `properties.${key}`).toBe("string");
      }
      expect(duration!.properties?.control).toBe("range");
      expect(JSON.parse(duration!.properties!.ticks!)).toHaveLength(5);
    }
  });
});

describe("artwork", () => {
  it("gives the source and the merged channel their own icons", async () => {
    const response = await handleRequest(
      post("/api/status", {}),
      createEnv(),
      createExecutionContext(),
    );
    const status = ServerStatusSchema.parse(await response.json());
    expect(status.iconUrl).toBe("https://hottub.joekane.org/assets/icon.png");
    const merged = status.channels.find((channel) => channel.id === "all");
    expect(merged?.favicon).toBe("https://hottub.joekane.org/assets/icon-all.png");
    // Every channel should have artwork of some kind.
    for (const channel of status.channels) {
      expect(channel.favicon, `${channel.id} has no favicon`).toBeTruthy();
    }
  });

  it("serves every icon as a real PNG", async () => {
    const paths = [
      "/assets/icon.png",
      ...listBundles().map((bundle) => `/assets/icon-${bundle.icon}.png`),
    ];
    for (const path of paths) {
      const response = await handleRequest(
        new Request(`https://hottub.joekane.org${path}`, {
          headers: { "CF-Connecting-IP": "192.0.2.10" },
        }),
        createEnv(),
        createExecutionContext(),
      );
      expect(response.status, path).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("image/png");
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(bytes.length).toBeGreaterThan(200);
      // PNG magic number, so a corrupt embed fails here rather than on a phone.
      expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    }
  });

  it("404s an icon that does not exist rather than serving an empty body", async () => {
    const response = await handleRequest(
      new Request("https://hottub.joekane.org/assets/icon-nope.png", {
        headers: { "CF-Connecting-IP": "192.0.2.10" },
      }),
      createEnv(),
      createExecutionContext(),
    );
    expect(response.status).toBe(404);
  });
});
