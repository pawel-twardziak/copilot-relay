// Tests for electron/usage.mjs on fixture session dirs in a temp COPILOT_HOME.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createUsagePusher, formatTokens, readQuota, readSessionUsage, summarize } from "../usage.mjs";

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
      used: 109,
      total: 1500,
      remainingPct: 92.7,
      resetDate: "2026-12-01T00:00:00Z",
      unlimited: false,
    });
  });

  test("does not look beyond the tail of a large file", async () => {
    const filler = JSON.stringify({ type: "assistant.message", data: { content: "x".repeat(1000) } }) + "\n";
    put(fixture("events-quota.jsonl") + filler.repeat(3 * 1024));
    assert.equal(await readQuota({ copilotHome: home }), null);
  });

  test("ignores snapshots with missing fields", async () => {
    const snap = (q) => JSON.stringify({ type: "model.model_call_success", data: { quotaSnapshots: { premium_interactions: q } } }) + "\n";
    put(snap({ isUnlimitedEntitlement: false, usedRequests: 5 }));
    assert.equal(await readQuota({ copilotHome: home }), null);
    // an older complete snapshot is used when the newest is incomplete
    put(fixture("events-quota.jsonl") + snap({ isUnlimitedEntitlement: false }));
    assert.equal((await readQuota({ copilotHome: home })).used, 109);
    put(snap({ isUnlimitedEntitlement: true }).replace("{", '{"timestamp":"2027-01-01T00:00:00Z",'));
    assert.equal((await readQuota({ copilotHome: home })).unlimited, true);
  });

  test("returns null when no session has a snapshot", async () => {
    put(fixture("events-basic.jsonl"));
    assert.equal(await readQuota({ copilotHome: home }), null);
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
    const q = { used: 109, total: 1500, remainingPct: 92.7, resetDate: "2026-12-01T00:00:00Z", unlimited: false };
    assert.equal(summarize({ quota: q }).quota, "Premium: 109 / 1500 used · 92.7% left · resets Dec 1");
    assert.equal(summarize({ quota: { ...q, unlimited: true } }).quota, "Premium: unlimited");
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
      readQuota: async () => (calls.quota++, null),
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

  test("pusher caches quota for 60 s", async (t) => {
    const { calls, pusher, tick } = make(t);
    pusher.refresh("s1");
    await tick(300);
    await tick(10_000);
    pusher.refresh("s1");
    await tick(300);
    assert.equal(calls.quota, 1);
    await tick(61_000);
    pusher.refresh("s1");
    await tick(300);
    assert.equal(calls.quota, 2);
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
