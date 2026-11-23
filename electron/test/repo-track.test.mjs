// Tests for the trigger that records a repository's start point at the agent's first change.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRecordStore } from "../repo-records.mjs";
import { createRepoTracker, defaultNearestDir, editPaths } from "../repo-track.mjs";

// Absolute fixture paths per platform (on Windows path.resolve adds a drive letter); rel values stay forward-slash.
const REPO = path.resolve("/w/repo");
const NONE = path.resolve("/w/none");
const at = (dir, name) => path.join(dir, name);
const ABS = at(REPO, "a.txt");

test("editPaths: the captured shapes", () => {
  assert.deepEqual(editPaths({ kind: "edit", status: "pending", content: [], rawInput: "*** Update File: repo/a.txt" }), []);
  assert.deepEqual(editPaths({ kind: "edit", locations: [{ path: ABS }], content: [] }), [ABS]);
  assert.deepEqual(editPaths({ status: "completed", content: [{ type: "diff", path: ABS, oldText: "a", newText: "b" }] }), [ABS]);
  assert.deepEqual(editPaths({ kind: "read", locations: [{ path: ABS }] }), []);
  assert.deepEqual(editPaths({ kind: "execute", rawInput: { command: "mv a b" } }), []);
  assert.deepEqual(editPaths({ kind: "edit", locations: [{ path: ABS }], content: [{ type: "diff", path: ABS }] }), [ABS]);
});

test("defaultNearestDir: the nearest folder that exists", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "repo-track-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "a"));
  assert.equal(await defaultNearestDir(path.join(dir, "a", "f.txt")), path.join(dir, "a"));
  assert.equal(await defaultNearestDir(path.join(dir, "a", "new", "deep", "f.txt")), path.join(dir, "a"));
});

const setup = (t, { folders = { [REPO]: { root: REPO, prefix: "" } }, allow = () => true, nearestDir } = {}) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "repo-track-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createRecordStore(path.join(dir, "r.json"));
  const calls = { where: 0, head: 0, status: 0 };
  let nowCalls = 0;
  const git = {
    failWhere: false,
    failNext: 0, // number of upcoming where calls that reject
    async where(d) {
      calls.where++;
      if (git.failNext > 0) {
        git.failNext--;
        throw new Error("timeout");
      }
      if (git.failWhere) throw new Error("boom");
      return folders[d] ?? null;
    },
    async head() {
      calls.head++;
      return `h${calls.head}`;
    },
    async status() {
      calls.status++;
      return [{ path: "a.txt", state: "M" }, { path: "other.txt", state: "M" }];
    },
  };
  const tracker = createRepoTracker({
    store,
    git,
    allow,
    nearestDir: nearestDir ?? (async (abs) => path.dirname(abs)),
    now: () => new Date(Date.UTC(2026, 10, 22, 10, 0, nowCalls++)),
  });
  return { store, git, calls, tracker };
};
const diffUpdate = (p) => ({ sessionUpdate: "tool_call_update", status: "completed", content: [{ type: "diff", path: p, oldText: "a", newText: "b" }] });

test("1: a completed diff without an earlier request records the root", async (t) => {
  const { store, tracker } = setup(t);
  await tracker.update("s", REPO, diffUpdate(at(REPO, "a.txt")));
  const r = store.repo("s", REPO);
  assert.equal(r.base, "h1");
  assert.equal(r.source, "auto");
  assert.equal(r.at, "2026-11-22T10:00:00.000Z");
  assert.deepEqual(r.touched, ["a.txt"]);
  assert.deepEqual(r.dirtyAtStart, ["other.txt"]);
});

test("2: a permission request with locations records the same way", async (t) => {
  const { store, tracker } = setup(t);
  await tracker.permission("s", REPO, { kind: "edit", locations: [{ path: at(REPO, "a.txt") }] });
  const r = store.repo("s", REPO);
  assert.deepEqual(r.touched, ["a.txt"]);
  assert.deepEqual(r.dirtyAtStart, ["other.txt"]);
});

test("3: a pending edit without a path, session folder outside a repository: nothing", async (t) => {
  const { store, tracker } = setup(t, { folders: {} });
  await tracker.update("s", NONE, { sessionUpdate: "tool_call", kind: "edit", status: "pending" });
  assert.deepEqual(store.session("s"), { repos: [], loose: [], opened: [] });
});

test("4: a pending execute in a repository records the session folder's root with all dirty paths", async (t) => {
  const { store, tracker } = setup(t);
  await tracker.update("s", REPO, { sessionUpdate: "tool_call", kind: "execute", status: "pending" });
  const r = store.repo("s", REPO);
  assert.deepEqual(r.dirtyAtStart, ["a.txt", "other.txt"]);
  assert.deepEqual(r.touched, []);
});

test("5: a second edit in a recorded root keeps base and at, adds the path, no new head call", async (t) => {
  const { store, calls, tracker } = setup(t);
  await tracker.update("s", REPO, diffUpdate(at(REPO, "a.txt")));
  const first = store.repo("s", REPO);
  await tracker.update("s", REPO, diffUpdate(at(REPO, "b.txt")));
  const r = store.repo("s", REPO);
  assert.equal(r.base, first.base);
  assert.equal(r.at, first.at);
  assert.deepEqual(r.touched, ["a.txt", "b.txt"]);
  assert.equal(calls.head, 1);
});

test("6: two updates for the same new root sent without awaiting give one record", async (t) => {
  const { store, calls, tracker } = setup(t);
  await Promise.all([tracker.update("s", REPO, diffUpdate(at(REPO, "a.txt"))), tracker.update("s", REPO, diffUpdate(at(REPO, "b.txt")))]);
  assert.equal(store.session("s").repos.length, 1);
  assert.equal(calls.head, 1);
  assert.deepEqual(store.repo("s", REPO).touched, ["a.txt", "b.txt"]);
});

test("7: a relative path resolves against cwd", async (t) => {
  const { store, tracker } = setup(t);
  await tracker.update("s", REPO, diffUpdate("notes.txt"));
  assert.deepEqual(store.repo("s", REPO).touched, ["notes.txt"]);
});

test("8: allow returning false means no git call and no record", async (t) => {
  const { store, calls, tracker } = setup(t, { allow: () => false });
  await tracker.update("s", REPO, diffUpdate(at(REPO, "a.txt")));
  await tracker.update("s", REPO, { sessionUpdate: "tool_call", kind: "execute" });
  assert.equal(calls.where, 0);
  assert.deepEqual(store.session("s"), { repos: [], loose: [], opened: [] });
});

test("9: a file in a folder that does not exist yet is recorded below the nearest folder", async (t) => {
  const { store, tracker } = setup(t, { nearestDir: async () => REPO });
  await tracker.update("s", REPO, diffUpdate(path.join(REPO, "new", "dir", "x.txt")));
  assert.deepEqual(store.repo("s", REPO).touched, ["new/dir/x.txt"]);
});

test("9b: the prefix of the nearest folder inside the repository is kept", async (t) => {
  const { store, tracker } = setup(t, { folders: { [at(REPO, "sub")]: { root: REPO, prefix: "sub/" } } });
  await tracker.update("s", REPO, diffUpdate(at(path.join(REPO, "sub"), "x.txt")));
  assert.deepEqual(store.repo("s", REPO).touched, ["sub/x.txt"]);
});

test("10: a file in no repository is loose, once", async (t) => {
  const { store, tracker } = setup(t, { folders: {} });
  await tracker.update("s", NONE, diffUpdate(at(NONE, "x.txt")));
  await tracker.update("s", NONE, diffUpdate(at(NONE, "x.txt")));
  assert.deepEqual(store.session("s"), { repos: [], loose: [at(NONE, "x.txt")], opened: [] });
});

test("11: git.where rejecting is reported, not thrown, and later updates still work", async (t) => {
  const { store, git, tracker } = setup(t);
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  t.after(() => {
    console.warn = original;
  });
  git.failWhere = true;
  await tracker.update("s", REPO, diffUpdate(at(REPO, "a.txt")));
  assert.deepEqual(store.session("s"), { repos: [], loose: [], opened: [] });
  assert.ok(warnings.length > 0 && warnings.every((w) => w.startsWith("[changes]")));
  git.failWhere = false;
  await tracker.update("s", REPO, diffUpdate(at(REPO, "b.txt")));
  assert.deepEqual(store.repo("s", REPO).touched, ["b.txt"]);
});

test("12: after closed, the session folder lookup runs again at the next tool_call", async (t) => {
  const { calls, tracker } = setup(t);
  const call = { sessionUpdate: "tool_call", kind: "execute" };
  await tracker.update("s", REPO, call);
  await tracker.update("s", REPO, call);
  assert.equal(calls.where, 1);
  tracker.closed("s");
  await tracker.update("s", REPO, call);
  assert.equal(calls.where, 2);
});

test("13: the triggering edit is left out of dirtyAtStart also through a symlinked folder", async (t) => {
  const LINK = path.resolve("/w/link");
  const REAL = path.resolve("/w/real");
  const { store, tracker } = setup(t, { folders: { [LINK]: { root: REAL, prefix: "" } } });
  await tracker.update("s", LINK, diffUpdate(at(LINK, "a.txt")));
  const r = store.repo("s", REAL);
  assert.deepEqual(r.touched, ["a.txt"]);
  assert.deepEqual(r.dirtyAtStart, ["other.txt"]);
});

test("14: a call with two paths in one root leaves both out of dirtyAtStart", async (t) => {
  const { store, tracker } = setup(t);
  await tracker.update("s", REPO, {
    sessionUpdate: "tool_call_update",
    content: [{ type: "diff", path: at(REPO, "a.txt") }, { type: "diff", path: at(REPO, "other.txt") }],
  });
  const r = store.repo("s", REPO);
  assert.deepEqual(r.dirtyAtStart, []);
  assert.deepEqual(r.touched, ["a.txt", "other.txt"]);
});

test("15: a failed session-folder lookup is retried at the next tool_call", async (t) => {
  const { store, git, tracker } = setup(t);
  const original = console.warn;
  console.warn = () => {};
  t.after(() => {
    console.warn = original;
  });
  const call = { sessionUpdate: "tool_call", kind: "execute" };
  git.failNext = 1;
  await tracker.update("s", REPO, call);
  assert.equal(store.repo("s", REPO), null);
  await tracker.update("s", REPO, call);
  assert.deepEqual(store.repo("s", REPO).dirtyAtStart, ["a.txt", "other.txt"]);
});

test("16: closed clears the seen paths", async (t) => {
  const { calls, tracker } = setup(t);
  await tracker.update("s", REPO, diffUpdate(at(REPO, "a.txt")));
  await tracker.update("s", REPO, diffUpdate(at(REPO, "a.txt")));
  assert.equal(calls.where, 1);
  tracker.closed("s");
  await tracker.update("s", REPO, diffUpdate(at(REPO, "a.txt")));
  assert.equal(calls.where, 2);
});

test("17: forgetSeen: a removed root returns at the next edit, not at the next tool call of any kind", async (t) => {
  const { store, tracker } = setup(t);
  await tracker.update("s", REPO, diffUpdate(at(REPO, "a.txt")));
  const first = store.repo("s", REPO);
  const call = { sessionUpdate: "tool_call", kind: "execute" };
  await tracker.update("s", REPO, call); // the session folder is looked at once
  store.removeRepo("s", REPO);
  tracker.forgetSeen("s");
  await tracker.update("s", REPO, call);
  assert.equal(store.repo("s", REPO), null, "an execute call does not record it again");
  await tracker.update("s", REPO, diffUpdate(at(REPO, "a.txt")));
  const again = store.repo("s", REPO);
  assert.ok(again, "the same edit path records it again");
  assert.notEqual(again.base, first.base);
  assert.notEqual(again.at, first.at);
});
