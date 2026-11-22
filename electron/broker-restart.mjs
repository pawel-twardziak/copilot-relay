// The "update and restart broker" run: check, update, install, stop, start, reconnect. Main process only, no electron
// import. Every outside effect comes in through `fx`, so the run is tested with fakes.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeUpdate, GIT_ENV, updateRepo } from "./broker-git.mjs";
import { runProgram } from "./run-program.mjs";

export const LIMITS = { npmMs: 300_000, installMs: 30_000, stopMs: 10_000, startMs: 15_000, reconnectMs: 20_000, healthMs: 2_000, pollMs: 200 };
export const STEP_IDS = ["check", "update", "install", "stop", "start", "reconnect"];
export const STEP_LABELS = { check: "Check", update: "Update", install: "Install", stop: "Stop", start: "Start", reconnect: "Reconnect" };

/** Same folder after resolve + realpath (when it exists), ignoring a trailing separator; case-insensitive on Windows. */
export function sameFolder(a, b, platform = process.platform) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const norm = (x) => {
    let r = p.resolve(x);
    if (platform === process.platform) {
      try { r = realpathSync(r); } catch { /* does not exist: compare as given */ }
    }
    return platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/** $COPILOT_HOME/extensions/copilot-relay/config.json; copilotHome defaults to ~/.copilot. */
export function readInstalled(copilotHome) {
  const file = path.join(copilotHome ?? path.join(os.homedir(), ".copilot"), "extensions", "copilot-relay", "config.json");
  try {
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    return { installed: true, brokerScript: cfg.brokerScript ?? null, nodePath: cfg.nodePath ?? null };
  } catch {
    return { installed: false, brokerScript: null, nodePath: null };
  }
}

/** npm for this Node: its npm-cli.js when found, else npm from PATH. */
export function npmCommand(nodeExe, { platform = process.platform, exists = existsSync } = {}) {
  const win = platform === "win32";
  const p = win ? path.win32 : path.posix;
  const dir = p.dirname(nodeExe);
  const cli = win ? p.join(dir, "node_modules", "npm", "bin", "npm-cli.js") : p.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  if (exists(cli)) return { program: nodeExe, args: [cli, "ci"], shell: false };
  return { program: "npm", args: ["ci"], shell: win };
}

export async function runRestart(input, fx, onStep = () => {}) {
  const { repo, url, copilotHome } = input ?? {};
  const steps = STEP_IDS.map((id) => ({ id, label: STEP_LABELS[id], status: "pending", detail: "" }));
  const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
  const ctx = { node: null, port: "80", noAutostart: false, update: null, stash: null, stoppedPid: null, pid: null };
  const stashNote = () => (ctx.stash ? ` Your changes from ${ctx.stash.branch} are in the stash "${ctx.stash.message}".` : "");

  // Runs one step: `fn` returns { detail, status?, warning? } or throws; a throw fails the step with its message.
  const step = async (id, fn) => {
    const s = byId[id];
    const tell = () => {
      try { onStep({ ...s }); } catch { /* a listener must not change the run */ }
    };
    s.status = "running";
    tell();
    try {
      Object.assign(s, { status: "done" }, await fn());
    } catch (err) {
      s.status = "failed";
      s.detail = err?.message ?? String(err);
    }
    tell();
    return s.status !== "failed";
  };

  const health = async () => {
    try {
      const res = await fx.fetch(`${url}/health`, { signal: AbortSignal.timeout(LIMITS.healthMs) });
      return await res.json().catch(() => ({}));
    } catch {
      return null;
    }
  };
  // Polls `probe` until it returns something other than undefined, for at most `ms` of fx time.
  const poll = async (ms, probe) => {
    const end = fx.now() + ms;
    for (;;) {
      const got = await probe();
      if (got !== undefined) return got;
      if (fx.now() >= end) return undefined;
      await fx.sleep(LIMITS.pollMs);
    }
  };

  const check = async () => {
    if (typeof repo !== "string" || !path.isAbsolute(repo)) throw new Error("Set the copilot-relay repository folder first (an absolute path).");
    if (!["server.mjs", path.join("scripts", "install-extension.mjs")].every((f) => existsSync(path.join(repo, f)))) {
      throw new Error(`Not a copilot-relay folder: ${repo} (server.mjs and scripts/install-extension.mjs are expected there).`);
    }
    const { stdout } = await fx.run("git", ["rev-parse", "--show-toplevel"], { cwd: repo, env: GIT_ENV, timeoutMs: 60_000 });
    if (!sameFolder(stdout.trim(), repo)) throw new Error(`${repo} is not the top folder of a git repository.`);
    const parsed = new URL(url);
    if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname)) throw new Error(`The broker address ${url} is not on this computer.`);
    ctx.port = parsed.port || "80";
    const installed = readInstalled(copilotHome);
    ctx.noAutostart = installed.installed && installed.brokerScript === null;
    ctx.node = installed.nodePath && existsSync(installed.nodePath) ? installed.nodePath : (await fx.run("node", ["-p", "process.execPath"], { timeoutMs: 10_000 })).stdout.trim();
    return { detail: repo };
  };

  const update = async () => {
    try {
      ctx.update = await updateRepo({ repo, run: fx.run });
    } catch (err) {
      ctx.stash = err.stash ?? null;
      throw new Error(err.message + stashNote());
    }
    ctx.stash = ctx.update.stash;
    return { detail: describeUpdate(ctx.update) };
  };

  const install = async () => {
    const npm = npmCommand(ctx.node);
    await fx.run(npm.program, npm.args, { cwd: repo, shell: npm.shell, timeoutMs: LIMITS.npmMs, label: "npm ci" });
    const env = { COPILOT_RELAY_PORT: ctx.port, ...(copilotHome ? { COPILOT_HOME: copilotHome } : {}) };
    const args = [path.join(repo, "scripts", "install-extension.mjs"), ...(ctx.noAutostart ? ["--no-autostart"] : [])];
    await fx.run(ctx.node, args, { cwd: repo, env, timeoutMs: LIMITS.installMs, label: "install-extension" });
    return { detail: "dependencies and extension installed" };
  };

  const stop = async () => {
    const old = await health();
    if (!old) return { status: "skipped", detail: "no broker was running" };
    if (old.app !== "copilot-relay") throw new Error(`Something else answers at ${url}; it is not a copilot-relay broker.`);
    let res = null;
    try {
      res = await fx.fetch(`${url}/api/shutdown`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(LIMITS.healthMs) });
    } catch { /* aborted or dropped: the broker may have exited while answering; the polling below decides */ }
    if (res?.status === 404) throw new Error("This broker is older than the restart button. Stop it by hand once; it will then run the updated files.");
    if (res && !res.ok) throw new Error(`The broker refused to stop: HTTP ${res.status}.`);
    const gone = await poll(LIMITS.stopMs, async () => {
      const h = await health();
      return h === null || h.pid !== old.pid ? true : undefined;
    });
    if (!gone) throw new Error(`The broker did not stop within ${LIMITS.stopMs / 1000} s.`);
    ctx.stoppedPid = old.pid;
    return { detail: `stopped pid ${old.pid}` };
  };

  const start = async () => {
    await fx.spawnBroker(ctx.node, path.join(repo, "server.mjs"), { cwd: repo, env: { COPILOT_RELAY_PORT: ctx.port } });
    const up = await poll(LIMITS.startMs, async () => {
      const h = await health();
      return h && h.pid !== ctx.stoppedPid ? h : undefined;
    });
    if (!up) throw new Error(`The broker did not answer within ${LIMITS.startMs / 1000} s.`);
    if (!up.root || !sameFolder(up.root, repo)) throw Object.assign(new Error(`A broker from another folder answers: ${up.root || "unknown folder"}.`), { other: true });
    ctx.pid = up.pid;
    return { detail: `pid ${up.pid}` };
  };

  const reconnect = async () => {
    try {
      const { total, back } = await fx.reconnect(LIMITS.reconnectMs);
      if (total === 0) return { status: "skipped", detail: "no open sessions" };
      return { detail: `${back} of ${total} sessions reconnected`, ...(back < total ? { warning: true } : {}) };
    } catch (err) {
      return { detail: err?.message ?? String(err), warning: true };
    }
  };

  const phases = { check, update, install, stop, start, reconnect };
  let failed = null;
  for (const id of STEP_IDS) {
    if (!(await step(id, phases[id]))) { failed = id; break; }
  }

  let summary;
  if (!failed) summary = `Broker running: pid ${ctx.pid}, commit ${ctx.update.after}.`;
  else if (failed === "stop") summary = "Stopped at Stop. The old broker is still running.";
  else if (failed === "start") {
    summary = byId.start.detail.startsWith("A broker from another folder")
      ? "Stopped at Start. A different broker is running."
      : "Stopped at Start. No broker is running; opening a session starts it.";
  } else summary = `Stopped at ${STEP_LABELS[failed]}. The broker was not restarted.`;
  return { ok: !failed, steps, summary: summary + stashNote() };
}

/** Calls reconnectNow() on every client; waits until all answered or `ms` passed. `back` counts the `true` answers. */
export async function reconnectClients(clients, ms) {
  let back = 0;
  const answers = clients.map((c) => Promise.resolve().then(() => c.reconnectNow()).then((ok) => { if (ok === true) back++; }, () => {}));
  let timer;
  await Promise.race([Promise.all(answers), new Promise((r) => { timer = setTimeout(r, ms); })]);
  clearTimeout(timer);
  return { total: clients.length, back };
}

/** One run at a time; `notify(snapshot)` on start, after every step change and at the end. */
export function createRestarter({ fx, notify }) {
  let state = { running: false, steps: [], summary: "", ok: null };
  const snapshot = () => ({ ...state, steps: state.steps.map((s) => ({ ...s })) });
  const push = () => {
    try { notify(snapshot()); } catch { /* a listener must not break the run */ }
  };
  return {
    snapshot,
    start(input) {
      if (state.running) return false;
      state = { running: true, summary: "", ok: null, steps: STEP_IDS.map((id) => ({ id, label: STEP_LABELS[id], status: "pending", detail: "" })) };
      push();
      runRestart(input, fx, (s) => {
        state.steps = state.steps.map((x) => (x.id === s.id ? s : x));
        push();
      }).then((out) => {
        state = { running: false, steps: out.steps, summary: out.summary, ok: out.ok };
        push();
      }, (err) => { // runRestart does not reject; if it ever does, the holder must not stay "running"
        state = { ...state, running: false, ok: false, summary: `The restart failed unexpectedly: ${err?.message ?? err}` };
        push();
      });
      return true;
    },
  };
}

export function realEffects({ reconnect }) {
  return {
    run: runProgram,
    fetch: (...a) => fetch(...a),
    // Started the way RelayClient#autostart starts it.
    spawnBroker: (node, script, { cwd, env }) => new Promise((resolve, reject) => {
      const child = spawn(node, [script], { detached: true, stdio: "ignore", windowsHide: true, cwd, env: { ...process.env, ...env } });
      child.once("error", reject);
      child.once("spawn", () => { child.unref(); resolve(); });
    }),
    reconnect,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}
