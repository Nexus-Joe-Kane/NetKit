/**
 * Real supplier logos, without shipping anybody's brand assets.
 *
 * The monogram squares were honest but they were not what an engineer sees
 * on the rest of the internet, and a WAN row reads faster with the actual
 * Openreach mark on it than with the letters "OP".
 *
 * How: every provider in the directory has its own domain, and a website's
 * own icon is a logo it publishes for exactly this purpose. So the logo is
 * fetched from the provider's own site — not from an icon-farming service
 * that would be told which suppliers we look at, and not hot-linked from the
 * browser either. It goes through the portal, which fetches it once, caches
 * it, and serves it from our own origin. A provider with no usable icon
 * falls back to the monogram, which is why the monogram stays.
 *
 * This module is the pure half: which URLs to try, in what order, and what
 * counts as an image worth keeping.
 */

/** Where the portal serves a cached logo from. */
export const LOGO_PATH = '/api/brand/logo';

/**
 * The URL the browser asks for. A key, not a domain, so the browser never
 * talks to the supplier directly.
 */
export const logoUrl = (key: string): string => `${LOGO_PATH}/${encodeURIComponent(key)}`;

/**
 * Where to look on a supplier's own site, best first.
 *
 * The Apple touch icon comes first because it is the one that has to be a
 * proper square PNG at a usable size — `favicon.ico` is often a 16-pixel
 * relic that looks like a smudge next to type. The `www` variants are there
 * because plenty of estates redirect the apex domain in a way that loses the
 * path.
 */
export function logoCandidates(domain: string): string[] {
  const host = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!host || !host.includes('.')) return [];
  const hosts = host.startsWith('www.') ? [host, host.slice(4)] : [`www.${host}`, host];
  const paths = ['/apple-touch-icon.png', '/apple-touch-icon-precomposed.png', '/favicon.svg', '/favicon.ico'];
  const out: string[] = [];
  for (const path of paths) for (const h of hosts) out.push(`https://${h}${path}`);
  return out;
}

/**
 * Content types worth caching, and what to save them as.
 *
 * An allow-list because this endpoint takes bytes from a third party and
 * serves them from our origin. Anything not on it — an HTML error page
 * dressed as an icon, an SVG from a host we have no reason to trust — is
 * discarded rather than passed on.
 *
 * SVG is deliberately absent despite being the nicest format for this: an
 * SVG is a document that can carry script, and serving one from our own
 * origin would run it there. A 180-pixel PNG is not worth that.
 */
export const LOGO_TYPES: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** The largest icon worth keeping. Generous for a PNG, mean for a payload. */
export const LOGO_MAX_BYTES = 256 * 1024;

/** How long a browser may keep one. Logos change about once a decade. */
export const LOGO_CACHE_SECONDS = 7 * 24 * 60 * 60;

/** The extension to store a response under, or undefined to discard it. */
export function logoExtension(contentType: string | null | undefined): string | undefined {
  if (!contentType) return undefined;
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return LOGO_TYPES[type];
}

/**
 * Is this actually an image?
 *
 * Checked on the bytes as well as the header, because a login page served
 * with `Content-Type: image/png` is a thing that happens and an <img> tag
 * showing a broken glyph is a worse outcome than the monogram.
 */
export function looksLikeImage(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  const starts = (...sig: number[]): boolean => sig.every((b, i) => bytes[i] === b);
  return (
    starts(0x89, 0x50, 0x4e, 0x47) || // PNG
    starts(0xff, 0xd8, 0xff) || // JPEG
    starts(0x00, 0x00, 0x01, 0x00) || // ICO
    starts(0x47, 0x49, 0x46, 0x38) || // GIF
    (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57) // WEBP
  );
}

/**
 * A cache key safe to use as a filename.
 *
 * Provider keys come from the directory and are already tame, but an unknown
 * provider's key is derived from a name a console reported, and a name with
 * a slash in it must not become a path.
 */
export function logoCacheName(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 60) || 'unknown';
}
