/**
 * Resolves the viewer's orientation preference.
 *
 * Two things feed it. `orientation` is a per-channel filter this source
 * advertises, and `gender` is Hot Tub's global preference, which the app sends
 * on every request whether or not a channel filter is set. An explicitly
 * chosen channel filter wins; otherwise the global preference applies.
 *
 * Only Eporner and FapHouse can honour it. Verified 2026-07-27: Eporner's
 * `gay=0|1|2` and FapHouse's `?orientation=` each return genuinely different
 * catalogues, while the Hot Tub-compatible upstreams behind xHamster, XVideos
 * and Pornhub return byte-identical results with and without the parameter,
 * and fpo.xxx has no orientation listings at all.
 */
export type Orientation = "straight" | "gay" | "any";

const STRAIGHT = new Set(["straight", "hetero", "heterosexual", "female", "women", "girls"]);
const GAY = new Set(["gay", "homosexual", "male", "men", "guys"]);
const ANY = new Set(["any", "all", "both", "bi", "bisexual", "everything"]);

/**
 * `none` is what the app sends when the viewer has expressed no preference,
 * so it must read as "no filter" rather than as a value to act on.
 */
const UNSET = new Set(["", "none", "unset", "default", "no_preference", "nopreference"]);

function normalise(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return normalise(value[0]);
  const text = String(value).trim().toLocaleLowerCase();
  return text.length > 0 && text.length <= 40 ? text : undefined;
}

function classify(value: unknown): Orientation | undefined {
  const text = normalise(value);
  if (text === undefined || UNSET.has(text)) return undefined;
  if (GAY.has(text)) return "gay";
  if (STRAIGHT.has(text)) return "straight";
  if (ANY.has(text)) return "any";
  return undefined;
}

export function resolveOrientation(request: Record<string, unknown>): Orientation | undefined {
  return classify(request.orientation) ?? classify(request.gender);
}

/**
 * Eporner's `gay` parameter: 0 excludes it, 1 includes it, 2 restricts to it.
 *
 * "Restricts to it" is not the same as "gay male". Measured 2026-07-27, the
 * top weekly results for `gay=2` are overwhelmingly trans and femboy titles —
 * which is why choosing Gay used to come back looking like straight content.
 * Pairing it with a `gay` browse query (below) is what actually produces
 * male-on-male results from this API.
 */
export function epornerGayParameter(orientation: Orientation | undefined): string {
  if (orientation === "gay") return "2";
  if (orientation === "any") return "1";
  return "0";
}

/**
 * Eporner has no browse mode — the catalogue is a search for the special query
 * `all` — so the query is the only other lever on what comes back. Asking for
 * `gay men` alongside `gay=2` returns male-on-male titles, where `all` with the
 * same flag returns the trans-heavy bucket described above.
 *
 * A query the viewer actually typed is never replaced.
 */
export function epornerBrowseQuery(
  orientation: Orientation | undefined,
  query: string | undefined,
): string {
  if (query) return query;
  return orientation === "gay" ? "gay men" : "all";
}

/**
 * Channels that genuinely serve an orientation, used to narrow a merged feed.
 *
 * `undefined` means "do not narrow". Straight is deliberately in that case:
 * every general catalogue is straight by default, so restricting the feed
 * would shrink it for no gain — Eporner still receives `gay=0` either way.
 *
 * Gay is narrowed, because most channels have no gay catalogue at all and
 * would simply dilute the feed with straight titles. Verified 2026-07-27:
 * Homo.xxx is a dedicated gay catalogue and the only one of the upstream's 80
 * channels, FapHouse's `?orientation=gay` returns genuinely different gay
 * listings, and Eporner contributes through the query above.
 */
export function orientationChannels(
  orientation: Orientation | undefined,
): readonly string[] | undefined {
  if (orientation !== "gay") return undefined;
  return ["homoxxx", "faphouse-ultra", "eporner"];
}

/** FapHouse's `?orientation=` accepts the same two words the app uses. */
export function faphouseOrientationParameter(
  orientation: Orientation | undefined,
): string | undefined {
  if (orientation === "gay") return "gay";
  if (orientation === "straight") return "straight";
  return undefined;
}
