import type { Env } from "../config";
import { HttpError } from "../utils/errors";
import { sha256 } from "../utils/ids";

export interface AdminIdentity {
  sourceIp: string;
  subject: string;
  userKey: string;
}

function configuredAllowedIps(env: Env): Set<string> {
  const allowedIps = new Set(
    (env.ADMIN_ALLOWED_IPS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (allowedIps.size === 0) {
    throw new HttpError(
      503,
      "The admin IP allowlist has not been configured for this deployment.",
      "admin_ip_not_configured",
    );
  }
  return allowedIps;
}

export async function verifyAdminIp(request: Request, env: Env): Promise<AdminIdentity> {
  const allowedIps = configuredAllowedIps(env);
  const sourceIp = request.headers.get("CF-Connecting-IP")?.trim();
  if (!sourceIp || !allowedIps.has(sourceIp)) {
    throw new HttpError(
      403,
      "This route is restricted to an approved source IP.",
      "admin_ip_forbidden",
    );
  }

  return {
    sourceIp,
    subject: sourceIp,
    // All approved VPN egress addresses represent the same single operator.
    // Keeping this key independent of the IP preserves local data after a
    // deliberate allowlist change.
    userKey: await sha256("hottub:admin"),
  };
}
