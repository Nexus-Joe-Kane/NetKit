import { decryptSecret, encryptSecret, primaryEncryptionKeyId } from "../auth/encryption";

interface ConnectionRow {
  id: string;
  provider_id: string;
  encrypted_access_token: string | null;
  encrypted_refresh_token: string | null;
  token_expires_at: string | null;
  encryption_key_id: string | null;
  capabilities_json: string;
  last_sync_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConnectionSummary {
  id: string;
  providerId: string;
  tokenExpiresAt: string | null;
  encryptionKeyId: string | null;
  capabilities: Record<string, boolean>;
  lastSyncAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredConnection {
  summary: ConnectionSummary;
  accessToken?: string;
  refreshToken?: string;
}

function parseCapabilities(value: string): Record<string, boolean> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
      ),
    );
  } catch {
    return {};
  }
}

function summary(row: ConnectionRow): ConnectionSummary {
  return {
    id: row.id,
    providerId: row.provider_id,
    tokenExpiresAt: row.token_expires_at,
    encryptionKeyId: row.encryption_key_id,
    capabilities: parseCapabilities(row.capabilities_json),
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ConnectionRepository {
  constructor(private readonly db: D1Database) {}

  async list(userKey: string): Promise<ConnectionSummary[]> {
    const result = await this.db
      .prepare(
        `SELECT id, provider_id, encrypted_access_token, encrypted_refresh_token,
                token_expires_at, encryption_key_id, capabilities_json,
                last_sync_at, last_error, created_at, updated_at
         FROM provider_connections
         WHERE user_key = ?
         ORDER BY provider_id`,
      )
      .bind(userKey)
      .all<ConnectionRow>();
    return result.results.map(summary);
  }

  async get(
    userKey: string,
    providerId: string,
    encryptionKeys?: string,
  ): Promise<StoredConnection | null> {
    const row = await this.db
      .prepare(
        `SELECT id, provider_id, encrypted_access_token, encrypted_refresh_token,
                token_expires_at, encryption_key_id, capabilities_json,
                last_sync_at, last_error, created_at, updated_at
         FROM provider_connections
         WHERE user_key = ? AND provider_id = ?`,
      )
      .bind(userKey, providerId)
      .first<ConnectionRow>();
    if (!row) return null;
    const context = `${userKey}:${providerId}`;
    return {
      summary: summary(row),
      accessToken:
        row.encrypted_access_token && encryptionKeys
          ? await decryptSecret(row.encrypted_access_token, encryptionKeys, context)
          : undefined,
      refreshToken:
        row.encrypted_refresh_token && encryptionKeys
          ? await decryptSecret(row.encrypted_refresh_token, encryptionKeys, context)
          : undefined,
    };
  }

  async save(input: {
    userKey: string;
    providerId: string;
    accessToken?: string;
    refreshToken?: string;
    tokenExpiresAt?: string;
    capabilities: Record<string, boolean>;
    encryptionKeys: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    const context = `${input.userKey}:${input.providerId}`;
    const encryptedAccessToken = input.accessToken
      ? await encryptSecret(input.accessToken, input.encryptionKeys, context)
      : null;
    const encryptedRefreshToken = input.refreshToken
      ? await encryptSecret(input.refreshToken, input.encryptionKeys, context)
      : null;
    await this.db
      .prepare(
        `INSERT INTO provider_connections (
           id, user_key, provider_id, encrypted_access_token, encrypted_refresh_token,
           token_expires_at, encryption_key_id, capabilities_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_key, provider_id) DO UPDATE SET
           encrypted_access_token = excluded.encrypted_access_token,
           encrypted_refresh_token = excluded.encrypted_refresh_token,
           token_expires_at = excluded.token_expires_at,
           encryption_key_id = excluded.encryption_key_id,
           capabilities_json = excluded.capabilities_json,
           last_error = NULL,
           updated_at = excluded.updated_at`,
      )
      .bind(
        crypto.randomUUID(),
        input.userKey,
        input.providerId,
        encryptedAccessToken,
        encryptedRefreshToken,
        input.tokenExpiresAt ?? null,
        primaryEncryptionKeyId(input.encryptionKeys),
        JSON.stringify(input.capabilities),
        now,
        now,
      )
      .run();
  }

  async disconnect(userKey: string, providerId: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM provider_connections WHERE user_key = ? AND provider_id = ?")
      .bind(userKey, providerId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }
}
