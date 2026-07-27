import type { ProviderVideoPage } from "./types";

/**
 * Resolves with the first catalogue page that actually contains items.
 *
 * A source that answers `200` with zero items and no error is a successful
 * call but a useless page, and it is usually the fastest to respond — so a
 * plain `Promise.any` lets it starve out a slower source holding the real
 * results. An empty page is returned only when no source has anything, which
 * is a genuine "no results" answer rather than an outage.
 */
export async function firstNonEmptyPage(
  attempts: ReadonlyArray<Promise<ProviderVideoPage>>,
  noSourceMessage: string,
): Promise<ProviderVideoPage> {
  // Every attempt is awaited twice (once here, once in the fallback below).
  // Attach a no-op handler so a rejection settled by `Promise.any` is never
  // reported as an unhandled rejection.
  attempts.forEach((attempt) => void attempt.catch(() => undefined));

  const nonEmpty = attempts.map(async (attempt) => {
    const page = await attempt;
    if (page.items.length === 0) throw new Error("source returned an empty page");
    return page;
  });

  try {
    return await Promise.any(nonEmpty);
  } catch {
    const settled = await Promise.allSettled(attempts);
    // An empty result is only trustworthy when every source agreed on it. If
    // any source failed outright, report the failure so the caller can fall
    // back to its last-known-good page instead of showing an empty channel
    // that looks like the provider simply has nothing.
    const everySourceAnswered = settled.every((result) => result.status === "fulfilled");
    const empty = settled.find((result) => result.status === "fulfilled");
    if (everySourceAnswered && empty?.status === "fulfilled") return empty.value;
    throw new Error(noSourceMessage);
  }
}
