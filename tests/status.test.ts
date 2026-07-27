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
    expect(body.channels.map((channel) => channel.id)).toEqual([
      "all",
      "xhamster",
      "faphouse-ultra",
      "xvideos",
      "pornhub",
      "fpo",
      "eporner",
    ]);
    expect(body.channels.find((channel) => channel.id === "eporner")?.status).toBe("active");
    // Five real providers plus the merged channel.
    expect(body.channels.filter((channel) => channel.status === "active")).toHaveLength(6);
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
