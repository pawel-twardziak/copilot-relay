// Tests for electron/renderer/find-text.js (the matcher shared by the find bar and the content-search worker).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const { findMatches, makeSnippet, pickTarget } = createRequire(import.meta.url)("../renderer/find-text.js");

test("findMatches basic", () => {
  assert.deepEqual(findMatches("Cache keeper and cache", "CACHE"), [{ start: 0, end: 5 }, { start: 17, end: 22 }]);
});

test("whitespace collapsed", () => {
  assert.deepEqual(findMatches("a\n\n  b", "a b"), [{ start: 0, end: 6 }]);
  assert.deepEqual(findMatches("a  b", "  "), []);
});

test("literal special characters", () => {
  assert.deepEqual(findMatches("x (a+ <b> $& y", "(a+ <b> $&"), [{ start: 2, end: 12 }]);
});

test("length-changing case fold keeps offsets", () => {
  assert.deepEqual(findMatches("İİ ab", "AB"), [{ start: 3, end: 5 }]);
});

test("Polish letters", () => {
  assert.deepEqual(findMatches("Łódź", "łÓDŹ"), [{ start: 0, end: 4 }]);
});

test("makeSnippet cuts at whitespace", () => {
  const text = Array.from({ length: 40 }, (_, i) => `w${i}\n`).join("").slice(0, 200);
  const start = 100;
  const s = makeSnippet(text, start, start + 3);
  assert.ok(s.before.length <= 41);
  assert.ok(s.before.startsWith("…"));
  assert.equal(s.match, text.slice(start, start + 3).replace(/\n/g, " "));
  assert.ok(!/\n/.test(s.before + s.match + s.after));
  assert.ok(s.after.endsWith("…"));
});

test("makeSnippet at the text edges has no ellipsis", () => {
  assert.deepEqual(makeSnippet("hello world", 0, 5), { before: "", match: "hello", after: " world" });
});

test("pickTarget ignores the cut marks on one side", () => {
  const view = [{ before: "xabcdefghij klmnopqrstuvwxyz0123 ", after: "tail" }];
  assert.deepEqual(pickTarget(view, { k: 0, before: "…abcdefghij klmnopqrstuvwxyz0123 ", after: "tail" }), { index: 0, exact: true });
  const view2 = [{ before: "b", after: " abcdefghij klmnopqrstuvwxyz0123x" }];
  assert.deepEqual(pickTarget(view2, { k: 0, before: "b", after: " abcdefghij klmnopqrstuvwxyz0123…" }), { index: 0, exact: true });
});

test("pickTarget", () => {
  const snips = [{ before: "aaa", after: "xxx" }, { before: "bbb", after: "yyy" }, { before: "ccc", after: "zzz" }];
  // exact agreement wins over a closer k
  assert.deepEqual(pickTarget(snips, { k: 0, before: "bbb", after: "yyy" }), { index: 1, exact: true });
  // ties broken by distance to k
  const dup = [{ before: "a", after: "b" }, { before: "q", after: "r" }, { before: "a", after: "b" }];
  assert.deepEqual(pickTarget(dup, { k: 2, before: "a", after: "b" }), { index: 2, exact: true });
  assert.deepEqual(pickTarget(dup, { k: 0, before: "a", after: "b" }), { index: 0, exact: true });
  // no agreement
  assert.deepEqual(pickTarget(snips, { k: 7, before: "nope", after: "nope" }), { index: 2, exact: false });
  assert.deepEqual(pickTarget([], { k: 0, before: "", after: "" }), { index: -1, exact: false });
});

test("foldText is the folded form findMatches searches", () => {
  const { foldText } = createRequire(import.meta.url)("../renderer/find-text.js");
  assert.equal(foldText("A\n\n B"), "a b");
  assert.equal(foldText(" X"), " x");
  assert.equal(findMatches("A\n\n B", foldText("a b")).length, 1);
});

test("pickTarget compares raw Markdown with its rendered text", () => {
  const raw = "To run the suite use `npm test` in the **electron** folder, then check `scripts/ui-check/run.mjs` for the rest of it.";
  const rendered = "To run the suite use npm test in the electron folder, then check scripts/ui-check/run.mjs for the rest of it.";
  const other = "Something else entirely about the electron folder and a different neighbour sentence that goes on.";
  for (const word of ["suite", "electron", "folder"]) {
    const at = raw.indexOf(word);
    const wanted = { k: 0, ...makeSnippet(raw, at, at + word.length) };
    const at2 = rendered.indexOf(word);
    const view = [makeSnippet(other, other.indexOf(word) === -1 ? 0 : other.indexOf(word), (other.indexOf(word) === -1 ? 0 : other.indexOf(word)) + word.length), makeSnippet(rendered, at2, at2 + word.length)];
    assert.deepEqual(pickTarget(view, wanted), { index: 1, exact: true }, word);
  }
  // a list item under a heading and a link
  const rawList = "## Steps\n\n- first install the [docs](https://example.com/x) and then we look at needle which appears here in a list";
  const renList = "Steps first install the docs and then we look at needle which appears here in a list";
  const a = rawList.indexOf("needle");
  const b = renList.indexOf("needle");
  assert.deepEqual(pickTarget([makeSnippet(renList, b, b + 6)], { k: 0, ...makeSnippet(rawList, a, a + 6) }), { index: 0, exact: true });
  // a genuinely different neighbour text is still not exact
  const diff = "completely unrelated words before needle and unrelated words after it";
  const c = diff.indexOf("needle");
  assert.equal(pickTarget([makeSnippet(diff, c, c + 6)], { k: 0, ...makeSnippet(rawList, a, a + 6) }).exact, false);
});
