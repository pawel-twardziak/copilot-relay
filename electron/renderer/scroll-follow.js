// Whether the chat log follows streamed output (no DOM).
// Loaded as a classic <script> (sets globalThis.ScrollFollow) and via require() in tests.
"use strict";

/** How close to the bottom (px) scrolling down has to come to follow the output again. */
const NEAR_BOTTOM = 80;

/** Following after a scroll event of the log, from where it was (prevTop) to where it is now.
 *  The app itself only ever scrolls the log down to the bottom, so a move up is you: it stops following at once,
 *  however small (a wheel notch, a touchpad), as re-checking "near the bottom" on every streamed chunk would
 *  pull you back. A move up that ends at the very bottom is output that shrank, not you. */
function followAfterScroll(follow, prevTop, { top, height, client }) {
  if (!client) return follow; // hidden log: nothing to measure
  const dist = height - top - client;
  if (top < prevTop - 1 && dist > 1) return false;
  if (dist < NEAR_BOTTOM) return true;
  return follow;
}

const ScrollFollow = { NEAR_BOTTOM, followAfterScroll };
globalThis.ScrollFollow = ScrollFollow;
if (typeof module !== "undefined") module.exports = ScrollFollow;
