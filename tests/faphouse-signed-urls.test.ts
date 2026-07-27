import { probePlayback, redactSignedUrl, signedUrlExpiry } from "../src/providers/faphouse-session";

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
    // Nothing rendered back to the operator may carry the live token.
    expect(JSON.stringify(probe)).not.toContain("mCRdifT1yJ0cEGNfrv55IQ");
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
