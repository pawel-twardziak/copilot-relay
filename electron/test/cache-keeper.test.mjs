import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PING_LEAD_MS, LATE_MS, COUNTDOWN_LEAD_MS, COMPACT_LEAD_MS, CATCHUP_MS, KEEPALIVE_MARKER,
  isKeepAlive, keepAliveText, createReplayFilter, compactText, normalizeKeeperSettings, initialState, reduce, next,
} from "../cache-keeper.mjs";

const T = Date.parse("2026-11-25T10:00:00Z");
const exp = T + 300_000;
const S = { enabled: true, pings: 6, minContext: 50_000 };
const F = { enabled: true, busy: false, held: false, replaying: false, contextUsed: 160_000 };
const NONE = { action: "none", at: null };
const MISSED = { action: "none", at: null, missed: true };
const started = () => reduce(initialState(), { type: "turnEnded", expiresAt: exp });

test("a pause pings N times 60 s before expiry, then counts down and compacts", () => {
  let st = started();
  assert.deepEqual(next({ state: st, now: T, settings: S, facts: F }), { action: "ping", at: exp - 60_000 });
  let expiresAt = exp;
  for (let i = 0; i < 6; i++) {
    const at = expiresAt - 60_000;
    expiresAt = at + 300_000;
    st = reduce(st, { type: "pingEnded", expiresAt });
  }
  assert.equal(st.pingsSent, 6);
  assert.deepEqual(next({ state: st, now: T, settings: S, facts: F }), { action: "countdown", at: expiresAt - 120_000 });
  st = { ...st, phase: "countdown" };
  assert.deepEqual(next({ state: st, now: expiresAt - 120_000, settings: S, facts: F }),
    { action: "compact", at: expiresAt - 60_000 });
});

test("no pings when pings is 0", () => {
  assert.deepEqual(next({ state: started(), now: T, settings: { ...S, pings: 0 }, facts: F }),
    { action: "countdown", at: exp - 120_000 });
});

test("a countdown a little late starts at once; one later than the catch-up is missed", () => {
  const countdownAt = exp - 120_000;
  const s0 = { ...S, pings: 0 };
  let now = countdownAt + 1_000;
  assert.deepEqual(next({ state: started(), now, settings: s0, facts: F }), { action: "countdown", at: now });
  now = countdownAt + 2_001;
  assert.deepEqual(next({ state: started(), now, settings: s0, facts: F }), MISSED);
  assert.equal(CATCHUP_MS, 2_000);
});

test("in the countdown a compaction a little late is due now; one later than the catch-up is missed", () => {
  const st = { ...started(), phase: "countdown" };
  const compactAt = exp - 60_000;
  assert.deepEqual(next({ state: st, now: compactAt + 1_000, settings: S, facts: F }), { action: "compact", at: compactAt });
  assert.deepEqual(next({ state: st, now: compactAt + 2_001, settings: S, facts: F }), MISSED);
});

test("a late ping is still due now, past the catch-up too", () => {
  const pingAt = exp - 60_000;
  assert.deepEqual(next({ state: started(), now: pingAt + 20_000, settings: S, facts: F }), { action: "ping", at: pingAt });
});

test("the catch-up can be overridden", () => {
  const leads = { catchup: 500 };
  const compactAt = exp - 60_000;
  const st = { ...started(), phase: "countdown" };
  assert.deepEqual(next({ state: st, now: compactAt + 400, settings: S, facts: F, leads }), { action: "compact", at: compactAt });
  assert.deepEqual(next({ state: st, now: compactAt + 600, settings: S, facts: F, leads }), MISSED);
});

test("too late does nothing", () => {
  assert.deepEqual(next({ state: started(), now: exp - 29_000, settings: S, facts: F }), NONE);
  assert.deepEqual(next({ state: started(), now: exp - 29_000, settings: { ...S, pings: 0 }, facts: F }), NONE);
  assert.equal(LATE_MS, 30_000);
  assert.deepEqual(next({ state: initialState(), now: T, settings: S, facts: F }), NONE);
});

test("each fact or setting can stop it", () => {
  const st = started();
  const run = (o) => next({ state: o.state ?? st, now: T, settings: o.settings ?? S, facts: { ...F, ...o.facts } });
  for (const facts of [{ enabled: false }, { busy: true }, { held: true }, { replaying: true }, { contextUsed: 49_999 }]) {
    assert.deepEqual(run({ facts }), NONE, JSON.stringify(facts));
  }
  assert.deepEqual(run({ settings: { ...S, enabled: false } }), NONE);
  assert.deepEqual(run({ state: { ...st, skipped: true } }), NONE);
  assert.deepEqual(run({ state: { ...st, phase: "done" } }), NONE);
  assert.deepEqual(run({ facts: { contextUsed: undefined } }), NONE);
  assert.equal(run({ facts: { contextUsed: 50_000 } }).action, "ping");
});

test("Not now skips the rest of the pause, the next turn starts a new one", () => {
  const st = reduce(started(), { type: "notNow" });
  assert.deepEqual(next({ state: st, now: T, settings: S, facts: F }), NONE);
  const again = reduce(st, { type: "turnEnded", expiresAt: exp });
  assert.equal(again.pingsSent, 0);
  assert.equal(again.skipped, false);
  assert.equal(next({ state: again, now: T, settings: S, facts: F }).action, "ping");
});

test("activity resets the count and waits for a turn", () => {
  let st = started();
  for (let i = 0; i < 3; i++) st = reduce(st, { type: "pingEnded", expiresAt: exp + i });
  st = reduce(st, { type: "activity" });
  assert.equal(st.pingsSent, 0);
  assert.equal(st.expiresAt, null);
  assert.deepEqual(next({ state: st, now: T, settings: S, facts: F }), NONE);
});

test("after a compaction the pause is done", () => {
  let st = reduce({ ...started(), phase: "compacting" }, { type: "compactEnded" });
  assert.equal(st.phase, "done");
  st = { ...st, expiresAt: exp };
  assert.deepEqual(next({ state: st, now: T, settings: S, facts: F }), NONE);
  st = reduce(st, { type: "turnEnded", expiresAt: exp });
  assert.equal(next({ state: st, now: T, settings: S, facts: F }).action, "ping");
});

test("texts", () => {
  assert.ok(keepAliveText().startsWith(KEEPALIVE_MARKER));
  assert.equal(keepAliveText(),
    "[keep-alive] The user is away. Reply with a single dot. Do not use any tool and do not continue any task.");
  const base =
    "/compact Ignore the messages that start with [keep-alive] and their one-dot replies. Quote verbatim the last other user message and your answer to it.";
  assert.equal(compactText({ parent: false }), base);
  assert.equal(compactText({ parent: true }),
    base + " For each delegated child session, keep verbatim what you asked it to do and how you planned to check its result.");
  assert.ok(isKeepAlive(keepAliveText()));
  assert.ok(isKeepAlive("<current_datetime>x</current_datetime> " + keepAliveText()));
  assert.ok(isKeepAlive("  \n" + keepAliveText()));
  assert.ok(!isKeepAlive("hello [keep-alive]"));
  assert.equal([PING_LEAD_MS, COUNTDOWN_LEAD_MS, COMPACT_LEAD_MS].join(), "60000,120000,60000");
});

test("settings are normalised", () => {
  assert.deepEqual(normalizeKeeperSettings(undefined), { enabled: false, pings: 6, minContext: 50_000 });
  assert.equal(normalizeKeeperSettings({ enabled: true, pings: "" }).pings, 0);
  assert.equal(normalizeKeeperSettings({ pings: -2 }).pings, 0);
  assert.equal(normalizeKeeperSettings({ pings: 2.7 }).pings, 2);
  assert.equal(normalizeKeeperSettings({ minContext: "abc" }).minContext, 50_000);
  assert.equal(normalizeKeeperSettings({ enabled: true }).enabled, true);
  assert.equal(normalizeKeeperSettings({ pings: 600 }).pings, 20);
  assert.equal(normalizeKeeperSettings({ pings: 20 }).pings, 20);
});

test("leads can be overridden", () => {
  const leads = { ping: 3000, countdown: 5000, compact: 2000 };
  const st = started();
  assert.deepEqual(next({ state: st, now: T, settings: S, facts: F, leads }), { action: "ping", at: exp - 3000 });
  assert.deepEqual(next({ state: st, now: T, settings: { ...S, pings: 0 }, facts: F, leads }), { action: "countdown", at: exp - 5000 });
  assert.deepEqual(next({ state: { ...st, phase: "countdown" }, now: T, settings: S, facts: F, leads }),
    { action: "compact", at: exp - 2000 });
});

test("a late timer still acts", () => {
  const st = started();
  assert.deepEqual(next({ state: st, now: exp - 60_000 + 5, settings: S, facts: F }), { action: "ping", at: exp - 60_000 });
  assert.deepEqual(next({ state: { ...st, phase: "countdown" }, now: exp - 60_000 + 5, settings: S, facts: F }),
    { action: "compact", at: exp - 60_000 });
});

test("overridden late moves the cutoff", () => {
  const leads = { ping: 3000, countdown: 5000, compact: 2000, late: 1000 };
  assert.deepEqual(next({ state: started(), now: exp - 2500, settings: S, facts: F, leads }), { action: "ping", at: exp - 3000 });
  assert.deepEqual(next({ state: started(), now: exp - 900, settings: S, facts: F, leads }), NONE);
});

test("one ping, then the countdown", () => {
  const s1 = { ...S, pings: 1 };
  let st = started();
  assert.equal(next({ state: st, now: T, settings: s1, facts: F }).action, "ping");
  const e2 = exp - 60_000 + 300_000;
  st = reduce(st, { type: "pingEnded", expiresAt: e2 });
  assert.deepEqual(next({ state: st, now: exp, settings: s1, facts: F }), { action: "countdown", at: e2 - 120_000 });
});

const user = (text) => ({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
const agent = (text) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

test("the replay filter swallows a ping span", () => {
  const seq = [
    user("a"), agent("A."),
    user(keepAliveText()), agent("."), { sessionUpdate: "tool_call", toolCallId: "t" },
    user("b"), agent("B."),
  ];
  const f = createReplayFilter();
  assert.deepEqual(seq.filter((u) => f.pass(u)), [seq[0], seq[1], seq[5], seq[6]]);
});

test("the replay filter swallows the compact reply", () => {
  const f = createReplayFilter();
  const reply = agent("Compacted conversation history and removed 4 messages and 900 tokens.");
  assert.equal(f.pass(user("a")), true);
  assert.equal(f.pass(reply), false);
  assert.equal(f.pass(agent("Normal answer")), true);
});

test("the replay filter lets session state through inside a ping span", () => {
  const f = createReplayFilter();
  const state = [{ sessionUpdate: "available_commands_update", availableCommands: [] }, { sessionUpdate: "usage_update", used: 1, size: 2 }];
  assert.equal(f.pass(user(keepAliveText())), false);
  assert.equal(f.pass(agent(".")), false);
  assert.equal(f.pass({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "t" } }), false);
  assert.equal(f.pass({ sessionUpdate: "plan", entries: [] }), false);
  assert.equal(f.pass({ sessionUpdate: "tool_call_update", toolCallId: "t" }), false);
  for (const u of state) assert.equal(f.pass(u), true);
});
