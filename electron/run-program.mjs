// Runs an external program with a timeout and returns its (capped) output. Main process only, no electron import.
import { spawn } from "node:child_process";
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

export function runProgram(program, args, { cwd, env, timeoutMs, shell = false, label } = {}) {
  const name = label ?? defaultLabel(program, args);
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer;
    const cap = (s) => (s.length > CAP ? s.slice(-CAP) : s);
    const spawnFailed = (e) => fail(e.code === "ENOENT" ? notFound(program) : e.message, e.code ?? "SPAWN", stdout, stderr);
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
    child.stdout.setEncoding("utf8").on("data", (d) => { stdout = cap(stdout + d); });
    child.stderr.setEncoding("utf8").on("data", (d) => { stderr = cap(stderr + d); });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(spawnFailed(e));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (!isWin) killTree(child, "SIGKILL"); // sweep stragglers in the group
      if (timedOut) return reject(fail(`${name} did not finish in ${timeoutMs / 1000} s`, "TIMEOUT", stdout, stderr));
      if (code === 0) return resolve({ stdout, stderr });
      const tail = (stderr.trim() ? stderr : stdout).slice(-400).trim();
      reject(fail(`${name} failed (exit ${code ?? signal}): ${tail}`, "EXIT", stdout, stderr));
    });
    if (timeoutMs != null) {
      timer = setTimeout(() => { timedOut = true; killTree(child, "SIGKILL"); }, timeoutMs);
    }
  });
}
