export interface Env {
  DB: D1Database;
  PUBLIC_BASE_URL?: string;
  SOURCE_NAME?: string;
  ADMIN_ACCESS_TEAM_DOMAIN?: string;
  ADMIN_ACCESS_AUDIENCE?: string;
  TOKEN_ENCRYPTION_KEYS?: string;
}

export interface RequestContext {
  env: Env;
  execution: ExecutionContext;
  request: Request;
  requestId: string;
}

export const DEFAULT_BASE_URL = "https://hottub.joekane.org";
export const DEFAULT_SOURCE_NAME = "Joe's Unified Hot Tub Source";
