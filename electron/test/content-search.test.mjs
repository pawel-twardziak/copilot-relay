// Tests for extractMessages / searchMessages in electron/history.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { KEEPALIVE_MARKER } from "../cache-keeper.mjs";
import { createContentSearch } from "../content-search.mjs";
import { extractMessages, REPLAY_HAS_PRE_COMPACTION, searchMessages } from "../history.mjs";

const FindText = createRequire(import.meta.url)("../renderer/find-text.js");
const ev = (type, data, extra = {}) => JSON.stringify({ type, data, timestamp: "2026-11-27T10:00:00.000Z", ...extra });
const user = (content, extra) => ev("user.message", { content }, extra);
const agent = (content, extra, data) => ev("assistant.message", { content, ...data }, extra);
const file = (...lines) => lines.join("\n") + "\n";

test("extract skips sub-agents, keep-alive and bad lines", () => {
  const text = file(
    user("hello"),
    agent("sub", { agentId: "a1" }),
    user(`${KEEPALIVE_MARKER} The user is away.`),
    "not json but has \"user.message\"",
    user("again"),
    agent("world"),
  );
  const m = extractMessages(text);
  assert.deepEqual(m.map((x) => [x.kind, x.text]), [["user", "hello"], ["user", "again"], ["agent", "world"]]);
  assert.equal(typeof m[0].at, "number");
});

test("partial last line", () => {
  const m = extractMessages(user("hello") + '\n{"type":"user.mess');
  assert.equal(m.length, 1);
});

test("relay header not searchable", () => {
  const m = extractMessages(file(user('[from api-1]\n[folder "/x"]\nhello')));
  assert.equal(searchMessages(m, "api-1").count, 0);
  assert.equal(searchMessages(m, "hello").count, 1);
});

test("k counts occurrences", () => {
  const m = extractMessages(file(user("foo foo"), agent("a foo")));
  const r = searchMessages(m, "foo");
  assert.deepEqual(r.hits.map((h) => h.k), [0, 1, 2]);
  assert.equal(r.count, 3);
  assert.equal(r.latest, Date.parse("2026-11-27T10:00:00.000Z"));
});

test("caps", () => {
  const m = extractMessages(file(user("x ".repeat(10))));
  const r = searchMessages(m, "x");
  assert.equal(r.count, 10);
  assert.equal(r.hits.length, 3);
});

test("compaction marks", () => {
  const m = extractMessages(file(user("foo"), ev("session.compaction_complete", {}), user("foo")));
  assert.equal(m[0].beforeCompaction, true);
  assert.equal(m[1].beforeCompaction, false);
  const hits = searchMessages(m, "foo").hits;
  assert.equal(hits[0].beforeCompaction, true);
  assert.equal(hits[0].k, REPLAY_HAS_PRE_COMPACTION ? 0 : -1);
  assert.equal(hits[1].k, REPLAY_HAS_PRE_COMPACTION ? 1 : 0);
});

test("sub-agent compaction does not move the boundary", () => {
  const m = extractMessages(file(user("a"), ev("session.compaction_complete", {}, { agentId: "x" }), user("b")));
  assert.deepEqual(m.map((x) => x.beforeCompaction), [false, false]);
});

test("cached folded text skips messages without the query", () => {
  const m = extractMessages(file(user("foo bar"), agent("a foo")));
  const plain = searchMessages(m, "foo");
  const folded = m.map((x) => ({ ...x, folded: FindText.foldText(x.text) }));
  assert.deepEqual(searchMessages(folded, "FOO"), plain);
  const wrong = [{ ...folded[0], folded: "nothing" }, folded[1]];
  const r = searchMessages(wrong, "foo");
  assert.equal(r.count, 1);
  assert.deepEqual(r.hits.map((h) => h.k), [0]);
});

// ---- service ----
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const sid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function makeHome(sessions) {
  const home = mkdtempSync(path.join(os.tmpdir(), "content-search-"));
  for (const [id, text] of Object.entries(sessions)) {
    mkdirSync(path.join(home, "session-state", id), { recursive: true });
    writeFileSync(path.join(home, "session-state", id, "events.jsonl"), text);
  }
  return home;
}

/** A service whose worker reads under `home` (main passes copilotHome() with each query). */
function serviceFor(home) {
  const saved = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = home;
  const svc = createContentSearch();
  return {
    ...svc,
    async close() {
      await svc.close();
      if (saved === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = saved;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const at = (iso, content) => ev("user.message", { content }, { timestamp: iso });

test("service finds hits across sessions", async () => {
  const svc = serviceFor(makeHome({
    [SESSION_A]: file(at("2026-11-26T10:00:00.000Z", "alpha foo")),
    [SESSION_B]: file(at("2026-11-27T10:00:00.000Z", "foo foo beta")),
  }));
  try {
    const r = await svc.search("foo", [SESSION_A, SESSION_B]);
    assert.equal(r.cancelled, false);
    assert.equal(r.more, false);
    assert.deepEqual(r.sessions.map((s) => [s.sessionId, s.count]), [[SESSION_B, 2], [SESSION_A, 1]]);
    assert.equal(r.sessions[0].hits.length, 2);
  } finally {
    await svc.close();
  }
});

test("ids limit the scan", async () => {
  const svc = serviceFor(makeHome({ [SESSION_A]: file(user("foo")), [SESSION_B]: file(user("foo")) }));
  try {
    const r = await svc.search("foo", [SESSION_A, "../../etc", "not-a-uuid", sid(999)]);
    assert.deepEqual(r.sessions.map((s) => s.sessionId), [SESSION_A]);
  } finally {
    await svc.close();
  }
});

test("cache follows the file", async () => {
  const home = makeHome({ [SESSION_A]: file(user("foo")) });
  const svc = serviceFor(home);
  try {
    assert.equal((await svc.search("zebra", [SESSION_A])).sessions.length, 0);
    appendFileSync(path.join(home, "session-state", SESSION_A, "events.jsonl"), user("a zebra") + "\n");
    const r = await svc.search("zebra", [SESSION_A]);
    assert.equal(r.sessions[0].count, 1);
  } finally {
    await svc.close();
  }
});

test("newer query cancels", async () => {
  const sessions = {};
  for (let i = 0; i < 300; i++) sessions[sid(i)] = file(user("word ".repeat(2000)), agent("foo ".repeat(2000)));
  const svc = serviceFor(makeHome(sessions));
  try {
    const ids = Object.keys(sessions);
    const first = svc.search("foo", ids);
    const second = svc.search("word", ids);
    assert.deepEqual(await first, { cancelled: true });
    const r = await second;
    assert.equal(r.cancelled, false);
    assert.equal(r.sessions.length, 50);
  } finally {
    await svc.close();
  }
});

test("50+ sessions", async () => {
  const sessions = {};
  for (let i = 0; i < 60; i++) sessions[sid(i)] = file(user("needle"));
  const svc = serviceFor(makeHome(sessions));
  try {
    const r = await svc.search("needle", Object.keys(sessions));
    assert.equal(r.sessions.length, 50);
    assert.equal(r.more, true);
  } finally {
    await svc.close();
  }
});

test("a query too short for the trimmed text finds nothing and close is idempotent", async () => {
  const svc = serviceFor(makeHome({ [SESSION_A]: file(user("foo")) }));
  assert.equal((await svc.search("   ", [SESSION_A])).sessions.length, 0);
  await svc.close();
  await svc.close();
});

test("a keep-alive turn's replies and the compact reply are not searched", () => {
  const m = extractMessages(file(
    user("needle first"),
    user(`${KEEPALIVE_MARKER} The user is away.`),
    agent("needle ."),
    user("real question"),
    agent("Compacted conversation history needle"),
    agent("a needle"),
  ));
  assert.deepEqual(m.map((x) => x.text), ["needle first", "real question", "a needle"]);
  const r = searchMessages(m, "needle");
  assert.equal(r.count, 2);
  assert.deepEqual(r.hits.map((h) => h.k), [0, 1]);
});
