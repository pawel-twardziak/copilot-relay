// Tests for the pure file link and recent-list helpers in electron/renderer/file-links.js.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const FileLinks = createRequire(import.meta.url)("../renderer/file-links.js");
const {
  pathCandidates,
  splitPathSuffix,
  parseRelayHeader,
  parseRecent,
  recentAdd,
  recentRemove,
  previewLanguage,
} = FileLinks;

const one = (t, o) =>
  pathCandidates(t, o).map(({ raw, path, line }) => ({ raw, path, line }));
test("relative path with line", () =>
  assert.deepEqual(one("see src/app.js:42, ok"), [
    { raw: "src/app.js:42", path: "src/app.js", line: 42 },
  ]));
test("column and #L suffixes", () => {
  assert.equal(one("a/b.js:4:7")[0].line, 4);
  assert.equal(one("a/b.js#L42-L50")[0].line, 42);
});
test("grep output links only path and line", () =>
  assert.deepEqual(one("src/a.js:12:const x = 1")[0], {
    raw: "src/a.js:12",
    path: "src/a.js",
    line: 12,
  }));
test("urls are not candidates", () =>
  assert.deepEqual(one("https://x.dev/a.js"), []));
test("ordinary words are not candidates", () =>
  assert.deepEqual(one("build the test data"), []));
test("well-known names are case-sensitive", () => {
  assert.equal(one("Makefile").length, 1);
  assert.equal(one("makefile").length, 0);
});
test("punctuation and brackets are trimmed", () => {
  assert.equal(one("README.md.")[0].path, "README.md");
  assert.equal(one("(see ./x/y.ts)")[0].path, "./x/y.ts");
});
test("version numbers are not file names", () =>
  assert.deepEqual(one("v 1.2.3"), []));
test("home and windows paths", () => {
  assert.equal(one("~/a.txt")[0].path, "~/a.txt");
  assert.equal(one("C:\\a\\b.txt")[0].path, "C:\\a\\b.txt");
});
test("whole span keeps spaces", () =>
  assert.equal(
    one("my dir/a b.txt", { whole: true })[0].path,
    "my dir/a b.txt",
  ));
test("whole span must still look like a path", () =>
  assert.deepEqual(one("build", { whole: true }), []));
test("whole span accepts a line suffix", () =>
  assert.deepEqual(one("my dir/a b.txt:7", { whole: true }), [
    { raw: "my dir/a b.txt:7", path: "my dir/a b.txt", line: 7 },
  ]));
test("cap counts unique paths", () => {
  const text = Array.from({ length: 600 }, (_, i) => `f${i}.js`).join(" ");
  assert.equal(new Set(pathCandidates(text).map((c) => c.path)).size, 500);
});
test("repeated path keeps every occurrence", () =>
  assert.equal(one("a.js a.js").length, 2));
test("offsets locate raw in the text", () => {
  const text = "see (src/app.js:42), ok";
  const [c] = pathCandidates(text);
  assert.equal(text.slice(c.start, c.end), c.raw);
});
test("splitPathSuffix", () => {
  assert.deepEqual(splitPathSuffix("src/a.js:12:3"), {
    path: "src/a.js",
    line: 12,
  });
  assert.deepEqual(splitPathSuffix("src/a.js#L5-L9"), {
    path: "src/a.js",
    line: 5,
  });
  assert.deepEqual(splitPathSuffix("src/a.js"), {
    path: "src/a.js",
    line: null,
  });
});
test("relay header with folder", () =>
  assert.deepEqual(parseRelayHeader('[from a]\n[folder "/x]y"]\nhello'), {
    from: "a",
    folder: "/x]y",
    display: "[from a]\nhello",
  }));
test("relay header without folder", () =>
  assert.deepEqual(parseRelayHeader("[from a]\nhello"), {
    from: "a",
    folder: null,
    display: "[from a]\nhello",
  }));
test("not a relay message", () =>
  assert.deepEqual(parseRelayHeader("hello"), {
    from: null,
    folder: null,
    display: "hello",
  }));
test("corrupted recent data is empty", () => {
  for (const bad of [null, "{", "[]", '{"s":"x"}', '{"s":[1,{"path":5}]}'])
    assert.deepEqual(Object.values(parseRecent(bad)).flat(), []);
});
test("recentAdd moves to the top and caps", () => {
  let l = [];
  for (let i = 0; i < 25; i++) l = recentAdd(l, { path: `/f${i}`, line: null });
  assert.equal(l.length, 20);
  l = recentAdd(l, { path: "/f10", line: 3 });
  assert.deepEqual(l[0], { path: "/f10", line: 3 });
  assert.equal(l.filter((e) => e.path === "/f10").length, 1);
});
test("recentRemove", () =>
  assert.deepEqual(recentRemove([{ path: "/a", line: null }], "/a"), []));
test("language by name", () => {
  assert.equal(previewLanguage("a.ts"), "typescript");
  assert.equal(previewLanguage("Makefile"), "makefile");
  assert.equal(previewLanguage("a.unknownext"), null);
});

test("a long run of punctuation is trimmed in linear time", () => {
  for (const [text, want] of [[`${".".repeat(200000)}x`, 1], [".".repeat(200000), 0]]) {
    const t = Date.now();
    assert.equal(pathCandidates(text).length, want);
    assert.ok(Date.now() - t < 500, `took ${Date.now() - t} ms`);
  }
});
