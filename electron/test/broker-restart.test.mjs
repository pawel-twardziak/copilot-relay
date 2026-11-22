// Tests for the broker restart run, with every outside effect faked: no real broker, git, npm or spawn.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createRestarter, LIMITS, npmCommand, readInstalled, reconnectClients, runRestart, sameFolder, STEP_IDS,
} from "../broker-restart.mjs";

const tmp = (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "broker-restart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// script: { toplevel, branch, dirty, update: { before, after }, pullError, errors: { node, npm, installer },
//   health: [state | null, ...] (one per read, the last repeats), shutdownStatus, spawnError, reconnect,
//   installed: { brokerScript, nodePath }, noServer, url, nodePath }
function fakeFx(t, script = {}) {
  const repo = tmp(t);
  const copilotHome = tmp(t);
  if (!script.noServer) writeFileSync(path.join(repo, "server.mjs"), "");
  mkdirSync(path.join(repo, "scripts"));
  writeFileSync(path.join(repo, "scripts", "install-extension.mjs"), "");
  if (script.installed) {
    const dir = path.join(copilotHome, "extensions", "copilot-relay");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "config.json"), JSON.stringify(script.installed));
  }
  let clock = 0;
  let healthReads = 0;
  let pulled = false;
  const calls = { order: [], runs: [], shutdowns: [], spawns: [], reconnects: [] };
  const seen = (kind) => { if (!calls.order.includes(kind)) calls.order.push(kind); };
  const failWith = (e) => { if (e) throw e; };
  const fx = {
    async run(program, args, opts = {}) {
      const record = (kind) => { seen(kind); calls.runs.push({ kind, program, args, opts }); };
      if (program === "git") {
        record("git");
        let i = 0;
        while (args[i] === "-c") i += 2;
        const sub = args[i];
        if (sub === "rev-parse" && args[i + 1] === "--show-toplevel") return { stdout: `${script.toplevel ?? repo}\n`, stderr: "" };
        if (sub === "rev-parse" && args[i + 1] === "--abbrev-ref") return { stdout: `${script.branch ?? "main"}\n`, stderr: "" };
        if (sub === "rev-parse") return { stdout: `${pulled ? script.update?.after ?? "aaa1111" : script.update?.before ?? "aaa1111"}\n`, stderr: "" };
        if (sub === "status") return { stdout: script.dirty ?? "", stderr: "" };
        if (sub === "pull") {
          failWith(script.pullError);
          pulled = true;
        }
        return { stdout: "", stderr: "" };
      }
      if (program === "node" && args[0] === "-p") {
        record("node");
        failWith(script.errors?.node);
        return { stdout: `${script.nodePath ?? "/fake/bin/node"}\n`, stderr: "" };
      }
      if (opts.label === "npm ci") {
        record("npm");
        failWith(script.errors?.npm);
        return { stdout: "", stderr: "" };
      }
      record("installer");
      failWith(script.errors?.installer);
      return { stdout: "", stderr: "" };
    },
    async fetch(url, init = {}) {
      if (url.endsWith("/health")) {
        const list = script.health ?? [null];
        const state = list[Math.min(healthReads++, list.length - 1)];
        if (state === null) throw new TypeError("fetch failed");
        const body = JSON.parse(JSON.stringify(state).replaceAll("<repo>", repo.replaceAll("\\", "\\\\")));
        return { ok: true, status: 200, json: async () => body };
      }
      seen("shutdown");
      calls.shutdowns.push({ url, init });
      const status = script.shutdownStatus ?? 200;
      return { ok: status === 200, status, json: async () => ({ ok: true }) };
    },
    async spawnBroker(node, file, opts) {
      seen("spawn");
      calls.spawns.push({ node, file, opts });
      failWith(script.spawnError);
    },
    async reconnect(ms) {
      seen("reconnect");
      calls.reconnects.push(ms);
      return script.reconnect ?? { total: 0, back: 0 };
    },
    async sleep(ms) { clock += ms; },
    now: () => clock,
  };
  return { fx, calls, repo, copilotHome, input: { repo, url: script.url ?? "http://127.0.0.1:7777", copilotHome } };
}

const relay = (extra) => ({ app: "copilot-relay", ...extra });
const okHealth = (pid1, pid2) => [relay({ pid: pid1 }), null, relay({ pid: pid2, root: "<repo>" })];
const noLater = (calls, ...kinds) => { for (const k of kinds) assert.ok(!calls.order.includes(k), `${k} must not run`); };

test("a full run: six steps in order, summary with pid and commit", async (t) => {
  const { fx, calls, input } = fakeFx(t, {
    update: { before: "abc1234", after: "def5678" },
    health: [{ pid: 100, app: "copilot-relay" }, null, { pid: 200, app: "copilot-relay", root: "<repo>" }],
    reconnect: { total: 2, back: 2 },
  });
  const seen = [];
  const out = await runRestart(input, fx, (s) => seen.push(`${s.id}:${s.status}`));
  assert.equal(out.ok, true);
  assert.deepEqual(out.steps.map((s) => s.status), ["done", "done", "done", "done", "done", "done"]);
  assert.deepEqual(seen.filter((s) => s.endsWith(":running")).map((s) => s.split(":")[0]), STEP_IDS);
  assert.equal(out.steps[1].detail, "abc1234 → def5678");
  assert.equal(out.steps[3].detail, "stopped pid 100");
  assert.equal(out.steps[4].detail, "pid 200");
  assert.equal(out.steps[5].detail, "2 of 2 sessions reconnected");
  assert.equal(out.summary, "Broker running: pid 200, commit def5678.");
  assert.deepEqual(calls.order, ["git", "node", "npm", "installer", "shutdown", "spawn", "reconnect"]); // install before stop
  assert.deepEqual(calls.shutdowns[0].init.body, "{}");
  assert.equal(calls.spawns[0].opts.env.COPILOT_RELAY_PORT, "7777");
});

test("check: a folder without server.mjs", async (t) => {
  const { fx, calls, input, repo } = fakeFx(t, { noServer: true });
  const out = await runRestart(input, fx);
  assert.deepEqual(out.steps.map((s) => s.status), ["failed", "pending", "pending", "pending", "pending", "pending"]);
  assert.equal(out.steps[0].detail, `Not a copilot-relay folder: ${repo} (server.mjs and scripts/install-extension.mjs are expected there).`);
  assert.equal(out.summary, "Stopped at Check. The broker was not restarted.");
  assert.deepEqual(calls.order, []);
});

test("check: a missing folder is reported as not a copilot-relay folder, before any program runs", async (t) => {
  const { fx, calls, input } = fakeFx(t);
  const gone = path.join(input.repo, "nope");
  const out = await runRestart({ ...input, repo: gone }, fx);
  assert.match(out.steps[0].detail, /^Not a copilot-relay folder:/);
  assert.deepEqual(calls.order, []);
});

test("check: an empty, missing or relative repo fails before any file check or effect", async (t) => {
  for (const repo of ["", undefined, "relative/folder"]) {
    const { fx, calls, input } = fakeFx(t);
    const out = await runRestart({ ...input, repo }, fx);
    assert.equal(out.ok, false, String(repo));
    assert.equal(out.steps[0].status, "failed", String(repo));
    assert.equal(out.steps[0].detail, "Set the copilot-relay repository folder first (an absolute path).", String(repo));
    assert.equal(out.summary, "Stopped at Check. The broker was not restarted.", String(repo));
    assert.deepEqual(calls.order, [], String(repo));
  }
});

test("check: git's top level is another folder", async (t) => {
  const { fx, calls, input, repo } = fakeFx(t, { toplevel: os.tmpdir() });
  const out = await runRestart(input, fx);
  assert.equal(out.steps[0].status, "failed");
  assert.equal(out.steps[0].detail, `${repo} is not the top folder of a git repository.`);
  noLater(calls, "npm", "shutdown", "spawn");
});

test("check: a broker address that is not on this computer", async (t) => {
  const { fx, calls, input } = fakeFx(t, { url: "http://10.0.0.5:7777" });
  const out = await runRestart(input, fx);
  assert.equal(out.steps[0].detail, "The broker address http://10.0.0.5:7777 is not on this computer.");
  noLater(calls, "npm", "shutdown", "spawn");
});

test("check: node not found", async (t) => {
  const err = Object.assign(new Error("node was not found (is it installed and on PATH?)"), { code: "ENOENT" });
  const { fx, calls, input } = fakeFx(t, { errors: { node: err } });
  const out = await runRestart(input, fx);
  assert.equal(out.steps[0].status, "failed");
  assert.equal(out.steps[0].detail, err.message);
  assert.equal(out.summary, "Stopped at Check. The broker was not restarted.");
  noLater(calls, "npm", "shutdown", "spawn");
});

test("update fails with a stash: detail and summary carry the stash sentence", async (t) => {
  const { fx, calls, input } = fakeFx(t, { branch: "feat/x", dirty: " M a.txt\0", pullError: new Error("git pull failed (exit 1): diverged") });
  const out = await runRestart(input, fx);
  assert.deepEqual(out.steps.map((s) => s.status), ["done", "failed", "pending", "pending", "pending", "pending"]);
  const sentence = / Your changes from feat\/x are in the stash "copilot-sessions restart [^"]+"\.$/;
  assert.match(out.steps[1].detail, /^git pull failed \(exit 1\): diverged Your changes/);
  assert.match(out.steps[1].detail, sentence);
  assert.match(out.summary, /^Stopped at Update\. The broker was not restarted\. Your changes/);
  assert.match(out.summary, sentence);
  noLater(calls, "npm");
});

test("npm ci runs on every run, in the repo, also when nothing was pulled", async (t) => {
  const { fx, calls, input, repo } = fakeFx(t, { update: { before: "abc", after: "abc" }, health: [null, relay({ pid: 5, root: "<repo>" })] });
  const out = await runRestart(input, fx);
  assert.equal(out.steps[1].detail, "already up to date (abc)");
  const npm = calls.runs.find((r) => r.kind === "npm");
  assert.equal(npm.opts.cwd, repo);
  assert.equal(npm.opts.timeoutMs, 300_000);
  assert.deepEqual(npm.args, ["ci"]);
});

test("installer arguments and env", async (t) => {
  const realNode = path.join(tmp(t), "node");
  writeFileSync(realNode, "");
  const cases = [
    [{ installed: { brokerScript: "/x/server.mjs", nodePath: realNode } }, false, realNode],
    [{ installed: { brokerScript: null, nodePath: realNode } }, true, realNode],
    [{}, false, "/fake/bin/node"],
  ];
  for (const [script, noAuto, node] of cases) {
    const { fx, calls, input, repo, copilotHome } = fakeFx(t, { ...script, url: "http://127.0.0.1:7790" });
    await runRestart(input, fx);
    const inst = calls.runs.find((r) => r.kind === "installer");
    assert.equal(inst.program, node);
    assert.deepEqual(inst.args, [path.join(repo, "scripts", "install-extension.mjs"), ...(noAuto ? ["--no-autostart"] : [])]);
    assert.deepEqual(inst.opts.env, { COPILOT_RELAY_PORT: "7790", COPILOT_HOME: copilotHome });
    assert.equal(inst.opts.cwd, repo);
    assert.equal(inst.opts.timeoutMs, 30_000);
    assert.equal(inst.opts.label, "install-extension");
    assert.equal(calls.runs.some((r) => r.kind === "node"), script.installed !== undefined ? false : true);
  }
});

test("a recorded nodePath that no longer exists falls back to the node lookup", async (t) => {
  const { fx, calls, input } = fakeFx(t, { installed: { brokerScript: "/x/server.mjs", nodePath: "/gone/node" } });
  await runRestart(input, fx);
  assert.equal(calls.runs.find((r) => r.kind === "installer").program, "/fake/bin/node");
  assert.ok(calls.runs.some((r) => r.kind === "node"));
});

test("a throwing onStep does not change the outcome", async (t) => {
  const a = fakeFx(t, { health: okHealth(1, 2) });
  const b = fakeFx(t, { health: okHealth(1, 2) });
  const plain = await runRestart(a.input, a.fx);
  const noisy = await runRestart(b.input, b.fx, () => { throw new Error("listener"); });
  assert.equal(noisy.ok, true);
  assert.deepEqual(noisy.steps.map((s) => s.status), plain.steps.map((s) => s.status));
  assert.equal(noisy.summary, plain.summary);
});

test("runRestart without input resolves with a failed check", async (t) => {
  const { fx } = fakeFx(t);
  const out = await runRestart(undefined, fx);
  assert.equal(out.ok, false);
  assert.equal(out.steps[0].status, "failed");
  assert.equal(out.summary, "Stopped at Check. The broker was not restarted.");
});

test("createRestarter ends a run started without input and accepts the next one", async (t) => {
  const good = fakeFx(t, { health: okHealth(1, 2) });
  const r = createRestarter({ fx: good.fx, notify: () => {} });
  assert.equal(r.start(undefined), true);
  while (r.snapshot().running) await new Promise((res) => setImmediate(res));
  assert.equal(r.snapshot().ok, false);
  assert.ok(r.snapshot().summary);
  assert.equal(r.start(good.input), true);
});

test("shutdown POST aborted, broker gone: stop is done", async (t) => {
  const { fx, input } = fakeFx(t, { health: [relay({ pid: 100 }), null, relay({ pid: 200, root: "<repo>" })] });
  const inner = fx.fetch;
  fx.fetch = async (url, init) => {
    if (url.endsWith("/api/shutdown")) {
      assert.ok(init.signal);
      throw new DOMException("aborted", "AbortError");
    }
    return inner(url, init);
  };
  const out = await runRestart(input, fx);
  assert.equal(out.steps[3].status, "done");
  assert.equal(out.steps[3].detail, "stopped pid 100");
  assert.equal(out.ok, true);
});

test("shutdown POST fails, broker still answers the old pid: the 10 s failure", async (t) => {
  const { fx, calls, input } = fakeFx(t, { health: [relay({ pid: 9 })] });
  const inner = fx.fetch;
  fx.fetch = async (url, init) => {
    if (url.endsWith("/api/shutdown")) throw new TypeError("fetch failed");
    return inner(url, init);
  };
  const out = await runRestart(input, fx);
  assert.equal(out.steps[3].detail, "The broker did not stop within 10 s.");
  noLater(calls, "spawn");
});

test("install fails: nothing is stopped", async (t) => {
  const { fx, calls, input } = fakeFx(t, { errors: { installer: new Error("install-extension failed (exit 1): boom") } });
  const out = await runRestart(input, fx);
  assert.equal(out.steps[2].status, "failed");
  assert.equal(out.steps[2].detail, "install-extension failed (exit 1): boom");
  assert.equal(out.summary, "Stopped at Install. The broker was not restarted.");
  noLater(calls, "shutdown", "spawn");
});

test("no broker running: stop is skipped and any pid starts", async (t) => {
  const { fx, calls, input } = fakeFx(t, { health: [null, relay({ pid: 100, root: "<repo>" })] });
  const out = await runRestart(input, fx);
  assert.equal(out.steps[3].status, "skipped");
  assert.equal(out.steps[3].detail, "no broker was running");
  assert.equal(out.steps[4].detail, "pid 100");
  assert.equal(out.ok, true);
  noLater(calls, "shutdown");
});

test("an old broker: the shutdown answers 404", async (t) => {
  const { fx, calls, input } = fakeFx(t, { health: [relay({}) ], shutdownStatus: 404 });
  const out = await runRestart(input, fx);
  assert.equal(out.steps[3].detail, "This broker is older than the restart button. Stop it by hand once; it will then run the updated files.");
  assert.equal(out.summary, "Stopped at Stop. The old broker is still running.");
  noLater(calls, "spawn");
});

test("a refused shutdown names the status", async (t) => {
  const { fx, input } = fakeFx(t, { health: [relay({ pid: 1 })], shutdownStatus: 500 });
  const out = await runRestart(input, fx);
  assert.equal(out.steps[3].detail, "The broker refused to stop: HTTP 500.");
});

test("something else on the port is left alone", async (t) => {
  const { fx, calls, input } = fakeFx(t, { health: [{ ok: true }] });
  const out = await runRestart(input, fx);
  assert.equal(out.steps[3].status, "failed");
  assert.equal(out.steps[3].detail, "Something else answers at http://127.0.0.1:7777; it is not a copilot-relay broker.");
  noLater(calls, "shutdown", "spawn");
});

test("a broker that keeps answering with the same pid: fails after 10 s of virtual time", async (t) => {
  const { fx, calls, input } = fakeFx(t, { health: [relay({ pid: 9 })] });
  const out = await runRestart(input, fx);
  assert.equal(out.steps[3].detail, "The broker did not stop within 10 s.");
  assert.equal(out.summary, "Stopped at Stop. The old broker is still running.");
  assert.ok(fx.now() >= LIMITS.stopMs);
  noLater(calls, "spawn");
});

test("the port taken by another starter that serves this repo is accepted", async (t) => {
  const { fx, input } = fakeFx(t, { health: okHealth(100, 300) });
  const out = await runRestart(input, fx);
  assert.equal(out.steps[4].status, "done");
  assert.equal(out.steps[4].detail, "pid 300");
});

test("a broker from another folder", async (t) => {
  const { fx, input } = fakeFx(t, { health: [relay({ pid: 100 }), null, relay({ pid: 200, root: "/somewhere/else" })] });
  const out = await runRestart(input, fx);
  assert.equal(out.steps[4].detail, "A broker from another folder answers: /somewhere/else.");
  assert.equal(out.summary, "Stopped at Start. A different broker is running.");
  assert.equal(out.steps[5].status, "pending");
});

test("a start that never answers: fails after 15 s of virtual time", async (t) => {
  const { fx, input } = fakeFx(t, { health: [null] });
  const out = await runRestart(input, fx);
  assert.equal(out.steps[4].detail, "The broker did not answer within 15 s.");
  assert.equal(out.summary, "Stopped at Start. No broker is running; opening a session starts it.");
  assert.ok(fx.now() >= LIMITS.startMs);
});

test("a spawn error fails the start with its message", async (t) => {
  const { fx, input } = fakeFx(t, { health: [null], spawnError: new Error("spawn /x ENOENT") });
  const out = await runRestart(input, fx);
  assert.equal(out.steps[4].detail, "spawn /x ENOENT");
  assert.match(out.summary, /^Stopped at Start\. No broker is running/);
});

test("sessions not back is a warning, not a failure", async (t) => {
  const { fx, input } = fakeFx(t, { health: okHealth(1, 2), reconnect: { total: 3, back: 1 } });
  const out = await runRestart(input, fx);
  assert.equal(out.steps[5].status, "done");
  assert.equal(out.steps[5].warning, true);
  assert.equal(out.steps[5].detail, "1 of 3 sessions reconnected");
  assert.equal(out.ok, true);
});

test("no sessions: reconnect is skipped", async (t) => {
  const { fx, input } = fakeFx(t, { health: okHealth(1, 2), reconnect: { total: 0, back: 0 } });
  const out = await runRestart(input, fx);
  assert.equal(out.steps[5].status, "skipped");
  assert.equal(out.steps[5].detail, "no open sessions");
});

test("a reconnect that throws becomes a warning", async (t) => {
  const { fx, input } = fakeFx(t, { health: okHealth(1, 2) });
  fx.reconnect = async () => { throw new Error("boom"); };
  const out = await runRestart(input, fx);
  assert.equal(out.steps[5].warning, true);
  assert.equal(out.steps[5].detail, "boom");
  assert.equal(out.ok, true);
});

test("the stash sentence is appended to a successful summary too", async (t) => {
  const { fx, input } = fakeFx(t, { branch: "feat/x", dirty: "?? a\0", health: okHealth(1, 2), update: { before: "a", after: "b" } });
  const out = await runRestart(input, fx);
  assert.match(out.summary, /^Broker running: pid 2, commit b\. Your changes from feat\/x are in the stash "copilot-sessions restart [^"]+"\.$/);
});

test("sameFolder", (t) => {
  assert.equal(sameFolder("/a/b", "/a/b/"), true);
  assert.equal(sameFolder("C:\\Repo", "c:\\repo\\", "win32"), true);
  assert.equal(sameFolder("/a/B", "/a/b", "linux"), false);
  const dir = tmp(t);
  const link = path.join(tmp(t), "link");
  try {
    symlinkSync(dir, link, "dir");
  } catch (e) {
    if (e.code === "EPERM") return;
    throw e;
  }
  assert.equal(sameFolder(dir, link), true);
});

test("readInstalled", (t) => {
  const home = tmp(t);
  assert.deepEqual(readInstalled(home), { installed: false, brokerScript: null, nodePath: null });
  const dir = path.join(home, "extensions", "copilot-relay");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "config.json"), JSON.stringify({ brokerScript: null }));
  assert.deepEqual(readInstalled(home), { installed: true, brokerScript: null, nodePath: null });
  writeFileSync(path.join(dir, "config.json"), JSON.stringify({ brokerScript: "/s.mjs", nodePath: "/n" }));
  assert.deepEqual(readInstalled(home), { installed: true, brokerScript: "/s.mjs", nodePath: "/n" });
});

test("npmCommand", () => {
  const yes = () => true;
  const no = () => false;
  const winNode = "C:\\node\\node.exe";
  assert.deepEqual(npmCommand(winNode, { platform: "win32", exists: yes }),
    { program: winNode, args: ["C:\\node\\node_modules\\npm\\bin\\npm-cli.js", "ci"], shell: false });
  assert.deepEqual(npmCommand(winNode, { platform: "win32", exists: no }), { program: "npm", args: ["ci"], shell: true });
  assert.deepEqual(npmCommand("/opt/node/bin/node", { platform: "linux", exists: yes }),
    { program: "/opt/node/bin/node", args: ["/opt/node/lib/node_modules/npm/bin/npm-cli.js", "ci"], shell: false });
  assert.deepEqual(npmCommand("/opt/node/bin/node", { platform: "linux", exists: no }), { program: "npm", args: ["ci"], shell: false });
});

test("reconnectClients bounds the wait and counts only true answers", async () => {
  const started = Date.now();
  const out = await reconnectClients([
    { reconnectNow: async () => true },
    { reconnectNow: async () => false },
    { reconnectNow: () => new Promise(() => {}) },
  ], 50);
  assert.deepEqual(out, { total: 3, back: 1 });
  assert.ok(Date.now() - started >= 40);
  const t0 = Date.now();
  assert.deepEqual(await reconnectClients([], 5000), { total: 0, back: 0 });
  assert.ok(Date.now() - t0 < 500);
});

test("createRestarter: one run at a time, notifications, snapshot", async (t) => {
  const { fx, input } = fakeFx(t, { health: okHealth(1, 2), reconnect: { total: 1, back: 1 } });
  const notes = [];
  const r = createRestarter({ fx, notify: (s) => notes.push(s) });
  assert.deepEqual(r.snapshot(), { running: false, steps: [], summary: "", ok: null });
  assert.equal(r.start(input), true);
  assert.equal(r.start(input), false);
  assert.equal(notes[0].running, true);
  assert.deepEqual(notes[0].steps.map((s) => s.status), Array(6).fill("pending"));
  while (r.snapshot().running) await new Promise((res) => setImmediate(res));
  const last = notes.at(-1);
  assert.equal(last.running, false);
  assert.equal(last.ok, true);
  assert.equal(last.summary, "Broker running: pid 2, commit aaa1111.");
  assert.deepEqual(r.snapshot(), last);
  assert.ok(notes.length > 2);
  const again = fakeFx(t, { health: okHealth(1, 2) });
  const r2 = createRestarter({ fx: again.fx, notify: () => {} });
  assert.equal(r2.start(again.input), true);
  while (r2.snapshot().running) await new Promise((res) => setImmediate(res));
  assert.equal(r2.start(again.input), true);
});
