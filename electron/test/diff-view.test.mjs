// Tests for the unified diff parser in electron/renderer/diff-view.js.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const DiffView = createRequire(import.meta.url)("../renderer/diff-view.js");

const DIFF = [
  "diff --git a/a.txt b/a.txt", "index 1..2 100644", "--- a/a.txt", "+++ b/a.txt",
  "@@ -1,3 +1,3 @@ fn()", " one", "-two", "+TWO", " three",
  "@@ -10,2 +10,3 @@", " ten", "+new", " eleven", "\\ No newline at end of file", "",
].join("\n"); // prettier-ignore

test("parse: numbers, hunks, note", () => {
  const { binary, lines } = DiffView.parse(DIFF);
  assert.equal(binary, false);
  assert.deepEqual(lines.map((l) => [l.type, l.old, l.new, l.text]), [
    ["hunk", null, null, "@@ -1,3 +1,3 @@ fn()"], ["ctx", 1, 1, "one"], ["del", 2, null, "two"], ["add", null, 2, "TWO"], ["ctx", 3, 3, "three"],
    ["hunk", null, null, "@@ -10,2 +10,3 @@"], ["ctx", 10, 10, "ten"], ["add", null, 11, "new"], ["ctx", 11, 12, "eleven"],
    ["note", null, null, "\\ No newline at end of file"],
  ]); // prettier-ignore
});

test("parse: added file, deleted file, binary, empty", () => {
  assert.deepEqual(
    DiffView.parse("diff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n@@ -0,0 +1 @@\n+hi\n").lines.map((l) => [l.type, l.new]),
    [["hunk", null], ["add", 1]],
  ); // prettier-ignore
  assert.deepEqual(
    DiffView.parse("diff --git a/g b/g\ndeleted file mode 100644\n--- a/g\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n").lines.map((l) => [l.type, l.old]),
    [["hunk", null], ["del", 1]],
  ); // prettier-ignore
  assert.equal(DiffView.parse("diff --git a/i.png b/i.png\nindex 1..2\nBinary files a/i.png and b/i.png differ\n").binary, true);
  assert.deepEqual(DiffView.parse(""), { binary: false, lines: [] });
});

test("parse: a line that starts with +++ inside a hunk is content", () => {
  const { lines } = DiffView.parse("--- a/x\n+++ b/x\n@@ -1 +1 @@\n---- old\n++++ new\n");
  assert.deepEqual(lines.slice(1).map((l) => [l.type, l.text]), [["del", "--- old"], ["add", "+++ new"]]);
});

test("parse: a second file after a hunk drops its header lines", () => {
  const { lines } = DiffView.parse(
    "@@ -1 +1 @@\n-a\n+b\ndiff --git a/y b/y\nsimilarity index 90%\nrename from y\nrename to z\n--- a/y\n+++ b/z\n@@ -1 +1 @@\n-c\n+d\n",
  );
  assert.deepEqual(lines.map((l) => l.type), ["hunk", "del", "add", "hunk", "del", "add"]);
});

test("parse: only the diff's line terminator loses its carriage return", () => {
  const { lines } = DiffView.parse("@@ -1 +1 @@\r\n-a\r\n+b\r\n");
  assert.deepEqual(lines.map((l) => l.text), ["@@ -1 +1 @@", "a", "b"]);
});

test("parse: an empty context line (blank in the diff) is context", () => {
  const { lines } = DiffView.parse("@@ -1,3 +1,3 @@\n a\n\n c\n");
  assert.deepEqual(lines.slice(1).map((l) => [l.type, l.old, l.new, l.text]), [["ctx", 1, 1, "a"], ["ctx", 2, 2, ""], ["ctx", 3, 3, "c"]]);
});

test("added", () => {
  assert.deepEqual(DiffView.added("a\nb\n").lines.map((l) => [l.type, l.new, l.text]), [["add", 1, "a"], ["add", 2, "b"]]);
  assert.deepEqual(DiffView.added(""), { binary: false, lines: [] });
});
