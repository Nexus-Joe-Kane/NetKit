import { VideosResponseSchema } from "../src/hottub/schemas";
import { handleRequest } from "../src/router";
import { epornerFixture } from "./fixtures/eporner";
import { upstreamFixture } from "./fixtures/upstream";
import { createEnv, createExecutionContext, post } from "./helpers/context";

function fixtureFetch(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (["hottubapp.io", "hottub.spacemoehre.de"].includes(url.hostname)) {
      throw new Error("upstream unavailable in official API fixture test");
    }
    expect(url.hostname).toBe("www.eporner.com");
    return new Response(JSON.stringify(epornerFixture), {
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function multiProviderFetch(options: { failEporner?: boolean } = {}): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname === "www.eporner.com") {
      if (options.failEporner) throw new Error("direct API unavailable");
      return new Response(JSON.stringify(epornerFixture), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (["hottubapp.io", "hottub.spacemoehre.de"].includes(url.hostname)) {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        channel: "xhamster" | "xvideos" | "pornhub" | "eporner";
      };
      return new Response(JSON.stringify(upstreamFixture(payload.channel)), {
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected host: ${url.hostname}`);
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

    const call = vi
      .mocked(fetcher)
      .mock.calls.map((entry) => entry[0])
      .find(
        (entry) =>
          new URL(entry instanceof Request ? entry.url : String(entry)).hostname ===
          "www.eporner.com",
      );
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

  it("returns normalized public results from the Hot Tub upstream", async () => {
    const response = await handleRequest(
      post("/api/videos", { channel: "xhamster", page: 1 }),
      createEnv(),
      createExecutionContext(),
      multiProviderFetch(),
    );
    expect(response.status).toBe(200);
    const body = VideosResponseSchema.parse(await response.json());
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.channel).toBe("xhamster");
    expect(body.items[0]?.url).toContain("xhamster.com/videos/");
    expect(body.pageInfo.error).toBeUndefined();
  });

  it("merges official and federated providers", async () => {
    const response = await handleRequest(
      post("/api/videos", {
        channels: ["eporner", "pornhub"],
        pageSize: 10,
      }),
      createEnv(),
      createExecutionContext(),
      multiProviderFetch(),
    );
    const body = VideosResponseSchema.parse(await response.json());
    expect(body.items.length).toBeGreaterThanOrEqual(2);
    expect(body.pageInfo.error).toBeUndefined();
    expect(new Set(body.items.map((item) => item.channel))).toEqual(
      new Set(["eporner", "pornhub"]),
    );
  });

  it("uses the live Hot Tub upstream when direct Eporner Worker egress is unavailable", async () => {
    const fetcher = multiProviderFetch({ failEporner: true });
    const response = await handleRequest(
      post("/api/videos", { channel: "eporner", page: 1 }),
      createEnv(),
      createExecutionContext(),
      fetcher,
    );
    const body = VideosResponseSchema.parse(await response.json());
    expect(body.pageInfo.error).toBeUndefined();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.channel).toBe("eporner");
    expect(
      vi
        .mocked(fetcher)
        .mock.calls.some(
          (entry) =>
            new URL(entry[0] instanceof Request ? entry[0].url : String(entry[0])).hostname ===
            "www.eporner.com",
        ),
    ).toBe(true);
  });

  it("serves the last successful result when every live backend is down", async () => {
    const records = new Map<string, Response>();
    const cache = {
      async match(key: Request) {
        return records.get(key.url)?.clone();
      },
      async put(key: Request, value: Response) {
        records.set(key.url, value.clone());
      },
    };
    vi.stubGlobal("caches", { default: cache });

    try {
      const firstContext = createExecutionContext();
      const first = await handleRequest(
        post("/api/videos", { channel: "xhamster", page: 1 }),
        createEnv(),
        firstContext,
        multiProviderFetch(),
      );
      expect(first.status).toBe(200);
      await Promise.all(firstContext.pending);
      for (const key of records.keys()) {
        if (key.includes("/__cache/videos/")) records.delete(key);
      }

      const second = await handleRequest(
        post("/api/videos", { channel: "xhamster", page: 1 }),
        createEnv(),
        createExecutionContext(),
        vi.fn(async () => {
          throw new Error("all live backends unavailable");
        }) as typeof fetch,
      );
      const body = VideosResponseSchema.parse(await second.json());
      expect(second.headers.get("X-Cache")).toBe("STALE");
      expect(body.pageInfo.error).toBeUndefined();
      expect(body.pageInfo.message).toContain("last successful");
      expect(body.items).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
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
      headers: {
        "CF-Connecting-IP": "192.0.2.10",
        "Content-Type": "application/json",
      },
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

describe("Hot Tub client compatibility", () => {
  it("serialises every pageInfo.parameters value as a string", async () => {
    // Hot Tub types `parameters` as Record<string, string> and the iOS client
    // decodes it strictly. A numeric value there makes the app report a
    // generic "Server Error" on an otherwise perfectly good page of results,
    // which is indistinguishable from the source being down.
    const response = await handleRequest(
      post("/api/videos", { channel: "eporner", page: 1, pageSize: 5 }),
      createEnv(),
      createExecutionContext(),
      multiProviderFetch(),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      pageInfo: { parameters?: Record<string, unknown> };
      items: unknown[];
    };

    const parameters = body.pageInfo.parameters ?? {};
    expect(Object.keys(parameters).length).toBeGreaterThan(0);
    for (const [key, value] of Object.entries(parameters)) {
      expect(typeof value, `pageInfo.parameters.${key} must be a string`).toBe("string");
    }
    expect(parameters.returnedResults).toBe(String(body.items.length));
  });

  it("omits totalResults rather than reporting zero next to real results", async () => {
    const response = await handleRequest(
      post("/api/videos", { channel: "xhamster", page: 1, pageSize: 5 }),
      createEnv(),
      createExecutionContext(),
      multiProviderFetch(),
    );
    const body = (await response.json()) as {
      pageInfo: { parameters?: Record<string, string> };
      items: unknown[];
    };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.pageInfo.parameters?.totalResults).toBeUndefined();
  });
});
