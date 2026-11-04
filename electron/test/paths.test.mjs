// Tests for the folder-scope check that decides which local images load without a click (electron/paths.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { isInside, lexicalPath } from "../paths.mjs";

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

test("lexicalPath resolves without touching the disk", () => {
  assert.equal(lexicalPath("a.png", "/p/a", "/home/u", "linux"), "/p/a/a.png");
  assert.equal(lexicalPath("../b.png", "/p/a", "/home/u", "linux"), "/p/b.png");
  assert.equal(lexicalPath("~/x.png", "/p/a", "/home/u", "linux"), "/home/u/x.png");
  assert.equal(lexicalPath("file:///p/a/my%20shot.png", "/p/a", "/home/u", "linux"), "/p/a/my shot.png");
  assert.equal(lexicalPath("sub/my%20shot.png", "/p/a", "/home/u", "linux"), "/p/a/sub/my shot.png");
  assert.equal(lexicalPath("Z:\\x.png", "C:\\p", "C:\\Users\\u", "win32"), "Z:\\x.png");
});

test("lexicalPath gives up on network and odd inputs", () => {
  assert.equal(lexicalPath("//server/x.png", "/p/a", "/home/u", "linux"), null);
  assert.equal(lexicalPath("file://server/x.png", "/p/a", "/home/u", "linux"), null);
  assert.equal(lexicalPath("https://x/y.png", "/p/a", "/home/u", "linux"), null);
  assert.equal(lexicalPath("", "/p/a", "/home/u", "linux"), null);
});

test("a mapped drive or automount path is outside before any file access", () => {
  assert.equal(isInside(lexicalPath("/net/host/x.png", "/p/a", "/home/u", "linux"), "/p/a", "linux"), false);
  assert.equal(isInside(lexicalPath("Z:\\x.png", "C:\\p", "C:\\Users\\u", "win32"), "C:\\p", "win32"), false);
});
