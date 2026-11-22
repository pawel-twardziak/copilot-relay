// Tests for the read-only git calls of the changes browser, against real throwaway git repositories.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DIFF_LIMIT, createGit } from "../repo-git.mjs";
import { gitIn, isolatedRun, repoWithRemote } from "./git-helper.mjs";

const git = createGit(isolatedRun);
const posixOnly = { skip: process.platform === "win32" && "needs a shell script or a symlink" };

function tempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "repo-git-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}
const write = (repo, rel, text) => {
  mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  writeFileSync(path.join(repo, rel), text);
};
// Writes the files and commits them; returns the full hash.
async function commit(r, files, message) {
  for (const [rel, text] of Object.entries(files)) write(r.repo, rel, text);
  await r.git("add", "-A");
  await r.git("commit", "-m", message);
  return (await r.git("rev-parse", "HEAD")).trim();
}
const headOf = async (r) => (await r.git("rev-parse", "HEAD")).trim();

test("where: root and prefix of a nested folder; null outside a repository", async (t) => {
  const r = await repoWithRemote(t);
  const nested = path.join(r.repo, "sub", "deep");
  mkdirSync(nested, { recursive: true });
  const real = realpathSync.native(r.repo);
  assert.deepEqual(await git.where(nested), { root: real, prefix: "sub/deep/" });
  assert.deepEqual(await git.where(r.repo), { root: real, prefix: "" });
  assert.equal(await git.where(tempDir(t)), null);
});

test("where: through a symlinked folder", posixOnly, async (t) => {
  const r = await repoWithRemote(t);
  mkdirSync(path.join(r.repo, "sub", "deep"), { recursive: true });
  const link = path.join(r.tmp, "link");
  symlinkSync(r.repo, link);
  assert.deepEqual(await git.where(path.join(link, "sub", "deep")), { root: realpathSync(r.repo), prefix: "sub/deep/" });
});

test("head: the commit; null without a commit", async (t) => {
  const r = await repoWithRemote(t);
  assert.equal(await git.head(r.repo), await headOf(r));
  const empty = tempDir(t);
  await gitIn(empty, ["init", "-b", "main"]);
  assert.equal(await git.head(empty), null);
});

test("status: modified, staged new, deleted and untracked files", async (t) => {
  const r = await repoWithRemote(t);
  await commit(r, { "gone.txt": "g" }, "add gone");
  write(r.repo, "README.md", "edited");
  write(r.repo, "new.txt", "n");
  await r.git("add", "new.txt");
  unlinkSync(path.join(r.repo, "gone.txt"));
  write(r.repo, "dir/u.txt", "u");
  const files = (await git.status(r.repo)).sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(files, [
    { path: "dir/u.txt", state: "?" }, { path: "gone.txt", state: "D" }, { path: "new.txt", state: "A" }, { path: "README.md", state: "M" },
  ]);
});

test("commitFiles: the files of the commits after base; all of history for null; a missing base is NOBASE", async (t) => {
  const r = await repoWithRemote(t);
  const base = await headOf(r);
  await commit(r, { "README.md": "changed", "x.txt": "x" }, "change");
  await commit(r, { "README.md": "hello" }, "change back");
  const paths = (files) => files.map((f) => f.path).sort();
  assert.deepEqual(paths(await git.commitFiles(r.repo, base)), ["README.md", "x.txt"]);
  assert.deepEqual(await git.commitFiles(r.repo, base), [{ path: "README.md", state: "M" }, { path: "x.txt", state: "A" }]);
  await commit(r, { "y.txt": "y" }, "y");
  assert.deepEqual(paths(await git.commitFiles(r.repo, null)), ["README.md", "x.txt", "y.txt"]);
  await assert.rejects(git.commitFiles(r.repo, "0123456789abcdef0123456789abcdef01234567"), (e) => e.code === "NOBASE");
  const empty = tempDir(t);
  await gitIn(empty, ["init", "-b", "main"]);
  assert.deepEqual(await git.commitFiles(empty, null), []);
  assert.deepEqual(await git.commitFiles(empty, base), []);
});

test("fileCommits: the commits after base that touched the file, newest first", async (t) => {
  const r = await repoWithRemote(t);
  const base = await commit(r, { "a.txt": "0" }, "a before");
  const first = await commit(r, { "a.txt": "1" }, "a one");
  await commit(r, { "b.txt": "b" }, "b only");
  const third = await commit(r, { "a.txt": "3" }, "a three");
  const list = await git.fileCommits(r.repo, base, "a.txt");
  assert.deepEqual(list.map(({ sha, subject, author }) => ({ sha, subject, author })), [
    { sha: third, subject: "a three", author: "test" }, { sha: first, subject: "a one", author: "test" },
  ]);
  for (const c of list) assert.ok(!Number.isNaN(Date.parse(c.date)), c.date);
  assert.deepEqual((await git.fileCommits(r.repo, null, "a.txt")).map((c) => c.subject), ["a three", "a one", "a before"]);
  await assert.rejects(git.fileCommits(r.repo, "0123456789abcdef0123456789abcdef01234567", "a.txt"), (e) => e.code === "NOBASE");
});

test("diffUncommitted: staged and unstaged changes of the file against HEAD", async (t) => {
  const r = await repoWithRemote(t);
  write(r.repo, "README.md", "edited");
  const { text, tooLarge } = await git.diffUncommitted(r.repo, "README.md");
  assert.equal(tooLarge, false);
  assert.match(text, /^-hello$/m);
  assert.match(text, /^\+edited$/m);
  write(r.repo, "README.md", "staged\nline");
  await r.git("add", "README.md");
  write(r.repo, "README.md", "staged\nline\nunstaged");
  const both = (await git.diffUncommitted(r.repo, "README.md")).text;
  assert.match(both, /^\+staged$/m);
  assert.match(both, /^\+unstaged$/m);
});

test("diffCommit: that commit's change of that file only; a merge gives an ordinary diff", async (t) => {
  const r = await repoWithRemote(t);
  const sha = await commit(r, { "a.txt": "a", "b.txt": "b" }, "two files");
  const { text, tooLarge } = await git.diffCommit(r.repo, sha, "a.txt");
  assert.equal(tooLarge, false);
  assert.match(text, /^diff --git a\/a\.txt b\/a\.txt$/m);
  assert.match(text, /^\+a$/m);
  assert.doesNotMatch(text, /b\.txt/);

  await r.git("checkout", "-b", "side");
  await commit(r, { "README.md": "side" }, "side");
  await r.git("checkout", "main");
  await commit(r, { "README.md": "main" }, "main");
  await assert.rejects(r.git("merge", "side")); // a conflict in README.md
  write(r.repo, "README.md", "resolved");
  await r.git("add", "README.md");
  await r.git("commit", "--no-edit");
  const merge = await git.diffCommit(r.repo, await headOf(r), "README.md");
  assert.ok(merge.text.startsWith("diff --git "), merge.text);
  assert.match(merge.text, /^-main$/m);
  assert.match(merge.text, /^\+resolved$/m);
});

test("a path with pathspec characters is a plain name", async (t) => {
  const r = await repoWithRemote(t);
  const base = await headOf(r);
  const own = await commit(r, { "app/[id]/page.tsx": "own" }, "own page");
  await commit(r, { "app/i/page.tsx": "sibling" }, "sibling page");
  assert.deepEqual((await git.fileCommits(r.repo, base, "app/[id]/page.tsx")).map((c) => c.sha), [own]);
  write(r.repo, "app/[id]/page.tsx", "own edited");
  write(r.repo, "app/i/page.tsx", "sibling edited");
  const { text } = await git.diffUncommitted(r.repo, "app/[id]/page.tsx");
  assert.match(text, /^\+own edited$/m);
  assert.doesNotMatch(text, /sibling|app\/i\//);
});

test("headAt: where HEAD was at a time; before the first commit the first", async (t) => {
  const repo = tempDir(t);
  await gitIn(repo, ["init", "-b", "main"]);
  const at = async (date, file) => {
    writeFileSync(path.join(repo, file), file);
    await gitIn(repo, ["add", "."]);
    await gitIn(repo, ["commit", "-m", file], { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date });
    return (await gitIn(repo, ["rev-parse", "HEAD"])).trim();
  };
  const first = await at("2026-01-10T10:00:00Z", "one.txt");
  const second = await at("2026-01-20T10:00:00Z", "two.txt");
  assert.equal(await git.headAt(repo, "2026-01-15T00:00:00.000Z"), first);
  assert.equal(await git.headAt(repo, "2026-01-21T00:00:00.000Z"), second);
  assert.equal(await git.headAt(repo, "2025-06-01T00:00:00.000Z"), first);
  const empty = tempDir(t);
  await gitIn(empty, ["init", "-b", "main"]);
  assert.equal(await git.headAt(empty, "2026-01-15T00:00:00.000Z"), null);
});

test("tooLarge: a diff over the limit gives no text", async (t) => {
  const r = await repoWithRemote(t);
  await commit(r, { "big.txt": "small\n" }, "big");
  write(r.repo, "big.txt", `${"x".repeat(99)}\n`.repeat(31_000));
  assert.ok(31_000 * 100 > DIFF_LIMIT);
  assert.deepEqual(await git.diffUncommitted(r.repo, "big.txt"), { text: "", tooLarge: true });
});

// A repository with history after `base`, an uncommitted change and a file rewritten with its own content.
async function busyRepo(t) {
  const r = await repoWithRemote(t);
  const base = await headOf(r);
  await commit(r, { "a.md": "a\n" }, "a");
  const last = await commit(r, { "a.md": "a2\n", "b.md": "b\n" }, "a2");
  write(r.repo, "README.md", "edited");
  write(r.repo, "b.md", "b\n");
  const later = new Date(Date.now() + 60_000);
  utimesSync(path.join(r.repo, "b.md"), later, later);
  return { r, base, last };
}
// The five calls; `diffUncommitted` also for the rewritten file (git refreshes only the entries in its pathspec).
const allFive = ({ r, base, last }) => [
  git.status(r.repo), git.commitFiles(r.repo, base), git.fileCommits(r.repo, base, "a.md"),
  git.diffUncommitted(r.repo, "README.md"), git.diffCommit(r.repo, last, "a.md"), git.diffUncommitted(r.repo, "b.md"),
];
// Every file under .git with its size and modification time.
function listing(dir, prefix = "") {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = `${prefix}${e.name}`;
    if (e.isDirectory()) return listing(path.join(dir, e.name), `${rel}/`);
    const s = statSync(path.join(dir, e.name));
    return [`${rel} ${s.size} ${s.mtimeMs}`];
  }).sort();
}

test("no writes: index, refs, stash and the .git folder stay as they were; an index.lock does not stop the calls", async (t) => {
  const w = await busyRepo(t);
  const dotGit = path.join(w.r.repo, ".git");
  const snapshot = async () => ({
    index: readFileSync(path.join(dotGit, "index")).toString("base64"),
    refs: await w.r.git("for-each-ref"),
    stash: await w.r.git("stash", "list"),
    files: listing(dotGit),
  });
  const before = await snapshot();
  await Promise.all(allFive(w));
  assert.deepEqual(await snapshot(), before);

  writeFileSync(path.join(dotGit, "index.lock"), "");
  const results = await Promise.all(allFive(w));
  assert.deepEqual(results[0], [{ path: "README.md", state: "M" }]);
  assert.match(results[3].text, /^\+edited$/m);
  assert.equal(readFileSync(path.join(dotGit, "index.lock"), "utf8"), "");
  assert.equal(readFileSync(path.join(dotGit, "index")).toString("base64"), before.index);
});

test("no programs from the repository's configuration", posixOnly, async (t) => {
  const w = await busyRepo(t);
  const marker = path.join(w.r.tmp, "marker");
  const script = path.join(w.r.tmp, "marker.sh");
  writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(script, 0o755);
  for (const [key, value] of [
    ["core.fsmonitor", script], ["diff.external", script], ["diff.marker.textconv", script],
    ["gpg.program", script], ["log.showSignature", "true"],
  ]) await w.r.git("config", key, value);
  writeFileSync(path.join(w.r.repo, ".gitattributes"), "*.md diff=marker\n");
  await Promise.all(allFive(w));
  assert.equal(existsSync(marker), false);
  await w.r.git("diff", "HEAD"); // the same configuration without the flags does run the script
  assert.equal(existsSync(marker), true);
});

// A fake `run` that records every call and answers with canned output.
function recordingRun() {
  const calls = [];
  const sub = (args) => {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-C" || args[i] === "-c") i++;
      else if (!args[i].startsWith("--")) return args[i];
    }
  };
  const out = { "rev-parse": "/r\nsub/\n", status: " M a.txt\0", log: "", diff: "", show: "" };
  const run = async (program, args, opts) => {
    calls.push({ program, args, opts });
    const name = sub(args);
    return { stdout: name === "rev-parse" && !args.includes("--show-toplevel") ? "abc\n" : out[name], stderr: "", truncated: false };
  };
  return { run, calls, sub };
}

test("every call carries the read-only flags and environment", async () => {
  const { run, calls, sub } = recordingRun();
  const g = createGit(run);
  const sha = "0123456789abcdef0123456789abcdef01234567";
  await g.where("/r/sub");
  await g.head("/r");
  await g.headAt("/r", "2026-01-15T00:00:00.000Z");
  await g.status("/r");
  await g.commitFiles("/r", sha);
  await g.commitFiles("/r", null);
  await g.fileCommits("/r", sha, "a b.txt");
  await g.diffUncommitted("/r", "a b.txt");
  await g.diffCommit("/r", sha, "a b.txt");
  assert.equal(calls.length, 9);
  const pair = (args, a, b) => args.some((x, i) => x === a && args[i + 1] === b);
  for (const { program, args, opts } of calls) {
    const name = sub(args);
    assert.equal(program, "git");
    assert.equal(args[0], "--literal-pathspecs", args.join(" "));
    for (const c of ["core.fsmonitor=false", "core.quotepath=false", "diff.autoRefreshIndex=false"]) assert.ok(pair(args, "-c", c), `${c}: ${args.join(" ")}`);
    assert.equal(opts.env.GIT_OPTIONAL_LOCKS, "0");
    assert.equal(opts.env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(opts.timeoutMs, 10_000);
    if (args.includes("--show-toplevel")) {
      assert.ok(!args.includes("-C"));
      assert.equal(opts.cwd, "/r/sub");
    } else {
      assert.ok(pair(args, "-C", "/r"), args.join(" "));
      assert.ok(args.indexOf("-C") < args.indexOf(name));
    }
    if (name === "log" || name === "show") assert.ok(args.includes("--no-show-signature"), args.join(" "));
    if (name === "diff" || name === "show" || args.includes("--name-status")) {
      for (const f of ["--no-ext-diff", "--no-textconv", "--no-color"]) assert.ok(args.includes(f), `${f}: ${args.join(" ")}`);
    }
    if (name === "show") assert.ok(args.includes("--diff-merges=first-parent"));
    if (["log", "diff", "show"].includes(name) && !args.includes("--name-status")) assert.deepEqual(args.slice(-2), ["--", "a b.txt"]);
  }
  assert.deepEqual(calls.map((c) => sub(c.args)), ["rev-parse", "rev-parse", "rev-parse", "status", "log", "log", "log", "diff", "show"]);
});

test("a list cut by the output limit loses its half entry", async () => {
  const outputs = { status: " M a.txt\0 M b.t", log: "M\0a.txt\0M\0b.t" };
  const run = async (program, args, opts) => {
    assert.equal(opts.keep, "start");
    assert.equal(opts.outputLimit, 8 * 1024 * 1024);
    return { stdout: outputs[args.includes("status") ? "status" : "log"], stderr: "", truncated: true };
  };
  const g = createGit(run);
  assert.deepEqual(await g.status("/r"), [{ path: "a.txt", state: "M" }]);
  assert.deepEqual(await g.commitFiles("/r", null), [{ path: "a.txt", state: "M" }]);
});

test("git's messages are read in English under a translated environment", async (t) => {
  const translated = (program, args, opts) => isolatedRun(program, args, { ...opts, env: { LANG: "pl_PL.UTF-8", LANGUAGE: "pl", LC_ALL: "pl_PL.UTF-8", ...opts.env } });
  const g = createGit(translated);
  assert.equal(await g.where(tempDir(t)), null);
  const r = await repoWithRemote(t);
  await assert.rejects(g.commitFiles(r.repo, "0123456789abcdef0123456789abcdef01234567"), (e) => e.code === "NOBASE");
});

test("a missing git rejects with ENOENT; a commit id that is not hex is refused", async () => {
  const g = createGit((program, args, opts) => isolatedRun("no-such-git-xyz", args, opts));
  await assert.rejects(g.status("/r"), (e) => e.code === "ENOENT");
  const never = createGit(async () => assert.fail("git must not run"));
  await assert.rejects(never.commitFiles("/r", "--output=/tmp/x"), /Not a commit id/);
  await assert.rejects(never.fileCommits("/r", "HEAD~1", "a.txt"), /Not a commit id/);
  await assert.rejects(never.diffCommit("/r", "-p", "a.txt"), /Not a commit id/);
});
