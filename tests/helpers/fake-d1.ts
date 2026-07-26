type ConnectionRecord = Record<string, string | null | undefined>;
type LocalRecord = Record<string, string | number | null | undefined>;

function result(changes = 0): D1Result<unknown> {
  return {
    success: true,
    results: [],
    meta: {
      changed_db: false,
      changes,
      duration: 0,
      last_row_id: 0,
      rows_read: 0,
      rows_written: changes,
      served_by: "fake",
      size_after: 0,
    },
  };
}

class FakeStatement {
  constructor(
    private readonly database: FakeD1Database,
    private readonly query: string,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new FakeStatement(this.database, this.query, values) as unknown as D1PreparedStatement;
  }

  async first<T>(): Promise<T | null> {
    return this.database.first(this.query, this.values) as T | null;
  }

  async all<T>(): Promise<D1Result<T>> {
    return {
      ...result(),
      results: this.database.all(this.query, this.values) as T[],
    } as D1Result<T>;
  }

  async run<T>(): Promise<D1Result<T>> {
    return this.database.run(this.query, this.values) as D1Result<T>;
  }
}

export class FakeD1Database {
  private readonly rateLimits = new Map<string, { count: number; windowStart: number }>();
  readonly connections = new Map<string, ConnectionRecord>();
  readonly history = new Map<string, LocalRecord>();
  readonly favourites = new Map<string, LocalRecord>();
  readonly playlists = new Map<string, LocalRecord>();
  readonly followedUploaders = new Map<string, LocalRecord>();

  prepare(query: string): D1PreparedStatement {
    return new FakeStatement(this, query) as unknown as D1PreparedStatement;
  }

  first(query: string, values: unknown[]): unknown {
    if (query.includes("SELECT 1 AS ok")) return { ok: 1 };
    if (query.includes("INSERT INTO rate_limits")) {
      const [key, windowStart] = values as [string, number, number];
      const existing = this.rateLimits.get(key);
      const count = existing?.windowStart === windowStart ? existing.count + 1 : 1;
      this.rateLimits.set(key, { count, windowStart });
      return { request_count: count };
    }
    if (query.includes("FROM provider_connections") && query.includes("provider_id = ?")) {
      const [userKey, providerId] = values as [string, string];
      return this.connections.get(`${userKey}:${providerId}`) ?? null;
    }
    return null;
  }

  all(query: string, values: unknown[]): unknown[] {
    const userKey = String(values[0] ?? "");
    if (query.includes("FROM provider_connections")) {
      return [...this.connections.values()].filter((row) => row.user_key === userKey);
    }
    if (query.includes("FROM local_history")) {
      return [...this.history.values()]
        .filter((row) => row.user_key === userKey)
        .sort((left, right) => String(right.watched_at).localeCompare(String(left.watched_at)));
    }
    if (query.includes("FROM local_favourites")) {
      return [...this.favourites.values()]
        .filter((row) => row.user_key === userKey)
        .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
    }
    return [];
  }

  run(query: string, values: unknown[]): D1Result<unknown> {
    if (query.includes("DELETE FROM rate_limits")) return result(0);
    if (query.includes("INSERT INTO provider_connections")) {
      const [
        id,
        userKey,
        providerId,
        encryptedAccessToken,
        encryptedRefreshToken,
        tokenExpiresAt,
        encryptionKeyId,
        capabilitiesJson,
        createdAt,
        updatedAt,
      ] = values.map((value) => (value === undefined ? null : value)) as Array<string | null>;
      const key = `${userKey}:${providerId}`;
      const current = this.connections.get(key);
      this.connections.set(key, {
        id: current?.id ?? id,
        user_key: userKey,
        provider_id: providerId,
        encrypted_access_token: encryptedAccessToken,
        encrypted_refresh_token: encryptedRefreshToken,
        token_expires_at: tokenExpiresAt,
        encryption_key_id: encryptionKeyId,
        capabilities_json: capabilitiesJson,
        last_sync_at: null,
        last_error: null,
        created_at: current?.created_at ?? createdAt,
        updated_at: updatedAt,
      });
      return result(1);
    }
    if (query.includes("DELETE FROM provider_connections")) {
      const [userKey, providerId] = values as [string, string];
      const changed = this.connections.delete(`${userKey}:${providerId}`) ? 1 : 0;
      return result(changed);
    }
    if (query.includes("INSERT INTO local_history")) {
      const [
        id,
        userKey,
        providerId,
        videoId,
        videoUrl,
        title,
        thumb,
        duration,
        progressSeconds,
        watchedAt,
      ] = values as Array<string | number | null>;
      this.history.set(`${userKey}:${providerId}:${videoId}`, {
        id,
        user_key: userKey,
        provider_id: providerId,
        video_id: videoId,
        video_url: videoUrl,
        title,
        thumb,
        duration,
        progress_seconds: progressSeconds,
        watched_at: watchedAt,
      });
      return result(1);
    }
    if (query.includes("INSERT INTO local_favourites")) {
      const [id, userKey, providerId, videoId, videoUrl, title, thumb, duration, createdAt] =
        values as Array<string | number | null>;
      this.favourites.set(`${userKey}:${providerId}:${videoId}`, {
        id,
        user_key: userKey,
        provider_id: providerId,
        video_id: videoId,
        video_url: videoUrl,
        title,
        thumb,
        duration,
        created_at: createdAt,
      });
      return result(1);
    }
    if (query.includes("DELETE FROM local_favourites")) {
      const [userKey, providerId, videoId] = values as [string, string, string];
      const changed = this.favourites.delete(`${userKey}:${providerId}:${videoId}`) ? 1 : 0;
      return result(changed);
    }
    if (query.includes("INSERT INTO local_playlists")) {
      const [id, userKey, name, description, createdAt, updatedAt] = values as Array<string | null>;
      this.playlists.set(String(id), {
        id,
        user_key: userKey,
        name,
        description,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      return result(1);
    }
    if (query.includes("INSERT INTO followed_uploaders")) {
      const [id, userKey, providerId, uploaderId, uploaderName, uploaderUrl, avatar, followedAt] =
        values as Array<string | null>;
      this.followedUploaders.set(`${userKey}:${providerId}:${uploaderId}`, {
        id,
        user_key: userKey,
        provider_id: providerId,
        uploader_id: uploaderId,
        uploader_name: uploaderName,
        uploader_url: uploaderUrl,
        avatar,
        followed_at: followedAt,
      });
      return result(1);
    }
    return result(0);
  }
}
