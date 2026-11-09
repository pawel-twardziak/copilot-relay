// Tests for the pure UI-state helpers in electron/renderer/ui-state.js (session list model, zoom, image refs).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const UiState = createRequire(import.meta.url)("../renderer/ui-state.js");
const { listModel, stepScale, imageMentions, fitScale, zoomAt, acceptDelivery, deliveryAck, shouldCloseIdle } = UiState;

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

test("pinned sessions are listed first and removed from their group", () => {
  const m = listModel(sessions, { pinned: new Set(["s2"]) });
  assert.deepEqual(ids(m.pinned), ["s2"]);
  assert.ok(m.groups.every((g) => !ids(g.sessions).includes("s2")));
  assert.equal(m.groups.find((g) => g.cwd === "/a").count, 1);
});

test("pinned are filtered by query", () => {
  const m = listModel(sessions, { pinned: new Set(["s2"]), query: "s3" });
  assert.deepEqual(m.pinned, []);
});

test("stale pinned ids are ignored", () => {
  const m = listModel(sessions, { pinned: new Set(["gone"]) });
  assert.deepEqual(m.pinned, []);
  assert.equal(m.groups.length, 2);
});

test("group whose sessions are all pinned is omitted", () => {
  const m = listModel(sessions, { pinned: new Set(["s3", "s1"]) });
  assert.deepEqual(ids(m.pinned), ["s3", "s1"]);
  assert.deepEqual(
    m.groups.map((g) => g.cwd),
    ["/a"],
  );
});

test("stepScale steps by 10 % and clamps to 70-200 %", () => {
  assert.equal(stepScale(1, 1), 1.1);
  assert.equal(stepScale(2, 1), 2);
  assert.equal(stepScale(0.7, -1), 0.7);
  assert.equal(stepScale(1.3, 0), 1);
  assert.equal(stepScale(0.8999999, 1), 1);
  assert.equal(stepScale(Number.NaN, 1), 1.1); // a broken stored value starts from 100 %
});

test("imageMentions keeps only image files", () => {
  assert.deepEqual(imageMentions("see @a.png and @b.txt"), ["a.png"]);
  assert.deepEqual(imageMentions("@/x/A.JPG @y.jpeg @z.gif @w.webp @v.svg"), ["/x/A.JPG", "y.jpeg", "z.gif", "w.webp"]);
});

test("quoted mention with spaces", () => {
  assert.deepEqual(imageMentions('look @"C:\\A B\\Shot.PNG" ok'), ["C:\\A B\\Shot.PNG"]);
});

test("imageMentions drops trailing punctuation and repeats", () => {
  assert.deepEqual(imageMentions("@x.png, @x.png. (@y.png)"), ["x.png"]);
});

test("an @ inside a word is not a mention", () => {
  assert.deepEqual(imageMentions("mail me@x.png"), []);
  assert.deepEqual(imageMentions(""), []);
});

test("fitScale fits large images and never upscales", () => {
  assert.equal(fitScale(4000, 2000, 1000, 800), 0.25);
  assert.equal(fitScale(100, 100, 1000, 800), 1);
  assert.equal(fitScale(0, 0, 1000, 800), 1); // not decoded yet
});

test("zoomAt keeps the point under the cursor", () => {
  assert.deepEqual(zoomAt({ scale: 1, x: 0, y: 0 }, 2, 100, 50), { scale: 2, x: -100, y: -50 });
  const s = zoomAt({ scale: 0.5, x: 20, y: 10 }, 2, 220, 110); // image point (400, 200) under (220, 110)
  assert.deepEqual(s, { scale: 1, x: -180, y: -90 });
});

test("zoomAt clamps to 10-1000 %", () => {
  assert.deepEqual(zoomAt({ scale: 10, x: 5, y: 6 }, 2, 0, 0), { scale: 10, x: 5, y: 6 });
  assert.equal(zoomAt({ scale: 0.1, x: 0, y: 0 }, 0.5, 0, 0).scale, 0.1);
});

test("imageMentions ignores URLs (a relay message must not make the app fetch them)", () => {
  assert.deepEqual(imageMentions("@https://evil.example/p.png @http://x/y.gif @file:///p/a.png @b.png"), ["file:///p/a.png", "b.png"]);
});

test("a redelivered report is accepted once; messages without an id always pass", () => {
  const seen = new Set();
  assert.equal(acceptDelivery(seen, "d1"), true);
  assert.equal(acceptDelivery(seen, "d1"), false);
  assert.equal(acceptDelivery(seen, undefined), true);
});

function tracked() {
  const seen = new Set(["d1"]);
  const acks = [];
  return { seen, acks, d: deliveryAck("d1", seen, (id) => acks.push(id)) };
}

test("a delivery is acknowledged once, on its first turn update", () => {
  const { acks, d } = tracked();
  d.update({ sessionUpdate: "agent_message_chunk" });
  d.update({ sessionUpdate: "tool_call" });
  d.returned();
  assert.deepEqual(acks, ["d1"]);
});

test("a delivery is acknowledged on return when no turn update came", () => {
  const { acks, d } = tracked();
  d.update({ sessionUpdate: "available_commands_update" });
  d.update({ sessionUpdate: "usage_update" });
  assert.deepEqual(acks, []);
  d.returned();
  assert.deepEqual(acks, ["d1"]);
});

test("a prompt that fails before any update is not acknowledged and can be redelivered", () => {
  const { seen, acks, d } = tracked();
  d.failed();
  assert.deepEqual(acks, []);
  assert.equal(acceptDelivery(seen, "d1"), true);
});

test("a prompt that fails after it started stays acknowledged and seen", () => {
  const { seen, acks, d } = tracked();
  d.update({ sessionUpdate: "agent_thought_chunk" });
  d.failed();
  assert.deepEqual(acks, ["d1"]);
  assert.equal(acceptDelivery(seen, "d1"), false);
});

const idle = { parentSessionId: "p", busy: false, inboxLength: 0, pendingPermissions: 0, active: false, lastActivity: 0 };
test("an idle child closes after 15 minutes", () => {
  assert.equal(shouldCloseIdle(idle, 900_000), true);
  assert.equal(shouldCloseIdle(idle, 899_999), false);
});
for (const [what, change] of [
  ["a busy child", { busy: true }],
  ["a child with a queued message", { inboxLength: 1 }],
  ["a child waiting for a permission", { pendingPermissions: 1 }],
  ["the child on screen", { active: true }],
  ["a session that is not a child", { parentSessionId: null }],
]) test(`${what} is not closed`, () => assert.equal(shouldCloseIdle({ ...idle, ...change }, 1e9), false));
