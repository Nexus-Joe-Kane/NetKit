import { Router } from 'express';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ISP_DIRECTORY,
  LOGO_CACHE_SECONDS,
  LOGO_MAX_BYTES,
  MAJOR_PROVIDERS,
  logoCacheName,
  logoCandidates,
  logoExtension,
  looksLikeImage,
} from '@sw/shared';
import { config } from '../config';

/**
 * Supplier logos, fetched once and served from our own origin.
 *
 * Three reasons it goes through here rather than straight from the browser.
 *
 * A hot-linked logo tells the supplier's servers which of our engineers is
 * looking at which of their customers, on every page view. Caching it here
 * means one request per logo per week from one address.
 *
 * A portal on a locked-down network can reach this app and not the open
 * internet, and a page full of broken images is a page that looks broken.
 *
 * And bytes from a third party get checked before they are served from our
 * origin: an allow-list of content types, a magic-number check on the
 * actual bytes, and a size cap. An <img> tag pointed at a supplier's site
 * gets none of that.
 */

/** Both directories, so a dashboard name and a WAN name resolve the same. */
function domainFor(key: string): string | undefined {
  const wanted = key.trim().toLowerCase();
  const isp = ISP_DIRECTORY.find((e) => e.key === wanted);
  if (isp?.domain) return isp.domain;
  const major = MAJOR_PROVIDERS.find((p) => p.slug === wanted);
  // The major-provider list carries no domains of its own; its slugs are the
  // directory's keys where they overlap, which covers every row that has a
  // logo worth showing.
  if (major) {
    const byName = ISP_DIRECTORY.find((e) => e.aka.some((a) => major.aka.includes(a)));
    if (byName?.domain) return byName.domain;
  }
  return undefined;
}

interface Cached {
  bytes: Buffer;
  contentType: string;
}

/** In-process cache, on top of the on-disk one, to save a stat per request. */
const memory = new Map<string, Cached | null>();

function cacheDir(): string | null {
  try {
    const dir = join(config().dataDir, 'logo-cache');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  } catch {
    return null;
  }
}

const CONTENT_TYPE: Readonly<Record<string, string>> = {
  png: 'image/png',
  ico: 'image/x-icon',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

function fromDisk(name: string): Cached | null {
  const dir = cacheDir();
  if (!dir) return null;
  try {
    const file = readdirSync(dir).find((f) => f.startsWith(`${name}.`));
    if (!file) return null;
    const ext = file.split('.').pop() ?? '';
    const contentType = CONTENT_TYPE[ext];
    if (!contentType) return null;
    return { bytes: readFileSync(join(dir, file)), contentType };
  } catch {
    return null;
  }
}

/**
 * Fetches a supplier's own icon.
 *
 * Every candidate is tried in turn and the first one that is genuinely an
 * image wins. A miss is cached as a miss — a supplier with no usable icon
 * should cost one round of requests a restart, not one per page view.
 */
async function fetchLogo(domain: string): Promise<Cached | null> {
  for (const url of logoCandidates(domain)) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      let res: Response;
      try {
        res = await fetch(url, { redirect: 'follow', signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) continue;
      const ext = logoExtension(res.headers.get('content-type'));
      if (!ext) continue;
      const buffer = Buffer.from(await res.arrayBuffer());
      if (!buffer.length || buffer.length > LOGO_MAX_BYTES) continue;
      if (!looksLikeImage(buffer)) continue;
      return { bytes: buffer, contentType: CONTENT_TYPE[ext] ?? 'application/octet-stream' };
    } catch {
      // A supplier's website being unreachable is not our outage.
    }
  }
  return null;
}

export function brandRouter(): Router {
  const router = Router();

  /*
   * Deliberately open to any signed-in user rather than admin-only, and
   * deliberately not part of the JSON API shape: it answers with an image or
   * a 404, because it is the `src` of an <img> tag and the fallback is the
   * browser's error event.
   */
  router.get('/logo/:key', async (req, res) => {
    const key = String(req.params.key ?? '');
    const name = logoCacheName(key);

    const send = (hit: Cached) => {
      res.setHeader('Content-Type', hit.contentType);
      res.setHeader('Cache-Control', `public, max-age=${LOGO_CACHE_SECONDS}`);
      // Nothing here is per-user, but it is worth being explicit that an
      // image from a third party is not to be treated as anything else.
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(hit.bytes);
    };

    const cached = memory.get(name);
    if (cached) {
      send(cached);
      return;
    }
    if (cached === null) {
      res.status(404).end();
      return;
    }

    const onDisk = fromDisk(name);
    if (onDisk) {
      memory.set(name, onDisk);
      send(onDisk);
      return;
    }

    const domain = domainFor(key);
    if (!domain) {
      memory.set(name, null);
      res.status(404).end();
      return;
    }

    const fetched = await fetchLogo(domain);
    if (!fetched) {
      memory.set(name, null);
      res.status(404).end();
      return;
    }

    memory.set(name, fetched);
    const dir = cacheDir();
    if (dir) {
      const ext = Object.entries(CONTENT_TYPE).find(([, v]) => v === fetched.contentType)?.[0] ?? 'png';
      try {
        writeFileSync(join(dir, `${name}.${ext}`), fetched.bytes, { mode: 0o600 });
      } catch {
        /* The memory cache still works without a disk one. */
      }
    }
    send(fetched);
  });

  return router;
}

/** Test hook. */
export function resetLogoCache(): void {
  memory.clear();
}
