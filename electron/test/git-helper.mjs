// Test helper (not a test): a throwaway git repository with a bare remote, all inside one temp folder.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runProgram } from "../run-program.mjs";

const IDENTITY = ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false"];

// What keeps these tests off the surrounding repository: every git call has an explicit `cwd` inside a temp folder AND
// an environment without the variables that override repository discovery (git exports them to hooks), plus no system
// or global git config, so a user's core.hooksPath, pull.rebase or core.fsmonitor cannot change results.
const REPO_LOCATION_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_NAMESPACE", "GIT_PREFIX"];
// A global config file that does not exist (os.devNull is "\\.\nul" on Windows, unverified with Git for Windows).
const NO_GLOBAL_CONFIG = path.join(os.tmpdir(), "copilot-relay-tests-no-such-gitconfig");
export const isolatedEnv = () => {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: NO_GLOBAL_CONFIG };
  for (const v of REPO_LOCATION_VARS) delete env[v];
  return env;
};

// `runProgram` with the same isolation, for handing to `updateRepo` as `run`.
export const isolatedRun = (program, args, opts = {}) => runProgram(program, args, {
  ...opts,
  env: { ...Object.fromEntries(REPO_LOCATION_VARS.map((v) => [v, undefined])), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: NO_GLOBAL_CONFIG, ...opts.env },
});

// git in `cwd` with the test identity and the isolation above; `env` adds variables (GIT_COMMITTER_DATE, ...).
export function gitIn(cwd, args, env = {}) {
  return new Promise((resolve, reject) => {
    execFile("git", [...IDENTITY, ...args], { cwd, env: { ...isolatedEnv(), ...env }, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(" ")} failed: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

// A bare remote and a clone of it on `main` with one pushed commit. The folder is removed after the test.
export async function repoWithRemote(t, name = "repo") {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "broker-git-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const remote = path.join(tmp, "remote.git");
  const repo = path.join(tmp, name);
  mkdirSync(remote);
  mkdirSync(repo);
  await gitIn(remote, ["init", "--bare", "-b", "main"]);
  await gitIn(repo, ["init", "-b", "main"]);
  await gitIn(repo, ["remote", "add", "origin", remote]);
  writeFileSync(path.join(repo, "README.md"), "hello");
  await gitIn(repo, ["add", "."]);
  await gitIn(repo, ["commit", "-m", "first"]);
  await gitIn(repo, ["push", "-u", "origin", "main"]);

  const git = (...args) => gitIn(repo, args);
  // Pushes one more commit to main through a second clone and returns its short hash.
  const upstream = async (file, text) => {
    const other = mkdtempSync(path.join(tmp, "other-"));
    await gitIn(other, ["clone", remote, "."]);
    writeFileSync(path.join(other, file), text);
    await gitIn(other, ["add", "."]);
    await gitIn(other, ["commit", "-m", `add ${file}`]);
    await gitIn(other, ["push", "origin", "main"]);
    return (await gitIn(other, ["rev-parse", "--short", "HEAD"])).trim();
  };
  return { tmp, repo, git, upstream };
}
