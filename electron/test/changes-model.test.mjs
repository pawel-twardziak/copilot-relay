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

test("versions: with and without uncommitted", () => {
  const commits = [{ sha: "0123456789abcdef", subject: "Fix it", date: "2026-11-22", author: "Ann" }];
  assert.deepEqual(ChangesModel.versions(file("a", { uncommitted: true }), commits), [
    { id: "uncommitted", label: "Uncommitted", title: "" },
    { id: "0123456789abcdef", label: "0123456 Fix it", title: "Ann · 2026-11-22" },
  ]);
  assert.deepEqual(ChangesModel.versions(file("a"), commits).map((v) => v.id), ["0123456789abcdef"]);
  assert.deepEqual(ChangesModel.versions(file("a"), []), []);
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
