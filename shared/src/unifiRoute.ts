/**
 * Which way to reach a UniFi console, and how to trust it.
 *
 * There are two roads to the same API. The Network Integration API lives on
 * the console itself, and Ubiquiti also expose it through their cloud as the
 * Connector Proxy — same paths, same payloads, one goes over the customer's
 * network and the other over Ubiquiti's.
 *
 * The console is the better road when it is reachable: no third party in the
 * middle, no dependency on Ubiquiti's cloud being up, no proxy firmware
 * requirement, and it answers in milliseconds rather than over the internet
 * and back. The cloud is the better road when the console is not reachable,
 * which is most of the time for most of an estate.
 *
 * So: the console first, the cloud when it does not answer. This module is
 * the part with no I/O in it — how the two URLs are built, when to stop
 * trying the console, and what the TLS arrangement actually amounts to.
 */

/** The path prefix the integration API lives under, on either road. */
export const INTEGRATION_PREFIX = '/proxy/network/integration/v1';

/** Ubiquiti's cloud entry point for the same API. */
export const CLOUD_PROXY_BASE = 'https://api.ui.com/v1/connector/consoles';

export type UnifiRoute = 'controller' | 'cloud';

/** The URL of an integration path on the console itself. */
export function controllerUrl(base: string, path: string): string {
  const host = base.trim().replace(/\/+$/, '');
  const tail = path.startsWith('/') ? path : `/${path}`;
  return `${host}${INTEGRATION_PREFIX}${tail}`;
}

/** The URL of the same path through Ubiquiti's cloud. */
export function cloudUrl(consoleId: string, path: string): string {
  const tail = path.startsWith('/') ? path : `/${path}`;
  return `${CLOUD_PROXY_BASE}/${encodeURIComponent(consoleId.trim())}${INTEGRATION_PREFIX}${tail}`;
}

/**
 * A console URL as somebody will actually type it.
 *
 * People paste the address bar of the console, or of unifi.ui.com. Both are
 * accepted and neither is left to fail silently: an https:// scheme is added
 * where it is missing, a trailing path is dropped, and a unifi.ui.com URL is
 * recognised as *not* a controller address — it is the cloud, and pasting it
 * in as the controller would send every "local" call to Ubiquiti while
 * claiming to be direct.
 */
export function normaliseControllerUrl(raw: string): { url?: string; problem?: string } {
  const value = raw.trim();
  if (!value) return {};
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { problem: 'That is not a usable address. Use the console’s own address, e.g. https://192.168.1.1.' };
  }
  if (/(^|\.)ui\.com$/i.test(parsed.hostname)) {
    return {
      problem:
        'That is the Site Manager address, not the console’s own. Put the console id in the console field and ' +
        'leave this one empty, or use the address the console answers on your network.',
    };
  }
  if (parsed.protocol === 'http:') {
    return {
      problem:
        'A console reached over plain http would send its API key in the clear. Use https, even with the ' +
        'self-signed certificate — the certificate settings below are there for exactly that.',
    };
  }
  return { url: `${parsed.protocol}//${parsed.host}` };
}

/**
 * The console id out of a unifi.ui.com address.
 *
 * `https://unifi.ui.com/consoles/<id>` — and often with more path after it,
 * because people copy the URL of whatever page they were on.
 */
export function consoleIdFromUrl(raw: string): string | undefined {
  const match = raw.match(/consoles\/([0-9a-f-]{8,})/i);
  return match?.[1]?.toLowerCase();
}

/* ------------------------------------------------------------------ *
 * How the console's certificate is trusted
 * ------------------------------------------------------------------ */

/**
 * `verified`   an ordinary certificate an ordinary CA signed.
 * `pinned-ca`  the console's own certificate, supplied by us and trusted
 *              because we supplied it.
 * `pinned-fingerprint`
 *              no chain at all: the certificate must hash to a value we
 *              were given.
 * `unverified` no checking. Works, and is worth saying out loud.
 */
export type TlsMode = 'verified' | 'pinned-ca' | 'pinned-fingerprint' | 'unverified';

export interface ControllerTls {
  caCert?: string;
  fingerprint?: string;
  insecure?: boolean;
}

export function tlsMode(tls: ControllerTls | undefined): TlsMode {
  if (tls?.caCert?.trim()) return 'pinned-ca';
  if (tls?.fingerprint?.trim()) return 'pinned-fingerprint';
  if (tls?.insecure) return 'unverified';
  return 'verified';
}

/**
 * What that arrangement means, in a sentence an operator can act on.
 *
 * The default is listed as a problem for a local console on purpose. A
 * console on 192.168.x.x has a self-signed certificate, so plain
 * verification fails and the fallback quietly takes over — the portal would
 * look like it was talking to the console and would never have reached it.
 */
export function tlsExplanation(mode: TlsMode): { text: string; tone: 'ok' | 'warn' | 'info' } {
  switch (mode) {
    case 'pinned-ca':
      return {
        tone: 'ok',
        text:
          'The console’s own certificate is on file, so the connection is verified against that rather than ' +
          'against a public authority. The host name is not checked, because a console’s certificate names ' +
          'itself rather than its address.',
      };
    case 'pinned-fingerprint':
      return {
        tone: 'ok',
        text:
          'The certificate must match the fingerprint on file exactly. Nothing else is trusted, so a replaced ' +
          'certificate stops the connection until the new fingerprint is entered — which is the point.',
      };
    case 'unverified':
      return {
        tone: 'warn',
        text:
          'Certificate checking is switched off for the console. Anything on the path between this server and it ' +
          'could read the API key. Acceptable on a private link you control, and worth replacing with a ' +
          'fingerprint when somebody has five minutes.',
      };
    default:
      return {
        tone: 'info',
        text:
          'The certificate is verified normally. That works where the console is behind a proper certificate, and ' +
          'fails on a console using its own — in which case add its certificate or its fingerprint below, or the ' +
          'portal will silently fall back to Site Manager.',
      };
  }
}

/** SHA-256 fingerprints are pasted with colons, spaces, or neither. */
export const normaliseFingerprint = (raw: string): string =>
  raw.trim().toUpperCase().replace(/[^0-9A-F]/g, '');

export function fingerprintProblem(raw: string): string | undefined {
  if (!raw.trim()) return undefined;
  const clean = normaliseFingerprint(raw);
  if (clean.length !== 64) {
    return `A SHA-256 fingerprint is 64 hex characters (32 pairs). That one has ${clean.length}.`;
  }
  return undefined;
}

export const fingerprintsMatch = (a: string | undefined, b: string | undefined): boolean =>
  Boolean(a && b && normaliseFingerprint(a) === normaliseFingerprint(b));

/* ------------------------------------------------------------------ *
 * When to stop trying the console
 * ------------------------------------------------------------------ */

/**
 * How long the console is left alone after it fails to answer.
 *
 * Without this, every call pays the console's connect timeout before going
 * to the cloud, and a page with six panels on it takes half a minute to
 * load a site that is perfectly healthy. One minute is short enough that a
 * console coming back is noticed quickly and long enough to stop the
 * timeouts stacking up.
 */
export const CONTROLLER_RETRY_MS = 60 * 1000;

export interface RouteState {
  /** When the console last failed to answer at all. */
  unreachableAt?: number;
  /** The last road that worked, for the status panel. */
  lastRoute?: UnifiRoute;
  lastError?: string;
}

export function shouldTryController(
  state: RouteState | undefined,
  options: { controllerConfigured: boolean; now?: number },
): boolean {
  if (!options.controllerConfigured) return false;
  if (!state?.unreachableAt) return true;
  return (options.now ?? Date.now()) - state.unreachableAt >= CONTROLLER_RETRY_MS;
}

/**
 * How the status panel describes where the answers are coming from.
 *
 * "Site Manager" on its own is not enough: an operator who set a controller
 * up needs to know it is not being used, and why.
 */
export function routeExplanation(state: RouteState | undefined, controllerConfigured: boolean): string {
  if (!controllerConfigured) {
    return 'Reading through Ubiquiti’s cloud. No console address is set, so there is nothing local to try.';
  }
  if (state?.lastRoute === 'controller') return 'Reading directly from the console.';
  if (state?.unreachableAt) {
    return `The console did not answer${state.lastError ? ` (${state.lastError})` : ''}, so this is coming through Ubiquiti’s cloud instead. The console is retried a minute after each failure.`;
  }
  if (state?.lastRoute === 'cloud') return 'Reading through Ubiquiti’s cloud.';
  return 'Nothing read yet.';
}
