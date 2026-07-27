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

describe("the merged all channel", () => {
  it("fans out to every provider and keeps each item's real channel", async () => {
    const response = await handleRequest(
      post("/api/videos", { channel: "all", page: 1, pageSize: 12 }),
      createEnv(),
      createExecutionContext(),
      multiProviderFetch(),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<{ channel: string }> };

    // Items must carry the provider that actually served them, never "all",
    // because the app uses the channel for playback and branding.
    const channels = new Set(body.items.map((item) => item.channel));
    expect(channels.has("all")).toBe(false);
    expect(channels.size).toBeGreaterThan(1);
    for (const channel of channels) {
      expect(["xhamster", "xvideos", "pornhub", "eporner", "fpo", "faphouse-ultra"]).toContain(
        channel,
      );
    }
  });

  it("interleaves providers rather than emptying one before starting the next", async () => {
    const response = await handleRequest(
      post("/api/videos", { channel: "all", page: 1, pageSize: 12 }),
      createEnv(),
      createExecutionContext(),
      multiProviderFetch(),
    );
    const body = (await response.json()) as { items: Array<{ channel: string }> };
    const leading = body.items.slice(0, 3).map((item) => item.channel);
    expect(new Set(leading).size).toBe(leading.length);
  });

  it("expands a themed bundle only into its own members", async () => {
    const seen: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const payload = JSON.parse(String(init?.body ?? "{}")) as { channel: string };
      seen.push(payload.channel);
      expect(url.hostname).toBe("hottub.spacemoehre.de");
      return new Response(JSON.stringify(upstreamFixture("xhamster")), {
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const response = await handleRequest(
      post("/api/videos", { channel: "anime", page: 1, pageSize: 12 }),
      createEnv(),
      createExecutionContext(),
      fetcher,
    );
    expect(response.status).toBe(200);
    expect(new Set(seen)).toEqual(new Set(["hentaihaven", "rule34video", "rule34gen"]));
  });

  it("asks each member for the sort in that member's own dialect", async () => {
    const sorts = new Map<string, string | undefined>();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        channel: string;
        sort?: string;
      };
      sorts.set(payload.channel, payload.sort);
      return new Response(JSON.stringify(upstreamFixture("xhamster")), {
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await handleRequest(
      post("/api/videos", { channel: "anime", page: 1, pageSize: 12, sort: "views" }),
      createEnv(),
      createExecutionContext(),
      fetcher,
    );

    // Each catalogue names its own most-viewed ordering differently. Sending
    // the generic "views" to all three would be ignored by all three.
    expect(sorts.get("rule34video")).toBe("video_viewed");
    // Hentai Haven declares no sorts, so it keeps the caller's value and falls
    // back to its own default upstream.
    expect(sorts.get("hentaihaven")).toBe("views");
  });

  it("still rejects a channel that does not exist", async () => {
    const response = await handleRequest(
      post("/api/videos", { channel: "not-a-channel", page: 1 }),
      createEnv(),
      createExecutionContext(),
      multiProviderFetch(),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("unknown_channel");
  });
});

describe("duration range filter", () => {
  it("accepts every plausible encoding of a range value", async () => {
    const { parseDurationRange } = await import("../src/utils/filters");
    // The range control is undocumented, so the wire format is not pinned
    // down; all of these should read as 120..1800.
    for (const value of [
      "120,1800",
      "120-1800",
      "120..1800",
      " 120 , 1800 ",
      [120, 1800],
      { min: 120, max: 1800 },
      { from: 120, to: 1800 },
    ]) {
      expect(parseDurationRange(value), JSON.stringify(value)).toEqual({ min: 120, max: 1800 });
    }
    expect(parseDurationRange("600")).toEqual({ min: 600 });
    // A leading separator reads as an open-ended lower bound, i.e. "up to".
    expect(parseDurationRange("-300")).toEqual({ max: 300 });
    // Anything unrecognised must yield no bounds rather than filtering
    // everything away.
    for (const value of [undefined, null, "", "abc", {}, [], "999999999"]) {
      expect(parseDurationRange(value), JSON.stringify(value)).toEqual({});
    }
  });

  it("keeps only videos inside the selected range", async () => {
    const { applyDurationRange } = await import("../src/utils/filters");
    const items = [60, 300, 1200, 4000].map(
      (duration) => ({ duration, channel: "x", title: "t", url: "u", thumb: "h" }) as never,
    );
    expect(applyDurationRange(items, { min: 120, max: 1800 }).map((item) => item.duration)).toEqual(
      [300, 1200],
    );
    // The top of the slider means "and longer", so a maximum at the ceiling
    // must not exclude anything.
    expect(applyDurationRange(items, { min: 0, max: 86_400 })).toHaveLength(4);
    expect(applyDurationRange(items, {})).toHaveLength(4);
  });

  it("applies the range end to end over the merged channel", async () => {
    const response = await handleRequest(
      post("/api/videos", {
        channel: "all",
        page: 1,
        pageSize: 20,
        durationSecondsRange: "0,60",
      }),
      createEnv(),
      createExecutionContext(),
      multiProviderFetch(),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<{ duration: number }> };
    // Fixture videos are 125s and 600s, so a 0-60s window excludes them all
    // without erroring.
    expect(body.items.every((item) => item.duration <= 60)).toBe(true);
  });
});

describe("orientation preference", () => {
  it("reads the channel filter first and the global preference second", async () => {
    const { resolveOrientation } = await import("../src/utils/orientation");
    expect(resolveOrientation({ gender: "gay" })).toBe("gay");
    expect(resolveOrientation({ gender: "straight" })).toBe("straight");
    expect(resolveOrientation({ gender: "both" })).toBe("any");
    // An explicit channel filter beats the app-wide preference.
    expect(resolveOrientation({ orientation: "straight", gender: "gay" })).toBe("straight");
    // "none" is what the app sends when no preference is set, so it must not
    // be treated as a value to act on.
    for (const value of ["none", "", undefined, null, "wat"]) {
      expect(resolveOrientation({ gender: value }), String(value)).toBeUndefined();
    }
  });

  it("maps to each provider's own parameter", async () => {
    const { epornerGayParameter, faphouseOrientationParameter } =
      await import("../src/utils/orientation");
    expect(epornerGayParameter("straight")).toBe("0");
    expect(epornerGayParameter("any")).toBe("1");
    expect(epornerGayParameter("gay")).toBe("2");
    expect(epornerGayParameter(undefined)).toBe("0");
    expect(faphouseOrientationParameter("gay")).toBe("gay");
    expect(faphouseOrientationParameter("straight")).toBe("straight");
    // "All" means send nothing, so the site's own default applies.
    expect(faphouseOrientationParameter("any")).toBeUndefined();
    expect(faphouseOrientationParameter(undefined)).toBeUndefined();
  });

  it("asks Eporner for gay men rather than its trans-heavy default bucket", async () => {
    const { epornerBrowseQuery } = await import("../src/utils/orientation");
    // `gay=2` alone returns mostly trans and femboy titles, which is why the
    // Gay option used to come back looking like straight content.
    expect(epornerBrowseQuery("gay", undefined)).toBe("gay men");
    expect(epornerBrowseQuery("straight", undefined)).toBe("all");
    expect(epornerBrowseQuery(undefined, undefined)).toBe("all");
    // A query the viewer typed is never overwritten.
    expect(epornerBrowseQuery("gay", "amateur")).toBe("amateur");
  });

  it("routes gay to catalogues that actually carry it", async () => {
    const { orientationChannels } = await import("../src/utils/orientation");
    // Homo.xxx is the only dedicated gay catalogue among the upstream's 80
    // channels, and unlike FapHouse its items are playable.
    expect(orientationChannels("gay")).toContain("homoxxx");
    // Straight needs no narrowing: general catalogues are straight by default,
    // and narrowing merely shrank the feed.
    expect(orientationChannels("straight")).toBeUndefined();
    expect(orientationChannels("any")).toBeUndefined();
    expect(orientationChannels(undefined)).toBeUndefined();
  });

  it("keeps the merged feed wide for straight and points it at gay catalogues for gay", async () => {
    const mixed = await handleRequest(
      post("/api/videos", { channel: "all", page: 1, pageSize: 12, gender: "none" }),
      createEnv(),
      createExecutionContext(),
      multiProviderFetch(),
    );
    const mixedChannels = new Set(
      ((await mixed.json()) as { items: Array<{ channel: string }> }).items.map(
        (item) => item.channel,
      ),
    );
    expect(mixedChannels.size).toBeGreaterThan(2);

    const seen: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname === "www.eporner.com") {
        seen.push("eporner");
        return new Response(JSON.stringify(epornerFixture), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.hostname === "faphouse.com") {
        seen.push("faphouse-ultra");
        return new Response("<html></html>", { headers: { "Content-Type": "text/html" } });
      }
      const payload = JSON.parse(String(init?.body ?? "{}")) as { channel: string };
      seen.push(payload.channel);
      return new Response(JSON.stringify(upstreamFixture("xhamster")), {
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await handleRequest(
      post("/api/videos", { channel: "all", page: 1, pageSize: 12, gender: "gay" }),
      createEnv(),
      createExecutionContext(),
      fetcher,
    );
    // The dedicated gay catalogue must be reached even though it is not one of
    // the featured channels the merged feed normally fans out to.
    expect(seen).toContain("homoxxx");
    // Straight-only tubes must not be queried under a gay preference.
    expect(seen).not.toContain("pornhub");
    expect(seen).not.toContain("xvideos");
  });

  it("does not strip a themed bundle of its theme", async () => {
    const seen: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { channel: string };
      seen.push(payload.channel);
      return new Response(JSON.stringify(upstreamFixture("xhamster")), {
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await handleRequest(
      post("/api/videos", { channel: "anime", page: 1, pageSize: 12, gender: "gay" }),
      createEnv(),
      createExecutionContext(),
      fetcher,
    );
    // Someone who picked "Animated & hentai" must not be handed a feed with no
    // animation in it, so a bundle whose members serve no orientation is left
    // exactly as chosen.
    expect(new Set(seen)).toEqual(new Set(["hentaihaven", "rule34video", "rule34gen"]));
  });
});
