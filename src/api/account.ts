import { z } from "zod";
import { verifyAdminIp } from "../auth/access";
import { csrfCookie, newCsrfToken, requireCsrf } from "../auth/csrf";
import type { RequestContext } from "../config";
import { getProvider } from "../providers/registry";
import { ConnectionRepository } from "../storage/connections";
import { HttpError } from "../utils/errors";
import { htmlResponse, parseBody, requireSameOrigin } from "../utils/http";
import { enforceRateLimit } from "../utils/rate-limit";
import { getPublicBaseUrl } from "../utils/urls";
import { accountPage } from "../views";

const disconnectSchema = z.object({
  csrf: z.string().min(32).max(200),
  providerId: z.string().min(1).max(64),
});

const connectSchema = z
  .object({
    csrf: z.string().min(32).max(200),
    providerId: z.string().min(1).max(64),
    // Either revocable app credentials, or a session cookie copied from a
    // browser where the operator already signed in.
    login: z.string().trim().min(1).max(320).optional(),
    password: z.string().min(1).max(1_000).optional(),
    sessionCookie: z.string().max(8_000).optional(),
  })
  .refine((value) => (value.login && value.password) || (value.sessionCookie ?? "").length >= 8, {
    message: "Provide a login and password, or a session cookie.",
  });

const diagnoseSchema = z.object({
  csrf: z.string().min(32).max(200),
  providerId: z.string().min(1).max(64),
  watchUrl: z.string().url().max(2_000),
});

/**
 * Connecting stores provider secrets, so an encryption key ring is mandatory.
 * Failing loudly here beats writing an unencrypted session into D1.
 */
function requireEncryptionKeys(context: RequestContext): string {
  const keys = context.env.TOKEN_ENCRYPTION_KEYS?.trim();
  if (!keys) {
    throw new HttpError(
      503,
      "Set the TOKEN_ENCRYPTION_KEYS secret before connecting a provider account.",
      "encryption_not_configured",
    );
  }
  return keys;
}

async function authorizeWrite(context: RequestContext, submittedToken: string): Promise<void> {
  requireSameOrigin(context.request, getPublicBaseUrl(context.env.PUBLIC_BASE_URL).origin);
  requireCsrf(context.request, submittedToken);
}

function redirectToAccount(note?: string): Response {
  const location = note ? `/account?note=${encodeURIComponent(note.slice(0, 600))}` : "/account";
  return new Response(null, {
    status: 303,
    headers: { "Cache-Control": "no-store", Location: location },
  });
}

export async function accountHandler(context: RequestContext): Promise<Response> {
  const identity = await verifyAdminIp(context.request, context.env);
  await enforceRateLimit(context, "account", 120, 60, identity.userKey);
  const connections = await new ConnectionRepository(context.env.DB).list(identity.userKey);
  const csrfToken = newCsrfToken();
  const note = new URL(context.request.url).searchParams.get("note")?.slice(0, 600) ?? undefined;
  return htmlResponse(
    accountPage(context.env, identity, connections, csrfToken, {
      note,
      encryptionConfigured: Boolean(context.env.TOKEN_ENCRYPTION_KEYS?.trim()),
    }),
    200,
    { "Set-Cookie": csrfCookie(csrfToken) },
  );
}

export async function connectHandler(
  context: RequestContext,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const identity = await verifyAdminIp(context.request, context.env);
  await enforceRateLimit(context, "account-write", 30, 60, identity.userKey);
  const body = await parseBody(context.request, connectSchema);
  await authorizeWrite(context, body.csrf);

  const provider = getProvider(body.providerId);
  if (!provider) throw new HttpError(400, "Unknown provider.", "unknown_provider");
  const useCredentials = Boolean(body.login && body.password);
  if (useCredentials ? !provider.connectCredentials : !provider.connectSession) {
    throw new HttpError(
      400,
      `${provider.name} does not support that kind of connection.`,
      "connection_not_supported",
    );
  }
  const encryptionKeys = requireEncryptionKeys(context);

  // Verified against the provider before storage, so bad credentials or a
  // stale cookie are rejected outright rather than sitting in the database
  // looking connected.
  const result = useCredentials
    ? await provider.connectCredentials!(body.login!, body.password!, fetcher)
    : await provider.connectSession!(body.sessionCookie!, fetcher);
  if (!result.authenticated) {
    return redirectToAccount(`Not connected. ${result.detail}`);
  }

  const sessionCookie =
    "sessionCookie" in result && typeof result.sessionCookie === "string"
      ? result.sessionCookie
      : undefined;
  await new ConnectionRepository(context.env.DB).save({
    userKey: identity.userKey,
    providerId: provider.id,
    // The session is the access token; the credentials are the refresh
    // secret, since they are what obtains a new session once this one lapses.
    accessToken: sessionCookie ?? body.sessionCookie,
    refreshToken: useCredentials ? JSON.stringify({ l: body.login, p: body.password }) : undefined,
    capabilities: {
      premiumAccess: "premium" in result ? result.premium === true : true,
      renewable: useCredentials,
    },
    encryptionKeys,
  });
  return redirectToAccount(`Connected. ${result.detail}`);
}

export async function diagnoseHandler(
  context: RequestContext,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const identity = await verifyAdminIp(context.request, context.env);
  await enforceRateLimit(context, "account-write", 30, 60, identity.userKey);
  const body = await parseBody(context.request, diagnoseSchema);
  await authorizeWrite(context, body.csrf);

  const provider = getProvider(body.providerId);
  if (!provider?.diagnosePlayback) {
    throw new HttpError(400, "Provider has no playback diagnostic.", "diagnostic_not_supported");
  }
  const encryptionKeys = requireEncryptionKeys(context);
  const stored = await new ConnectionRepository(context.env.DB).get(
    identity.userKey,
    provider.id,
    encryptionKeys,
  );
  if (!stored?.accessToken) {
    throw new HttpError(400, "Connect the provider first.", "not_connected");
  }

  const report = await provider.diagnosePlayback(stored.accessToken, body.watchUrl, fetcher);
  return redirectToAccount(report);
}

export async function disconnectHandler(context: RequestContext): Promise<Response> {
  const identity = await verifyAdminIp(context.request, context.env);
  await enforceRateLimit(context, "account-write", 30, 60, identity.userKey);
  const baseUrl = getPublicBaseUrl(context.env.PUBLIC_BASE_URL);
  requireSameOrigin(context.request, baseUrl.origin);
  const body = await parseBody(context.request, disconnectSchema);
  requireCsrf(context.request, body.csrf);
  if (!getProvider(body.providerId)) {
    throw new HttpError(400, "Unknown provider.", "unknown_provider");
  }
  await new ConnectionRepository(context.env.DB).disconnect(identity.userKey, body.providerId);
  return new Response(null, {
    status: 303,
    headers: {
      "Cache-Control": "no-store",
      Location: "/account",
    },
  });
}
