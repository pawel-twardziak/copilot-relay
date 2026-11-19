// Runs one scheduled script: spawn, capped output, timeout/abort with tree kill, result file.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RESULT_CAP } from "./jobs.mjs";

const KEEP = RESULT_CAP + 4096;
const KILL_GRACE_MS = 3000;

// Keeps the last KEEP bytes of a stream, dropping whole chunks from the front.
function tailCollector() {
  let chunks = [];
  let total = 0;
  let truncated = false;
  return {
    push(buf) {
      chunks.push(buf);
      total += buf.length;
      while (total > KEEP && chunks.length > 1) {
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

function killTree(child, signal) {
  if (child.pid == null) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
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

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-sessions-job-"));
  fs.chmodSync(dir, 0o700);
  const resultFile = path.join(dir, "result");
  fs.writeFileSync(resultFile, "", { mode: 0o600 });
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });

  const out = tailCollector();
  const err = tailCollector();
  let reason = "exit";
  let spawnError = null;
  let killTimer = null;
  let timeoutTimer = null;
  let closed = false;

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
      clearTimeout(killTimer);
      if (reason !== "exit") killTree(child, "SIGKILL"); // sweep stragglers in the group
      const durationMs = Date.now() - started;
      const o = out.result();
      const e = err.result();
      const r = readResult(resultFile);
      cleanup();
      resolve({
        reason, exitCode: spawnError ? null : exitCode, error: spawnError,
        stdout: o.text, stderr: e.text, stdoutTruncated: o.truncated, stderrTruncated: e.truncated,
        resultText: r.text, resultTruncated: r.truncated, durationMs,
      });
    };
    child.stdout.on("data", (b) => out.push(b));
    child.stderr.on("data", (b) => err.push(b));
    child.on("error", (e) => {
      spawnError = e.message;
      if (child.pid == null) finish(null); // never started: no close event follows
    });
    child.on("close", (code) => finish(code));
  });

  const kill = (why) => {
    if (closed || reason !== "exit") return; // first of abort/timeout wins
    reason = why;
    killTree(child, "SIGTERM");
    killTimer = setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS);
    killTimer.unref();
  };
  timeoutTimer = setTimeout(() => kill("timeout"), timeoutMs);
  timeoutTimer.unref();

  return { abort: () => kill("aborted"), done };
}
