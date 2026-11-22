// Tests for bringing the broker repository to the latest main, against real throwaway git repositories.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { GIT_ENV, describeUpdate, updateRepo } from "../broker-git.mjs";
import { runProgram } from "../run-program.mjs";
import { repoWithRemote } from "./git-helper.mjs";

const now = () => new Date("2026-11-22T12:00:00.000Z");
const message = "copilot-sessions restart 2026-11-22T12:00:00.000Z";
// A stash is a commit, so it needs an identity that does not depend on the machine's git config.
const identity = { GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
const run = (program, args, opts = {}) => runProgram(program, args, { ...opts, env: { ...opts.env, ...identity } });
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
  assert.deepEqual(calls.map((c) => c.args.slice(0, 2).join(" ")), [
    "rev-parse --abbrev-ref", "rev-parse --short", "status --porcelain", "stash push", "checkout main", "pull --ff-only", "rev-parse --short",
  ]);
  assert.deepEqual(calls[3].args, ["stash", "push", "--include-untracked", "-m", message]);
  assert.deepEqual(calls[5].args, ["pull", "--ff-only", "origin", "main"]);
  for (const c of calls) {
    assert.equal(c.program, "git");
    assert.equal(c.opts.cwd, r.repo);
    assert.equal(c.opts.env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(c.opts.env.GCM_INTERACTIVE, "never");
    assert.equal(c.opts.timeoutMs, 60_000);
  }
  assert.deepEqual(GIT_ENV, { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" });
});

test("describeUpdate", () => {
  assert.equal(describeUpdate({ before: "abc1234", after: "abc1234", stash: null }), "already up to date (abc1234)");
  assert.equal(describeUpdate({ before: "abc1234", after: "def5678", stash: null }), "abc1234 → def5678");
  assert.equal(describeUpdate({ before: "abc1234", after: "def5678", stash: { branch: "feature", message } }),
    "abc1234 → def5678; changes stashed from feature");
});
