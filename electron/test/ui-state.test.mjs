// Tests for the pure UI-state helpers in electron/renderer/ui-state.js (session list model, zoom, image refs).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const UiState = createRequire(import.meta.url)("../renderer/ui-state.js");
const { listModel, stepScale, imageMentions, fitScale, zoomAt, acceptDelivery, deliveryAck } = UiState;

const SessionTree = createRequire(import.meta.url)("../renderer/session-tree.js");

const S = (sessionId, cwd, updatedAt, title = sessionId) => ({ sessionId, cwd, updatedAt, title });
const sessions = [
  S("s1", "/a", "2026-11-01T10:00:00Z"),
  S("s2", "/a", "2026-11-03T10:00:00Z", "foo bar"),
  S("s3", "/b", "2026-11-02T10:00:00Z"),
];
const ids = (rows) => rows.map((r) => r.s.sessionId);
const flat = (rows) => rows.map((r) => `${r.s.sessionId}:${r.depth}`);
const L = (id, parent = null, createdAt = 0) => ({ key: `cli:${id}`, parent: parent && `cli:${parent}`, createdAt, parentDeleted: false });
const T = (...links) => SessionTree.index(links);
const allRows = (m) => [...m.pinned, ...m.open, ...m.groups.flatMap((g) => g.rows)];

test("groups by cwd, newest group and session first", () => {
  const m = listModel(sessions);
  assert.deepEqual(
    m.groups.map((g) => g.cwd),
    ["/a", "/b"],
  );
  assert.deepEqual(ids(m.groups[0].rows), ["s2", "s1"]);
  assert.deepEqual(m.pinned, []);
  assert.deepEqual(m.open, []);
});

test("collapsed group keeps its count", () => {
  const m = listModel(sessions, { collapsed: new Set(["/a"]) });
  const a = m.groups.find((g) => g.cwd === "/a");
  assert.equal(a.collapsed, true);
  assert.equal(a.count, 2);
  assert.equal(a.rows.length, 2);
  assert.equal(m.groups.find((g) => g.cwd === "/b").collapsed, false);
});

test("query expands collapsed groups and filters", () => {
  const m = listModel(sessions, { collapsed: new Set(["/a"]), query: "foo" });
  assert.equal(m.groups.length, 1);
  assert.equal(m.groups[0].collapsed, false);
  assert.deepEqual(ids(m.groups[0].rows), ["s2"]);
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
  assert.ok(m.groups.every((g) => !ids(g.rows).includes("s2")));
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

test("a folder whose sessions are all pinned keeps an empty group", () => {
  const m = listModel(sessions, { pinned: new Set(["s3", "s1"]) });
  assert.deepEqual(ids(m.pinned), ["s3", "s1"]);
  assert.deepEqual(
    m.groups.map((g) => [g.cwd, ids(g.rows), g.count]),
    [
      ["/a", ["s2"], 1],
      ["/b", [], 0],
    ],
  );
});

test("an empty group keeps its place by its folder's newest session", () => {
  const m = listModel(sessions, { open: new Set(["s2", "s1"]) });
  assert.deepEqual(
    m.groups.map((g) => [g.cwd, g.count]),
    [
      ["/a", 0],
      ["/b", 1],
    ],
  );
});

test("a search hides empty groups", () => {
  const m = listModel(sessions, { pinned: new Set(["s3", "s1"]), query: "foo" });
  assert.deepEqual(
    m.groups.map((g) => g.cwd),
    ["/a"],
  );
});

// trees: p (newest) in /a with child c; x apart
const treeRows = [S("p", "/a", "2026-11-05T10:00:00Z"), S("c", "/b", "2026-11-04T10:00:00Z"), S("x", "/a", "2026-11-01T10:00:00Z")];
const pc = T(L("c", "p", 1));

test("a child stays under its parent across folders", () => {
  const m = listModel(treeRows.slice(0, 2), { tree: pc });
  assert.deepEqual(
    m.groups.map((g) => [g.cwd, g.count]),
    [
      ["/a", 2],
      ["/b", 0],
    ],
  );
  const [g] = m.groups;
  assert.deepEqual(flat(g.rows), ["p:0", "c:1"]);
  assert.equal(g.rows[0].showProject, false);
  assert.equal(g.rows[1].showProject, true);
  assert.equal(g.count, 2);
});

test("a pinned child pulls its tree into Pinned", () => {
  const m = listModel(treeRows, { tree: pc, pinned: new Set(["c"]) });
  assert.deepEqual(flat(m.pinned), ["p:0", "c:1"]);
  assert.ok(m.pinned.every((r) => r.showProject === true));
  assert.deepEqual(m.groups.flatMap((g) => ids(g.rows)), ["x"]);
});

test("an open child pulls its tree into Open in app", () => {
  const m = listModel(treeRows, { tree: pc, open: new Set(["c"]) });
  assert.deepEqual(flat(m.open), ["p:0", "c:1"]);
  assert.ok(m.open.every((r) => r.showProject === true), "Open in app shows every row's folder");
  assert.deepEqual(m.groups.flatMap((g) => ids(g.rows)), ["x"]);
});

test("an open session Copilot does not list yet sorts as the newest", () => {
  const rows = [S("q", "/a", "2026-11-05T10:00:00Z"), { sessionId: "new", cwd: "/a", title: "new" }, { sessionId: "new2", cwd: "/b", title: "new2" }];
  const m = listModel(rows, { open: new Set(["q", "new", "new2"]) });
  assert.deepEqual(ids(m.open), ["new", "new2", "q"]);
});

test("Pinned wins over Open in app", () => {
  const m = listModel(treeRows, { tree: pc, pinned: new Set(["p"]), open: new Set(["c"]) });
  assert.deepEqual(m.open, []);
  assert.deepEqual(flat(m.pinned), ["p:0", "c:1"]);
});

test("a closed child of an open parent stays under it", () => {
  const m = listModel(treeRows, { tree: pc, open: new Set(["p"]) });
  assert.deepEqual(flat(m.open), ["p:0", "c:1"]);
});

test("grandchildren nest depth-first in link order", () => {
  const rows = ["p", "a", "b", "g"].map((id) => S(id, "/a", "2026-11-01T10:00:00Z"));
  const m = listModel(rows, { tree: T(L("b", "p", 2), L("a", "p", 1), L("g", "a", 3)) });
  assert.deepEqual(flat(m.groups[0].rows), ["p:0", "a:1", "g:2", "b:1"]);
});

test("search on a child shows the whole tree", () => {
  const rows = [S("p", "/a", "2026-11-05T10:00:00Z"), S("c", "/b", "2026-11-04T10:00:00Z", "needle"), S("x", "/a", "2026-11-01T10:00:00Z")];
  const m = listModel(rows, { tree: pc, query: "needle" });
  assert.equal(m.groups.length, 1);
  assert.deepEqual(flat(m.groups[0].rows), ["p:0", "c:1"]);
});

test("trees are ordered by their newest member", () => {
  const rows = [S("p", "/a", "2026-11-01T10:00:00Z"), S("c", "/a", "2026-11-09T10:00:00Z"), S("q", "/a", "2026-11-05T10:00:00Z")];
  const m = listModel(rows, { tree: pc });
  assert.deepEqual(ids(m.groups[0].rows), ["p", "c", "q"]);
});

test("an unlisted open child sits under its listed parent", () => {
  const rows = [S("p", "/a", "2026-11-05T10:00:00Z"), { sessionId: "c", cwd: "/a", title: "c" }];
  const m = listModel(rows, { tree: pc, open: new Set(["c"]) });
  assert.deepEqual(flat(m.open), ["p:0", "c:1"]);
  assert.deepEqual(m.groups, [{ cwd: "/a", rows: [], count: 0, collapsed: false }]);
});

test("a child of an absent parent is a root", () => {
  const m = listModel([S("c", "/b", "2026-11-04T10:00:00Z")], { tree: T(L("c", "gone", 1)) });
  assert.equal(m.groups.length, 1);
  assert.deepEqual(flat(m.groups[0].rows), ["c:0"]);
});

test("a cycle lists each member once", () => {
  const rows = [S("a", "/a", "2026-11-01T10:00:00Z"), S("b", "/a", "2026-11-02T10:00:00Z")];
  const all = ids(allRows(listModel(rows, { tree: T(L("a", "b", 1), L("b", "a", 2)) })));
  assert.equal(all.length, 2);
  assert.deepEqual(new Set(all), new Set(["a", "b"]));
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

test("panelLayout: wide keeps 480 px for the chat, narrow below 760 px", () => {
  assert.deepEqual(UiState.panelLayout(980, 420), { narrow: false, width: 420 });
  assert.deepEqual(UiState.panelLayout(980, 900), { narrow: false, width: 500 }); // 980 - 480
  assert.deepEqual(UiState.panelLayout(980, 100), { narrow: false, width: 280 });
  assert.deepEqual(UiState.panelLayout(760, 420), { narrow: false, width: 280 });
  assert.deepEqual(UiState.panelLayout(759, 420), { narrow: true, width: 420 });
  assert.deepEqual(UiState.panelLayout(400, 420), { narrow: true, width: 360 }); // 400 - 40
  assert.deepEqual(UiState.panelLayout(980, NaN), { narrow: false, width: 420 }); // default
});

test("order and shown time follow the last activity, not Copilot's updatedAt", () => {
  const opened = { ...S("old", "/a", "2026-11-23T22:37:00Z"), lastActivityAt: "2026-11-23T13:26:00Z" }; // only opened late
  const used = { ...S("new", "/a", "2026-11-23T20:00:00Z"), lastActivityAt: "2026-11-23T20:00:00Z" };
  const unknown = { ...S("unknown", "/a", "2026-11-23T15:00:00Z"), lastActivityAt: null }; // falls back to updatedAt
  const m = listModel([opened, used, unknown]);
  assert.deepEqual(ids(m.groups[0].rows), ["new", "unknown", "old"]);
  assert.deepEqual(ids(listModel([opened, used, unknown], { pinned: new Set(["old", "new"]) }).pinned), ["new", "old"]);
  assert.equal(UiState.activityAt(opened), "2026-11-23T13:26:00Z");
  assert.equal(UiState.activityAt(unknown), "2026-11-23T15:00:00Z");
});
