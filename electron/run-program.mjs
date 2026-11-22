// Runs an external program with a timeout and returns its (capped) output. Main process only, no electron import.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { killTree } from "./job-runner.mjs";

const isWin = process.platform === "win32";
const CAP = 64 * 1024;

function fail(message, code, stdout, stderr) {
  return Object.assign(new Error(message), { code, stdout, stderr });
}

const notFound = (program) => `${program} was not found (is it installed and on PATH?)`;

// "git pull", "node npm-cli.js": the program's base name plus its first argument (its base name when it is a path).
function defaultLabel(program, args) {
  const name = path.basename(program, path.extname(program));
  const first = args[0];
  return first == null ? name : `${name} ${/[\\/]/.test(first) ? path.basename(first) : first}`;
}

// After the program exits, how long its pipes may stay open (held by a descendant) before the result is taken as is.
const CLOSE_GRACE_MS = 1000;

export function runProgram(program, args, { cwd, env, timeoutMs, shell = false, label, outputLimit = CAP, keep = "end" } = {}) {
  const name = label ?? defaultLabel(program, args);
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timer;
    let grace;
    let settled = false;
    let truncated = false;
    const cap = (s) => (s.length > CAP ? s.slice(-CAP) : s);
    // stdout: "end" keeps the last outputLimit characters, "start" the first ones (the rest is dropped).
    const addStdout = (d) => {
      const all = stdout + d;
      if (all.length <= outputLimit) { stdout = all; return; }
      truncated = true;
      stdout = keep === "start" ? all.slice(0, outputLimit) : all.slice(-outputLimit);
    };
    const spawnFailed = (e) => {
      // Node reports a nonexistent cwd as ENOENT on the spawn too.
      if (e.code === "ENOENT" && cwd != null && !fs.existsSync(cwd)) return fail(`Folder does not exist: ${cwd}`, "NOCWD", stdout, stderr);
      return fail(e.code === "ENOENT" ? notFound(program) : e.message, e.code ?? "SPAWN", stdout, stderr);
    };
    let child;
    try {
      child = spawn(program, args, {
        cwd, shell, windowsHide: true, detached: !isWin,
        env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      reject(spawnFailed(e));
      return;
    }
    // Settles the promise once; later events (a close after the timeout, the grace after a close) change nothing.
    const settle = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      if (err) reject(err);
      else resolve(value);
    };
    const dropPipes = () => {
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const finish = (code, signal) => {
      if (settled) return;
      if (!isWin) killTree(child, "SIGKILL"); // sweep stragglers in the group
      if (code === 0) return settle(null, { stdout, stderr, truncated });
      const tail = (stderr.trim() ? stderr : stdout).slice(-400).trim();
      settle(fail(`${name} failed (exit ${code ?? signal}): ${tail}`, "EXIT", stdout, stderr));
    };
    child.stdout.setEncoding("utf8").on("data", (d) => { addStdout(d); });
    child.stderr.setEncoding("utf8").on("data", (d) => { stderr = cap(stderr + d); });
    child.on("error", (e) => settle(spawnFailed(e)));
    // A descendant that holds the pipes keeps "close" from coming: after the exit, wait for it only so long.
    child.on("exit", (code, signal) => {
      if (settled) return;
      clearTimeout(timer); // the program has finished: from here the grace bounds the wait
      grace = setTimeout(() => { dropPipes(); finish(code, signal); }, CLOSE_GRACE_MS);
    });
    child.on("close", finish);
    if (timeoutMs != null) {
      timer = setTimeout(() => {
        killTree(child, "SIGKILL");
        dropPipes();
        settle(fail(`${name} did not finish in ${timeoutMs / 1000} s`, "TIMEOUT", stdout, stderr));
      }, timeoutMs);
    }
  });
}
