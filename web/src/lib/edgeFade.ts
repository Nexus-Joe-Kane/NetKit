import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Fades whichever end of a sideways-scrolling strip has more behind it.
 *
 * On a phone the section nav and every tab strip are wider than the screen
 * and scroll sideways. Left alone, the last visible label ended mid-word
 * against the card edge, which reads as a broken layout rather than as
 * something to swipe.
 *
 * It has to be measured rather than styled, because CSS cannot ask whether an
 * element actually overflows or where it is scrolled to. Both matter: a strip
 * that fits should not be fading a label for no reason, and scrolling to the
 * end should clear the fade instead of leaving the final item dimmed forever.
 */
export type ScrollEdges = 'none' | 'start' | 'end' | 'both';

export function useEdgeFade<T extends HTMLElement>(deps: unknown[] = []): {
  ref: (node: T | null) => void;
  edges: ScrollEdges;
  onScroll: () => void;
} {
  const node = useRef<T | null>(null);
  const [edges, setEdges] = useState<ScrollEdges>('none');

  const measure = useCallback(() => {
    const el = node.current;
    if (!el) return;
    // A couple of pixels of slack: sub-pixel layout means scrollLeft rarely
    // lands exactly on the maximum.
    if (el.scrollWidth <= el.clientWidth + 2) setEdges('none');
    else if (el.scrollLeft <= 2) setEdges('end');
    else if (el.scrollLeft >= el.scrollWidth - el.clientWidth - 2) setEdges('start');
    else setEdges('both');
  }, []);

  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback(
    (el: T | null) => {
      observer.current?.disconnect();
      node.current = el;
      if (!el) return;
      measure();
      observer.current = new ResizeObserver(measure);
      observer.current.observe(el);
    },
    [measure],
  );

  /**
   * Brings the selected item fully clear of the faded edge.
   *
   * On a phone the strip is wider than the screen, so the section you are
   * actually looking at can sit half off the end -- which is how the SIMs
   * page ended up with its own tab dimmed at the right edge.
   *
   * Done by hand rather than with `scrollIntoView`. That only moves an
   * element it considers out of view, and a tab three quarters visible under
   * the fade counts as in view, so nothing happened; and `inline: 'center'`
   * would yank a perfectly visible tab to the middle for no reason. This
   * scrolls by exactly the shortfall, and only when there is one.
   */
  const revealSelected = useCallback(() => {
    const el = node.current;
    if (!el) return;
    const selected = el.querySelector<HTMLElement>('[aria-current="page"], [aria-selected="true"]');
    if (!selected) return;
    // Clear the fade itself, not just the edge, or the item arrives legible
    // but greyed.
    const pad = el.scrollWidth > el.clientWidth + 2 ? 32 : 0;
    const strip = el.getBoundingClientRect();
    const item = selected.getBoundingClientRect();
    if (item.right > strip.right - pad) el.scrollLeft += item.right - (strip.right - pad);
    else if (item.left < strip.left + pad) el.scrollLeft -= strip.left + pad - item.left;
  }, []);

  // Re-measure when the contents change, not only when the box does: adding a
  // tab does not necessarily resize the strip.
  useEffect(() => {
    measure();
    revealSelected();
    measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure, revealSelected, ...deps]);

  useEffect(() => () => observer.current?.disconnect(), []);

  return { ref, edges, onScroll: measure };
}
