import type { Env } from "../config";
import { HttpError } from "../utils/errors";
import { base64UrlToBytes, sha256 } from "../utils/ids";

interface JwtHeader {
  alg: string;
  kid: string;
}

interface JwtPayload {
  aud: string | string[];
  email?: string;
  exp: number;
  iat?: number;
  iss: string;
  nbf?: number;
  sub: string;
}

interface JsonWebKeyWithKid extends JsonWebKey {
  kid?: string;
  alg?: string;
}

interface JwksResponse {
  keys: JsonWebKeyWithKid[];
}

export interface AccessIdentity {
  subject: string;
  email?: string;
  userKey: string;
}

const jwksCache = new Map<string, { expiresAt: number; keys: JsonWebKeyWithKid[] }>();

function parseSegment<T>(segment: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment))) as T;
  } catch {
    throw new HttpError(401, "Cloudflare Access token is malformed.", "invalid_access_token");
  }
}

function getAccessConfiguration(env: Env): {
  audience: string;
  issuer: string;
  teamDomain: string;
} {
  const teamDomain = env.ADMIN_ACCESS_TEAM_DOMAIN?.trim().toLowerCase();
  const audience = env.ADMIN_ACCESS_AUDIENCE?.trim();
  if (!teamDomain || !audience) {
    throw new HttpError(
      503,
      "Cloudflare Access has not been configured for this deployment.",
      "access_not_configured",
    );
  }
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/u.test(teamDomain)) {
    throw new HttpError(503, "Cloudflare Access team domain is invalid.", "access_misconfigured");
  }
  return { audience, teamDomain, issuer: `https://${teamDomain}` };
}

async function fetchJwks(teamDomain: string, fetcher: typeof fetch): Promise<JsonWebKeyWithKid[]> {
  const cached = jwksCache.get(teamDomain);
  if (cached && cached.expiresAt > Date.now()) return cached.keys;
  let response: Response;
  try {
    response = await fetcher(`https://${teamDomain}/cdn-cgi/access/certs`, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new HttpError(503, "Access key discovery failed.", "access_keys_unavailable");
  }
  if (!response.ok) {
    throw new HttpError(503, "Access key discovery failed.", "access_keys_unavailable");
  }
  const payload = (await response.json()) as Partial<JwksResponse>;
  if (!Array.isArray(payload.keys)) {
    throw new HttpError(503, "Access key response was invalid.", "access_keys_unavailable");
  }
  const keys = payload.keys.filter(
    (key): key is JsonWebKeyWithKid =>
      typeof key === "object" && key !== null && typeof key.kid === "string" && key.kty === "RSA",
  );
  jwksCache.set(teamDomain, { expiresAt: Date.now() + 60 * 60 * 1000, keys });
  return keys;
}

function hasAudience(claim: string | string[], expected: string): boolean {
  return Array.isArray(claim) ? claim.includes(expected) : claim === expected;
}

export async function verifyAccessRequest(
  request: Request,
  env: Env,
  fetcher: typeof fetch = fetch,
): Promise<AccessIdentity> {
  const config = getAccessConfiguration(env);
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!assertion) {
    throw new HttpError(401, "Cloudflare Access authentication is required.", "access_required");
  }
  const parts = assertion.split(".");
  if (parts.length !== 3) {
    throw new HttpError(401, "Cloudflare Access token is malformed.", "invalid_access_token");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new HttpError(401, "Cloudflare Access token is malformed.", "invalid_access_token");
  }
  const header = parseSegment<JwtHeader>(encodedHeader);
  const payload = parseSegment<JwtPayload>(encodedPayload);
  if (header.alg !== "RS256" || !header.kid) {
    throw new HttpError(
      401,
      "Cloudflare Access token algorithm is invalid.",
      "invalid_access_token",
    );
  }
  const keys = await fetchJwks(config.teamDomain, fetcher);
  const jwk = keys.find((candidate) => candidate.kid === header.kid);
  if (!jwk) {
    jwksCache.delete(config.teamDomain);
    throw new HttpError(401, "Cloudflare Access signing key is unknown.", "invalid_access_token");
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlToBytes(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!verified) {
    throw new HttpError(
      401,
      "Cloudflare Access token signature is invalid.",
      "invalid_access_token",
    );
  }

  const now = Math.floor(Date.now() / 1000);
  if (
    payload.iss !== config.issuer ||
    !hasAudience(payload.aud, config.audience) ||
    !payload.sub ||
    !Number.isFinite(payload.exp) ||
    payload.exp <= now ||
    (payload.nbf !== undefined && payload.nbf > now + 30)
  ) {
    throw new HttpError(401, "Cloudflare Access token claims are invalid.", "invalid_access_token");
  }
  return {
    subject: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
    userKey: await sha256(`${payload.iss}:${payload.sub}`),
  };
}

export function clearAccessKeyCache(): void {
  jwksCache.clear();
}
