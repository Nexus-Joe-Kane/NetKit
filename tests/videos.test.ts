import { VideosResponseSchema } from "../src/hottub/schemas";
import { handleRequest } from "../src/router";
import { epornerFixture } from "./fixtures/eporner";
import { createEnv, createExecutionContext, post } from "./helpers/context";

function fixtureFetch(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    expect(url.hostname).toBe("www.eporner.com");
    return new Response(JSON.stringify(epornerFixture), {
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

describe("POST /api/videos", () => {
  it("dispatches to the official Eporner adapter and preserves pagination", async () => {
    const fetcher = fixtureFetch();
    const response = await handleRequest(
      post("/api/videos", {
        channel: "eporner",
        query: "fixture",
        page: 1,
        pageSize: 3,
        sort: "new",
      }),
      createEnv(),
      createExecutionContext(),
      fetcher,
    );
    expect(response.status).toBe(200);
    const body = VideosResponseSchema.parse(await response.json());
    expect(body.items).toHaveLength(3);
    expect(body.pageInfo.hasNextPage).toBe(true);
    expect(body.items[0]?.url).toContain("eporner.com/hd-porn/");
    expect(body.items[0]?.formats).toBeUndefined();

    const call = vi.mocked(fetcher).mock.calls[0]?.[0];
    const calledUrl = new URL(call instanceof Request ? call.url : String(call));
    expect(calledUrl.searchParams.get("query")).toBe("fixture");
    expect(calledUrl.searchParams.get("per_page")).toBe("3");
    expect(calledUrl.searchParams.get("order")).toBe("latest");
  });

  it("enforces blocked keywords and blocked uploaders", async () => {
    const response = await handleRequest(
      post("/api/videos", {
        channel: "eporner",
        pageSize: 10,
        blockedKeywords: ["blocked phrase"],
        blockedUploaders: ["blocked creator"],
      }),
      createEnv(),
      createExecutionContext(),
      fixtureFetch(),
    );
    const body = VideosResponseSchema.parse(await response.json());
    expect(body.items.map((item) => item.id)).toEqual(["alpha123"]);
  });

  it("degrades unsupported providers without inventing data", async () => {
    const response = await handleRequest(
      post("/api/videos", { channel: "xhamster", page: 1 }),
      createEnv(),
      createExecutionContext(),
      fixtureFetch(),
    );
    expect(response.status).toBe(200);
    const body = VideosResponseSchema.parse(await response.json());
    expect(body.items).toEqual([]);
    expect(body.pageInfo.error).toContain("xHamster is unavailable");
  });

  it("keeps working when one provider in a multi-channel request is unavailable", async () => {
    const response = await handleRequest(
      post("/api/videos", {
        channels: ["eporner", "pornhub"],
        pageSize: 10,
      }),
      createEnv(),
      createExecutionContext(),
      fixtureFetch(),
    );
    const body = VideosResponseSchema.parse(await response.json());
    expect(body.items).toHaveLength(3);
    expect(body.pageInfo.error).toBeUndefined();
    expect(body.pageInfo.message).toContain("pornhub");
  });

  it("isolates provider failures", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("network details must not leak");
    }) as typeof fetch;
    const response = await handleRequest(
      post("/api/videos", { channel: "eporner" }),
      createEnv(),
      createExecutionContext(),
      fetcher,
    );
    const body = VideosResponseSchema.parse(await response.json());
    expect(body.items).toEqual([]);
    expect(body.pageInfo.error).toBe("eporner: Eporner is temporarily unavailable.");
    expect(JSON.stringify(body)).not.toContain("network details");
  });

  it("rejects malformed request bodies and unknown channels", async () => {
    const malformed = new Request("https://hottub.joekane.org/api/videos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    const malformedResponse = await handleRequest(malformed, createEnv(), createExecutionContext());
    expect(malformedResponse.status).toBe(400);

    const unknownResponse = await handleRequest(
      post("/api/videos", { channel: "invented" }),
      createEnv(),
      createExecutionContext(),
    );
    expect(unknownResponse.status).toBe(400);
  });
});
