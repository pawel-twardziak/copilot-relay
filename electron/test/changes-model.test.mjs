// Tests for the changes browser list model in electron/renderer/changes-model.js.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const ChangesModel = createRequire(import.meta.url)("../renderer/changes-model.js");

const file = (path, extra = {}) => ({ path, state: "M", uncommitted: false, committed: false, touched: true, dirtyAtStart: false, ...extra });
const repo = (root, files) => ({ root, name: root, files });

test("abs: root and rel with the platform's separator; a loose file's path as is", () => {
  assert.equal(ChangesModel.abs("/home/u/repo", "a/b.txt", "linux"), "/home/u/repo/a/b.txt");
  assert.equal(ChangesModel.abs("/home/u/repo/", "b.txt", "linux"), "/home/u/repo/b.txt");
  assert.equal(ChangesModel.abs("C:\\Repo", "a/b.txt", "win32"), "C:\\Repo\\a\\b.txt");
  assert.equal(ChangesModel.abs("C:\\Repo\\", "b.txt", "win32"), "C:\\Repo\\b.txt");
  assert.equal(ChangesModel.abs(null, "/x/loose.txt", "linux"), "/x/loose.txt");
  assert.equal(ChangesModel.abs(null, "C:\\x\\loose.txt", "win32"), "C:\\x\\loose.txt");
});

test("key: repository file and loose file", () => {
  assert.equal(ChangesModel.key("/r", "a/b.txt"), ChangesModel.key("/r", "a/b.txt"));
  assert.notEqual(ChangesModel.key("/r", "a"), ChangesModel.key("/s", "a"));
  assert.notEqual(ChangesModel.key(null, "/r/a"), ChangesModel.key("/r", "a"));
});

test("pick: keeps a listed key, else first file, else loose, else null", () => {
  const data = { repos: [repo("/e", []), repo("/r", [file("a"), file("b")])], loose: ["/x/y"] };
  assert.equal(ChangesModel.pick(data, ChangesModel.key("/r", "b")), ChangesModel.key("/r", "b"));
  assert.equal(ChangesModel.pick(data, ChangesModel.key("/r", "gone")), ChangesModel.key("/r", "a"));
  assert.equal(ChangesModel.pick(data, null), ChangesModel.key("/r", "a"));
  assert.equal(ChangesModel.pick(data, ChangesModel.key(null, "/x/y")), ChangesModel.key(null, "/x/y"));
  const looseOnly = { repos: [repo("/e", [])], loose: ["/x/y", "/x/z"] };
  assert.equal(ChangesModel.pick(looseOnly, ChangesModel.key("/r", "a")), ChangesModel.key(null, "/x/y"));
  assert.equal(ChangesModel.pick({ repos: [], loose: [] }, "k"), null);
});

test("locate: win32 returns the spelling the list holds; otherwise rel stays as computed", () => {
  const win = { repos: [repo("c:/repo", [file("A/b.txt")])], loose: [] };
  assert.deepEqual(ChangesModel.locate(win, "C:\\Repo\\a\\B.TXT", "win32"), { root: "c:/repo", rel: "A/b.txt" });
  assert.deepEqual(ChangesModel.locate(win, "C:\\Repo\\other.txt", "win32"), { root: "c:/repo", rel: "other.txt" });
});

test("locate: a root with a trailing slash", () => {
  const data = { repos: [repo("/w/r/", [])], loose: [] };
  assert.deepEqual(ChangesModel.locate(data, "/w/r/a.txt", "linux"), { root: "/w/r/", rel: "a.txt" });
});

test("splitName", () => {
  assert.deepEqual(ChangesModel.splitName("electron/main.mjs"), { dir: "electron/", name: "main.mjs" });
  assert.deepEqual(ChangesModel.splitName("main.mjs"), { dir: "", name: "main.mjs" });
});

test("locate: inner root wins, outside is null, win32 is case and slash insensitive", () => {
  const data = { repos: [repo("/w/outer", []), repo("/w/outer/inner", [])], loose: [] };
  assert.deepEqual(ChangesModel.locate(data, "/w/outer/inner/a/b.txt", "linux"), { root: "/w/outer/inner", rel: "a/b.txt" });
  assert.deepEqual(ChangesModel.locate(data, "/w/outer/c.txt", "linux"), { root: "/w/outer", rel: "c.txt" });
  assert.equal(ChangesModel.locate(data, "/w/other/c.txt", "linux"), null);
  assert.equal(ChangesModel.locate(data, "/w/outer-x/c.txt", "linux"), null);
  assert.equal(ChangesModel.locate(data, "/W/Outer/c.txt", "linux"), null);
  const win = { repos: [repo("c:/repo", [])], loose: [] };
  assert.deepEqual(ChangesModel.locate(win, "C:\\Repo\\a\\b.txt", "win32"), { root: "c:/repo", rel: "a/b.txt" });
});

test("clampRatio: a finite number clamped to 0.2–0.8, anything else 0.5", () => {
  assert.equal(ChangesModel.clampRatio(0.1), 0.2);
  assert.equal(ChangesModel.clampRatio(0.95), 0.8);
  assert.equal(ChangesModel.clampRatio(0.3), 0.3);
  assert.equal(ChangesModel.clampRatio(NaN), 0.5);
  assert.equal(ChangesModel.clampRatio(Infinity), 0.5);
  assert.equal(ChangesModel.clampRatio("x"), 0.5);
  assert.equal(ChangesModel.clampRatio("0.3"), 0.5);
});

test("parsePrefs: the stored split, defaults for missing or broken text", () => {
  const defaults = { showFile: false, ratio: 0.5 };
  assert.deepEqual(ChangesModel.parsePrefs(null), defaults);
  assert.deepEqual(ChangesModel.parsePrefs("{"), defaults);
  assert.deepEqual(ChangesModel.parsePrefs("null"), defaults);
  assert.deepEqual(ChangesModel.parsePrefs("[1]"), defaults);
  assert.deepEqual(ChangesModel.parsePrefs('{"showFile":true,"ratio":0.3}'), { showFile: true, ratio: 0.3 });
  assert.deepEqual(ChangesModel.parsePrefs('{"showFile":"yes","ratio":2}'), { showFile: false, ratio: 0.8 });
});

test("viewFor: the stored view, the diff for a commit, the file where there is no diff", () => {
  for (const v of ["diff", "file", "both"]) {
    assert.equal(ChangesModel.viewFor(v, "change"), v);
    assert.equal(ChangesModel.viewFor(v, "nodiff"), "file");
  }
  assert.equal(ChangesModel.viewFor("file", "commit"), "diff");
  assert.equal(ChangesModel.viewFor("both", "commit"), "both");
  assert.equal(ChangesModel.viewFor("diff", "commit"), "diff");
});

test("openedShown: without the files the changes list holds, the newest 20", () => {
  const data = { repos: [repo("/r", [file("a.txt")])], loose: ["/tmp/l.txt"], opened: ["/r/a.txt", "/r/docs/b.md", "/tmp/l.txt", "/else/c.txt", "/r/A.txt"] };
  // /r/docs/b.md is under a listed root but not a changed file: it stays
  assert.deepEqual(ChangesModel.openedShown(data, "linux"), ["/r/docs/b.md", "/else/c.txt", "/r/A.txt"]);
  const win = { repos: [repo("C:\\R", [file("Sub/A.txt")])], loose: ["C:\\T\\L.txt"], opened: ["c:\\r\\sub\\a.txt", "C:\\t\\l.TXT", "C:\\R\\other.txt"] };
  assert.deepEqual(ChangesModel.openedShown(win, "win32"), ["C:\\R\\other.txt"]);
  const many = { repos: [repo("/r", [file("a.txt")])], loose: [], opened: ["/r/a.txt", ...Array.from({ length: 25 }, (_, i) => `/o/${i}.txt`)] };
  const shown = ChangesModel.openedShown(many, "linux");
  assert.equal(shown.length, 20);
  assert.equal(shown[0], "/o/0.txt"); // the hidden one does not use a place
  assert.deepEqual(ChangesModel.openedShown(null, "linux"), []);
  assert.deepEqual(ChangesModel.openedShown({ repos: [], loose: [] }, "linux"), []);
});

test("openedLabel: relative inside the session folder, else absolute", () => {
  const l = ChangesModel.openedLabel;
  assert.deepEqual(l("/w/docs/b.md", "/w", "linux"), { dir: "docs/", name: "b.md" });
  assert.deepEqual(l("/w/b.md", "/w/", "linux"), { dir: "", name: "b.md" });
  assert.deepEqual(l("/work2/a.txt", "/w", "linux"), { dir: "/work2/", name: "a.txt" });
  assert.deepEqual(l("/else/c.txt", null, "linux"), { dir: "/else/", name: "c.txt" });
  assert.deepEqual(l("C:\\W\\docs\\b.md", "c:\\w", "win32"), { dir: "docs\\", name: "b.md" });
});

test("samePath, commitLabel, keepVersion", () => {
  assert.equal(ChangesModel.samePath("/a/B", "/a/b", "linux"), false);
  assert.equal(ChangesModel.samePath("C:\\a\\B", "c:/A/b", "win32"), true);
  const c = { sha: "a1b2c3d4e5f6", subject: "fix: x", author: "Ann", date: "2026-11-22 10:00" };
  assert.deepEqual(ChangesModel.commitLabel(c), { label: "a1b2c3d fix: x", title: "Ann · 2026-11-22 10:00" });
  assert.equal(ChangesModel.keepVersion("uncommitted", []), "uncommitted");
  assert.equal(ChangesModel.keepVersion("a1b2c3d4e5f6", [c]), "a1b2c3d4e5f6");
  assert.equal(ChangesModel.keepVersion("gone", [c]), "uncommitted");
});

test("pick: an opened row is kept while it is listed, and is the last fallback", () => {
  const k = ChangesModel.key;
  assert.equal(ChangesModel.pick({ repos: [], loose: [], opened: ["/o/x.txt"] }, null, "linux"), k(null, "/o/x.txt"));
  const d = { repos: [repo("/r", [file("a.txt")])], loose: [], opened: ["/o/x.txt", "/r/a.txt"] };
  assert.equal(ChangesModel.pick(d, k(null, "/o/x.txt"), "linux"), k(null, "/o/x.txt"));
  assert.equal(ChangesModel.pick(d, k(null, "/r/a.txt"), "linux"), k("/r", "a.txt")); // hidden: it moved up
});

test("pick: the selection follows a file that moves between the two lists", () => {
  const k = ChangesModel.key;
  const up = { repos: [repo("/r", [file("z.txt"), file("a.txt")])], loose: [], opened: ["/r/a.txt"] };
  assert.equal(ChangesModel.pick(up, k(null, "/r/a.txt"), "linux"), k("/r", "a.txt"));
  const down = { repos: [], loose: [], opened: ["/o/x.txt", "/r/a.txt"] };
  assert.equal(ChangesModel.pick(down, k("/r", "a.txt"), "linux"), k(null, "/r/a.txt"));
  const win = { repos: [repo("C:\\R", [file("z.txt"), file("Sub/A.txt")])], loose: [], opened: ["c:\\r\\sub\\a.txt"] };
  assert.equal(ChangesModel.pick(win, k(null, "c:\\r\\sub\\a.txt"), "win32"), k("C:\\R", "Sub/A.txt"));
  assert.equal(ChangesModel.pick(up, k("/r", "gone.txt"), "linux"), k("/r", "z.txt"));
  assert.equal(ChangesModel.pick(up, k(null, "/nowhere"), "linux"), k("/r", "z.txt"));
});
