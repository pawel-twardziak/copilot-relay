// Tests for electron/usage.mjs on fixture session dirs in a temp COPILOT_HOME.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createQuotaService, createUsagePusher, formatTokens, pickPool, quotaLine, quotaView, readLiveQuota, readQuota, readSessionUsage, summarize } from "../usage.mjs";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "usage");
let root;
let home;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-test-"));
  home = path.join(root, "home ł");
  fs.mkdirSync(path.join(home, "session-state"), { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function put(content, id = randomUUID()) {
  const dir = path.join(home, "session-state", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "events.jsonl"), content);
  return id;
}
const fixture = (name) => fs.readFileSync(path.join(FIX, name), "utf8");
const BASIC = {
  premiumRequests: 1,
  linesAdded: 12,
  linesRemoved: 3,
};

describe("readSessionUsage", () => {
  test("reads the last complete checkpoint", async () => {
    const id = put(fixture("events-basic.jsonl"));
    const u = await readSessionUsage(id, { copilotHome: home });
    assert.ok(Math.abs(u.aiCredits - 3.86373) < 1e-9);
    assert.equal(u.premiumRequests, BASIC.premiumRequests);
    assert.equal(u.tokens.input, 31081);
    assert.equal(u.tokens.output, 4);
    assert.equal(u.tokens.cacheRead, 16293);
    assert.equal(u.tokens.cacheWrite, 14784);
    assert.equal(u.tokens.reasoning, 0);
    assert.equal(u.linesAdded, BASIC.linesAdded);
    assert.equal(u.linesRemoved, BASIC.linesRemoved);
  });

  test("returns null for a missing file", async () => {
    assert.equal(await readSessionUsage(randomUUID(), { copilotHome: home }), null);
  });

  test("returns null for a file with only garbage lines", async () => {
    const id = put("garbage\n{not json\n");
    assert.equal(await readSessionUsage(id, { copilotHome: home }), null);
  });

  test("rejects a session id that is not a UUID", async () => {
    put(fixture("events-basic.jsonl"), randomUUID());
    assert.equal(await readSessionUsage("../x", { copilotHome: home }), null);
    assert.equal(await readSessionUsage("not-a-uuid", { copilotHome: home }), null);
  });

  test("finds a checkpoint far from the end", async () => {
    const filler = JSON.stringify({ type: "assistant.message", data: { content: "x".repeat(1000) } }) + "\n";
    const id = put(fixture("events-basic.jsonl").replace(/\{"type":"session.usage_chec\n?$/, "") + filler.repeat(3 * 1024));
    const u = await readSessionUsage(id, { copilotHome: home });
    assert.ok(Math.abs(u.aiCredits - 3.86373) < 1e-9);
    assert.equal(u.linesAdded, 12);
  });

  test("tolerates a checkpoint without accountingSnapshot", async () => {
    const id = put(JSON.stringify({ type: "session.usage_checkpoint", data: { totalNanoAiu: 2e9 } }) + "\n");
    const u = await readSessionUsage(id, { copilotHome: home });
    assert.equal(u.aiCredits, 2);
    assert.equal(u.tokens, null);
    assert.equal(u.linesAdded, null);
  });

  test("memoizes by size+mtime so an unchanged file is not re-read", async () => {
    const orig = fixture("events-basic.jsonl");
    const id = put(orig);
    const file = path.join(home, "session-state", id, "events.jsonl");
    fs.utimesSync(file, 1_700_000_000, 1_700_000_000); // whole-second mtime so it can be restored exactly
    const first = await readSessionUsage(id, { copilotHome: home });
    const st = fs.statSync(file);
    // same size and mtime, different content: only a cache hit returns the old value
    fs.writeFileSync(file, orig.replaceAll('"totalPremiumRequests":1', '"totalPremiumRequests":7'));
    fs.utimesSync(file, 1_700_000_000, 1_700_000_000);
    assert.equal(fs.statSync(file).size, st.size);
    assert.equal((await readSessionUsage(id, { copilotHome: home })).premiumRequests, first.premiumRequests);
    // a real change (new size) invalidates
    fs.appendFileSync(file, "\n");
    assert.equal((await readSessionUsage(id, { copilotHome: home })).premiumRequests, 7);
  });

  test("honours COPILOT_HOME", async () => {
    const id = put(fixture("events-basic.jsonl"));
    const prev = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = home;
    try {
      assert.equal((await readSessionUsage(id)).premiumRequests, 1);
    } finally {
      if (prev === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = prev;
    }
  });
});

describe("readQuota", () => {
  test("returns the newest premium snapshot", async () => {
    put(fixture("events-quota.jsonl"));
    assert.deepEqual(await readQuota({ copilotHome: home }), {
      quota: { pool: "premium", used: 109, total: 1500, remainingPct: 92.7, resetDate: "2026-12-01T00:00:00Z", unlimited: false, tokenBased: false },
      at: Date.parse("2026-11-01T10:03:00.000Z"),
    });
  });

  test("a missing or unparseable timestamp gives at: null", async () => {
    put(JSON.stringify({ type: "x", data: { quotaSnapshots: { premium_interactions: { isUnlimitedEntitlement: false, entitlementRequests: 10, usedRequests: 1, remainingPercentage: 90 } } } }) + "\n");
    assert.equal((await readQuota({ copilotHome: home })).at, null);
  });

  test("picks chat from a file snapshot when premium is 0", async () => {
    const line = JSON.stringify({
      type: "model.model_call_success",
      timestamp: "2026-11-02T10:00:00.000Z",
      data: { quotaSnapshots: {
        premium_interactions: { isUnlimitedEntitlement: false, entitlementRequests: 0, usedRequests: 0, remainingPercentage: 0, resetDate: "2026-12-01T00:00:00Z" },
        chat: { isUnlimitedEntitlement: false, entitlementRequests: 200, usedRequests: 13, remainingPercentage: 93.6, resetDate: "2026-12-01T00:00:00Z", tokenBasedBilling: true },
      } },
    }) + "\n";
    put(line);
    const r = await readQuota({ copilotHome: home });
    assert.equal(r.quota.pool, "chat");
    assert.equal(r.quota.total, 200);
    assert.equal(r.at, Date.parse("2026-11-02T10:00:00.000Z"));
  });

  test("does not look beyond the tail of a large file", async () => {
    const filler = JSON.stringify({ type: "assistant.message", data: { content: "x".repeat(1000) } }) + "\n";
    put(fixture("events-quota.jsonl") + filler.repeat(3 * 1024));
    assert.equal(await readQuota({ copilotHome: home }), null);
  });

  test("ignores snapshots with missing fields", async () => {
    const snap = (q) => JSON.stringify({ type: "model.model_call_success", data: { quotaSnapshots: { premium_interactions: q } } }) + "\n";
    put(snap({ isUnlimitedEntitlement: false, entitlementRequests: 1500, remainingPercentage: 5, resetDate: "2026-12-01T00:00:00Z" }));
    assert.equal(await readQuota({ copilotHome: home }), null);
    // an older complete snapshot is used when the newest is incomplete
    put(fixture("events-quota.jsonl") + snap({ isUnlimitedEntitlement: false }));
    assert.equal((await readQuota({ copilotHome: home })).quota.used, 109);
    put(snap({ isUnlimitedEntitlement: true }).replace("{", '{"timestamp":"2027-01-01T00:00:00Z",'));
    assert.equal((await readQuota({ copilotHome: home })).quota.unlimited, true);
  });

  test("returns null when no session has a snapshot", async () => {
    put(fixture("events-basic.jsonl"));
    assert.equal(await readQuota({ copilotHome: home }), null);
  });
});

describe("pickPool", () => {
  const snap = (o) => ({ isUnlimitedEntitlement: false, entitlementRequests: 1500, usedRequests: 533, remainingPercentage: 64.5, resetDate: "2026-12-01T00:00:00Z", ...o });
  test("premium with an entitlement wins", () => {
    assert.deepEqual(pickPool({ premium_interactions: snap(), chat: snap({ entitlementRequests: 200 }) }),
      { pool: "premium", used: 533, total: 1500, remainingPct: 64.5, resetDate: "2026-12-01T00:00:00Z", unlimited: false, tokenBased: false });
  });
  test("premium 0 falls to chat", () => {
    const p = pickPool({ premium_interactions: snap({ entitlementRequests: 0, usedRequests: 0 }), chat: snap({ entitlementRequests: 200, usedRequests: 13, remainingPercentage: 93.6, tokenBasedBilling: true }), completions: snap({ entitlementRequests: 2000 }) });
    assert.equal(p.pool, "chat"); assert.equal(p.total, 200); assert.equal(p.tokenBased, true);
  });
  test("only completions → null", () => assert.equal(pickPool({ premium_interactions: snap({ entitlementRequests: 0 }), chat: snap({ entitlementRequests: 0 }), completions: snap() }), null));
  test("unlimited premium", () => assert.equal(pickPool({ premium_interactions: { isUnlimitedEntitlement: true, entitlementRequests: -1 } }).unlimited, true));
  test("a missing number makes a pool invalid", () => assert.equal(pickPool({ premium_interactions: snap({ usedRequests: undefined }) }), null));
  test("a missing resetDate is allowed", () => assert.equal(pickPool({ premium_interactions: snap({ resetDate: undefined }) }).resetDate, ""));
  test("null / non-object → null", () => { assert.equal(pickPool(null), null); assert.equal(pickPool("x"), null); });
});

describe("quotaLine", () => {
  const P = { pool: "premium", used: 533, total: 1500, remainingPct: 64.5, resetDate: "2026-12-01T00:00:00Z", unlimited: false, tokenBased: false };
  test("formats", () => {
    assert.equal(quotaLine(P), "Premium: 533 / 1500 used · 64.5% left · resets Dec 1");
    assert.equal(quotaLine({ ...P, pool: "chat", used: 13, total: 200, remainingPct: 93.6, tokenBased: true }), "Chat: 13 / 200 used · 93.6% left");
    assert.equal(quotaLine({ ...P, used: 187.25 }), "Premium: 187.3 / 1500 used · 64.5% left · resets Dec 1");
    assert.equal(quotaLine({ ...P, unlimited: true }), "Premium: unlimited");
    assert.equal(quotaLine({ ...P, pool: "chat", unlimited: true }), "Chat: unlimited");
    assert.equal(quotaLine(P, { at: Date.UTC(2026, 10, 25, 18, 5), timeZone: "UTC" }), "Premium: 533 / 1500 used · 64.5% left · resets Dec 1 · as of 18:05");
    assert.equal(quotaLine({ ...P, resetDate: "nonsense" }), "Premium: 533 / 1500 used · 64.5% left");
    assert.equal(quotaLine(null), null);
  });
  test("unlimited keeps the age", () => {
    assert.equal(quotaLine({ ...P, pool: "chat", unlimited: true }, { at: Date.UTC(2026, 10, 25, 18, 5), timeZone: "UTC" }), "Chat: unlimited · as of 18:05");
  });
});

const snap = (o) => ({ isUnlimitedEntitlement: false, entitlementRequests: 1500, usedRequests: 533, remainingPercentage: 64.5, resetDate: "2026-12-01T00:00:00Z", ...o });
const qpick = { pool: "chat", used: 13, total: 200, remainingPct: 93.6, resetDate: "", unlimited: false, tokenBased: true };
const ppick = { pool: "premium", used: 533, total: 1500, remainingPct: 64.5, resetDate: "2026-12-01T00:00:00Z", unlimited: false, tokenBased: false };

describe("createQuotaService", () => {
  function svc(over = {}) {
    let t = 1_000_000;
    const calls = { live: 0, file: 0 };
    const changes = [];
    const clock = { advance: (ms) => (t += ms), now: () => t };
    const liveFn = over.live ?? (async () => qpick);
    const service = createQuotaService({
      readLive: async () => (calls.live++, liveFn()),
      readFile: async () => (calls.file++, over.file ?? null),
      now: clock.now,
      onChange: (s) => changes.push(s),
    });
    return { service, calls, changes, clock };
  }
  test("live wins", async () => {
    const { service } = svc();
    assert.deepEqual(await service.get(), { quota: qpick, source: "live", at: null, reason: null });
  });
  test("live fails -> last live with its time", async () => {
    let fail = false;
    const { service, clock } = svc({ live: async () => { if (fail) throw new Error("boom"); return qpick; } });
    const t0 = clock.now();
    await service.get();
    fail = true;
    clock.advance(61_000);
    assert.deepEqual(await service.get(), { quota: qpick, source: "earlier", at: t0, reason: "boom" });
  });
  test("last live older than 1 h -> fresh file", async () => {
    let fail = false;
    const file = { quota: ppick, at: 0 };
    const { service, clock } = svc({ live: async () => { if (fail) throw new Error("boom"); return qpick; }, file });
    const t0 = clock.now();
    await service.get();
    fail = true;
    clock.advance(3_600_001);
    file.at = t0 + 3_590_000;
    assert.deepEqual(await service.get(), { quota: ppick, source: "file", at: t0 + 3_590_000, reason: "boom" });
  });
  test("no live ever -> file under 1 h", async () => {
    const { service, clock } = svc({ live: async () => { throw new Error("boom"); }, file: { quota: ppick, at: 1_000_000 - 60_000 } });
    const s = await service.get();
    assert.equal(s.source, "file");
    assert.equal(s.at, clock.now() - 60_000);
  });
  test("file older than 1 h -> none", async () => {
    const { service } = svc({ live: async () => { throw new Error("boom"); }, file: { quota: ppick, at: 1_000_000 - 3_600_001 } });
    assert.deepEqual(await service.get(), { quota: null, source: null, at: null, reason: "boom" });
  });
  test("a file result with no time is too old", async () => {
    const { service } = svc({ live: async () => { throw new Error("boom"); }, file: { quota: ppick, at: null } });
    assert.equal((await service.get()).quota, null);
  });
  test("live none is final", async () => {
    const { service, calls } = svc({ live: async () => null, file: { quota: ppick, at: 1_000_000 } });
    assert.deepEqual(await service.get(), { quota: null, source: "live", at: null, reason: null });
    assert.equal(calls.file, 0);
  });
  test("cached 60 s, success and failure", async () => {
    for (const live of [async () => qpick, async () => { throw new Error("boom"); }]) {
      const { service, calls, clock } = svc({ live });
      await service.get();
      clock.advance(59_999);
      await service.get();
      assert.equal(calls.live, 1);
      clock.advance(1);
      await service.get();
      assert.equal(calls.live, 2);
    }
  });
  test("force skips the cache", async () => {
    const { service, calls } = svc();
    await service.get();
    await service.get({ force: true });
    assert.equal(calls.live, 2);
  });
  test("onChange only on a different state", async () => {
    let fail = false;
    const { service, changes, clock } = svc({ live: async () => { if (fail) throw new Error("boom"); return qpick; } });
    await service.get();
    await service.get({ force: true });
    assert.equal(changes.length, 1);
    fail = true;
    clock.advance(1);
    await service.get({ force: true });
    assert.equal(changes.length, 2);
  });
});

describe("readLiveQuota", () => {
  test("times out", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const runtime = { withClient: () => new Promise(() => {}) };
    const p = readLiveQuota({ runtime, command: "copilot" });
    t.mock.timers.tick(10_000);
    await assert.rejects(p, /did not answer in 10 s/);
  });
  test("picks from quotaSnapshots", async () => {
    const client = { rpc: { account: { getQuota: async () => ({ quotaSnapshots: { chat: snap({ entitlementRequests: 200 }) } }) } } };
    const runtime = { withClient: async ({ command }, fn) => (assert.equal(command, "copilot"), fn(client)) };
    assert.equal((await readLiveQuota({ runtime, command: "copilot" })).pool, "chat");
  });
  test("propagates a start error", async () => {
    const runtime = { withClient: async () => { throw new Error("no start"); } };
    await assert.rejects(readLiveQuota({ runtime, command: "c" }), /no start/);
  });
});

describe("quotaView", () => {
  test("live", () => {
    assert.deepEqual(quotaView({ quota: qpick, source: "live", at: null, reason: null }), { line: "Chat: 13 / 200 used · 93.6% left", tooltip: "Live from Copilot" });
  });
  test("earlier and file", () => {
    const at = Date.UTC(2026, 10, 25, 18, 5);
    assert.equal(quotaView({ quota: qpick, source: "earlier", at, reason: "boom" }, { timeZone: "UTC" }).tooltip, "Last live figure; live query failed: boom");
    const f = quotaView({ quota: ppick, source: "file", at, reason: "boom" }, { timeZone: "UTC" });
    assert.equal(f.line, "Premium: 533 / 1500 used · 64.5% left · resets Dec 1 · as of 18:05");
    assert.equal(f.tooltip, "From a session file; live query failed: boom");
  });
  test("none", () => {
    assert.equal(quotaView({ quota: null, source: null, at: null, reason: "boom" }), null);
    assert.equal(quotaView(null), null);
  });
});

test("formatTokens", () => {
  const cases = [[0, "0"], [4, "4"], [999, "999"], [22899, "22.9k"], [16293, "16.3k"], [200000, "200k"], [1250000, "1.25M"]];
  for (const [n, s] of cases) assert.equal(formatTokens(n), s);
});

describe("summarize", () => {
  const session = {
    aiCredits: 3.86373,
    premiumRequests: 1,
    tokens: { input: 31081, output: 4, cacheRead: 16293, cacheWrite: 14784, reasoning: 0 },
    linesAdded: 12,
    linesRemoved: 3,
  };

  test("context", () => {
    assert.deepEqual(summarize({ context: { used: 22899, size: 200000 } }).context, {
      label: "22.9k / 200k · 11%",
      pct: 11,
      level: "ok",
    });
    assert.equal(summarize({ context: { used: 152000, size: 200000 } }).context.level, "ok");
    assert.equal(summarize({ context: { used: 188000, size: 200000 } }).context.level, "warn");
    assert.equal(summarize({ context: { used: 160000, size: 200000 } }).context.level, "warn");
    assert.equal(summarize({ context: { used: 190000, size: 200000 } }).context.level, "full");
    const over = summarize({ context: { used: 210000, size: 200000 } }).context;
    assert.equal(over.pct, 100);
    assert.equal(over.level, "full");
    assert.equal(summarize({ context: { used: 5, size: 0 } }).context, null);
    assert.equal(summarize({ context: null }).context, null);
  });

  test("session", () => {
    const v = summarize({ session });
    assert.equal(v.credits, "3.86 AI credits");
    assert.ok(v.tooltip.includes("Requests: 1 premium"));
    assert.ok(v.tooltip.includes("Tokens: input 31.1k, output 4, cached 16.3k"));
    assert.ok(v.tooltip.includes("Changes: +12 −3"));
    const noTok = summarize({ session: { ...session, tokens: null } });
    assert.ok(!noTok.tooltip.includes("Tokens"));
    const sparse = summarize({ session: { aiCredits: null, premiumRequests: null, tokens: null, linesAdded: null, linesRemoved: null } });
    for (const s of [v.credits, v.tooltip, noTok.tooltip, noTok.credits, sparse.credits, sparse.tooltip]) {
      if (s !== null) assert.doesNotMatch(s, /NaN|undefined|null/);
    }
  });

  test("quota", () => {
    const q = { pool: "premium", used: 109, total: 1500, remainingPct: 92.7, resetDate: "2026-12-01T00:00:00Z", unlimited: false, tokenBased: false };
    const live = (quota) => ({ quota, source: "live", at: null, reason: null });
    assert.equal(summarize({ quota: live(q) }).quota, "Premium: 109 / 1500 used · 92.7% left · resets Dec 1");
    assert.equal(summarize({ quota: live({ ...q, unlimited: true }) }).quota, "Premium: unlimited");
    assert.equal(summarize({ quota: null }).quota, null);
  });

  test("nothing", () => {
    assert.deepEqual(summarize({}), { context: null, credits: null, tooltip: "", quota: null });
  });
});

describe("createUsagePusher", () => {
  function make(t, over = {}) {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const sent = [];
    const calls = { session: 0, quota: 0 };
    const pusher = createUsagePusher({
      send: (id, view) => sent.push({ id, view }),
      readSession: async () => (calls.session++, null),
      quota: async () => (calls.quota++, null),
      ...over,
    });
    // timers fire synchronously on tick; let the async readers settle afterwards
    const tick = async (ms) => {
      t.mock.timers.tick(ms);
      for (let i = 0; i < 10; i++) await Promise.resolve();
    };
    return { sent, calls, pusher, tick };
  }

  test("pusher debounces bursts into one send", async (t) => {
    const { sent, pusher, tick } = make(t);
    for (let i = 1; i <= 5; i++) {
      pusher.context("s1", { used: i * 1000, size: 200000 });
      await tick(20);
    }
    await tick(300);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].view.context.label, summarize({ context: { used: 5000, size: 200000 } }).context.label);
  });

  test("pusher keeps the latest context across refreshes", async (t) => {
    const { sent, pusher, tick } = make(t);
    pusher.context("s1", { used: 22899, size: 200000 });
    await tick(300);
    pusher.refresh("s1");
    await tick(300);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].view.context.pct, 11);
  });

  test("forget cancels pending sends", async (t) => {
    const { sent, pusher, tick } = make(t);
    pusher.refresh("s1");
    pusher.forget("s1");
    await tick(1000);
    assert.equal(sent.length, 0);
  });

  test("forget during an in-flight read sends nothing", async (t) => {
    let release;
    const { sent, pusher, tick } = make(t, { readSession: () => new Promise((r) => (release = r)) });
    pusher.refresh("s1");
    await tick(300);
    pusher.forget("s1");
    release(null);
    await tick(10);
    assert.equal(sent.length, 0);
  });

  test("a failing reader yields a view, not an exception", async (t) => {
    const { sent, pusher, tick } = make(t, {
      readSession: async () => {
        throw new Error("boom");
      },
    });
    pusher.refresh("s1");
    await tick(300);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].view.credits, null);
  });
});
