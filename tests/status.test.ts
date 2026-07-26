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
      "xhamster",
      "faphouse-ultra",
      "xvideos",
      "pornhub",
      "fpo",
      "eporner",
    ]);
    expect(body.channels.find((channel) => channel.id === "eporner")?.status).toBe("active");
    expect(body.channels.filter((channel) => channel.status === "active")).toHaveLength(5);
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
