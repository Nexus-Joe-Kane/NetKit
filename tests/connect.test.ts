import { CSRF_COOKIE } from "../src/auth/csrf";
import { assertUsableCookie, probeSession } from "../src/providers/faphouse-session";
import { handleRequest } from "../src/router";
import { ConnectionRepository } from "../src/storage/connections";
import { bytesToBase64Url } from "../src/utils/ids";
import type { Env } from "../src/config";
import { createEnv, createExecutionContext } from "./helpers/context";
import { FakeD1Database } from "./helpers/fake-d1";

const ORIGIN = "https://hottub.joekane.org";
const VPN_IP = "92.71.54.161";
const COOKIE = "fhaccess=abc123; fhsession=def456";

function keyRing(): string {
  return `test:${bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

function envWith(database: FakeD1Database, keys?: string): Env {
  return { ...createEnv(database), ADMIN_ALLOWED_IPS: VPN_IP, TOKEN_ENCRYPTION_KEYS: keys };
}

function connectRequest(token: string, body: Record<string, string>): Request {
  return new Request(`${ORIGIN}/account/connect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "CF-Connecting-IP": VPN_IP,
      Origin: ORIGIN,
      Cookie: `${CSRF_COOKIE}=${token}`,
    },
    body: new URLSearchParams({ csrf: token, ...body }).toString(),
  });
}

/** Grabs a CSRF token the same way a browser loading /account would. */
async function openAccount(env: Env): Promise<string> {
  const response = await handleRequest(
    new Request(`${ORIGIN}/account`, { headers: { "CF-Connecting-IP": VPN_IP } }),
    env,
    createExecutionContext(),
  );
  return /__Host-hottub_csrf=([^;]+)/.exec(response.headers.get("Set-Cookie") ?? "")?.[1] ?? "";
}

function siteFetch(html: string, status = 200): typeof fetch {
  return vi.fn(async () => new Response(html, { status })) as unknown as typeof fetch;
}

const SIGNED_IN = '<a href="/api/auth/signout">Sign out</a><div>/api/profile/settings</div>';
const SIGNED_OUT =
  '<form action="/api/auth/signin"></form><a href="/api/signup/generate-username">';

describe("session cookie handling", () => {
  it("accepts a pasted Cookie header and a bare pair, and rejects junk", () => {
    expect(assertUsableCookie("Cookie: a=1; b=2")).toBe("a=1; b=2");
    expect(assertUsableCookie(" a=1 ")).toBe("a=1");
    expect(() => assertUsableCookie("not a cookie at all")).toThrow();
    expect(() => assertUsableCookie("")).toThrow();
  });

  it("treats a signed-out response as unauthenticated", async () => {
    await expect(probeSession(siteFetch(SIGNED_OUT), COOKIE)).resolves.toMatchObject({
      authenticated: false,
    });
    await expect(probeSession(siteFetch("", 403), COOKIE)).resolves.toMatchObject({
      authenticated: false,
    });
    await expect(probeSession(siteFetch(SIGNED_IN), COOKIE)).resolves.toMatchObject({
      authenticated: true,
    });
  });
});

describe("POST /account/connect", () => {
  it("stores an encrypted session once the provider confirms it is live", async () => {
    const database = new FakeD1Database();
    const keys = keyRing();
    const env = envWith(database, keys);
    const token = await openAccount(env);

    const response = await handleRequest(
      connectRequest(token, { providerId: "faphouse-ultra", sessionCookie: COOKIE }),
      env,
      createExecutionContext(),
      siteFetch(SIGNED_IN),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toContain("Connected");

    const raw = [...database.connections.values()][0];
    expect(raw?.encrypted_access_token).toBeTruthy();
    expect(raw?.encrypted_access_token).not.toContain("fhaccess");

    const stored = await new ConnectionRepository(database as unknown as D1Database).get(
      raw!.user_key as string,
      "faphouse-ultra",
      keys,
    );
    expect(stored?.accessToken).toBe(COOKIE);
  });

  it("never stores a session the provider rejects", async () => {
    const database = new FakeD1Database();
    const env = envWith(database, keyRing());
    const token = await openAccount(env);

    const response = await handleRequest(
      connectRequest(token, { providerId: "faphouse-ultra", sessionCookie: COOKIE }),
      env,
      createExecutionContext(),
      siteFetch(SIGNED_OUT),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toContain("Not%20connected");
    expect(database.connections.size).toBe(0);
  });

  it("refuses to store anything without an encryption key ring", async () => {
    const database = new FakeD1Database();
    const env = envWith(database);
    const token = await openAccount(env);

    const response = await handleRequest(
      connectRequest(token, { providerId: "faphouse-ultra", sessionCookie: COOKIE }),
      env,
      createExecutionContext(),
      siteFetch(SIGNED_IN),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("encryption_not_configured");
    expect(database.connections.size).toBe(0);
  });

  it("rejects a provider that has no session connection", async () => {
    const database = new FakeD1Database();
    const env = envWith(database, keyRing());
    const token = await openAccount(env);

    const response = await handleRequest(
      connectRequest(token, { providerId: "xhamster", sessionCookie: COOKIE }),
      env,
      createExecutionContext(),
      siteFetch(SIGNED_IN),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("connection_not_supported");
  });

  it("requires CSRF and a matching origin", async () => {
    const database = new FakeD1Database();
    const env = envWith(database, keyRing());
    const token = await openAccount(env);

    // The submitted token must differ from the cookie, otherwise the
    // double-submit check legitimately passes.
    const badCsrf = await handleRequest(
      new Request(`${ORIGIN}/account/connect`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "CF-Connecting-IP": VPN_IP,
          Origin: ORIGIN,
          Cookie: `${CSRF_COOKIE}=${token}`,
        },
        body: new URLSearchParams({
          csrf: `${token.slice(0, -1)}x`,
          providerId: "faphouse-ultra",
          sessionCookie: COOKIE,
        }).toString(),
      }),
      env,
      createExecutionContext(),
      siteFetch(SIGNED_IN),
    );
    expect(badCsrf.status).toBe(403);
    expect(await badCsrf.text()).toContain("invalid_csrf");

    const badOrigin = await handleRequest(
      new Request(`${ORIGIN}/account/connect`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "CF-Connecting-IP": VPN_IP,
          Origin: "https://attacker.example",
          Cookie: `${CSRF_COOKIE}=${token}`,
        },
        body: new URLSearchParams({
          csrf: token,
          providerId: "faphouse-ultra",
          sessionCookie: COOKIE,
        }).toString(),
      }),
      env,
      createExecutionContext(),
      siteFetch(SIGNED_IN),
    );
    expect(badOrigin.status).toBe(403);
    expect(database.connections.size).toBe(0);
  });

  it("accepts a Safari form post, which sends no Origin header", async () => {
    const database = new FakeD1Database();
    const env = envWith(database, keyRing());
    const token = await openAccount(env);

    // Safari omits Origin on same-origin form submissions. Requiring it meant
    // every connect attempt from an iPhone — the only device this source is
    // used from — failed with invalid_origin.
    const response = await handleRequest(
      new Request(`${ORIGIN}/account/connect`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "CF-Connecting-IP": VPN_IP,
          "Sec-Fetch-Site": "same-origin",
          Referer: `${ORIGIN}/account`,
          Cookie: `${CSRF_COOKIE}=${token}`,
        },
        body: new URLSearchParams({
          csrf: token,
          providerId: "faphouse-ultra",
          sessionCookie: COOKIE,
        }).toString(),
      }),
      env,
      createExecutionContext(),
      siteFetch(SIGNED_IN),
    );
    expect(response.status).toBe(303);
    expect(database.connections.size).toBe(1);
  });

  it("keeps the whole connection UI behind the VPN allowlist", async () => {
    const env = envWith(new FakeD1Database(), keyRing());
    for (const path of ["/account", "/account/connect", "/account/diagnose"]) {
      const response = await handleRequest(
        new Request(`${ORIGIN}${path}`, { method: path === "/account" ? "GET" : "POST" }),
        env,
        createExecutionContext(),
      );
      expect(response.status).toBe(403);
    }
  });
});

const SIGNIN = "https://faphouse.com/api/auth/signin";

function signinFetch(
  body: Record<string, unknown>,
  status = 200,
  setCookie = "fhaccess=live-session; Path=/; HttpOnly",
): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    expect(url.toString()).toBe(SIGNIN);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", "Set-Cookie": setCookie },
    });
  }) as unknown as typeof fetch;
}

describe("connecting with revocable credentials", () => {
  it("exchanges credentials for a session and records the entitlement", async () => {
    const database = new FakeD1Database();
    const keys = keyRing();
    const env = envWith(database, keys);
    const token = await openAccount(env);

    const response = await handleRequest(
      connectRequest(token, {
        providerId: "faphouse-ultra",
        login: "app-user",
        password: "app-secret",
      }),
      env,
      createExecutionContext(),
      signinFetch({ userId: 4242, hasGoldSubscription: true }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toContain("Gold");

    const raw = [...database.connections.values()][0]!;
    // Both the session and the renewal credentials are encrypted at rest.
    expect(String(raw.encrypted_access_token)).not.toContain("live-session");
    expect(String(raw.encrypted_refresh_token)).not.toContain("app-secret");

    const stored = await new ConnectionRepository(database as unknown as D1Database).get(
      raw.user_key as string,
      "faphouse-ultra",
      keys,
    );
    expect(stored?.accessToken).toContain("fhaccess=live-session");
    expect(JSON.parse(stored!.refreshToken!)).toEqual({ l: "app-user", p: "app-secret" });
    expect(stored?.summary.capabilities).toMatchObject({ premiumAccess: true, renewable: true });
  });

  it("says so when the account has no subscription", async () => {
    const env = envWith(new FakeD1Database(), keyRing());
    const token = await openAccount(env);
    const response = await handleRequest(
      connectRequest(token, {
        providerId: "faphouse-ultra",
        login: "app-user",
        password: "app-secret",
      }),
      env,
      createExecutionContext(),
      signinFetch({ userId: 7, hasGoldSubscription: false }),
    );
    expect(response.headers.get("Location")).toContain("no%20Gold%20subscription");
  });

  it("stores nothing when the provider rejects the credentials", async () => {
    const database = new FakeD1Database();
    const env = envWith(database, keyRing());
    const token = await openAccount(env);

    const response = await handleRequest(
      connectRequest(token, {
        providerId: "faphouse-ultra",
        login: "app-user",
        password: "wrong",
      }),
      env,
      createExecutionContext(),
      signinFetch({ errors: { _global: ["Invalid credentials"] }, userId: null }, 400, ""),
    );
    expect(response.status).toBe(303);
    const location = response.headers.get("Location") ?? "";
    expect(location).toContain("Invalid%20credentials");
    // The submitted secret must never be echoed back in a redirect or page.
    expect(location).not.toContain("wrong");
    expect(database.connections.size).toBe(0);
  });

  it("rejects a sign-in that returns no session cookie", async () => {
    const database = new FakeD1Database();
    const env = envWith(database, keyRing());
    const token = await openAccount(env);
    const response = await handleRequest(
      connectRequest(token, {
        providerId: "faphouse-ultra",
        login: "app-user",
        password: "app-secret",
      }),
      env,
      createExecutionContext(),
      signinFetch({ userId: 1, hasGoldSubscription: true }, 200, ""),
    );
    expect(response.headers.get("Location")).toContain("no%20session%20cookie");
    expect(database.connections.size).toBe(0);
  });

  it("refuses credentials for a provider that has no sign-in endpoint", async () => {
    const env = envWith(new FakeD1Database(), keyRing());
    const token = await openAccount(env);
    const response = await handleRequest(
      connectRequest(token, { providerId: "xhamster", login: "a", password: "b" }),
      env,
      createExecutionContext(),
      signinFetch({ userId: 1 }),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("connection_not_supported");
  });
});
