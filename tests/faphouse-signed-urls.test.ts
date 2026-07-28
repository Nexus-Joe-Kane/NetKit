import {
  measureStreamSeconds,
  probePlayback,
  redactSignedUrl,
  resolvePlaybackFormats,
  signedUrlExpiry,
} from "../src/providers/faphouse-session";

// Shape taken from a real entitled watch page. The signature and expiry sit in
// a path segment, not a query string.
const SIGNED =
  "https://video-nss.flixcdn.com/mCRdifT1yJ0cEGNfrv55IQ==,1785207603/vid/123/1080p.mp4";

describe("redactSignedUrl", () => {
  it("removes a token embedded in the path", () => {
    const redacted = redactSignedUrl(SIGNED);
    // Stripping only the query string left the token on screen, which is how
    // this was originally shipped.
    expect(redacted).not.toContain("mCRdifT1yJ0cEGNfrv55IQ");
    expect(redacted).not.toContain("1785207603");
    expect(redacted).toBe("https://video-nss.flixcdn.com/<signed>/vid/123/1080p.mp4");
  });

  it("keeps the host and file path, which are the useful parts", () => {
    const redacted = redactSignedUrl(SIGNED);
    expect(redacted).toContain("video-nss.flixcdn.com");
    expect(redacted).toContain("1080p.mp4");
  });

  it("still drops a query string", () => {
    expect(redactSignedUrl("https://cdn.example/a.mp4?token=abc123&e=1785207603")).toBe(
      "https://cdn.example/a.mp4",
    );
  });

  it("leaves an unsigned URL alone", () => {
    const plain = "https://cdn.example/vid/123/1080p.mp4";
    expect(redactSignedUrl(plain)).toBe(plain);
  });
});

describe("signedUrlExpiry", () => {
  it("reads the epoch that follows the signature", () => {
    expect(signedUrlExpiry(SIGNED)?.toISOString()).toBe("2026-07-28T03:00:03.000Z");
  });

  it("returns undefined when no expiry is encoded", () => {
    expect(signedUrlExpiry("https://cdn.example/vid/123/1080p.mp4")).toBeUndefined();
  });

  it("ignores a number that is not a plausible epoch", () => {
    expect(signedUrlExpiry("https://cdn.example/abc,42/1080p.mp4")).toBeUndefined();
  });
});

describe("probePlayback", () => {
  const WATCH = "https://faphouse.com/videos/example";
  const page = `<html><body><script>var s="${SIGNED.replace(/\//g, "\\/")}";</script>
    <a href="/api/auth/signout">Sign out</a></body></html>`;

  function fetcher(cdnStatus: number) {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname === "faphouse.com") {
        return new Response(page, { headers: { "Content-Type": "text/html" } });
      }
      // The CDN check must go out without the account session attached.
      expect(new Headers(init?.headers).get("Cookie")).toBeNull();
      expect(new Headers(init?.headers).get("Range")).toBe("bytes=0-0");
      return new Response("x", { status: cdnStatus });
    }) as unknown as typeof fetch;
  }

  it("reports a CDN that serves the signed URL without the session", async () => {
    const probe = await probePlayback(fetcher(206), "fhaccess=abc", WATCH);
    expect(probe.foundStreamCandidate).toBe(true);
    expect(probe.playableWithoutSession).toBe(true);
    expect(probe.expiresAt).toBe("2026-07-28T03:00:03.000Z");
    // Everything shown to the operator is redacted...
    expect(JSON.stringify(probe.mediaUrls)).not.toContain("mCRdifT1yJ0cEGNfrv55IQ");
    expect(probe.notes.join(" ")).not.toContain("mCRdifT1yJ0cEGNfrv55IQ");
    // ...while rawStreams keeps the live URL, which is the whole point of it:
    // the resolver needs a working URL to hand to the player.
    expect(probe.rawStreams[0]).toBe(SIGNED);
  });

  it("keeps the token out of the report rendered on /account", async () => {
    const { faphouseProvider } = await import("../src/providers/faphouse");
    const report = await faphouseProvider.diagnosePlayback!(
      "fhaccess=abc",
      WATCH,
      fetcher(206) as typeof fetch,
    );
    // This string is written into a redirect query parameter and rendered on
    // the page, so it is the one that must never carry a live signature.
    expect(report).not.toContain("mCRdifT1yJ0cEGNfrv55IQ");
    expect(report).toContain("<signed>");
  });

  it("reports a CDN that refuses without the session", async () => {
    const probe = await probePlayback(fetcher(403), "fhaccess=abc", WATCH);
    expect(probe.playableWithoutSession).toBe(false);
  });

  it("finds a source whether or not the page escapes its slashes", async () => {
    const plain = `<html><body><video src="${SIGNED}"></video>
      <a href="/api/auth/signout">out</a></body></html>`;
    const escaped = page;
    for (const [label, body] of [
      ["plain", plain],
      ["JSON-escaped", escaped],
    ] as const) {
      const probe = await probePlayback(
        vi.fn(async (input: RequestInfo | URL) => {
          const url = new URL(input instanceof Request ? input.url : input.toString());
          return url.hostname === "faphouse.com"
            ? new Response(body, { headers: { "Content-Type": "text/html" } })
            : new Response("x", { status: 206 });
        }) as unknown as typeof fetch,
        "fhaccess=abc",
        WATCH,
      );
      expect(probe.foundStreamCandidate, `${label} page`).toBe(true);
      expect(probe.mediaUrls[0], `${label} page`).toBe(
        "https://video-nss.flixcdn.com/<signed>/vid/123/1080p.mp4",
      );
    }
  });
});

describe("telling a title from its trailer", () => {
  const FULL = "https://video-nss.flixcdn.com/AAAAAAAAAAAAAAAA==,1785207603/full/index.m3u8";
  const TRAILER = "https://video-nss.flixcdn.com/BBBBBBBBBBBBBBBB==,1785207603/tr/index.m3u8";

  function playlist(seconds: number[]) {
    return `#EXTM3U\n#EXT-X-VERSION:3\n${seconds
      .map((value) => `#EXTINF:${value},\nseg.ts`)
      .join("\n")}\n#EXT-X-ENDLIST`;
  }

  function fetcher(bodies: Record<string, string>) {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = bodies[url];
      if (body === undefined) return new Response("", { status: 404 });
      return new Response(body, { headers: { "Content-Type": "application/vnd.apple.mpegurl" } });
    }) as unknown as typeof fetch;
  }

  it("sums the segment durations of a playlist", async () => {
    const seconds = await measureStreamSeconds(fetcher({ [FULL]: playlist([10, 10, 9.5]) }), FULL);
    expect(seconds).toBeCloseTo(29.5, 1);
  });

  it("follows a master playlist to its first variant", async () => {
    const master = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nvariant.m3u8`;
    const variant = new URL("variant.m3u8", FULL).toString();
    const seconds = await measureStreamSeconds(
      fetcher({ [FULL]: master, [variant]: playlist([60, 60]) }),
      FULL,
    );
    expect(seconds).toBe(120);
  });

  it("returns undefined for something that is not a playlist", async () => {
    expect(await measureStreamSeconds(fetcher({}), "https://cdn.example/a.mp4")).toBeUndefined();
  });

  it("drops a trailer when a full-length stream is present", async () => {
    // FapHouse serves both over HLS from the same host — its page advertises an
    // "hlsTrailers" experiment — so only the length distinguishes them. An
    // 11-minute title played for 39 seconds before this.
    const page = `<html><body><a href="/api/auth/signout">out</a>
      <script>var a="${TRAILER}"; var b="${FULL}";</script></body></html>`;
    const call = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://faphouse.com/")) {
        return new Response(page, { headers: { "Content-Type": "text/html" } });
      }
      if (url === TRAILER) {
        return new Response(playlist([39]), {
          headers: { "Content-Type": "application/x-mpegURL" },
        });
      }
      return new Response(playlist(Array.from({ length: 66 }, () => 10)), {
        headers: { "Content-Type": "application/x-mpegURL" },
      });
    }) as unknown as typeof fetch;

    const formats = await resolvePlaybackFormats(
      call,
      "fhaccess=x",
      "https://faphouse.com/videos/example",
      660,
    );
    expect(formats.map((format) => format.url)).toEqual([FULL]);
  });

  it("keeps every candidate when the expected duration is unknown", async () => {
    const page = `<html><body><a href="/api/auth/signout">out</a>
      <script>var a="${TRAILER}"; var b="${FULL}";</script></body></html>`;
    const call = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://faphouse.com/")) {
        return new Response(page, { headers: { "Content-Type": "text/html" } });
      }
      return new Response(playlist([39]), { headers: { "Content-Type": "application/x-mpegURL" } });
    }) as unknown as typeof fetch;

    const formats = await resolvePlaybackFormats(
      call,
      "fhaccess=x",
      "https://faphouse.com/videos/example",
      0,
    );
    // Nothing to compare against means nothing can be judged a trailer.
    expect(formats.length).toBe(2);
  });
});
