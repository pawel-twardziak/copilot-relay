// Tests for the cache keeper's runner (electron/cache-keeper-runner.mjs): timers, actions and notices with fake
// timers, a scripted expiry reader and a fake `run`; and the per-session opt-out store.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { compactText, keepAliveText } from "../cache-keeper.mjs";
import { createKeeperOptOut, createKeeperRunner } from "../cache-keeper-runner.mjs";

const flush = () => new Promise((r) => setImmediate(r));
const T0 = 10_000_000;
const MIN = 60_000;
const ID = "s1";
const PING_OK = { text: ".", toolCalled: false, error: null };

function harness({ settings, facts, retry } = {}) {
  const clock = { t: T0 };
  const timers = [];
  const runs = [];
  const emitted = [];
  const reads = [];
  const s = { enabled: true, pings: 2, minContext: 50_000, ...settings };
  const f = { busy: false, replaying: false, contextUsed: 100_000, modelId: "claude-opus-5.5", parent: false, ...facts };
  const opted = new Set();
  const expiries = [];
  let lastRead = null;
  const runner = createKeeperRunner({
    settings: () => s,
    optedOut: (id) => opted.has(id),
    facts: () => f,
    readExpiry: async (id, modelId) => {
      reads.push({ id, modelId });
      if (expiries.length) lastRead = expiries.shift();
      return lastRead;
    },
    run: (id, text, kind) => new Promise((resolve) => runs.push({ id, text, kind, resolve })),
    emit: (channel, payload) => emitted.push({ channel, payload }),
    now: () => clock.t,
    setTimer: (fn, ms) => {
      const h = { fn, at: clock.t + ms };
      timers.push(h);
      return h;
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h);
      if (i >= 0) timers.splice(i, 1);
    },
    retry,
  });
  /** Fires the due timers in time order up to `to`, letting promises settle in between. */
  async function advance(to) {
    for (;;) {
      await flush();
      const due = timers.filter((h) => h.at <= to).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      clock.t = Math.max(clock.t, due.at);
      due.fn();
    }
    clock.t = Math.max(clock.t, to);
    await flush();
  }
  /** Scripts the next read: a checkpoint `cp` expiring `inMs` after the current time. */
  const expiry = (cp, inMs = 5 * MIN) => expiries.push({ expiresAt: clock.t + inMs, checkpointId: cp });
  const states = () => emitted.filter((e) => e.channel === "keeper:state").map((e) => e.payload);
  const notices = () => emitted.filter((e) => e.channel === "acp:notice").map((e) => e.payload);
  const phases = () => states().map((p) => p.phase);
  const finish = async (result = PING_OK) => {
    runs.at(-1).resolve(result);
    await flush();
    await flush();
  };
  return { clock, timers, runs, emitted, reads, s, f, opted, expiries, runner, advance, expiry, states, notices, phases, finish };
}

test("a pause runs N pings then the countdown and the compaction", async () => {
  const h = harness();
  h.expiry("c1");
  const exp1 = T0 + 5 * MIN;
  await h.runner.turnEnded(ID);
  assert.deepEqual(h.reads, [{ id: ID, modelId: "claude-opus-5.5" }]);
  assert.deepEqual(h.timers.map((t) => t.at), [exp1 - MIN]);

  await h.advance(exp1 - MIN);
  assert.equal(h.runs.length, 1);
  assert.deepEqual([h.runs[0].id, h.runs[0].text, h.runs[0].kind], [ID, keepAliveText(), "ping"]);
  assert.equal(h.phases().at(-1), "pinging");
  assert.equal(h.timers.length, 0);

  h.expiry("c2");
  const exp2 = h.clock.t + 5 * MIN;
  await h.finish();
  assert.deepEqual(h.timers.map((t) => t.at), [exp2 - MIN]);
  assert.deepEqual(h.runner.state(ID), { phase: "pinging", pingsSent: 1, pings: 2, compactAt: null });

  await h.advance(exp2 - MIN);
  assert.equal(h.runs.length, 2);
  assert.equal(h.runs[1].kind, "ping");
  h.expiry("c3");
  const exp3 = h.clock.t + 5 * MIN;
  await h.finish();
  assert.deepEqual(h.timers.map((t) => t.at), [exp3 - 2 * MIN]);

  await h.advance(exp3 - 2 * MIN);
  assert.deepEqual(h.states().at(-1), { sessionId: ID, phase: "countdown", pingsSent: 2, pings: 2, compactAt: exp3 - MIN });
  assert.deepEqual(h.timers.map((t) => t.at), [exp3 - MIN]);

  await h.advance(exp3 - MIN);
  assert.equal(h.runs.length, 3);
  assert.deepEqual([h.runs[2].text, h.runs[2].kind], [compactText({ parent: false }), "compact"]);
  assert.equal(h.phases().at(-1), "compacting");

  await h.finish({ text: "Compacted conversation history and removed 4 messages and 900 tokens.", toolCalled: false, error: null });
  assert.deepEqual(h.notices(), [{ sessionId: ID, text: "Compacted automatically before the prompt cache expired (−4 messages)" }]);
  assert.equal(h.phases().at(-1), "done");
  assert.equal(h.timers.length, 0);
  assert.deepEqual(
    h.states().map((p) => `${p.phase} ${p.pingsSent}`),
    ["idle 0", "pinging 0", "pinging 1", "pinging 2", "countdown 2", "compacting 2", "done 2"],
  );
});

/** Runs a turn and N = 0 straight to the compaction run. */
async function toCompaction(h) {
  h.expiry("c1");
  await h.runner.turnEnded(ID);
  await h.advance(T0 + 5 * MIN - MIN);
  assert.equal(h.runs.at(-1)?.kind, "compact");
}

test("the parent gets the long focus text", async () => {
  const h = harness({ settings: { pings: 0 }, facts: { parent: true } });
  await toCompaction(h);
  assert.equal(h.runs[0].text, compactText({ parent: true }));
});

test("a compaction reply without a count gives the notice without it", async () => {
  const h = harness({ settings: { pings: 0 } });
  await toCompaction(h);
  await h.finish({ text: "Compacted conversation history.", toolCalled: false, error: null });
  assert.deepEqual(h.notices(), [{ sessionId: ID, text: "Compacted automatically before the prompt cache expired" }]);
});

test("a failed compaction leaves a notice and ends the pause", async () => {
  const h = harness({ settings: { pings: 0 } });
  await toCompaction(h);
  await h.finish({ text: "", toolCalled: false, error: "boom" });
  assert.deepEqual(h.notices(), [{ sessionId: ID, text: "Automatic compaction failed: boom" }]);
  assert.equal(h.phases().at(-1), "done");
  await h.advance(T0 + 60 * MIN);
  assert.equal(h.timers.length, 0);
  assert.equal(h.runs.length, 1);
});

test("a run that throws counts as a failed compaction", async () => {
  const h = harness({ settings: { pings: 0 } });
  h.expiry("c1");
  await h.runner.turnEnded(ID);
  await h.advance(T0 + 4 * MIN);
  h.runs.at(-1).resolve(Promise.reject(new Error("gone")));
  await flush();
  await flush();
  assert.deepEqual(h.notices(), [{ sessionId: ID, text: "Automatic compaction failed: gone" }]);
  assert.equal(h.phases().at(-1), "done");
});

test("a tool call during a ping stops the pause", async () => {
  const h = harness();
  h.expiry("c1");
  await h.runner.turnEnded(ID);
  await h.advance(T0 + 4 * MIN);
  h.expiry("c2");
  await h.finish({ text: "", toolCalled: true, error: null });
  assert.deepEqual(h.notices(), [{ sessionId: ID, text: "Keep-alive stopped: the agent started working." }]);
  assert.equal(h.phases().at(-1), "off");
  assert.equal(h.timers.length, 0);
  h.runner.replan(ID);
  assert.equal(h.timers.length, 0);

  h.expiry("c3");
  await h.runner.turnEnded(ID);
  assert.equal(h.timers.length, 1);
});

test("a ping without a new checkpoint ends the pause quietly", async () => {
  const h = harness({ retry: { tries: 2, ms: 1000 } });
  h.expiry("c1");
  await h.runner.turnEnded(ID);
  await h.advance(T0 + 4 * MIN);
  const reads = h.reads.length;
  await h.finish(); // the reader keeps returning c1
  await h.advance(h.clock.t + 5000);
  assert.equal(h.reads.length, reads + 2);
  assert.equal(h.phases().at(-1), "off");
  assert.equal(h.timers.length, 0);
  assert.deepEqual(h.notices(), []);
  assert.equal(h.runner.state(ID).pingsSent, 0);
});

test("a prompt during a ping waits for it", async () => {
  const h = harness();
  assert.equal(await Promise.race([h.runner.whenIdle(ID), "pending"]), undefined);
  h.expiry("c1");
  await h.runner.turnEnded(ID);
  await h.advance(T0 + 4 * MIN);
  let idle = false;
  const waited = h.runner.whenIdle(ID).then(() => {
    idle = true;
  });
  await flush();
  await flush();
  assert.equal(idle, false);
  h.runs[0].resolve(PING_OK);
  await waited;
  assert.equal(idle, true);
});

test("activity cancels the plan", async () => {
  const h = harness({ settings: { pings: 0 } });
  h.expiry("c1");
  await h.runner.turnEnded(ID);
  await h.advance(T0 + 3 * MIN);
  assert.equal(h.phases().at(-1), "countdown");
  assert.equal(h.timers.length, 1);
  h.runner.activity(ID);
  assert.equal(h.timers.length, 0);
  assert.equal(h.phases().at(-1), "off");
  await h.advance(T0 + 60 * MIN);
  assert.equal(h.runs.length, 0);
});

test("activity during a ping drops the ping's result", async () => {
  const h = harness();
  h.expiry("c1");
  await h.runner.turnEnded(ID);
  await h.advance(T0 + 4 * MIN);
  h.runner.activity(ID);
  h.expiry("c2");
  await h.finish();
  assert.equal(h.timers.length, 0);
  assert.equal(h.phases().at(-1), "off");
  assert.equal(h.runner.state(ID).pingsSent, 0);
});

test("Not now", async () => {
  const h = harness({ settings: { pings: 0 } });
  h.expiry("c1");
  await h.runner.turnEnded(ID);
  await h.advance(T0 + 3 * MIN);
  assert.equal(h.phases().at(-1), "countdown");
  h.runner.notNow(ID);
  assert.equal(h.timers.length, 0);
  assert.equal(h.phases().at(-1), "off");
  h.runner.replan();
  await h.advance(T0 + 60 * MIN);
  assert.equal(h.runs.length, 0);
});

test("text typed during the countdown skips the pause, also when it is cleared before compactAt + the catch-up", async () => {
  const h = harness({ settings: { pings: 0 } });
  h.expiry("c1");
  await h.runner.turnEnded(ID);
  await h.advance(T0 + 3 * MIN);
  assert.equal(h.phases().at(-1), "countdown");
  h.runner.setHeld(ID, true);
  assert.equal(h.phases().at(-1), "off");
  h.clock.t = T0 + 4 * MIN + 1_000; // past compactAt, inside the catch-up
  h.runner.setHeld(ID, false);
  assert.equal(h.timers.length, 0);
  await h.advance(T0 + 60 * MIN);
  assert.equal(h.runs.length, 0);
  assert.equal(h.phases().at(-1), "off");
});

test("a block released a little after compactAt compacts at once", async () => {
  const h = harness({ settings: { pings: 0 } });
  h.expiry("c1");
  await h.runner.turnEnded(ID);
  await h.advance(T0 + 3 * MIN);
  h.f.busy = true; // e.g. an open card
  await h.advance(T0 + 4 * MIN);
  assert.equal(h.phases().at(-1), "off");
  h.clock.t = T0 + 4 * MIN + 1_000;
  h.f.busy = false;
  h.runner.replan(ID);
  await h.advance(h.clock.t);
  assert.deepEqual(h.runs.map((r) => r.kind), ["compact"]);
});

test("a block released after compactAt + the catch-up ends the pause: no compaction, no revival", async () => {
  const h = harness({ settings: { pings: 0 } });
  h.expiry("c1");
  await h.runner.turnEnded(ID);
  await h.advance(T0 + 3 * MIN);
  h.f.busy = true;
  await h.advance(T0 + 4 * MIN);
  h.clock.t = T0 + 4 * MIN + 2_001;
  h.f.busy = false;
  h.runner.replan(ID);
  assert.equal(h.timers.length, 0);
  assert.equal(h.phases().at(-1), "off");
  h.s.pings = 3; // a settings change re-plans: the missed pause stays skipped
  h.runner.replan();
  await h.advance(T0 + 60 * MIN);
  assert.equal(h.runs.length, 0);
});

test("a countdown start missed by more than the catch-up ends the pause: no countdown, no revival", async () => {
  const h = harness({ settings: { pings: 0 } });
  h.expiry("c1");
  await h.runner.turnEnded(ID);
  h.f.busy = true;
  await h.advance(T0 + 3 * MIN);
  assert.equal(h.phases().at(-1), "off");
  h.clock.t = T0 + 3 * MIN + 2_001;
  h.f.busy = false;
  h.runner.replan(ID);
  assert.equal(h.timers.length, 0);
  h.s.pings = 3;
  h.runner.replan(ID);
  await h.advance(T0 + 60 * MIN);
  assert.equal(h.runs.length, 0);
  assert.ok(!h.phases().includes("countdown"));
});

test("an unchanged checkpoint gives no expiry", async () => {
  const h = harness();
  h.expiry("c1");
  await h.runner.turnEnded(ID);
  h.runner.activity(ID);
  h.expiries.push({ expiresAt: T0 + 5 * MIN, checkpointId: "c1" }, { expiresAt: T0 + 5 * MIN, checkpointId: "c1" });
  const reads = h.reads.length;
  const ended = h.runner.turnEnded(ID);
  await h.advance(T0 + 5000);
  await ended;
  assert.equal(h.reads.length - reads, 3);
  assert.equal(h.timers.length, 0);
  assert.equal(h.runs.length, 0);
});

test("a checkpoint that lands late is taken on a retry", async () => {
  const h = harness();
  h.expiry("c1");
  await h.runner.turnEnded(ID);
  h.runner.activity(ID);
  h.expiries.push({ expiresAt: T0 + 5 * MIN, checkpointId: "c1" }, { expiresAt: T0 + 6 * MIN, checkpointId: "c2" });
  const ended = h.runner.turnEnded(ID);
  await h.advance(T0 + 1000);
  await ended;
  assert.deepEqual(h.timers.map((t) => t.at), [T0 + 5 * MIN]);
});

test("turnStarted sets the baseline the end of the turn must differ from", async () => {
  const h = harness();
  h.expiries.push({ expiresAt: T0 + 2 * MIN, checkpointId: "before" });
  await h.runner.turnStarted(ID);
  assert.deepEqual(h.timers, []);
  h.expiries.push(
    { expiresAt: T0 + 2 * MIN, checkpointId: "before" },
    { expiresAt: T0 + 2 * MIN, checkpointId: "before" },
    { expiresAt: T0 + 7 * MIN, checkpointId: "after" },
  );
  const ended = h.runner.turnEnded(ID);
  await h.advance(T0 + 2000);
  await ended;
  assert.equal(h.reads.length, 4);
  assert.deepEqual(h.timers.map((t) => t.at), [T0 + 6 * MIN]);
});

test("turnEnded waits for a turnStarted read still in flight", async () => {
  const h = harness();
  h.expiries.push({ expiresAt: T0 + 2 * MIN, checkpointId: "before" }, { expiresAt: T0 + 7 * MIN, checkpointId: "after" });
  void h.runner.turnStarted(ID);
  await h.runner.turnEnded(ID);
  assert.deepEqual(h.timers.map((t) => t.at), [T0 + 6 * MIN]);
});

test("without turnStarted the first checkpoint read counts", async () => {
  const h = harness();
  h.expiries.push({ expiresAt: T0 + 5 * MIN, checkpointId: "c0" });
  await h.runner.turnEnded(ID);
  assert.equal(h.reads.length, 1);
  assert.deepEqual(h.timers.map((t) => t.at), [T0 + 4 * MIN]);
});

test("a ping that fails stops the pause quietly", async () => {
  const h = harness();
  h.expiry("c1");
  await h.runner.turnEnded(ID);
  await h.advance(T0 + 4 * MIN);
  const reads = h.reads.length;
  await h.finish({ text: "", toolCalled: false, error: "connection lost" });
  assert.equal(h.phases().at(-1), "off");
  assert.equal(h.timers.length, 0);
  assert.deepEqual(h.notices(), []);
  assert.equal(h.reads.length, reads);
  h.runner.replan(ID);
  assert.equal(h.timers.length, 0, "skipped for the rest of this pause");
});

test("close clears the timer and the state", async () => {
  const h = harness();
  h.expiry("c1");
  await h.runner.turnEnded(ID);
  assert.equal(h.timers.length, 1);
  h.runner.closed(ID);
  assert.equal(h.timers.length, 0);
  assert.equal(h.phases().at(-1), "off");
  await h.advance(T0 + 60 * MIN);
  assert.equal(h.runs.length, 0);
  assert.deepEqual(h.runner.state(ID), { phase: "off", pingsSent: 0, pings: 2, compactAt: null });
});

test("close during an action drops its result", async () => {
  const h = harness({ settings: { pings: 0 } });
  await toCompaction(h);
  h.runner.closed(ID);
  const emitted = h.emitted.length;
  await h.finish({ text: "Compacted conversation history and removed 4 messages.", toolCalled: false, error: null });
  assert.equal(h.emitted.length, emitted);
  assert.equal(h.timers.length, 0);
});

test("a session reopened during a run waits for it", async () => {
  const h = harness();
  h.expiry("c1");
  await h.runner.turnEnded(ID);
  await h.advance(T0 + 4 * MIN);
  assert.equal(h.runs.length, 1);
  h.runner.closed(ID);
  let idle = false;
  const waited = h.runner.whenIdle(ID).then(() => {
    idle = true;
  });
  h.expiry("c2", 2 * MIN); // the next ping would be due at once
  await h.runner.turnEnded(ID);
  assert.equal(h.timers.length, 0);
  await h.advance(h.clock.t + 10 * MIN);
  assert.equal(h.runs.length, 1);
  assert.equal(idle, false);

  h.runs[0].resolve(PING_OK);
  await waited;
  assert.equal(idle, true);
  await h.advance(h.clock.t);
  assert.equal(h.runs.length, 1, "the reopened session's ping time has passed by now: too late");
});

test("a session reopened during a run arms once it settles", async () => {
  const h = harness();
  h.expiry("c1");
  await h.runner.turnEnded(ID);
  await h.advance(T0 + 4 * MIN);
  h.runner.closed(ID);
  h.expiry("c2");
  await h.runner.turnEnded(ID);
  assert.equal(h.timers.length, 0);
  await h.finish();
  assert.deepEqual(h.timers.map((t) => t.at), [T0 + 8 * MIN]);
});

test("close during the checkpoint re-read stops the retries", async () => {
  const h = harness();
  h.expiry("c1");
  await h.runner.turnEnded(ID);
  h.runner.activity(ID);
  const ended = h.runner.turnEnded(ID); // the reader keeps returning c1: a retry waits
  await flush();
  assert.equal(h.timers.length, 1);
  h.runner.closed(ID);
  assert.equal(h.timers.length, 0);
  await ended;
});

test("settings change re-plans the pause", async () => {
  const h = harness();
  h.expiry("c1");
  await h.runner.turnEnded(ID);
  h.expiry("c9");
  await h.runner.turnEnded("s2");
  assert.equal(h.timers.length, 2);
  h.s.enabled = false;
  h.runner.replan();
  assert.equal(h.timers.length, 0);
  h.s.enabled = true;
  h.runner.replan();
  assert.equal(h.timers.length, 2);

  await h.advance(T0 + 4 * MIN);
  h.expiry("c2");
  const exp2 = h.clock.t + 5 * MIN;
  h.runs[0].resolve(PING_OK);
  h.runs[1].resolve(PING_OK);
  await flush();
  await flush();
  assert.equal(h.runner.state(ID).pingsSent, 1);
  h.s.pings = 0;
  h.runner.replan(ID);
  assert.deepEqual(h.runner.state(ID), { phase: "pinging", pingsSent: 1, pings: 0, compactAt: null });
  const mine = h.timers.filter((t) => t.at === exp2 - 2 * MIN);
  assert.equal(mine.length, 1);
  await h.advance(exp2 - 2 * MIN);
  assert.equal(h.runner.state(ID).phase, "countdown");
});

test("the opt-out stops the keeper for that session", async () => {
  const h = harness();
  h.expiry("c1");
  await h.runner.turnEnded(ID);
  h.opted.add(ID);
  h.runner.replan(ID);
  assert.equal(h.timers.length, 0);
});

test("held and busy block", async () => {
  const h = harness();
  h.expiry("c1");
  await h.runner.turnEnded(ID);
  assert.equal(h.timers.length, 1);
  h.runner.setHeld(ID, true);
  assert.equal(h.timers.length, 0);
  assert.equal(h.phases().at(-1), "off");
  h.runner.setHeld(ID, false);
  assert.deepEqual(h.timers.map((t) => t.at), [T0 + 4 * MIN]);

  h.f.busy = true;
  await h.advance(T0 + 4 * MIN);
  assert.equal(h.runs.length, 0);
  assert.equal(h.timers.length, 0);
  assert.equal(h.phases().at(-1), "off");

  h.f.busy = false;
  h.expiry("c2");
  await h.runner.turnEnded(ID);
  assert.equal(h.timers.length, 1);
});

test("no second action while one runs", async () => {
  const h = harness();
  h.expiry("c1");
  await h.runner.turnEnded(ID);
  await h.advance(T0 + 4 * MIN);
  assert.equal(h.runs.length, 1);
  h.runner.setHeld(ID, false);
  h.runner.replan(ID);
  await h.advance(T0 + 10 * MIN);
  assert.equal(h.runs.length, 1);
  assert.equal(h.timers.length, 0);
});

test("opt-out store", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-optout-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "sub", "cache-keeper.json");
  const store = createKeeperOptOut(file);
  assert.equal(store.get("a"), false);
  store.set("a", false);
  assert.equal(fs.existsSync(file), false);
  store.set("a", true);
  assert.equal(store.get("a"), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { a: true });
  store.copy("a", "b");
  store.copy("x", "c");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { a: true, b: true });
  store.delete("a");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { b: true });
  store.set("b", false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {});
  assert.equal(store.get("b"), false);
  fs.writeFileSync(file, "not json");
  assert.equal(store.get("b"), false);
});
