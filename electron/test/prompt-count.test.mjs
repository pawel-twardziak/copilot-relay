// Tests for the per-session overlapping prompt counter.
import assert from "node:assert/strict";
import { test } from "node:test";
import { beginPrompt, endPrompt } from "../prompt-count.mjs";

test("beginPrompt counts, true only for the first", () => {
  const e = {};
  assert.equal(beginPrompt(e), true);
  assert.equal(e.prompting, 1);
  assert.equal(beginPrompt(e), false);
  assert.equal(e.prompting, 2);
});

test("endPrompt is true only when the last prompt ends", () => {
  const e = { prompting: 2 };
  assert.equal(endPrompt(e), false);
  assert.equal(e.prompting, 1);
  assert.equal(endPrompt(e), true);
  assert.equal(e.prompting, 0);
});

test("endPrompt never goes below zero", () => {
  const e = { prompting: 0 };
  assert.equal(endPrompt(e), false);
  assert.equal(e.prompting, 0);
});
