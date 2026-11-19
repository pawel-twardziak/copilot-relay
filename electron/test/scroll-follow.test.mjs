// Tests for following streamed output in the chat log (electron/renderer/scroll-follow.js).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const SF = createRequire(import.meta.url)("../renderer/scroll-follow.js");

// a log 1000px high in a 400px window: the bottom is at scrollTop 600
const at = (top, height = 1000, client = 400) => ({ top, height, client });

test("scrolling up a little stops following, even within the near-bottom margin", () => {
  // one Linux wheel notch (~53px), and a touchpad's few pixels: both closer to the bottom than 80px
  assert.equal(SF.followAfterScroll(true, 600, at(547)), false);
  assert.equal(SF.followAfterScroll(true, 600, at(595)), false);
});

test("stays off while scrolling further up or growing output moves the bottom away", () => {
  assert.equal(SF.followAfterScroll(false, 547, at(494)), false);
  assert.equal(SF.followAfterScroll(false, 547, at(547, 1200)), false);
});

test("scrolling back down near the bottom follows again", () => {
  assert.equal(SF.followAfterScroll(false, 400, at(560)), true);
  assert.equal(SF.followAfterScroll(false, 400, at(600)), true);
});

test("scrolling down but still far from the bottom does not follow yet", () => {
  assert.equal(SF.followAfterScroll(false, 100, at(300)), false);
});

test("following the output to the bottom keeps following", () => {
  assert.equal(SF.followAfterScroll(true, 600, at(800, 1200)), true);
});

test("output that shrinks and clamps the scroll position to the bottom keeps following", () => {
  // a re-render or a collapsed block: the browser lowers scrollTop, but the view is still at the bottom
  assert.equal(SF.followAfterScroll(true, 600, at(500, 900)), true);
});

test("a hidden log (no size) does not change following", () => {
  assert.equal(SF.followAfterScroll(true, 600, at(0, 0, 0)), true);
  assert.equal(SF.followAfterScroll(false, 400, at(0, 0, 0)), false);
});
