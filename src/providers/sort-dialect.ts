import type { ChannelOptionChoice } from "../hottub/schemas";

/**
 * Every catalogue names its sorts differently: `most-viewed`, `video_viewed`,
 * `popular`, `hot`. A bundle fans out across catalogues that disagree, so it
 * advertises a generic intent and each member is asked in its own dialect.
 *
 * This was measured, not assumed. Sending a generic `views` to the community
 * upstream changes nothing for any channel, while sending a channel its own
 * declared ID genuinely reorders results for most of them. Translating is
 * therefore the difference between a working sort control and a placebo.
 *
 * Patterns are ordered from most to least specific, so `Most Viewed` wins over
 * `Trending` when a catalogue offers both.
 */
const INTENTS: Record<string, readonly RegExp[]> = {
  relevance: [/\brelevance\b/i, /\bmost relevant\b/i, /\brecommended\b/i],
  new: [/\b(?:newest|most recent|latest)\b/i, /\bnew\b/i, /\brecent\b/i, /\bdate\b/i],
  views: [
    /\bmost viewed\b/i,
    /\bviews?\b/i,
    /\bviewed\b/i,
    /\bmost popular\b/i,
    /\bpopular\b/i,
    /\btrending\b/i,
    /\bhot(?:test)?\b/i,
  ],
  rated: [/\btop rated\b/i, /\brat(?:ed|ing)\b/i, /\bbest\b/i, /\btop\b/i],
  longest: [/\blongest\b/i, /\bduration\b/i, /\blong\b/i],
};

/** The intents a bundle may advertise, since every dialect can express them. */
export const BUNDLE_SORT_OPTIONS: readonly ChannelOptionChoice[] = [
  { id: "new", title: "Newest" },
  { id: "views", title: "Most Viewed" },
  { id: "rated", title: "Top Rated" },
  { id: "longest", title: "Longest" },
];

/**
 * Resolves a requested sort into an ID the channel actually declares.
 *
 * Returns `undefined` when nothing matches, which drops the parameter entirely
 * so the catalogue uses its own default — better than forwarding a value it
 * would silently discard.
 */
export function resolveSortForChannel(
  declared: readonly ChannelOptionChoice[],
  requested: string | undefined,
): string | undefined {
  if (!requested || declared.length === 0) return undefined;
  // A channel that already speaks this ID needs no translation.
  if (declared.some((option) => option.id === requested)) return requested;
  for (const pattern of INTENTS[requested] ?? []) {
    const match = declared.find((option) => pattern.test(option.id) || pattern.test(option.title));
    if (match) return match.id;
  }
  return undefined;
}
