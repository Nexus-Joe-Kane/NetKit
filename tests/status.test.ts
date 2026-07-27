import { ServerStatusSchema } from "../src/hottub/schemas";
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
    // The merged channel leads, then the six primary channels, then the
    // federated community catalogue.
    expect(body.channels.slice(0, 7).map((channel) => channel.id)).toEqual([
      "all",
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

  it("serves both icons as real PNGs", async () => {
    for (const path of ["/assets/icon.png", "/assets/icon-all.png"]) {
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
});
