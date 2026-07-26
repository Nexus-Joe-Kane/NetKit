export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

interface CountRow {
  request_count: number;
}

export class RateLimitRepository {
  constructor(private readonly db: D1Database) {}

  async consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(now / windowSeconds) * windowSeconds;
    const row = await this.db
      .prepare(
        `INSERT INTO rate_limits (key, window_start, request_count, updated_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET
           request_count = CASE
             WHEN rate_limits.window_start = excluded.window_start
             THEN rate_limits.request_count + 1
             ELSE 1
           END,
           window_start = excluded.window_start,
           updated_at = excluded.updated_at
         RETURNING request_count`,
      )
      .bind(key, windowStart, now)
      .first<CountRow>();

    const count = Number(row?.request_count ?? limit + 1);
    return {
      allowed: count <= limit,
      limit,
      remaining: Math.max(0, limit - count),
      resetAt: windowStart + windowSeconds,
    };
  }

  async prune(beforeEpochSeconds: number): Promise<void> {
    await this.db
      .prepare("DELETE FROM rate_limits WHERE updated_at < ?")
      .bind(beforeEpochSeconds)
      .run();
  }
}
