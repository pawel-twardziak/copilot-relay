// Tests for the per-session record store of repositories.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRecordStore, sameRoot } from "../repo-records.mjs";

const tempFile = (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "repo-records-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "sub", "records.json"); // the folder is created by the first write
};
const rec = (root, extra = {}) => ({ root, source: "auto", base: "abc123", at: "2026-11-22T10:00:00.000Z", dirtyAtStart: [], touched: [], ...extra });

test("records round-trip through the file", (t) => {
  const file = tempFile(t);
  const store = createRecordStore(file);
  assert.deepEqual(store.session("s1"), { repos: [], loose: [] });
  assert.equal(store.repo("s1", "/r"), null);
  assert.equal(store.addRepo("s1", rec("/r", { dirtyAtStart: ["a.txt"] })), true);
  store.touch("s1", "/r", "src/x.js");
  store.addLoose("s1", "/tmp/note.txt");
  const expected = { repos: [rec("/r", { dirtyAtStart: ["a.txt"], touched: ["src/x.js"] })], loose: ["/tmp/note.txt"] };
  assert.deepEqual(store.session("s1"), expected);
  assert.deepEqual(createRecordStore(file).session("s1"), expected);
  assert.deepEqual(readdirSync(path.dirname(file)), ["records.json"]); // no temp file left behind
});

test("addRepo for a recorded root changes nothing and returns false", (t) => {
  const store = createRecordStore(tempFile(t));
  assert.equal(store.addRepo("s1", rec("/r", { base: "first", at: "T1" })), true);
  assert.equal(store.addRepo("s1", rec("/r", { base: "second", at: "T2" })), false);
  assert.equal(store.repo("s1", "/r").base, "first");
  assert.equal(store.repo("s1", "/r").at, "T1");
  assert.equal(store.session("s1").repos.length, 1);
});

test("touch stores a path once; an unrecorded root changes nothing", (t) => {
  const file = tempFile(t);
  const store = createRecordStore(file);
  store.addRepo("s1", rec("/r"));
  store.touch("s1", "/r", "a.js");
  store.touch("s1", "/r", "a.js");
  assert.deepEqual(store.repo("s1", "/r").touched, ["a.js"]);
  const before = readFileSync(file, "utf8");
  store.touch("s1", "/other", "a.js");
  store.touch("nobody", "/r", "a.js");
  assert.deepEqual(store.session("nobody"), { repos: [], loose: [] });
  assert.equal(readFileSync(file, "utf8"), before);
});

test("addLoose stores a path once", (t) => {
  const store = createRecordStore(tempFile(t));
  store.addLoose("s1", "/x");
  store.addLoose("s1", "/x");
  assert.deepEqual(store.session("s1").loose, ["/x"]);
});

test("sessions are independent: removeRepo and forget touch only their own session", (t) => {
  const file = tempFile(t);
  const store = createRecordStore(file);
  store.addRepo("s1", rec("/r", { base: "one" }));
  store.addRepo("s2", rec("/r", { base: "two" }));
  store.touch("s2", "/r", "k.js");
  assert.equal(store.removeRepo("s1", "/r"), true);
  assert.equal(store.removeRepo("s1", "/r"), false);
  assert.equal(store.repo("s1", "/r"), null);
  assert.deepEqual(store.repo("s2", "/r"), rec("/r", { base: "two", touched: ["k.js"] }));
  store.addRepo("s1", rec("/r"));
  store.forget("s1");
  assert.deepEqual(store.session("s1"), { repos: [], loose: [] });
  assert.equal(store.repo("s2", "/r").base, "two");
  assert.equal(createRecordStore(file).repo("s2", "/r").base, "two");
});

test("returned data is a copy", (t) => {
  const store = createRecordStore(tempFile(t));
  store.addRepo("s1", rec("/r"));
  store.session("s1").repos[0].touched.push("evil");
  store.repo("s1", "/r").touched.push("evil");
  assert.deepEqual(store.repo("s1", "/r").touched, []);
});

test("a broken file is an empty store and the next write is valid JSON", (t) => {
  const file = tempFile(t);
  const first = createRecordStore(file);
  first.addRepo("s0", rec("/q")); // creates the folder
  writeFileSync(file, "not json");
  const store = createRecordStore(file);
  assert.deepEqual(store.session("s0"), { repos: [], loose: [] });
  assert.equal(store.addRepo("s1", rec("/r")), true);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8"))), ["s1"]);
});

test("roots are compared with sameRoot", (t) => {
  const store = createRecordStore(tempFile(t));
  store.addRepo("s1", rec("/a/b"));
  assert.equal(store.addRepo("s1", rec("/a/b/")), false);
  assert.notEqual(store.repo("s1", "/a/./b"), null);
});

test("sameRoot: win32 is case- and separator-insensitive, linux is case-sensitive", () => {
  assert.equal(sameRoot("C:\\Repo", "c:/repo/", "win32"), true);
  assert.equal(sameRoot("C:\\Repo", "c:/repo2", "win32"), false);
  assert.equal(sameRoot("/a/Repo", "/a/repo", "linux"), false);
  assert.equal(sameRoot("/a/repo", "/a/repo/", "linux"), true);
  assert.equal(sameRoot("", "/a", "linux"), false);
});
