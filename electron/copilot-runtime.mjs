// Copilot SDK clients over the user's own Copilot command. The command runs through the system shell in headless TCP
// mode (`--headless --port 0`); the port it prints is where an SDK client connects, keyed by command. A process is
// started on first use, replaced if it died, and stopped after it has been idle for a while. No session options live
// here: callers only use account-level calls (`client.rpc.account.getQuota({})`).
import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID as nodeRandomUUID } from "node:crypto";
import os from "node:os";
import { shellLine } from "./copilot-command.mjs";
import { killTree as nodeKillTree } from "./job-runner.mjs";

const TAIL_MAX = 4000;
const PORT_RE = /listening on port (\d+)/i;

export function createCopilotRuntime({
  spawn = nodeSpawn,
  loadSdk = () => import("@microsoft/copilot-sdk"),
  killTree = nodeKillTree,
  platform = process.platform,
  homedir = os.homedir,
  randomUUID = nodeRandomUUID,
  now = Date.now,
  setTimeout: setTimer = globalThis.setTimeout,
  clearTimeout: clearTimer = globalThis.clearTimeout,
  idleMs = 300_000,
  portDeadlineMs = 20_000,
  startDeadlineMs = 10_000,
  failureHoldMs = 60_000,
  killGraceMs = 3_000,
} = {}) {
  const isWin = platform === "win32";
  const entries = new Map();
  let sdkPromise = null;
  let stopping = 0; // stopAll() calls in progress: no start while any runs

  const timer = (fn, ms) => {
    const t = setTimer(fn, ms);
    t?.unref?.();
    return t;
  };
  const sdk = () => {
    sdkPromise ??= Promise.resolve().then(loadSdk).catch((e) => { sdkPromise = null; throw e; });
    return sdkPromise;
  };

  // Ends the process tree: Windows once without a signal, POSIX SIGTERM and SIGKILL after the grace. Resolves when
  // the process has exited, or at the latest killGraceMs + 500 ms after the call.
  function terminate(entry) {
    if (entry.terminating) return entry.terminating;
    entry.terminating = new Promise((resolve) => {
      if (entry.exited) return resolve();
      let killTimer = null;
      let capTimer = null;
      const done = () => { clearTimer(killTimer); clearTimer(capTimer); resolve(); };
      entry.exitedPromise.then(done);
      capTimer = timer(done, killGraceMs + 500);
      try { killTree(entry.proc, isWin ? undefined : "SIGTERM"); } catch { /* already gone */ }
      if (!isWin) {
        killTimer = timer(() => {
          if (!entry.exited) { try { killTree(entry.proc, "SIGKILL"); } catch { /* already gone */ } }
        }, killGraceMs);
      }
    });
    return entry.terminating;
  }

  // Stops an entry: drops it, then client.stop() (raced against the grace unless `quick`) and the process tree.
  async function stop(entry, { quick = false } = {}) {
    clearTimer(entry.idleTimer);
    entry.idleTimer = null;
    if (entries.get(entry.command) === entry) entries.delete(entry.command);
    if (entry.client && entry.started) {
      let graceTimer;
      const stopping = Promise.resolve().then(() => entry.client.stop()).catch(() => {});
      if (quick) { /* do not wait: only the process tree stops the CLI */ }
      else {
        await Promise.race([stopping, new Promise((r) => { graceTimer = timer(r, killGraceMs); })]);
        clearTimer(graceTimer);
      }
    }
    await terminate(entry);
  }

  function begin(command) {
    const token = randomUUID();
    const entry = {
      command, proc: null, client: null, started: false, inFlight: 0, idleTimer: null, failedAt: null, error: null,
      exited: false, exitedPromise: null, terminating: null, stderrTail: "", starting: null,
    };
    entries.set(command, entry);

    entry.starting = new Promise((resolve, reject) => {
      let settled = false;
      let portTimer = null;
      let startTimer = null;
      const fail = (detail) => {
        if (settled) return;
        settled = true;
        clearTimer(portTimer);
        clearTimer(startTimer);
        const tail = entry.stderrTail.trim();
        entry.error = new Error(`Could not start "${command}": ${detail}${tail ? `\n${tail}` : ""}`);
        entry.failedAt = now();
        if (entry.proc && !entry.exited) terminate(entry);
        reject(entry.error);
      };

      let proc;
      try {
        const line = shellLine(command, ["--headless", "--no-auto-update", "--port", "0"], { platform });
        proc = spawn(line, {
          shell: true, detached: !isWin, windowsHide: true, cwd: homedir(),
          env: { ...process.env, COPILOT_CONNECTION_TOKEN: token },
        });
      } catch (e) {
        entry.exitedPromise = Promise.resolve();
        entry.exited = true;
        return fail(e?.message ?? String(e));
      }
      entry.proc = proc;
      entry.exitedPromise = new Promise((r) => { entry.markExited = r; });
      const sdkLoading = sdk();
      sdkLoading.catch(() => {}); // reported through fail() once the port is known

      proc.stderr?.on("data", (b) => { entry.stderrTail = (entry.stderrTail + b.toString()).slice(-TAIL_MAX); });
      let out = "";
      proc.stdout?.on("data", (b) => {
        if (settled || entry.port != null) return; // stays drained after the port line
        out = (out + b.toString()).slice(-TAIL_MAX);
        const m = PORT_RE.exec(out);
        if (!m) return;
        entry.port = Number(m[1]);
        clearTimer(portTimer);
        connect(entry.port);
      });
      proc.on("error", (e) => {
        if (proc.pid == null) { entry.exited = true; entry.markExited(); }
        fail(e.message);
      });
      proc.on("exit", (code, signal) => {
        entry.exited = true;
        entry.markExited();
        clearTimer(portTimer);
        clearTimer(startTimer);
        if (!isWin) { try { killTree(proc, "SIGKILL"); } catch { /* group already gone */ } } // sweep the group
        if (!settled) {
          fail(`the process ended before it printed its port (${signal ? `signal ${signal}` : `exit code ${code}`})`);
        } else if (entry.failedAt == null && entries.get(command) === entry) {
          entries.delete(command);
          clearTimer(entry.idleTimer);
        }
      });
      portTimer = timer(() => fail(`no "listening on port" line within ${portDeadlineMs / 1000} s`), portDeadlineMs);

      async function connect(port) {
        try {
          const { CopilotClient, RuntimeConnection } = await sdkLoading;
          if (settled) return;
          const runtime = RuntimeConnection.forTcp("127.0.0.1", port, { connectionToken: token });
          const client = new CopilotClient({ mode: "coding-agent", runtime });
          entry.client = client;
          startTimer = timer(() => fail(`the client did not connect within ${startDeadlineMs / 1000} s`), startDeadlineMs);
          await client.start();
          if (settled) return;
          clearTimer(startTimer);
          entry.started = true;
          settled = true;
          resolve(client);
        } catch (e) {
          fail(e?.message ?? String(e));
        }
      }
    });
    entry.starting.catch(() => {});
    return entry;
  }

  function armIdle(entry) {
    clearTimer(entry.idleTimer);
    entry.idleTimer = timer(() => {
      entry.idleTimer = null;
      if (entry.inFlight === 0) stop(entry).catch(() => {});
    }, idleMs);
  }

  async function withClient({ command }, fn) {
    if (stopping > 0) throw new Error("Copilot is stopping");
    let entry = entries.get(command);
    if (entry?.failedAt != null) {
      if (now() - entry.failedAt < failureHoldMs) throw entry.error;
      entries.delete(command);
      entry = undefined;
    }
    entry ??= begin(command);
    entry.inFlight++;
    clearTimer(entry.idleTimer);
    entry.idleTimer = null;
    try {
      const client = await entry.starting;
      return await fn(client);
    } finally {
      entry.inFlight--;
      if (entry.inFlight === 0 && entry.started && !entry.exited && entries.get(command) === entry) armIdle(entry);
    }
  }

  async function stopAll() {
    const all = [...entries.values()];
    stopping++;
    try {
      await Promise.all(all.map((e) => stop(e, { quick: true }).catch(() => {})));
    } finally {
      stopping--;
    }
  }

  return {
    withClient,
    stopAll,
    size: () => [...entries.values()].filter((e) => e.failedAt == null).length,
  };
}
