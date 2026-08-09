/**
 * Visual follow — the Reading area's playback auto-scroll (page-turn style):
 * the sentence list stays still while the currently playing sentence is fully
 * visible inside the list viewport, and scrolls it to the viewport top
 * otherwise. This module is the pure geometry decision — given the scroll
 * viewport and the playing card rects ({top, bottom} in viewport coordinates,
 * as getBoundingClientRect returns), return the action the DOM binding must
 * perform:
 *
 * - 'stay' — nothing to do: the card is fully visible, or (being taller than
 *   the viewport) its top has reached the viewport top and it counts as
 *   settled. Without the settled clause, a card taller than the viewport can
 *   never be "fully visible", so every state change would re-scroll forever.
 * - 'scroll-top-smooth' — the card is below the viewport: page-turn to the
 *   top (forward, animated).
 * - 'jump-top-instant' — the card is above the viewport (loop wrap, upward
 *   retargeting): jump to the top immediately.
 */

/** Absorb subpixel rounding after a scroll lands (px). */
const SETTLED_EPSILON = 1;

export function computeFollowAction(viewportRect, cardRect) {
  const vpTop = viewportRect.top;
  const vpBottom = viewportRect.bottom;
  const cardTop = cardRect.top;
  const cardBottom = cardRect.bottom;

  const fullyVisible = cardTop >= vpTop && cardBottom <= vpBottom;
  if (fullyVisible) return 'stay';

  const tallerThanViewport = cardBottom - cardTop > vpBottom - vpTop;
  if (tallerThanViewport && Math.abs(cardTop - vpTop) <= SETTLED_EPSILON) {
    return 'stay';
  }

  return cardTop < vpTop ? 'jump-top-instant' : 'scroll-top-smooth';
}
