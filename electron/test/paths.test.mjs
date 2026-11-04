// Tests for the folder-scope check that decides which local images load without a click (electron/paths.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { isInside } from "../paths.mjs";

test("descendant is inside", () => {
  assert.equal(isInside("/p/a/b.png", "/p/a", "linux"), true);
  assert.equal(isInside("/p/a/x/y/b.png", "/p/a/", "linux"), true);
  assert.equal(isInside("/p/a", "/p/a", "linux"), true);
});

test("sibling prefix is not inside", () => {
  assert.equal(isInside("/p/ab/x.png", "/p/a", "linux"), false);
  assert.equal(isInside("/p/a/../b.png", "/p/a", "linux"), false);
  assert.equal(isInside("/p/b.png", "/p/a", "linux"), false);
});

test("win32 compare is case-insensitive", () => {
  assert.equal(isInside("C:\\users\\a b\\x.png", "C:\\Users\\A B", "win32"), true);
  assert.equal(isInside("D:\\Users\\A B\\x.png", "C:\\Users\\A B", "win32"), false);
  assert.equal(isInside("/P/A/x.png", "/p/a", "linux"), false); // case matters elsewhere
});

test("isInside uses the real path given, not the text", () => {
  assert.equal(isInside("/etc/x.png", "/p/a", "linux"), false);
  assert.equal(isInside("", "/p/a", "linux"), false);
  assert.equal(isInside("/p/a/x.png", "", "linux"), false);
});
