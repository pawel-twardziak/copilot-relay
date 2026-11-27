// Tests for extractMessages / searchMessages in electron/history.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { KEEPALIVE_MARKER } from "../cache-keeper.mjs";
import { extractMessages, REPLAY_HAS_PRE_COMPACTION, searchMessages } from "../history.mjs";

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
    agent("world"),
  );
  const m = extractMessages(text);
  assert.deepEqual(m.map((x) => [x.kind, x.text]), [["user", "hello"], ["agent", "world"]]);
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
