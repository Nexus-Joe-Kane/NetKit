export interface LocalVideoInput {
  providerId: string;
  videoId: string;
  videoUrl: string;
  title: string;
  thumb?: string;
  duration?: number;
}

export interface HistoryInput extends LocalVideoInput {
  progressSeconds?: number;
}

export interface LocalVideoRow {
  id: string;
  provider_id: string;
  video_id: string;
  video_url: string;
  title: string;
  thumb: string | null;
  duration: number | null;
  created_at?: string;
  watched_at?: string;
  progress_seconds?: number;
}

export interface PlaylistRow {
  id: string;
  name: string;
  description: string | null;
  item_count: number;
  created_at: string;
  updated_at: string;
}

export interface PlaylistItemRow extends LocalVideoRow {
  playlist_id: string;
  position: number;
}

export interface FollowedUploaderRow {
  id: string;
  provider_id: string;
  uploader_id: string;
  uploader_name: string;
  uploader_url: string | null;
  avatar: string | null;
  followed_at: string;
}

export interface FollowedUploaderInput {
  providerId: string;
  uploaderId: string;
  uploaderName: string;
  uploaderUrl?: string;
  avatar?: string;
}

export class LocalLibraryRepository {
  constructor(private readonly db: D1Database) {}

  async recordHistory(userKey: string, input: HistoryInput): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO local_history (
           id, user_key, provider_id, video_id, video_url, title, thumb,
           duration, progress_seconds, watched_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_key, provider_id, video_id) DO UPDATE SET
           video_url = excluded.video_url,
           title = excluded.title,
           thumb = excluded.thumb,
           duration = excluded.duration,
           progress_seconds = excluded.progress_seconds,
           watched_at = excluded.watched_at`,
      )
      .bind(
        crypto.randomUUID(),
        userKey,
        input.providerId,
        input.videoId,
        input.videoUrl,
        input.title,
        input.thumb ?? null,
        input.duration ?? null,
        input.progressSeconds ?? 0,
        now,
      )
      .run();
  }

  async listHistory(userKey: string, limit = 100): Promise<LocalVideoRow[]> {
    const result = await this.db
      .prepare(
        `SELECT id, provider_id, video_id, video_url, title, thumb, duration,
                progress_seconds, watched_at
         FROM local_history
         WHERE user_key = ?
         ORDER BY watched_at DESC
         LIMIT ?`,
      )
      .bind(userKey, limit)
      .all<LocalVideoRow>();
    return result.results;
  }

  async removeHistoryEntry(userKey: string, providerId: string, videoId: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM local_history WHERE user_key = ? AND provider_id = ? AND video_id = ?")
      .bind(userKey, providerId, videoId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async clearHistory(userKey: string): Promise<number> {
    const result = await this.db
      .prepare("DELETE FROM local_history WHERE user_key = ?")
      .bind(userKey)
      .run();
    return result.meta.changes ?? 0;
  }

  async addFavourite(userKey: string, input: LocalVideoInput): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO local_favourites (
           id, user_key, provider_id, video_id, video_url, title, thumb, duration, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_key, provider_id, video_id) DO UPDATE SET
           video_url = excluded.video_url,
           title = excluded.title,
           thumb = excluded.thumb,
           duration = excluded.duration`,
      )
      .bind(
        crypto.randomUUID(),
        userKey,
        input.providerId,
        input.videoId,
        input.videoUrl,
        input.title,
        input.thumb ?? null,
        input.duration ?? null,
        now,
      )
      .run();
  }

  async removeFavourite(userKey: string, providerId: string, videoId: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        "DELETE FROM local_favourites WHERE user_key = ? AND provider_id = ? AND video_id = ?",
      )
      .bind(userKey, providerId, videoId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async listFavourites(userKey: string, limit = 100): Promise<LocalVideoRow[]> {
    const result = await this.db
      .prepare(
        `SELECT id, provider_id, video_id, video_url, title, thumb, duration, created_at
         FROM local_favourites
         WHERE user_key = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .bind(userKey, limit)
      .all<LocalVideoRow>();
    return result.results;
  }

  async createPlaylist(userKey: string, name: string, description?: string): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO local_playlists (id, user_key, name, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, userKey, name, description ?? null, now, now)
      .run();
    return id;
  }

  async listPlaylists(userKey: string, limit = 100): Promise<PlaylistRow[]> {
    const result = await this.db
      .prepare(
        `SELECT p.id, p.name, p.description, p.created_at, p.updated_at,
                (SELECT COUNT(*) FROM local_playlist_items i WHERE i.playlist_id = p.id)
                  AS item_count
         FROM local_playlists p
         WHERE p.user_key = ?
         ORDER BY p.updated_at DESC
         LIMIT ?`,
      )
      .bind(userKey, limit)
      .all<PlaylistRow>();
    return result.results;
  }

  async getPlaylist(userKey: string, playlistId: string): Promise<PlaylistRow | null> {
    return await this.db
      .prepare(
        `SELECT p.id, p.name, p.description, p.created_at, p.updated_at,
                (SELECT COUNT(*) FROM local_playlist_items i WHERE i.playlist_id = p.id)
                  AS item_count
         FROM local_playlists p
         WHERE p.user_key = ? AND p.id = ?`,
      )
      .bind(userKey, playlistId)
      .first<PlaylistRow>();
  }

  async updatePlaylist(
    userKey: string,
    playlistId: string,
    changes: { name?: string; description?: string },
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE local_playlists
         SET name = COALESCE(?, name),
             description = COALESCE(?, description),
             updated_at = ?
         WHERE user_key = ? AND id = ?`,
      )
      .bind(
        changes.name ?? null,
        changes.description ?? null,
        new Date().toISOString(),
        userKey,
        playlistId,
      )
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async deletePlaylist(userKey: string, playlistId: string): Promise<boolean> {
    // `local_playlist_items` cascades on the playlist foreign key, but the
    // delete is issued explicitly so the rows also disappear on connections
    // where `PRAGMA foreign_keys` is not enabled.
    await this.db
      .prepare("DELETE FROM local_playlist_items WHERE user_key = ? AND playlist_id = ?")
      .bind(userKey, playlistId)
      .run();
    const result = await this.db
      .prepare("DELETE FROM local_playlists WHERE user_key = ? AND id = ?")
      .bind(userKey, playlistId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async addPlaylistItem(
    userKey: string,
    playlistId: string,
    input: LocalVideoInput,
  ): Promise<boolean> {
    const playlist = await this.getPlaylist(userKey, playlistId);
    if (!playlist) return false;
    const now = new Date().toISOString();
    const nextPosition = await this.db
      .prepare(
        `SELECT COALESCE(MAX(position), -1) + 1 AS next_position
         FROM local_playlist_items
         WHERE playlist_id = ?`,
      )
      .bind(playlistId)
      .first<{ next_position: number }>();
    await this.db
      .prepare(
        `INSERT INTO local_playlist_items (
           id, playlist_id, user_key, provider_id, video_id, video_url,
           title, thumb, duration, position, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(playlist_id, provider_id, video_id) DO UPDATE SET
           video_url = excluded.video_url,
           title = excluded.title,
           thumb = excluded.thumb,
           duration = excluded.duration`,
      )
      .bind(
        crypto.randomUUID(),
        playlistId,
        userKey,
        input.providerId,
        input.videoId,
        input.videoUrl,
        input.title,
        input.thumb ?? null,
        input.duration ?? null,
        nextPosition?.next_position ?? 0,
        now,
      )
      .run();
    await this.touchPlaylist(userKey, playlistId);
    return true;
  }

  async listPlaylistItems(
    userKey: string,
    playlistId: string,
    limit = 200,
  ): Promise<PlaylistItemRow[]> {
    const result = await this.db
      .prepare(
        `SELECT id, playlist_id, provider_id, video_id, video_url, title, thumb,
                duration, position, created_at
         FROM local_playlist_items
         WHERE user_key = ? AND playlist_id = ?
         ORDER BY position ASC
         LIMIT ?`,
      )
      .bind(userKey, playlistId, limit)
      .all<PlaylistItemRow>();
    return result.results;
  }

  async removePlaylistItem(
    userKey: string,
    playlistId: string,
    providerId: string,
    videoId: string,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `DELETE FROM local_playlist_items
         WHERE user_key = ? AND playlist_id = ? AND provider_id = ? AND video_id = ?`,
      )
      .bind(userKey, playlistId, providerId, videoId)
      .run();
    if ((result.meta.changes ?? 0) === 0) return false;
    await this.resequencePlaylist(userKey, playlistId);
    await this.touchPlaylist(userKey, playlistId);
    return true;
  }

  /**
   * Moves one item to an absolute position, shifting the items it passes over.
   * Positions are rewritten from the resulting order so they always stay a
   * dense 0..n-1 sequence.
   */
  async movePlaylistItem(
    userKey: string,
    playlistId: string,
    providerId: string,
    videoId: string,
    position: number,
  ): Promise<boolean> {
    const items = await this.listPlaylistItems(userKey, playlistId);
    const currentIndex = items.findIndex(
      (item) => item.provider_id === providerId && item.video_id === videoId,
    );
    if (currentIndex === -1) return false;
    const target = Math.min(Math.max(position, 0), items.length - 1);
    if (target === currentIndex) return true;
    const [moved] = items.splice(currentIndex, 1);
    if (!moved) return false;
    items.splice(target, 0, moved);
    await this.writePositions(playlistId, items);
    await this.touchPlaylist(userKey, playlistId);
    return true;
  }

  async listFollowedUploaders(userKey: string, limit = 200): Promise<FollowedUploaderRow[]> {
    const result = await this.db
      .prepare(
        `SELECT id, provider_id, uploader_id, uploader_name, uploader_url, avatar, followed_at
         FROM followed_uploaders
         WHERE user_key = ?
         ORDER BY followed_at DESC
         LIMIT ?`,
      )
      .bind(userKey, limit)
      .all<FollowedUploaderRow>();
    return result.results;
  }

  async followUploader(userKey: string, input: FollowedUploaderInput): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO followed_uploaders (
           id, user_key, provider_id, uploader_id, uploader_name,
           uploader_url, avatar, followed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_key, provider_id, uploader_id) DO UPDATE SET
           uploader_name = excluded.uploader_name,
           uploader_url = excluded.uploader_url,
           avatar = excluded.avatar`,
      )
      .bind(
        crypto.randomUUID(),
        userKey,
        input.providerId,
        input.uploaderId,
        input.uploaderName,
        input.uploaderUrl ?? null,
        input.avatar ?? null,
        new Date().toISOString(),
      )
      .run();
  }

  async unfollowUploader(
    userKey: string,
    providerId: string,
    uploaderId: string,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `DELETE FROM followed_uploaders
         WHERE user_key = ? AND provider_id = ? AND uploader_id = ?`,
      )
      .bind(userKey, providerId, uploaderId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  private async touchPlaylist(userKey: string, playlistId: string): Promise<void> {
    await this.db
      .prepare("UPDATE local_playlists SET updated_at = ? WHERE user_key = ? AND id = ?")
      .bind(new Date().toISOString(), userKey, playlistId)
      .run();
  }

  private async resequencePlaylist(userKey: string, playlistId: string): Promise<void> {
    const items = await this.listPlaylistItems(userKey, playlistId);
    await this.writePositions(playlistId, items);
  }

  private async writePositions(
    playlistId: string,
    items: readonly PlaylistItemRow[],
  ): Promise<void> {
    const statement = this.db.prepare(
      "UPDATE local_playlist_items SET position = ? WHERE id = ? AND playlist_id = ?",
    );
    const changed = items
      .map((item, index) => ({ item, index }))
      .filter(({ item, index }) => item.position !== index);
    if (changed.length === 0) return;
    await this.db.batch(
      changed.map(({ item, index }) => statement.bind(index, item.id, playlistId)),
    );
  }
}
