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

/** Eporner's documented `gay` parameter: 0 excludes gay, 1 both, 2 gay only. */
export function epornerGayParameter(orientation: Orientation | undefined): string {
  if (orientation === "gay") return "2";
  if (orientation === "any") return "1";
  return "0";
}

/** FapHouse's `?orientation=` accepts the same two words the app uses. */
export function faphouseOrientationParameter(
  orientation: Orientation | undefined,
): string | undefined {
  if (orientation === "gay") return "gay";
  if (orientation === "straight") return "straight";
  return undefined;
}
