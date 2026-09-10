import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { TLSSocket } from 'node:tls';
import {
  CONTROLLER_RETRY_MS,
  cloudUrl,
  controllerUrl,
  fingerprintsMatch,
  normaliseFingerprint,
  routeExplanation,
  shouldTryController,
  tlsMode,
  type RouteState,
  type UnifiRoute,
} from '@sw/shared';
import { config } from '../../config';
import { fetchJson } from '../../lib/http';
import { recordUpstreamFailure } from '../../services/upstreamLog';

/**
 * One call to the UniFi Network Integration API, by whichever road works.
 *
 * The console first, Ubiquiti's cloud second. The paths and payloads are
 * identical — that is the whole reason this is a transport swap and not two
 * implementations — so everything above this file is unaware of which road
 * it got its answer from, except the status panel, which says.
 *
 * The console is only abandoned for a *transport* failure: DNS, connection
 * refused, a timeout, a TLS problem. A 404 from the console is a real 404,
 * and asking the cloud the same question would get the same answer more
 * slowly. A 401 is the exception among the refusals: the two roads take
 * different keys, so a console that rejects its key is worth one attempt
 * through the cloud before giving up.
 */

let state: RouteState = {};

/** Test hook, and the admin panel's "try the console again" button. */
export function resetUnifiRoute(): void {
  state = {};
}

export function unifiRouteState(): RouteState & { explanation: string; controllerConfigured: boolean } {
  const controllerConfigured = Boolean(config().unifi.controllerUrl && config().unifi.controllerKey);
  return { ...state, controllerConfigured, explanation: routeExplanation(state, controllerConfigured) };
}

/* ------------------------------------------------------------------ *
 * Talking to a console with its own certificate
 * ------------------------------------------------------------------ */

class TlsMismatch extends Error {}

/**
 * A JSON request against the console, with the certificate policy applied.
 *
 * `node:https` rather than `fetch`, because a console on a private address
 * has a self-signed certificate and `fetch` gives no way to say how to trust
 * one. The three arrangements this supports are described in
 * shared/src/unifiRoute.ts; the important one is the fingerprint, which is
 * checked here on the live socket rather than delegated, because
 * `rejectUnauthorized: false` skips Node's own identity check entirely.
 */
function controllerRequest(
  url: string,
  init: { method: string; body?: unknown; headers: Record<string, string>; timeoutMs: number },
): Promise<{ status: number; statusText: string; body: string }> {
  const cfg = config().unifi;
  const mode = tlsMode({ caCert: cfg.controllerCaCert, fingerprint: cfg.controllerFingerprint, insecure: cfg.controllerInsecureTls });
  const target = new URL(url);
  const payload = init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body);

  const options: RequestOptions = {
    method: init.method,
    hostname: target.hostname,
    ...(target.port ? { port: Number(target.port) } : {}),
    path: `${target.pathname}${target.search}`,
    headers: {
      Accept: 'application/json',
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      ...init.headers,
    },
    timeout: init.timeoutMs,
  };

  if (mode === 'pinned-ca') {
    options.ca = cfg.controllerCaCert;
    /*
     * The host name is not checked in this mode, deliberately.
     *
     * A UniFi console's certificate names the console — "UniFi Dream
     * Machine" — and never the address it is reached on, so a host-name
     * check against 192.168.1.1 fails every time. The chain is still
     * verified against the certificate we were given, which is the part
     * that proves it is the same console.
     */
    options.checkServerIdentity = () => undefined;
  } else if (mode === 'pinned-fingerprint' || mode === 'unverified') {
    options.rejectUnauthorized = false;
  }

  return new Promise((resolve, reject) => {
    const req = httpsRequest(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        // A console answering with something enormous is a console we do not
        // understand, and not worth buffering.
        if (chunks.reduce((n, c) => n + c.length, 0) > 8 * 1024 * 1024) req.destroy(new Error('response too large'));
      });
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });

    if (mode === 'pinned-fingerprint') {
      req.on('socket', (socket) => {
        socket.on('secureConnect', () => {
          const cert = (socket as TLSSocket).getPeerCertificate();
          if (!fingerprintsMatch(cert?.fingerprint256, cfg.controllerFingerprint)) {
            req.destroy(
              new TlsMismatch(
                `the console's certificate does not match the fingerprint on file (it is ${
                  normaliseFingerprint(cert?.fingerprint256 ?? '').match(/.{2}/g)?.join(':') ?? 'unreadable'
                })`,
              ),
            );
          }
        });
      });
    }

    req.on('timeout', () => req.destroy(new Error(`timed out after ${init.timeoutMs}ms`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/* ------------------------------------------------------------------ *
 * The call
 * ------------------------------------------------------------------ */

export interface IntegrationCall {
  /** A path under the integration API, e.g. `/sites`. */
  path: string;
  method?: 'GET' | 'POST' | 'PUT';
  body?: unknown;
  /** The Site Manager host id, needed for the cloud road. */
  consoleId?: string;
  timeoutMs?: number;
  /** Never retried where the action is not idempotent. */
  retries?: number;
  notFoundAsNull?: boolean;
}

const markUnreachable = (error: string): void => {
  state = { ...state, unreachableAt: Date.now(), lastError: error };
};

const markRoute = (route: UnifiRoute): void => {
  state = route === 'controller' ? { lastRoute: 'controller' } : { ...state, lastRoute: 'cloud' };
};

/**
 * Whether a failure means "this road is closed" rather than "that is the
 * answer".
 *
 * A refusal is an answer: the console is there and it said no, so the cloud
 * would say no too — except for authentication, where the two roads use
 * different keys.
 */
const isTransportFailure = (err: unknown): boolean => {
  if (err instanceof TlsMismatch) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /ECONN|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ETIMEDOUT|timed out|socket hang up|certificate|self.signed|CERT_|TLS/i.test(
    message,
  );
};

export async function integrationCall<T>(call: IntegrationCall): Promise<T | null> {
  const cfg = config();
  const unifi = cfg.unifi;
  const timeoutMs = call.timeoutMs ?? Math.min(cfg.requestTimeoutMs, 12_000);
  const controllerConfigured = Boolean(unifi.controllerUrl && unifi.controllerKey);

  if (shouldTryController(state, { controllerConfigured })) {
    const url = controllerUrl(unifi.controllerUrl, call.path);
    try {
      const res = await controllerRequest(url, {
        method: call.method ?? 'GET',
        ...(call.body !== undefined ? { body: call.body } : {}),
        headers: { 'X-API-KEY': unifi.controllerKey },
        timeoutMs,
      });

      if (res.status === 404 && call.notFoundAsNull) {
        markRoute('controller');
        return null;
      }
      if (res.status === 204 || !res.body.trim()) {
        markRoute('controller');
        return null;
      }
      if (res.status >= 200 && res.status < 300) {
        markRoute('controller');
        try {
          return JSON.parse(res.body) as T;
        } catch {
          throw new Error('the console answered with something that is not JSON');
        }
      }

      recordUpstreamFailure({
        label: 'UniFi console',
        method: call.method ?? 'GET',
        url,
        status: res.status,
        statusText: res.statusText,
        body: res.body,
      });

      /*
       * 401 and 403 are worth one go at the cloud, because the console key
       * and the cloud key are different keys and only one of them may be
       * right. Everything else is the console's real answer.
       */
      if (res.status !== 401 && res.status !== 403) {
        throw new Error(`the console responded ${res.status} ${res.statusText}`.trim());
      }
      state = { ...state, lastError: `the console rejected its API key (${res.status})` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isTransportFailure(err)) throw err;
      recordUpstreamFailure({ label: 'UniFi console', method: call.method ?? 'GET', url, body: message });
      markUnreachable(message);
    }
  }

  /* ---- Ubiquiti's cloud ------------------------------------------- */

  const consoleId = call.consoleId ?? unifi.consoleId;
  if (!unifi.integrationKey || !consoleId) {
    const reasons: string[] = [];
    if (controllerConfigured) reasons.push(state.lastError ?? 'the console did not answer');
    if (!unifi.integrationKey) reasons.push('no UniFi Network Integration key is set for the cloud route');
    if (!consoleId) reasons.push('no console id is set for the cloud route');
    throw new Error(`UniFi is unreachable: ${reasons.join(', ')}.`);
  }

  const result = await fetchJson<T>(cloudUrl(consoleId, call.path), {
    label: 'UniFi Network',
    method: call.method ?? 'GET',
    ...(call.body !== undefined ? { body: call.body } : {}),
    headers: { 'X-API-KEY': unifi.integrationKey, Accept: 'application/json' },
    timeoutMs,
    retries: call.retries ?? 0,
    ...(call.notFoundAsNull ? { notFoundAsNull: true } : {}),
  });
  markRoute('cloud');
  return result;
}

/** For the admin panel: how long until the console is tried again. */
export const controllerRetryInMs = (now = Date.now()): number =>
  state.unreachableAt ? Math.max(0, CONTROLLER_RETRY_MS - (now - state.unreachableAt)) : 0;
