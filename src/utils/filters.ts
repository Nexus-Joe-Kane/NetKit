import type { Video } from "../hottub/schemas";

function includesTerm(value: string | undefined, terms: Set<string>): boolean {
  if (!value) return false;
  const normalised = value.toLocaleLowerCase();
  for (const term of terms) {
    if (normalised.includes(term)) return true;
  }
  return false;
}

export function applyClientBlocks(
  items: Video[],
  blockedKeywords: string[],
  blockedUploaders: string[],
): Video[] {
  const keywords = new Set(
    blockedKeywords.map((value) => value.trim().toLocaleLowerCase()).filter(Boolean),
  );
  const uploaders = new Set(
    blockedUploaders.map((value) => value.trim().toLocaleLowerCase()).filter(Boolean),
  );

  return items.filter((item) => {
    const keywordFields = [item.title, ...(item.tags ?? []), ...(item.categories ?? [])].join(" ");
    if (includesTerm(keywordFields, keywords)) return false;
    const uploaderFields = [item.uploaderId, item.uploader, item.uploaderUrl];
    return !uploaderFields.some((value) => includesTerm(value, uploaders));
  });
}

export interface DurationRange {
  min?: number;
  max?: number;
}

const MAX_DURATION_SECONDS = 86_400;

function finiteSeconds(value: unknown): number | undefined {
  // Guarded explicitly, because `Number("")` and `Number(null)` are both 0 and
  // would otherwise turn an absent bound into a real one.
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" && String(value).trim() === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_DURATION_SECONDS) return undefined;
  return Math.round(parsed);
}

/**
 * Reads the value the app sends for a `control: "range"` option.
 *
 * The range control is undocumented, so the wire encoding is not pinned down
 * anywhere: the shapes below are all plausible and cheap to accept. An
 * unrecognised value yields no bounds rather than silently filtering
 * everything away.
 */
export function parseDurationRange(value: unknown): DurationRange {
  if (value === undefined || value === null || value === "") return {};

  if (Array.isArray(value) && value.length >= 2) {
    return { min: finiteSeconds(value[0]), max: finiteSeconds(value[1]) };
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const min = finiteSeconds(record.min ?? record.lower ?? record.from);
    const max = finiteSeconds(record.max ?? record.upper ?? record.to);
    if (min !== undefined || max !== undefined) return { min, max };
    return {};
  }
  const text = String(value).trim();
  const pair = text.split(/\s*(?:,|-|\.\.|:|–)\s*/);
  if (pair.length >= 2) {
    return { min: finiteSeconds(pair[0]), max: finiteSeconds(pair[1]) };
  }
  // A lone number is treated as a lower bound, matching how a single-thumb
  // "at least this long" control would read.
  const single = finiteSeconds(text);
  return single === undefined ? {} : { min: single };
}

/**
 * Applied to merged results rather than pushed down to providers, since only
 * two of the featured channels expose any duration filter upstream.
 *
 * Not every catalogue reports a duration: several federated channels — Erome,
 * FikFap, FYPTT, Tik Porn, Hentai Haven and Paradisehill among them — return
 * `0`, which means unknown rather than zero seconds. Those items are kept, so
 * raising the minimum narrows the feed instead of silently emptying whole
 * channels that simply never reported a length.
 */
export function applyDurationRange(items: Video[], range: DurationRange): Video[] {
  const { min, max } = range;
  if (min === undefined && max === undefined) return items;
  // A range covering the whole advertised span is the control at rest.
  if ((min ?? 0) <= 0 && (max ?? MAX_DURATION_SECONDS) >= MAX_DURATION_SECONDS) return items;
  return items.filter((item) => {
    const duration = item.duration;
    if (!Number.isFinite(duration) || duration <= 0) return true;
    if (min !== undefined && duration < min) return false;
    // The top of the slider means "and longer", so the maximum only excludes
    // when it is below the advertised ceiling.
    if (max !== undefined && max < MAX_DURATION_SECONDS && duration > max) return false;
    return true;
  });
}

export function mergeProviderResults(groups: Video[][], pageSize: number): Video[] {
  const result: Video[] = [];
  const seen = new Set<string>();
  const longest = Math.max(0, ...groups.map((group) => group.length));
  for (let index = 0; index < longest && result.length < pageSize; index += 1) {
    for (const group of groups) {
      const item = group[index];
      if (!item) continue;
      const key = `${item.channel}:${item.id ?? item.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(item);
      if (result.length >= pageSize) break;
    }
  }
  return result;
}
