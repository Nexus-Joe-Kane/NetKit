import { useEffect, useState } from 'react';

/**
 * The URL is the state.
 *
 * Everything reachable by clicking has to be reachable by pasting a link and
 * survivable across a refresh — an engineer mid-call who hits reload and lands
 * back on an empty search box has lost their place, and the back button
 * previously walked out of the app entirely rather than back one tab.
 *
 * A hash route rather than a path, because the app is served as a single
 * static file behind Passenger: a real path would 404 on refresh unless the
 * web server were taught to rewrite, and that is a deployment detail nobody
 * should have to remember.
 *
 * Shape: `#/<view>[/<a>[/<b>]]`
 *   #/lookup                     the search box
 *   #/site/100023253338          a premises, on its default tab
 *   #/site/100023253338/lines    a premises, on the Lines tab
 *   #/faults/closed              a page, on one of its own tabs
 */

export interface Route {
  /** First segment: which page. */
  view: string;
  /** Second segment: a UPRN under `site`, or a tab under a page. */
  a: string;
  /** Third segment: the report tab under `site`. */
  b: string;
}

const parse = (hash: string): Route => {
  const [view = '', a = '', b = ''] = hash
    .replace(/^#\/?/, '')
    .split('/')
    .map((part) => decodeURIComponent(part.trim()));
  return { view, a, b };
};

export const readRoute = (): Route => parse(window.location.hash);

/** Builds a hash from segments, dropping empty trailing ones. */
export function toHash(...segments: Array<string | undefined>): string {
  const parts = segments.filter((s): s is string => Boolean(s && s.length)).map(encodeURIComponent);
  return parts.length ? `#/${parts.join('/')}` : '#/';
}

/**
 * Navigates.
 *
 * `replace` is for corrections that should not cost the user a press of the
 * back button — landing on a page and normalising its URL, say. A real
 * navigation pushes, so back goes back one tab rather than out of the app.
 */
export function go(hash: string, replace = false): void {
  if (window.location.hash === hash) return;
  if (replace) {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
    // replaceState fires no event, so anything listening has to be told.
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  window.location.hash = hash;
}

/** The current route, kept in step with the address bar and the back button. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => readRoute());

  useEffect(() => {
    const onChange = (): void => setRoute(readRoute());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
}

/**
 * One page's own tab, stored in the URL.
 *
 * Pages own their tab list, so this validates against it and falls back to
 * the default rather than trusting whatever is in the address bar: a stale
 * link to a tab that no longer exists should open the page, not break it.
 */
export function useTabRoute<T extends string>(
  view: string,
  tabs: readonly T[],
  fallback: T,
): [T, (next: T) => void] {
  const route = useRoute();
  const fromUrl = tabs.find((t) => t === route.a);
  const active = fromUrl ?? fallback;

  const set = (next: T): void => {
    // The default tab gets the bare page URL, so the common link is the
    // short one.
    go(next === fallback ? toHash(view) : toHash(view, next));
  };

  return [active, set];
}
