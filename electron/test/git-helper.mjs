// Test helper (not a test): a throwaway git repository with a bare remote, all inside one temp folder.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const IDENTITY = ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false"];

// Runs git in `cwd` (always explicit, so nothing here can touch the surrounding repository).
function gitIn(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile("git", [...IDENTITY, ...args], { cwd, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
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
