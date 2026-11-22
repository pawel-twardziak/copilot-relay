// Tests for bringing the broker repository to the latest main, against real throwaway git repositories.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { GIT_ENV, describeUpdate, updateRepo } from "../broker-git.mjs";
import { runProgram } from "../run-program.mjs";
import { isolatedEnv, isolatedRun, repoWithRemote } from "./git-helper.mjs";

const now = () => new Date("2026-11-22T12:00:00.000Z");
const message = "copilot-sessions restart 2026-11-22T12:00:00.000Z";
const run = isolatedRun;
const update = (repo) => updateRepo({ repo, run, now });
const dirty = (repo) => {
  writeFileSync(path.join(repo, "README.md"), "edited");
  writeFileSync(path.join(repo, "untracked.txt"), "u");
};

test("on main with local changes: stashed, then pulled", async (t) => {
  const r = await repoWithRemote(t);
  const head = await r.upstream("new.txt", "x");
  dirty(r.repo);
  const out = await update(r.repo);
  assert.deepEqual(out.stash, { branch: "main", message });
  assert.equal(out.after, head);
  assert.notEqual(out.before, out.after);
  assert.equal((await r.git("status", "--porcelain")).trim(), "");
  assert.match(await r.git("stash", "list"), /copilot-sessions restart 2026-11-22T12:00:00\.000Z/);
});

test("on main, behind, clean: pulled without a stash", async (t) => {
  const r = await repoWithRemote(t);
  const head = await r.upstream("new.txt", "x");
  const out = await update(r.repo);
  assert.equal(out.stash, null);
  assert.equal(out.after, head);
});

test("on main, up to date: nothing changes", async (t) => {
  const r = await repoWithRemote(t);
  const out = await update(r.repo);
  assert.equal(out.before, out.after);
  assert.equal(out.stash, null);
});

test("on a branch, clean: ends on main, pulled", async (t) => {
  const r = await repoWithRemote(t);
  const head = await r.upstream("new.txt", "x");
  await r.git("checkout", "-b", "feature");
  const out = await update(r.repo);
  assert.equal((await r.git("rev-parse", "--abbrev-ref", "HEAD")).trim(), "main");
  assert.equal(out.after, head);
  assert.equal(out.stash, null);
});

test("on a branch with changes: stashed from that branch, ends on main, clean", async (t) => {
  const r = await repoWithRemote(t);
  await r.git("checkout", "-b", "feature");
  dirty(r.repo);
  const out = await update(r.repo);
  assert.deepEqual(out.stash, { branch: "feature", message });
  assert.equal((await r.git("rev-parse", "--abbrev-ref", "HEAD")).trim(), "main");
  assert.equal((await r.git("status", "--porcelain")).trim(), "");
});

test("detached HEAD: ends on main, pulled", async (t) => {
  const r = await repoWithRemote(t);
  const head = await r.upstream("new.txt", "x");
  await r.git("checkout", "--detach");
  const out = await update(r.repo);
  assert.equal((await r.git("rev-parse", "--abbrev-ref", "HEAD")).trim(), "main");
  assert.equal(out.after, head);
});

async function diverge(r) {
  await r.upstream("up.txt", "x");
  writeFileSync(path.join(r.repo, "local.txt"), "l");
  await r.git("add", ".");
  await r.git("commit", "-m", "local");
  return (await r.git("rev-parse", "HEAD")).trim();
}

test("diverged main: rejects, HEAD unchanged, no stash recorded", async (t) => {
  const r = await repoWithRemote(t);
  const local = await diverge(r);
  await assert.rejects(update(r.repo), (e) => {
    assert.match(e.message, /git pull failed/);
    assert.equal(e.stash, undefined);
    return true;
  });
  assert.equal((await r.git("rev-parse", "HEAD")).trim(), local);
});

test("diverged main with a dirty work tree: rejects and reports the stash", async (t) => {
  const r = await repoWithRemote(t);
  await diverge(r);
  dirty(r.repo);
  await assert.rejects(update(r.repo), (e) => {
    assert.deepEqual(e.stash, { branch: "main", message });
    return true;
  });
  assert.equal((await r.git("stash", "list")).trim().split("\n").length, 1);
});

test("the stash works on a machine with no git identity at all", async (t) => {
  const r = await repoWithRemote(t);
  await r.upstream("new.txt", "x");
  dirty(r.repo);
  const empty = mkdtempSync(path.join(r.tmp, "home-"));
  const noIdentity = (program, args, opts = {}) => isolatedRun(program, args, { ...opts, env: { ...opts.env,
    HOME: empty, USERPROFILE: empty, XDG_CONFIG_HOME: empty, GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(empty, "none"), EMAIL: "",
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.useConfigOnly", GIT_CONFIG_VALUE_0: "true" } });
  const out = await updateRepo({ repo: r.repo, run: noIdentity, now });
  assert.deepEqual(out.stash, { branch: "main", message });
  assert.equal((await r.git("status", "--porcelain")).trim(), "");
  assert.equal((await r.git("stash", "list")).trim().split("\n").length, 1);
  assert.equal((await r.git("log", "-1", "--format=%an <%ae>", "refs/stash")).trim(), "Copilot Sessions <copilot-sessions@localhost>");
});

test("a repo folder with spaces and non-ASCII characters", async (t) => {
  const r = await repoWithRemote(t, "re po ż");
  const head = await r.upstream("new.txt", "x");
  const out = await update(r.repo);
  assert.equal(out.after, head);
});

test("every git call has the repo as cwd, no prompts and the timeout", async (t) => {
  const r = await repoWithRemote(t);
  const calls = [];
  const fake = async (program, args, opts) => {
    calls.push({ program, args, opts });
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "feature\n", stderr: "" };
    if (args[0] === "rev-parse") return { stdout: "abc1234\n", stderr: "" };
    if (args[0] === "status") return { stdout: " M a\n", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  await updateRepo({ repo: r.repo, run: fake, now });
  assert.deepEqual(calls.map((c) => c.args.filter((a) => !a.startsWith("user.") && a !== "-c").slice(0, 2).join(" ")), [
    "rev-parse --abbrev-ref", "rev-parse --short", "status --porcelain", "stash push", "checkout main", "pull --ff-only", "rev-parse --short",
  ]);
  assert.deepEqual(calls[2].args, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  assert.deepEqual(calls[3].args, ["-c", "user.name=Copilot Sessions", "-c", "user.email=copilot-sessions@localhost",
    "stash", "push", "--include-untracked", "-m", message]);
  assert.deepEqual(calls[5].args, ["pull", "--ff-only", "origin", "main"]);
  for (const c of calls.filter((_, i) => i !== 3)) assert.ok(!c.args.includes("-c"));
  for (const c of calls) {
    assert.equal(c.program, "git");
    assert.equal(c.opts.cwd, r.repo);
    assert.equal(c.opts.env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(c.opts.env.GCM_INTERACTIVE, "never");
    assert.equal(c.opts.timeoutMs, 60_000);
  }
  assert.deepEqual(GIT_ENV, { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" });
});

test("only an untracked nested worktree: nothing is stashed and nothing is claimed", async (t) => {
  const r = await repoWithRemote(t);
  await r.git("worktree", "add", "nested/wt", "-b", "side");
  const head = await r.upstream("new.txt", "x");
  const out = await update(r.repo);
  assert.equal(out.stash, null);
  assert.equal(out.after, head);
  assert.equal((await r.git("stash", "list")).trim(), "");
  assert.doesNotMatch(describeUpdate(out), /stashed/);
});

test("an ordinary untracked folder is stashed", async (t) => {
  const r = await repoWithRemote(t);
  mkdirSync(path.join(r.repo, "notes"));
  writeFileSync(path.join(r.repo, "notes", "a.txt"), "n");
  const out = await update(r.repo);
  assert.deepEqual(out.stash, { branch: "main", message });
  assert.equal(existsSync(path.join(r.repo, "notes")), false);
  assert.match(await r.git("ls-tree", "-r", "--name-only", "refs/stash^3"), /notes\/a\.txt/);
});

test("an untracked file with a space and a non-ASCII letter alone triggers the stash", async (t) => {
  const r = await repoWithRemote(t);
  writeFileSync(path.join(r.repo, "mój plik.txt"), "u");
  const out = await update(r.repo);
  assert.deepEqual(out.stash, { branch: "main", message });
  assert.equal(existsSync(path.join(r.repo, "mój plik.txt")), false);
});

test("describeUpdate", () => {
  assert.equal(describeUpdate({ before: "abc1234", after: "abc1234", stash: null }), "already up to date (abc1234)");
  assert.equal(describeUpdate({ before: "abc1234", after: "def5678", stash: null }), "abc1234 → def5678");
  assert.equal(describeUpdate({ before: "abc1234", after: "def5678", stash: { branch: "feature", message } }),
    "abc1234 → def5678; changes stashed from feature");
});

test("a failed stash is reported as git stash", async (t) => {
  const r = await repoWithRemote(t);
  dirty(r.repo);
  const failStash = (program, args, opts) => args.includes("stash")
    ? isolatedRun(process.execPath, ["-e", "process.exit(1)"], opts)
    : isolatedRun(program, args, opts);
  await assert.rejects(updateRepo({ repo: r.repo, run: failStash, now }), /^Error: git stash failed/);
});

test("the stash call is labelled git stash", async () => {
  let label;
  const fake = async (program, args, opts) => {
    if (args[0] === "status") return { stdout: " M a\n", stderr: "" };
    if (args.includes("stash")) { label = opts.label; throw new Error("stop"); }
    return { stdout: "x\n", stderr: "" };
  };
  await assert.rejects(updateRepo({ repo: "unused", run: fake, now }), /stop/);
  assert.equal(label, "git stash");
});

test("an inherited GIT_DIR does not redirect git away from the temp repo", async (t) => {
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(os.tmpdir(), "no-such-git-dir-xyz");
  t.after(() => { if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved; });
  const r = await repoWithRemote(t);
  const head = await r.upstream("new.txt", "x");
  dirty(r.repo);
  const out = await update(r.repo);
  assert.equal(out.after, head);
  assert.equal((await r.git("status", "--porcelain")).trim(), "");
});

test("the stash leaves an untracked nested linked worktree and its uncommitted work alone", async (t) => {
  const r = await repoWithRemote(t);
  const wt = path.join(r.repo, "nested", "wt");
  await r.git("worktree", "add", "nested/wt", "-b", "side");
  writeFileSync(path.join(wt, "README.md"), "wt edit");
  writeFileSync(path.join(wt, "wt-untracked.txt"), "wt u");
  writeFileSync(path.join(r.repo, "README.md"), "main edit");
  const head = await r.upstream("new.txt", "x");
  const out = await update(r.repo);
  const wtStatus = (await runProgram("git", ["-C", wt, "status", "--porcelain"], { cwd: r.tmp, env: isolatedEnv() })).stdout;
  assert.equal(out.after, head);
  assert.equal(readFileSync(path.join(wt, "README.md"), "utf8"), "wt edit");
  assert.equal(readFileSync(path.join(wt, "wt-untracked.txt"), "utf8"), "wt u");
  assert.match(wtStatus, /README\.md/);
  assert.match(wtStatus, /wt-untracked\.txt/);
  assert.equal(out.stash.branch, "main");
  // The nested worktree is not part of the stash: only the main work tree's tracked change is, and `nested/` stays untracked.
  assert.match(await r.git("stash", "show", "--include-untracked", "--stat"), /README\.md \|/);
  assert.doesNotMatch(await r.git("stash", "show", "--include-untracked", "--stat"), /nested|wt-untracked/);
  assert.equal((await r.git("status", "--porcelain")).trim(), "?? nested/");
});
