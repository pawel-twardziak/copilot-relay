// Tests for the pure UI-state helpers in electron/renderer/ui-state.js (session list model, zoom, image refs).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const UiState = createRequire(import.meta.url)("../renderer/ui-state.js");
const { listModel } = UiState;

const S = (sessionId, cwd, updatedAt, title = sessionId) => ({ sessionId, cwd, updatedAt, title });
const sessions = [
  S("s1", "/a", "2026-11-01T10:00:00Z"),
  S("s2", "/a", "2026-11-03T10:00:00Z", "foo bar"),
  S("s3", "/b", "2026-11-02T10:00:00Z"),
];
const ids = (list) => list.map((s) => s.sessionId);

test("groups by cwd, newest group and session first", () => {
  const m = listModel(sessions);
  assert.deepEqual(
    m.groups.map((g) => g.cwd),
    ["/a", "/b"],
  );
  assert.deepEqual(ids(m.groups[0].sessions), ["s2", "s1"]);
  assert.deepEqual(m.pinned, []);
});

test("collapsed group keeps its count", () => {
  const m = listModel(sessions, { collapsed: new Set(["/a"]) });
  const a = m.groups.find((g) => g.cwd === "/a");
  assert.equal(a.collapsed, true);
  assert.equal(a.count, 2);
  assert.equal(a.sessions.length, 2);
  assert.equal(m.groups.find((g) => g.cwd === "/b").collapsed, false);
});

test("query expands collapsed groups and filters", () => {
  const m = listModel(sessions, { collapsed: new Set(["/a"]), query: "foo" });
  assert.equal(m.groups.length, 1);
  assert.equal(m.groups[0].collapsed, false);
  assert.deepEqual(ids(m.groups[0].sessions), ["s2"]);
  assert.equal(m.groups[0].count, 1);
});

test("collapsed state is not changed by query", () => {
  const collapsed = new Set(["/a"]);
  listModel(sessions, { collapsed, query: "foo" });
  assert.deepEqual([...collapsed], ["/a"]);
});
