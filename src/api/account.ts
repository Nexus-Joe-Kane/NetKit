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

export async function accountHandler(context: RequestContext): Promise<Response> {
  const identity = await verifyAdminIp(context.request, context.env);
  await enforceRateLimit(context, "account", 120, 60, identity.userKey);
  const connections = await new ConnectionRepository(context.env.DB).list(identity.userKey);
  const csrfToken = newCsrfToken();
  return htmlResponse(accountPage(context.env, identity, connections, csrfToken), 200, {
    "Set-Cookie": csrfCookie(csrfToken),
  });
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
