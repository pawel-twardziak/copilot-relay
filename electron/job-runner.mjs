// Runs one scheduled script: spawn, capped output, timeout/abort with tree kill, result file.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RESULT_CAP, TAIL_SLACK } from "./jobs.mjs";

const KEEP = RESULT_CAP + TAIL_SLACK;
const KILL_GRACE_MS = 3000;
const EXIT_GRACE_MS = 1000;

// Keeps the last KEEP bytes of a stream: drops whole chunks from the front while the rest still holds KEEP bytes.
function tailCollector() {
  let chunks = [];
  let total = 0;
  let truncated = false;
  return {
    push(buf) {
      chunks.push(buf);
      total += buf.length;
      while (chunks.length > 1 && total - chunks[0].length >= KEEP) {
        total -= chunks.shift().length;
        truncated = true;
      }
    },
    result() {
      let buf = Buffer.concat(chunks);
      if (buf.length > KEEP) {
        buf = buf.subarray(buf.length - KEEP);
        truncated = true;
      }
      return { text: buf.toString("utf8"), truncated };
    },
  };
}

function readResult(file) {
  try {
    const size = fs.statSync(file).size;
    if (size === 0) return { text: null, truncated: false };
    const len = Math.min(size, KEEP);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, "r");
    try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
    return { text: buf.toString("utf8"), truncated: size > KEEP };
  } catch {
    return { text: null, truncated: false };
  }
}

const isWin = process.platform === "win32";

// POSIX signals the process group. Windows has no groups: taskkill walks the tree from the leader, and only while the
// leader is alive (its PID could be reused afterwards). `sync` waits for taskkill, for when the app is quitting.
function killTree(child, signal, sync = false) {
  if (child.pid == null) return;
  try {
    if (isWin) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const args = ["/pid", String(child.pid), "/T", "/F"];
      if (sync) spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true, timeout: 5000 });
      else spawn("taskkill", args, { stdio: "ignore", windowsHide: true }).on("error", () => {});
    } else {
      process.kill(-child.pid, signal);
    }
  } catch { /* already gone */ }
}

export function startRun({ command, cwd, env, timeoutMs, jobName, runId }) {
  const empty = { stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false,
    resultText: null, resultTruncated: false, durationMs: 0 };
  const failed = (error) => ({ abort() {}, done: Promise.resolve({ reason: "exit", exitCode: null, error, ...empty }) });

  let isDir = false;
  try { isDir = fs.statSync(cwd).isDirectory(); } catch { /* missing */ }
  if (!isDir) return failed(`Folder does not exist: ${cwd}`);

  let dir = null;
  let resultFile;
  const cleanup = () => {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
  };
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-sessions-job-"));
    fs.chmodSync(dir, 0o700);
    resultFile = path.join(dir, "result");
    fs.writeFileSync(resultFile, "", { mode: 0o600 });
  } catch (e) {
    cleanup();
    return failed(e.message);
  }

  const out = tailCollector();
  const err = tailCollector();
  let reason = "exit";
  let spawnError = null;
  let killTimer = null;
  let timeoutTimer = null;
  let closed = false;
  let graceTimer = null;
  let swept = false;

  const started = Date.now();
  let child;
  try {
    child = spawn(command, {
      shell: true, cwd, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ...env, JOB_RESULT: resultFile, JOB_NAME: jobName, JOB_RUN_ID: runId },
    });
  } catch (e) {
    cleanup();
    return failed(e.message);
  }

  const done = new Promise((resolve) => {
    let settled = false;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      closed = true;
      clearTimeout(timeoutTimer);
      clearTimeout(graceTimer);
      if (!swept) clearTimeout(killTimer); // a sweep's SIGKILL timer stays armed (unref'd)
      let result;
      try {
        if (reason !== "exit" && !isWin) killTree(child, "SIGKILL"); // sweep stragglers in the group
        const o = out.result();
        const e = err.result();
        const r = readResult(resultFile);
        result = {
          reason, exitCode: spawnError ? null : exitCode, error: spawnError,
          stdout: o.text, stderr: e.text, stdoutTruncated: o.truncated, stderrTruncated: e.truncated,
          resultText: r.text, resultTruncated: r.truncated, durationMs: Date.now() - started,
        };
      } catch (e) {
        result = { reason, exitCode: null, error: e.message, ...empty, durationMs: Date.now() - started };
      }
      cleanup();
      resolve(result);
    };
    child.stdout.on("data", (b) => out.push(b));
    child.stderr.on("data", (b) => err.push(b));
    child.on("error", (e) => {
      spawnError = e.message;
      if (child.pid == null) finish(null); // never started: no close event follows
    });
    child.on("exit", () => {
      if (reason !== "exit" || settled) return;
      clearTimeout(timeoutTimer);
      // A background process may keep the pipes open; give it a moment, then end everything it started.
      graceTimer = setTimeout(() => {
        if (!isWin) {
          swept = true;
          killTree(child, "SIGTERM");
          killTimer = setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS);
          killTimer.unref();
        }
        child.stdout.destroy();
        child.stderr.destroy();
      }, EXIT_GRACE_MS);
      graceTimer.unref();
    });
    child.on("close", (code) => finish(code));
  });

  const kill = (why) => {
    if (closed || reason !== "exit") return; // first of abort/timeout wins
    reason = why;
    killTree(child, "SIGTERM"); // on Windows this is already taskkill /F
    if (isWin) return;
    killTimer = setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS);
    killTimer.unref();
  };
  // The app is quitting: no timer would outlive it, so kill everything now and remove the run's folder.
  const forceKill = () => {
    if (closed) return;
    if (reason === "exit") reason = "aborted";
    clearTimeout(timeoutTimer);
    killTree(child, "SIGKILL", true);
    cleanup();
  };
  timeoutTimer = setTimeout(() => kill("timeout"), timeoutMs);
  timeoutTimer.unref();

  return { abort: (opts) => (opts?.force ? forceKill() : kill("aborted")), done };
}
