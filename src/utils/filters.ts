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
