import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { shellLine } from "../copilot-command.mjs";
import { createCopilotRuntime } from "../copilot-runtime.mjs";

const ARGS = ["--headless", "--no-auto-update", "--port", "0"];
const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

function harness({ platform = "linux", killExits = true, startFails = false } = {}) {
  let clock = 0;
  let timerId = 0;
  const timers = new Map();
  const h = { children: [], spawns: [], kills: [], forTcp: [], clients: [], tokens: 0 };
  const setTimeout_ = (fn, ms) => {
    const id = ++timerId;
    timers.set(id, { at: clock + ms, fn });
    return { id, unref() {} };
  };
  const clearTimeout_ = (t) => { if (t) timers.delete(t.id); };
  h.advance = async (ms) => {
    const target = clock + ms;
    for (;;) {
      await tick(3);
      const due = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      clock = Math.max(clock, due[1].at);
      due[1].fn();
    }
    clock = target;
    await tick(3);
  };
  const spawn = (line, opts) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), pid: 1000 + h.children.length, exitCode: null, signalCode: null,
    });
    h.children.push(child);
    h.spawns.push({ line, opts });
    return child;
  };
  h.exit = (child, code = 0) => { child.exitCode = code; child.emit("exit", code, null); };
  const killTree = (child, signal) => {
    h.kills.push({ child, signal });
    if (killExits && (signal === "SIGTERM" || signal === undefined)) queueMicrotask(() => h.exit(child, null));
  };
  const sdk = {
    RuntimeConnection: { forTcp: (host, port, opts) => { h.forTcp.push({ host, port, opts }); return { host, port }; } },
    CopilotClient: class {
      constructor(options) {
        this.options = options; this.started = false; this.stopped = 0;
        this.rpc = { account: { getQuota: async () => ({ quotaSnapshots: {} }) } };
        h.clients.push(this);
      }
      async start() { if (startFails) await new Promise(() => {}); this.started = true; }
      async stop() { this.stopped++; }
    },
  };
  h.rt = createCopilotRuntime({
    spawn, loadSdk: async () => sdk, killTree, platform, homedir: () => "/home/x",
    randomUUID: () => `tok-${++h.tokens}`, now: () => clock, setTimeout: setTimeout_, clearTimeout: clearTimeout_,
  });
  h.port = async (child, text = "CLI server listening on port 41529\n") => { child.stdout.write(text); await tick(); };
  return h;
}

test("spawns the shell line", async () => {
  const h = harness();
  const p = h.rt.withClient({ command: '"/opt/my copilot" --flag' }, async () => 1);
  await tick();
  const { line, opts } = h.spawns[0];
  assert.equal(line, shellLine('"/opt/my copilot" --flag', ARGS));
  assert.equal(opts.shell, true);
  assert.equal(opts.cwd, "/home/x");
  assert.equal(opts.env.COPILOT_CONNECTION_TOKEN, "tok-1");
  assert.equal(opts.detached, true);
  assert.equal(opts.windowsHide, true);
  await h.port(h.children[0]);
  assert.equal(await p, 1);
});

test("connects to the printed port with the token", async () => {
  const h = harness();
  let got;
  const p = h.rt.withClient({ command: "copilot" }, async (c) => { got = c; });
  await tick();
  await h.port(h.children[0]);
  await p;
  assert.deepEqual(h.forTcp, [{ host: "127.0.0.1", port: 41529, opts: { connectionToken: "tok-1" } }]);
  assert.equal(h.clients[0].options.mode, "coding-agent");
  assert.deepEqual(h.clients[0].options.runtime, { host: "127.0.0.1", port: 41529 });
  assert.equal(got, h.clients[0]);
  assert.equal(h.clients[0].started, true);
});

test("finds a split port line after other output", async () => {
  const h = harness();
  const p = h.rt.withClient({ command: "copilot" }, async () => {});
  await tick();
  await h.port(h.children[0], "warning: x\nCLI server listen");
  assert.equal(h.forTcp.length, 0);
  await h.port(h.children[0], "ing on port 7\n");
  await p;
  assert.equal(h.forTcp[0].port, 7);
});

test("shares one start between concurrent calls", async () => {
  const h = harness();
  let ran = 0;
  const a = h.rt.withClient({ command: "copilot" }, async () => { ran++; });
  const b = h.rt.withClient({ command: "copilot" }, async () => { ran++; });
  await tick();
  await h.port(h.children[0]);
  await Promise.all([a, b]);
  assert.equal(h.spawns.length, 1);
  assert.equal(ran, 2);
});

test("a deadline without the port line fails and kills", async () => {
  const h = harness();
  const caught = h.rt.withClient({ command: "copilot" }, async () => {}).catch((e) => e);
  await tick();
  await h.advance(20_000);
  const e = await caught;
  assert.match(e.message, /Could not start ".*": .*port/);
  assert.ok(h.kills.some((k) => k.child === h.children[0]));
});

test("exit before the port line fails with the stderr tail", async () => {
  const h = harness();
  const caught = h.rt.withClient({ command: "copilot" }, async () => {}).catch((e) => e);
  await tick();
  h.children[0].stderr.write("not logged in");
  await tick();
  h.exit(h.children[0], 1);
  const e = await caught;
  assert.match(e.message, /Could not start "copilot": /);
  assert.match(e.message, /\nnot logged in$/);
});

test("a client that does not start in 10 s fails", async () => {
  const h = harness({ startFails: true });
  const caught = h.rt.withClient({ command: "copilot" }, async () => {}).catch((e) => e);
  await tick();
  await h.port(h.children[0]);
  await h.advance(10_000);
  const e = await caught;
  assert.match(e.message, /Could not start "copilot": /);
  assert.ok(h.kills.some((k) => k.child === h.children[0]));
});

test("holds a failure for 60 s", async () => {
  const h = harness();
  const first = h.rt.withClient({ command: "copilot" }, async () => {}).catch((e) => e);
  await tick();
  h.exit(h.children[0], 1);
  await first;
  await h.advance(59_999);
  await assert.rejects(h.rt.withClient({ command: "copilot" }, async () => {}), /Could not start/);
  assert.equal(h.spawns.length, 1);
  await h.advance(1);
  h.rt.withClient({ command: "copilot" }, async () => {}).catch(() => {});
  await tick();
  assert.equal(h.spawns.length, 2);
});

test("a died process is replaced on the next call", async () => {
  const h = harness();
  const p = h.rt.withClient({ command: "copilot" }, async () => {});
  await tick();
  await h.port(h.children[0]);
  await p;
  assert.equal(h.rt.size(), 1);
  h.exit(h.children[0], 0);
  await tick();
  assert.equal(h.rt.size(), 0);
  const q = h.rt.withClient({ command: "copilot" }, async () => {});
  await tick();
  assert.equal(h.spawns.length, 2);
  await h.port(h.children[1]);
  await q;
});

test("stops after 5 min idle, not during a call", async () => {
  const h = harness();
  let release;
  const p = h.rt.withClient({ command: "copilot" }, () => new Promise((r) => { release = r; }));
  await tick();
  await h.port(h.children[0]);
  await h.advance(300_000);
  assert.equal(h.kills.length, 0);
  release();
  await p;
  await h.advance(299_999);
  assert.equal(h.kills.length, 0);
  await h.advance(1);
  assert.equal(h.clients[0].stopped, 1);
  // SIGTERM, then the sweep of the process group once the leader has exited
  assert.deepEqual(h.kills.map((k) => k.signal), ["SIGTERM", "SIGKILL"]);
  assert.equal(h.rt.size(), 0);
});

test("a call past its deadline stops the CLI and the next call spawns a new one", async () => {
  const h = harness();
  const p = h.rt.withClient({ command: "copilot", deadlineMs: 10_000 }, () => new Promise(() => {})).catch((e) => e);
  await tick();
  await h.port(h.children[0]);
  assert.equal(h.rt.size(), 1);
  await h.advance(10_000);
  const err = await p;
  assert.match(err.message, /did not answer in 10 s/);
  assert.ok(h.kills.some((k) => k.child === h.children[0]));
  await h.advance(1);
  assert.equal(h.rt.size(), 0);
  const q = h.rt.withClient({ command: "copilot" }, async () => 7);
  await tick();
  assert.equal(h.spawns.length, 2);
  await h.port(h.children[1]);
  assert.equal(await q, 7);
});

test("POSIX: SIGKILL after the grace", async () => {
  const h = harness({ killExits: false });
  const p = h.rt.withClient({ command: "copilot" }, async () => {});
  await tick();
  await h.port(h.children[0]);
  await p;
  await h.advance(300_000);
  assert.deepEqual(h.kills.map((k) => k.signal), ["SIGTERM"]);
  await h.advance(2_999);
  assert.deepEqual(h.kills.map((k) => k.signal), ["SIGTERM"]);
  await h.advance(1);
  assert.deepEqual(h.kills.map((k) => k.signal), ["SIGTERM", "SIGKILL"]);
});

test("Windows: one killTree without a signal", async () => {
  const h = harness({ platform: "win32" });
  const p = h.rt.withClient({ command: "copilot" }, async () => {});
  await tick();
  assert.equal(h.spawns[0].opts.detached, false);
  await h.port(h.children[0]);
  await p;
  await h.advance(300_000);
  await h.advance(10_000);
  assert.deepEqual(h.kills.map((k) => k.signal), [undefined]);
});

test("two commands get two processes", async () => {
  const h = harness();
  const a = h.rt.withClient({ command: "a" }, async () => {});
  const b = h.rt.withClient({ command: "b" }, async () => {});
  await tick();
  await h.port(h.children[0]);
  await h.port(h.children[1]);
  await Promise.all([a, b]);
  assert.equal(h.spawns.length, 2);
  assert.equal(h.rt.size(), 2);
});

test("stopAll kills a start in progress", async () => {
  const h = harness();
  const caught = h.rt.withClient({ command: "copilot" }, async () => {}).catch((e) => e);
  await tick();
  await h.rt.stopAll();
  assert.ok(h.kills.some((k) => k.child === h.children[0]));
  assert.ok((await caught) instanceof Error);
  assert.equal(h.rt.size(), 0);
});

test("a call during stopAll is refused and spawns nothing", async () => {
  const h = harness({ killExits: false });
  const p = h.rt.withClient({ command: "copilot" }, async () => {});
  await tick();
  await h.port(h.children[0]);
  await p;
  const stopping = h.rt.stopAll();
  await assert.rejects(h.rt.withClient({ command: "other" }, async () => {}), /Copilot is stopping/);
  assert.equal(h.spawns.length, 1);
  await h.advance(3_500);
  await stopping;
  assert.equal(h.rt.size(), 0);
  assert.equal(h.spawns.length, 1);
});

test("a call after stopAll resolved starts a fresh process", async () => {
  const h = harness();
  const p = h.rt.withClient({ command: "copilot" }, async () => {});
  await tick();
  await h.port(h.children[0]);
  await p;
  await h.rt.stopAll();
  const q = h.rt.withClient({ command: "copilot" }, async () => 5);
  await tick();
  assert.equal(h.spawns.length, 2);
  await h.port(h.children[1]);
  assert.equal(await q, 5);
});

test("stopAll resolves even if a process never exits", async () => {
  const h = harness({ killExits: false });
  const p = h.rt.withClient({ command: "copilot" }, async () => {});
  await tick();
  await h.port(h.children[0]);
  await p;
  let done = false;
  h.rt.stopAll().then(() => { done = true; });
  await h.advance(3_499);
  assert.equal(done, false);
  await h.advance(1);
  assert.equal(done, true);
});
