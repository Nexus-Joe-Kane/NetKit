import { clearAccessKeyCache, verifyAccessRequest } from "../src/auth/access";
import type { Env } from "../src/config";
import { bytesToBase64Url } from "../src/utils/ids";
import { FakeD1Database } from "./helpers/fake-d1";

function encode(value: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function signedToken(
  privateKey: CryptoKey,
  claims: Record<string, unknown> = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "RS256", kid: "test-key", typ: "JWT" });
  const payload = encode({
    aud: "test-audience",
    email: "joe@example.test",
    exp: now + 300,
    iat: now,
    iss: "https://test-team.cloudflareaccess.com",
    sub: "subject-123",
    ...claims,
  });
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

describe("Cloudflare Access verification", () => {
  let privateKey: CryptoKey;
  let publicJwk: JsonWebKey;
  let env: Env;

  beforeAll(async () => {
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    privateKey = pair.privateKey;
    publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    env = {
      DB: new FakeD1Database() as unknown as D1Database,
      ADMIN_ACCESS_TEAM_DOMAIN: "test-team.cloudflareaccess.com",
      ADMIN_ACCESS_AUDIENCE: "test-audience",
    };
  });

  beforeEach(() => clearAccessKeyCache());

  it("verifies signature, issuer, audience, and expiry", async () => {
    const token = await signedToken(privateKey);
    const request = new Request("https://hottub.joekane.org/account", {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: "test-key", alg: "RS256" }] }), {
          headers: { "Content-Type": "application/json" },
        }),
    ) as typeof fetch;
    const identity = await verifyAccessRequest(request, env, fetcher);
    expect(identity.email).toBe("joe@example.test");
    expect(identity.userKey).toHaveLength(43);
  });

  it("rejects missing and invalid-audience assertions", async () => {
    await expect(
      verifyAccessRequest(new Request("https://hottub.joekane.org/account"), env),
    ).rejects.toMatchObject({ status: 401, code: "access_required" });

    const token = await signedToken(privateKey, { aud: "wrong-audience" });
    const request = new Request("https://hottub.joekane.org/account", {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: "test-key" }] }), {
          headers: { "Content-Type": "application/json" },
        }),
    ) as typeof fetch;
    await expect(verifyAccessRequest(request, env, fetcher)).rejects.toMatchObject({
      status: 401,
      code: "invalid_access_token",
    });
  });
});
