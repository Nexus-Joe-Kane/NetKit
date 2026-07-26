import type { Env } from "../../src/config";
import { FakeD1Database } from "./fake-d1";

export function createEnv(database = new FakeD1Database()): Env {
  return {
    DB: database as unknown as D1Database,
    PUBLIC_BASE_URL: "https://hottub.joekane.org",
    SOURCE_NAME: "Test Hot Tub Source",
    ADMIN_ALLOWED_IPS: "192.0.2.10",
  };
}

export function createExecutionContext(): ExecutionContext & { pending: Promise<unknown>[] } {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext & { pending: Promise<unknown>[] };
}

export function post(path: string, body: unknown, headers: HeadersInit = {}): Request {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("Content-Type", "application/json");
  requestHeaders.set("CF-Connecting-IP", "192.0.2.10");
  return new Request(`https://hottub.joekane.org${path}`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(body),
  });
}
