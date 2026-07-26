PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS provider_connections (
  id TEXT PRIMARY KEY,
  user_key TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  encrypted_access_token TEXT,
  encrypted_refresh_token TEXT,
  token_expires_at TEXT,
  encryption_key_id TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  last_sync_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_key, provider_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_connections_user
  ON provider_connections (user_key, provider_id);

CREATE TABLE IF NOT EXISTS local_history (
  id TEXT PRIMARY KEY,
  user_key TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  video_url TEXT NOT NULL,
  title TEXT NOT NULL,
  thumb TEXT,
  duration INTEGER,
  progress_seconds INTEGER NOT NULL DEFAULT 0,
  watched_at TEXT NOT NULL,
  UNIQUE (user_key, provider_id, video_id)
);

CREATE INDEX IF NOT EXISTS idx_local_history_user_watched
  ON local_history (user_key, watched_at DESC);

CREATE TABLE IF NOT EXISTS local_favourites (
  id TEXT PRIMARY KEY,
  user_key TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  video_url TEXT NOT NULL,
  title TEXT NOT NULL,
  thumb TEXT,
  duration INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (user_key, provider_id, video_id)
);

CREATE INDEX IF NOT EXISTS idx_local_favourites_user_created
  ON local_favourites (user_key, created_at DESC);

CREATE TABLE IF NOT EXISTS local_playlists (
  id TEXT PRIMARY KEY,
  user_key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_key, name)
);

CREATE INDEX IF NOT EXISTS idx_local_playlists_user
  ON local_playlists (user_key, updated_at DESC);

CREATE TABLE IF NOT EXISTS local_playlist_items (
  id TEXT PRIMARY KEY,
  playlist_id TEXT NOT NULL,
  user_key TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  video_url TEXT NOT NULL,
  title TEXT NOT NULL,
  thumb TEXT,
  duration INTEGER,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (playlist_id, provider_id, video_id),
  FOREIGN KEY (playlist_id) REFERENCES local_playlists(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_local_playlist_items_order
  ON local_playlist_items (playlist_id, position ASC);

CREATE TABLE IF NOT EXISTS followed_uploaders (
  id TEXT PRIMARY KEY,
  user_key TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  uploader_id TEXT NOT NULL,
  uploader_name TEXT NOT NULL,
  uploader_url TEXT,
  avatar TEXT,
  followed_at TEXT NOT NULL,
  UNIQUE (user_key, provider_id, uploader_id)
);

CREATE INDEX IF NOT EXISTS idx_followed_uploaders_user
  ON followed_uploaders (user_key, followed_at DESC);

CREATE TABLE IF NOT EXISTS sync_state (
  id TEXT PRIMARY KEY,
  user_key TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  cursor TEXT,
  last_sync_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (user_key, provider_id, resource)
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_updated
  ON rate_limits (updated_at);
