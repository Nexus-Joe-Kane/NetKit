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

  async followUploader(
    userKey: string,
    input: {
      providerId: string;
      uploaderId: string;
      uploaderName: string;
      uploaderUrl?: string;
      avatar?: string;
    },
  ): Promise<void> {
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
}
