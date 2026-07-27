import { assertUsableCookie, probePlayback, probeSession, signIn } from "./faphouse-session";
import { createHtmlCatalogProvider } from "./html-catalog";

const baseProvider = createHtmlCatalogProvider({
  id: "faphouse-ultra",
  name: "FapHouse Ultra",
  description:
    "Public catalogue metadata only. Protected playback still requires a provider-supported delegated login.",
  favicon: "https://www.google.com/s2/favicons?sz=64&domain=faphouse.com",
  premium: true,
  status: "degraded",
  sortOrder: 20,
  pageSize: 40,
  hostnames: ["faphouse.com", "faphouse2.com", "faphouse4k.com"],
  assetHostnames: ["faphouse.com", "faphouse2.com", "faphouse4k.com", "flixcdn.com"],
  // FapHouse dropped its `/en/` locale prefix; those paths now 404. It also
  // ignores `?sort=` entirely — new, most-viewed and top-rated return byte-for
  // byte the same first results — so no sort is sent and none is advertised.
  buildUrls(request) {
    const page = Math.max(1, request.page);
    if (request.query) {
      const primary = new URL("https://faphouse.com/search/videos");
      primary.searchParams.set("q", request.query);
      primary.searchParams.set("page", String(page));
      return [primary];
    }
    const primary = new URL("https://faphouse.com/videos");
    primary.searchParams.set("page", String(page));
    return [primary];
  },
  isWatchUrl(url) {
    return /\/(?:[a-z]{2}\/)?videos?\//i.test(url.pathname);
  },
  availability: "offline",
  tags: [
    { name: "Catalog only", systemImage: "rectangle.stack" },
    { name: "Premium", systemImage: "star.fill" },
  ],
});

/**
 * FapHouse publishes no OAuth or delegated-access API, so an account is
 * connected by the operator signing in themselves and pasting the resulting
 * session cookie. Nothing here submits credentials or works around the login
 * form's bot protection.
 *
 * Connecting does not yet make protected playback work: the anonymous watch
 * page embeds only heat-map scrubbing previews and no playable source, so how
 * an entitled session receives its stream is still unknown. `diagnosePlayback`
 * answers that against a real subscription, and a format resolver can then be
 * written against the observed behaviour rather than guessed at.
 */
export const faphouseProvider = {
  ...baseProvider,
  async connectSession(sessionCookie: string, fetcher: typeof fetch) {
    return probeSession(fetcher, assertUsableCookie(sessionCookie));
  },
  async connectCredentials(login: string, password: string, fetcher: typeof fetch) {
    return signIn(fetcher, login, password);
  },
  async diagnosePlayback(sessionCookie: string, watchUrl: string, fetcher: typeof fetch) {
    const probe = await probePlayback(fetcher, assertUsableCookie(sessionCookie), watchUrl);
    const parts = [
      `HTTP ${probe.status}`,
      probe.foundStreamCandidate
        ? `playable source candidates: ${probe.mediaUrls.join(" ") || "none"}`
        : "no playable source embedded in the page",
      probe.apiPaths.length ? `API paths seen: ${probe.apiPaths.slice(0, 12).join(" ")}` : "",
      ...probe.notes,
    ];
    return parts.filter(Boolean).join(" · ").slice(0, 300);
  },
};
