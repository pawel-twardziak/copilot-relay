// Tests for the changes browser's reading layer, against real throwaway git repositories.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FILE_LIMIT, checkRel, createChanges } from "../repo-changes.mjs";
import { createGit } from "../repo-git.mjs";
import { createRecordStore } from "../repo-records.mjs";
import { gitIn, isolatedRun, repoWithRemote } from "./git-helper.mjs";

const git = createGit(isolatedRun);
const SID = "s1";

function tempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "repo-changes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}
const write = (repo, rel, text) => {
  mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  writeFileSync(path.join(repo, rel), text);
};
async function commit(r, files, message) {
  for (const [rel, text] of Object.entries(files)) write(r.repo, rel, text);
  await r.git("add", "-A");
  await r.git("commit", "-m", message);
  return (await r.git("rev-parse", "HEAD")).trim();
}
const headOf = async (r) => (await r.git("rev-parse", "HEAD")).trim();
const rec = (root, extra = {}) => ({ root, source: "auto", base: null, at: "2026-01-01T00:00:00.000Z", dirtyAtStart: [], touched: [], ...extra });

function setup(t, over = {}) {
  const store = createRecordStore(path.join(tempDir(t), "records.json"));
  const changes = createChanges({ store, git: over.git ?? git, createdAt: () => null, allow: () => true, ...over.opts });
  return { store, changes };
}
const byPath = (view) => Object.fromEntries(view.files.map((f) => [f.path, f]));

test("list: committed, uncommitted and untracked files with the record's flags", async (t) => {
  const r = await repoWithRemote(t);
  const base = await headOf(r);
  await commit(r, { "b.txt": "b" }, "b");
  write(r.repo, "README.md", "edited");
  write(r.repo, "u.txt", "u");
  const { store, changes } = setup(t);
  store.addRepo(SID, rec(r.repo, { base, touched: ["b.txt"], dirtyAtStart: ["README.md"] }));
  const { repos, loose } = await changes.list(SID);
  assert.deepEqual(loose, []);
  assert.equal(repos.length, 1);
  const v = repos[0];
  assert.equal(v.name, "repo");
  assert.equal(v.error, null);
  assert.equal(v.noCommits, false);
  assert.equal(v.truncated, false);
  assert.deepEqual(v.files.map((f) => f.path), ["README.md", "b.txt", "u.txt"]);
  const f = byPath(v);
  assert.equal(f["b.txt"].uncommitted, false);
  assert.equal(f["b.txt"].committed, true);
  assert.equal(f["b.txt"].state, "A");
  assert.equal(f["b.txt"].touched, true);
  assert.equal(f["README.md"].uncommitted, true);
  assert.equal(f["README.md"].committed, false);
  assert.equal(f["README.md"].dirtyAtStart, true);
  assert.equal(f["u.txt"].state, "?");
  assert.equal(f["u.txt"].touched, false);
});

test("list: a file committed after the start and changed again is both", async (t) => {
  const r = await repoWithRemote(t);
  const base = await headOf(r);
  await commit(r, { "README.md": "one" }, "one");
  write(r.repo, "README.md", "two");
  const { store, changes } = setup(t);
  store.addRepo(SID, rec(r.repo, { base }));
  const f = byPath((await changes.list(SID)).repos[0])["README.md"];
  assert.equal(f.uncommitted, true);
  assert.equal(f.committed, true);
  assert.equal(f.state, "M");
});

test("list: a repository that is gone is isolated; the other is listed", async (t) => {
  const r = await repoWithRemote(t);
  const gone = await repoWithRemote(t, "gone");
  write(r.repo, "u.txt", "u");
  const { store, changes } = setup(t);
  store.addRepo(SID, rec(r.repo, { base: await headOf(r) }));
  store.addRepo(SID, rec(gone.repo));
  rmSync(gone.repo, { recursive: true, force: true });
  const { repos } = await changes.list(SID);
  assert.deepEqual(repos.map((v) => v.root), [r.repo, gone.repo]);
  assert.equal(repos[0].error, null);
  assert.deepEqual(repos[0].files.map((f) => f.path), ["u.txt"]);
  assert.equal(typeof repos[1].error, "string");
  assert.ok(repos[1].error);
  assert.deepEqual(repos[1].files, []);
});

test("list: a git call that times out is isolated to its repository", async (t) => {
  const a = await repoWithRemote(t, "a");
  const b = await repoWithRemote(t, "b");
  write(a.repo, "u.txt", "u");
  const slow = { ...git, status: (root) => (root === b.repo ? Promise.reject(new Error("git timed out after 10 s")) : git.status(root)) };
  const { store, changes } = setup(t, { git: slow });
  store.addRepo(SID, rec(a.repo, { base: await headOf(a) }));
  store.addRepo(SID, rec(b.repo));
  const { repos } = await changes.list(SID);
  assert.deepEqual(repos[0].files.map((f) => f.path), ["u.txt"]);
  assert.equal(repos[1].error, "git timed out after 10 s");
  assert.deepEqual(repos[1].files, []);
});

test("list: a base that no longer exists gives a note and the uncommitted files", async (t) => {
  const r = await repoWithRemote(t);
  write(r.repo, "u.txt", "u");
  const { store, changes } = setup(t);
  store.addRepo(SID, rec(r.repo, { base: "0123456789abcdef0123456789abcdef01234567" }));
  const v = (await changes.list(SID)).repos[0];
  assert.equal(v.error, null);
  assert.equal(v.note, "The start point of this session no longer exists in this repository. Only uncommitted changes are shown.");
  assert.deepEqual(v.files.map((f) => f.path), ["u.txt"]);
});

test("list: more than FILE_LIMIT files are cut and flagged", async (t) => {
  const r = await repoWithRemote(t);
  mkdirSync(path.join(r.repo, "many"));
  for (let i = 0; i <= FILE_LIMIT; i++) writeFileSync(path.join(r.repo, "many", `f${String(i).padStart(4, "0")}.txt`), "x");
  const { store, changes } = setup(t);
  store.addRepo(SID, rec(r.repo));
  const v = (await changes.list(SID)).repos[0];
  assert.equal(v.files.length, FILE_LIMIT);
  assert.equal(v.truncated, true);
});

test("list: a repository without a commit is flagged noCommits", async (t) => {
  const dir = tempDir(t);
  await gitIn(dir, ["init", "-b", "main"]);
  write(dir, "u.txt", "u");
  const { store, changes } = setup(t);
  store.addRepo(SID, rec(dir));
  const v = (await changes.list(SID)).repos[0];
  assert.equal(v.noCommits, true);
  assert.equal(v.error, null);
  assert.deepEqual(v.files.map((f) => f.path), ["u.txt"]);
});

test("commits and diff: an unrecorded root and a bad rel reject", async (t) => {
  const r = await repoWithRemote(t);
  const { store, changes } = setup(t);
  await assert.rejects(changes.commits(SID, r.repo, "README.md"), /not listed for this session/);
  await assert.rejects(changes.diff(SID, r.repo, "README.md", "uncommitted"), /not listed for this session/);
  await assert.rejects(changes.remove(SID, r.repo), /not listed for this session/);
  store.addRepo(SID, rec(r.repo));
  for (const bad of ["../x", "/etc/passwd", "", "a/../../x"]) {
    await assert.rejects(changes.commits(SID, r.repo, bad), /Invalid path/);
    await assert.rejects(changes.diff(SID, r.repo, bad, "uncommitted"), /Invalid path/);
  }
  assert.equal(checkRel("a/b.txt"), "a/b.txt");
});

test("diff: a sha outside the file's commits is unknown; one inside gives its text", async (t) => {
  const r = await repoWithRemote(t);
  const base = await headOf(r);
  const sha = await commit(r, { "a.txt": "alpha\n" }, "a");
  const other = await commit(r, { "b.txt": "beta\n" }, "b");
  const { store, changes } = setup(t);
  store.addRepo(SID, rec(r.repo, { base }));
  assert.deepEqual((await changes.commits(SID, r.repo, "a.txt")).map((c) => c.sha), [sha]);
  await assert.rejects(changes.diff(SID, r.repo, "a.txt", other), /Unknown version/);
  await assert.rejects(changes.diff(SID, r.repo, "a.txt", "nonsense"), /Unknown version/);
  const res = await changes.diff(SID, r.repo, "a.txt", sha);
  assert.match(res.text, /\+alpha/);
  write(r.repo, "a.txt", "alpha2\n");
  assert.match((await changes.diff(SID, r.repo, "a.txt", "uncommitted")).text, /\+alpha2/);
});

test("diff: too large passes through; uncommitted without a commit is added", async (t) => {
  const r = await repoWithRemote(t);
  const big = { ...git, diffUncommitted: async () => ({ text: "", tooLarge: true }) };
  const s1 = setup(t, { git: big });
  s1.store.addRepo(SID, rec(r.repo));
  assert.deepEqual(await s1.changes.diff(SID, r.repo, "README.md", "uncommitted"), { tooLarge: true });

  const dir = tempDir(t);
  await gitIn(dir, ["init", "-b", "main"]);
  write(dir, "n.txt", "n");
  const s2 = setup(t);
  s2.store.addRepo(SID, rec(dir));
  assert.deepEqual(await s2.changes.diff(SID, dir, "n.txt", "uncommitted"), { added: true });
});

test("add: base from createdAt, current HEAD, duplicates, no repository, network folders", async (t) => {
  const repo = tempDir(t);
  await gitIn(repo, ["init", "-b", "main"]);
  const at = async (date, file) => {
    write(repo, file, file);
    await gitIn(repo, ["add", "."]);
    await gitIn(repo, ["commit", "-m", file], { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date });
    return (await gitIn(repo, ["rev-parse", "HEAD"])).trim();
  };
  const first = await at("2026-01-10T10:00:00Z", "one.txt");
  const second = await at("2026-01-20T10:00:00Z", "two.txt");
  const sub = path.join(repo, "sub");
  mkdirSync(sub);
  const root = realpathSync.native(repo);

  let created = "2026-01-15T00:00:00.000Z";
  const { store, changes } = setup(t, { opts: { createdAt: () => created, now: () => new Date("2026-02-01T00:00:00Z") } });
  assert.deepEqual(await changes.add(SID, sub), { root });
  const r1 = store.repo(SID, root);
  assert.equal(r1.base, first);
  assert.equal(r1.source, "manual");
  assert.equal(r1.at, "2026-02-01T00:00:00.000Z");
  assert.deepEqual([r1.dirtyAtStart, r1.touched], [[], []]);
  const dup = await changes.add(SID, repo);
  assert.match(dup.message, /is already listed\.$/);
  assert.equal(store.session(SID).repos.length, 1);

  created = null;
  assert.deepEqual(await changes.add("s2", repo), { root });
  assert.equal(store.repo("s2", root).base, second);

  const none = tempDir(t);
  assert.equal((await changes.add(SID, none)).message, `${none} is not inside a git repository.`);
  const missing = path.join(none, "missing");
  assert.equal((await changes.add(SID, missing)).message, `${missing} is not inside a git repository.`);

  let calls = 0;
  const spy = { where: () => (calls++, null), head: () => (calls++, null), headAt: () => (calls++, null) };
  const denied = setup(t, { git: spy, opts: { allow: async () => false } });
  assert.deepEqual(await denied.changes.add(SID, repo), { message: "Network folders are not read." });
  assert.equal(calls, 0);
});

test("remove: drops the record; list no longer has it", async (t) => {
  const r = await repoWithRemote(t);
  const { store, changes } = setup(t);
  store.addRepo(SID, rec(r.repo));
  assert.equal((await changes.list(SID)).repos.length, 1);
  await changes.remove(SID, r.repo);
  assert.equal(store.repo(SID, r.repo), null);
  assert.deepEqual((await changes.list(SID)).repos, []);
});

const MADE_UP = "0123456789abcdef0123456789abcdef01234567";

test("commits and diff: a base that no longer exists gives no commits and Unknown version", async (t) => {
  const r = await repoWithRemote(t);
  write(r.repo, "README.md", "edited");
  const { store, changes } = setup(t);
  store.addRepo(SID, rec(r.repo, { base: MADE_UP }));
  assert.deepEqual(await changes.commits(SID, r.repo, "README.md"), []);
  assert.match((await changes.diff(SID, r.repo, "README.md", "uncommitted")).text, /\+edited/);
  await assert.rejects(changes.diff(SID, r.repo, "README.md", MADE_UP), /Unknown version/);
});

test("list: unreadable commits keep the uncommitted files and give a note", async (t) => {
  const a = await repoWithRemote(t, "a");
  const b = await repoWithRemote(t, "b");
  write(b.repo, "u.txt", "u");
  const broken = { ...git, commitFiles: (root, base) => (root === b.repo ? Promise.reject(new Error("boom")) : git.commitFiles(root, base)) };
  const { store, changes } = setup(t, { git: broken });
  store.addRepo(SID, rec(a.repo, { base: await headOf(a) }));
  store.addRepo(SID, rec(b.repo, { base: await headOf(b) }));
  const { repos } = await changes.list(SID);
  assert.equal(repos[0].note, null);
  assert.equal(repos[1].error, null);
  assert.equal(repos[1].note, "The commits since the start point could not be read: boom");
  assert.deepEqual(repos[1].files.map((f) => f.path), ["u.txt"]);
});

test("list: the state is the status state when uncommitted, else the commit state", async (t) => {
  const r = await repoWithRemote(t);
  const base = await headOf(r);
  await commit(r, { "added.txt": "a", "edited.txt": "e" }, "add");
  write(r.repo, "edited.txt", "e2");
  const { store, changes } = setup(t);
  store.addRepo(SID, rec(r.repo, { base, at: "2026-03-04T00:00:00.000Z" }));
  store.addLoose(SID, "/tmp/loose.txt");
  const { repos, loose } = await changes.list(SID);
  const f = byPath(repos[0]);
  assert.equal(f["added.txt"].state, "A");
  assert.equal(f["edited.txt"].state, "M");
  assert.equal(repos[0].source, "auto");
  assert.equal(repos[0].at, "2026-03-04T00:00:00.000Z");
  assert.deepEqual(loose, ["/tmp/loose.txt"]);
});

test("checkRel: Windows and odd paths are rejected", () => {
  for (const bad of ["C:\\x", "..\\x", "a\0b", undefined, 5, null]) assert.throws(() => checkRel(bad), /Invalid path/);
});

test("add: a bad folder is refused before any call; git's real error is not hidden", async (t) => {
  let calls = 0;
  const spy = { where: () => (calls++, null), head: () => (calls++, null), headAt: () => (calls++, null) };
  const guarded = setup(t, { git: spy, opts: { allow: () => (calls++, true) } });
  for (const bad of [undefined, "", "rel/dir"]) await assert.rejects(guarded.changes.add(SID, bad), /Invalid folder/);
  assert.equal(calls, 0);

  const dubious = Object.assign(new Error("fatal: detected dubious ownership"), { code: "EGIT" });
  const failing = setup(t, { git: { ...spy, where: () => Promise.reject(dubious) } });
  await assert.rejects(failing.changes.add(SID, path.resolve("x")), /dubious ownership/);
});

test("add: a listed root is detected before the start point is read", async (t) => {
  const r = await repoWithRemote(t);
  let reads = 0;
  const counting = { ...git, head: (root) => (reads++, git.head(root)), headAt: (...a) => (reads++, git.headAt(...a)) };
  const { store, changes } = setup(t, { git: counting });
  store.addRepo(SID, rec(realpathSync.native(r.repo)));
  const res = await changes.add(SID, r.repo);
  assert.equal(res.message, "repo is already listed.");
  assert.equal(reads, 0);
});

test("list: the session's opened files, as stored", async (t) => {
  const { store, changes } = setup(t);
  store.addOpened(SID, "/x/a.txt");
  assert.deepEqual((await changes.list(SID)).opened, ["/x/a.txt"]);
});
