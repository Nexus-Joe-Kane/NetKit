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

/**
 * Queries are matched by substring, so collapse the indentation of the
 * multi-line SQL in the repositories first.
 */
function normalise(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

class FakeStatement {
  constructor(
    private readonly database: FakeD1Database,
    readonly query: string,
    readonly values: unknown[] = [],
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

function descending(field: string) {
  return (left: LocalRecord, right: LocalRecord) =>
    String(right[field]).localeCompare(String(left[field]));
}

export class FakeD1Database {
  private readonly rateLimits = new Map<string, { count: number; windowStart: number }>();
  readonly connections = new Map<string, ConnectionRecord>();
  readonly history = new Map<string, LocalRecord>();
  readonly favourites = new Map<string, LocalRecord>();
  readonly playlists = new Map<string, LocalRecord>();
  readonly playlistItems = new Map<string, LocalRecord>();
  readonly followedUploaders = new Map<string, LocalRecord>();

  prepare(query: string): D1PreparedStatement {
    return new FakeStatement(this, query) as unknown as D1PreparedStatement;
  }

  async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    return statements.map((statement) => {
      const fake = statement as unknown as FakeStatement;
      return this.run(fake.query, fake.values) as D1Result<T>;
    });
  }

  private itemsFor(playlistId: string): LocalRecord[] {
    return [...this.playlistItems.values()]
      .filter((row) => row.playlist_id === playlistId)
      .sort((left, right) => Number(left.position) - Number(right.position));
  }

  private playlistRow(row: LocalRecord): LocalRecord {
    return { ...row, item_count: this.itemsFor(String(row.id)).length };
  }

  first(rawQuery: string, values: unknown[]): unknown {
    const query = normalise(rawQuery);
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
    if (query.includes("next_position")) {
      const [playlistId] = values as [string];
      const items = this.itemsFor(playlistId);
      const highest = items.reduce((max, row) => Math.max(max, Number(row.position)), -1);
      return { next_position: highest + 1 };
    }
    if (query.includes("FROM local_playlists p")) {
      const [userKey, playlistId] = values as [string, string];
      const row = this.playlists.get(playlistId);
      return row && row.user_key === userKey ? this.playlistRow(row) : null;
    }
    return null;
  }

  all(rawQuery: string, values: unknown[]): unknown[] {
    const query = normalise(rawQuery);
    const userKey = String(values[0] ?? "");
    if (query.includes("FROM provider_connections")) {
      return [...this.connections.values()].filter((row) => row.user_key === userKey);
    }
    if (query.includes("FROM local_history")) {
      return [...this.history.values()]
        .filter((row) => row.user_key === userKey)
        .sort(descending("watched_at"));
    }
    if (query.includes("FROM local_favourites")) {
      return [...this.favourites.values()]
        .filter((row) => row.user_key === userKey)
        .sort(descending("created_at"));
    }
    if (query.includes("ORDER BY p.updated_at")) {
      return [...this.playlists.values()]
        .filter((row) => row.user_key === userKey)
        .sort(descending("updated_at"))
        .map((row) => this.playlistRow(row));
    }
    if (query.includes("FROM local_playlist_items")) {
      const [, playlistId] = values as [string, string];
      return this.itemsFor(playlistId).filter((row) => row.user_key === userKey);
    }
    if (query.includes("FROM followed_uploaders")) {
      return [...this.followedUploaders.values()]
        .filter((row) => row.user_key === userKey)
        .sort(descending("followed_at"));
    }
    return [];
  }

  private deleteWhere(
    store: Map<string, LocalRecord>,
    predicate: (row: LocalRecord) => boolean,
  ): D1Result<unknown> {
    let changes = 0;
    for (const [key, row] of [...store.entries()]) {
      if (!predicate(row)) continue;
      store.delete(key);
      changes += 1;
    }
    return result(changes);
  }

  run(rawQuery: string, values: unknown[]): D1Result<unknown> {
    const query = normalise(rawQuery);
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
    if (query.includes("DELETE FROM local_history")) {
      const [userKey, providerId, videoId] = values as [string, string, string];
      return this.deleteWhere(
        this.history,
        (row) =>
          row.user_key === userKey &&
          (providerId === undefined ||
            (row.provider_id === providerId && row.video_id === videoId)),
      );
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
    if (query.includes("UPDATE local_playlists SET name")) {
      const [name, description, updatedAt, userKey, playlistId] = values as Array<string | null>;
      const row = this.playlists.get(String(playlistId));
      if (!row || row.user_key !== userKey) return result(0);
      this.playlists.set(String(playlistId), {
        ...row,
        name: name ?? row.name,
        description: description ?? row.description,
        updated_at: updatedAt,
      });
      return result(1);
    }
    if (query.includes("UPDATE local_playlists SET updated_at")) {
      const [updatedAt, userKey, playlistId] = values as Array<string | null>;
      const row = this.playlists.get(String(playlistId));
      if (!row || row.user_key !== userKey) return result(0);
      this.playlists.set(String(playlistId), { ...row, updated_at: updatedAt });
      return result(1);
    }
    if (query.includes("DELETE FROM local_playlists")) {
      const [userKey, playlistId] = values as [string, string];
      const row = this.playlists.get(playlistId);
      if (!row || row.user_key !== userKey) return result(0);
      this.playlists.delete(playlistId);
      return result(1);
    }
    if (query.includes("INSERT INTO local_playlist_items")) {
      const [
        id,
        playlistId,
        userKey,
        providerId,
        videoId,
        videoUrl,
        title,
        thumb,
        duration,
        position,
        createdAt,
      ] = values as Array<string | number | null>;
      const key = `${playlistId}:${providerId}:${videoId}`;
      const current = this.playlistItems.get(key);
      this.playlistItems.set(key, {
        id: current?.id ?? id,
        playlist_id: playlistId,
        user_key: userKey,
        provider_id: providerId,
        video_id: videoId,
        video_url: videoUrl,
        title,
        thumb,
        duration,
        position: current?.position ?? position,
        created_at: current?.created_at ?? createdAt,
      });
      return result(1);
    }
    if (query.includes("UPDATE local_playlist_items SET position")) {
      const [position, id, playlistId] = values as [number, string, string];
      for (const [key, row] of this.playlistItems.entries()) {
        if (row.id !== id || row.playlist_id !== playlistId) continue;
        this.playlistItems.set(key, { ...row, position });
        return result(1);
      }
      return result(0);
    }
    if (query.includes("DELETE FROM local_playlist_items")) {
      const [userKey, playlistId, providerId, videoId] = values as [string, string, string, string];
      return this.deleteWhere(
        this.playlistItems,
        (row) =>
          row.user_key === userKey &&
          row.playlist_id === playlistId &&
          (providerId === undefined ||
            (row.provider_id === providerId && row.video_id === videoId)),
      );
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
    if (query.includes("DELETE FROM followed_uploaders")) {
      const [userKey, providerId, uploaderId] = values as [string, string, string];
      const changed = this.followedUploaders.delete(`${userKey}:${providerId}:${uploaderId}`)
        ? 1
        : 0;
      return result(changed);
    }
    return result(0);
  }
}
