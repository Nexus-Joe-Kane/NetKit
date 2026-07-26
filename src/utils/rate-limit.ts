import type { RequestContext } from "../config";
import { RateLimitRepository, type RateLimitResult } from "../storage/rate-limit";
import { HttpError } from "./errors";
import { getClientIp } from "./http";
import { sha256 } from "./ids";
import { logger } from "./logging";

export async function enforceRateLimit(
  context: RequestContext,
  scope: string,
  limit: number,
  windowSeconds: number,
  accountKey?: string,
): Promise<RateLimitResult> {
  const identity = accountKey ? `account:${accountKey}` : `ip:${getClientIp(context.request)}`;
  const key = `${scope}:${await sha256(identity)}`;
  const repository = new RateLimitRepository(context.env.DB);
  let result: RateLimitResult;
  try {
    result = await repository.consume(key, limit, windowSeconds);
  } catch {
    logger.error("rate_limit_store_error", {
      requestId: context.requestId,
      scope,
    });
    if (accountKey) {
      throw new HttpError(
        503,
        "Rate limiting is temporarily unavailable.",
        "rate_limit_unavailable",
      );
    }
    return {
      allowed: true,
      limit,
      remaining: limit,
      resetAt: Math.floor(Date.now() / 1000) + windowSeconds,
    };
  }

  if (Math.random() < 0.01) {
    context.execution.waitUntil(
      repository.prune(Math.floor(Date.now() / 1000) - 86_400).catch(() => undefined),
    );
  }
  if (!result.allowed) {
    throw new HttpError(429, "Too many requests. Try again later.", "rate_limited");
  }
  return result;
}

export function rateLimitHeaders(result: RateLimitResult): Headers {
  return new Headers({
    "RateLimit-Limit": String(result.limit),
    "RateLimit-Remaining": String(result.remaining),
    "RateLimit-Reset": String(result.resetAt),
  });
}
