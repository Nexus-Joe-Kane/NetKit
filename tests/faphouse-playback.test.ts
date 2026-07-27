import { CSRF_COOKIE } from "../src/auth/csrf";
import { VideosResponseSchema } from "../src/hottub/schemas";
import { handleRequest } from "../src/router";
import { bytesToBase64Url } from "../src/utils/ids";
import type { Env } from "../src/config";
import { createEnv, createExecutionContext } from "./helpers/context";
import { FakeD1Database } from "./helpers/fake-d1";

const ORIGIN = "https://hottub.joekane.org";
const VPN_IP = "92.71.54.161";
const SIGNED = "https://video-nss.flixcdn.com/AbCdEfGhIjKlMnOp==,1785207603/vid/9/1080p.mp4";

function keyRing(): string {
  return `test:${bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

// Carries a signed-in marker, because connecting probes this page first and
// stores nothing if it looks signed out.
const CATALOGUE = `<html><body><a href="/api/auth/signout">out</a>
  <div class="video-item">
    <a href="https://faphouse.com/videos/example-clip">
      <img src="https://faphouse.com/thumb.jpg" alt="Example Clip">
    </a>
    <span>12:34</span>
  </div>
</body></html>`;

const WATCH = `<html><body><a href="/api/auth/signout">out</a>
  <script>var src = "${SIGNED}";</script></body></html>`;

function siteFetch(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname !== "faphouse.com") throw new Error(`unexpected host ${url.hostname}`);
    const body = url.pathname.startsWith("/videos/") ? WATCH : CATALOGUE;
    return new Response(body, { headers: { "Content-Type": "text/html" } });
  }) as typeof fetch;
}

async function connect(env: Env): Promise<void> {
  const page = await handleRequest(
    new Request(`${ORIGIN}/account`, { headers: { "CF-Connecting-IP": VPN_IP } }),
    env,
    createExecutionContext(),
  );
  const token = /__Host-hottub_csrf=([^;]+)/.exec(page.headers.get("Set-Cookie") ?? "")?.[1] ?? "";
  const response = await handleRequest(
    new Request(`${ORIGIN}/account/connect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "CF-Connecting-IP": VPN_IP,
        Origin: ORIGIN,
        Cookie: `${CSRF_COOKIE}=${token}`,
      },
      body: new URLSearchParams({
        csrf: token,
        providerId: "faphouse-ultra",
        sessionCookie: "fhaccess=live-session",
      }).toString(),
    }),
    env,
    createExecutionContext(),
    siteFetch(),
  );
  expect(response.status).toBe(303);
  // Connect redirects with 303 whether or not the session was accepted, so the
  // note is what proves the connection actually landed. Asserting only the
  // status let a silently-rejected session look like a success.
  expect(response.headers.get("Location")).toContain("Connected");
}

function videos(env: Env, fetcher: typeof fetch) {
  return handleRequest(
    new Request(`${ORIGIN}/api/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": VPN_IP },
      body: JSON.stringify({ channel: "faphouse-ultra", page: 1, pageSize: 5 }),
    }),
    env,
    createExecutionContext(),
    fetcher,
  );
}

describe("FapHouse playback", () => {
  it("attaches playable formats once an account is connected", async () => {
    const database = new FakeD1Database();
    const env: Env = {
      ...createEnv(database),
      ADMIN_ALLOWED_IPS: VPN_IP,
      TOKEN_ENCRYPTION_KEYS: keyRing(),
    };
    await connect(env);

    const response = await videos(env, siteFetch());
    const body = VideosResponseSchema.parse(await response.json());
    expect(body.items.length).toBeGreaterThan(0);

    const item = body.items[0]!;
    expect(item.formats?.length).toBeGreaterThan(0);
    expect(item.formats![0]!.url).toBe(SIGNED);
    // The docs name Referer as the fix for CDN hotlink protection, and a device
    // diagnostic showed playback failing with none sent.
    expect(item.formats![0]!.httpHeaders?.Referer).toBe("https://faphouse.com/");
    expect(item.formats![0]!.httpHeaders?.["User-Agent"]).toBeTruthy();
    // The account session must never be handed to the client.
    expect(JSON.stringify(item.formats)).not.toContain("fhaccess");
    // "offline" is only correct while nothing can be played.
    expect(item.availability).toBeUndefined();
  });

  it("still lists, without formats, when no account is connected", async () => {
    const env: Env = {
      ...createEnv(new FakeD1Database()),
      ADMIN_ALLOWED_IPS: VPN_IP,
      TOKEN_ENCRYPTION_KEYS: keyRing(),
    };
    const response = await videos(env, siteFetch());
    const body = VideosResponseSchema.parse(await response.json());
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0]?.formats).toBeUndefined();
    expect(body.items[0]?.availability).toBe("offline");
  });

  it("keeps the catalogue when resolving fails", async () => {
    const database = new FakeD1Database();
    const env: Env = {
      ...createEnv(database),
      ADMIN_ALLOWED_IPS: VPN_IP,
      TOKEN_ENCRYPTION_KEYS: keyRing(),
    };
    await connect(env);

    // Catalogue succeeds, every watch page fails.
    const flaky = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.startsWith("/videos/")) throw new Error("watch page unavailable");
      return new Response(CATALOGUE, { headers: { "Content-Type": "text/html" } });
    }) as typeof fetch;

    const response = await videos(env, flaky);
    const body = VideosResponseSchema.parse(await response.json());
    // A failed resolve must degrade to the previous behaviour, not empty the feed.
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0]?.formats).toBeUndefined();
  });
});
