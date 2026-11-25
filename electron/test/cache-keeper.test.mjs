import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PING_LEAD_MS, COUNTDOWN_LEAD_MS, COMPACT_LEAD_MS, KEEPALIVE_MARKER,
  isKeepAlive, keepAliveText, compactText, normalizeKeeperSettings, initialState, reduce, next,
} from "../cache-keeper.mjs";

const T = Date.parse("2026-11-25T10:00:00Z");
const exp = T + 300_000;
const S = { enabled: true, pings: 6, minContext: 50_000 };
const F = { enabled: true, busy: false, held: false, replaying: false, contextUsed: 160_000 };
const NONE = { action: "none", at: null };
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

test("the countdown starts at once when its time has passed but compaction still fits", () => {
  const now = exp - 90_000;
  assert.deepEqual(next({ state: started(), now, settings: { ...S, pings: 0 }, facts: F }), { action: "countdown", at: now });
});

test("too late does nothing", () => {
  assert.deepEqual(next({ state: started(), now: exp - 59_000, settings: S, facts: F }), NONE);
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
  const base = "/compact Quote verbatim the last user message and your last answer.";
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
});

test("leads can be overridden", () => {
  const leads = { ping: 3000, countdown: 5000, compact: 2000 };
  const st = started();
  assert.deepEqual(next({ state: st, now: T, settings: S, facts: F, leads }), { action: "ping", at: exp - 3000 });
  assert.deepEqual(next({ state: st, now: T, settings: { ...S, pings: 0 }, facts: F, leads }), { action: "countdown", at: exp - 5000 });
  assert.deepEqual(next({ state: { ...st, phase: "countdown" }, now: T, settings: S, facts: F, leads }),
    { action: "compact", at: exp - 2000 });
});
