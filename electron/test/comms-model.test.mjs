// Tests for the Communication panel model in electron/renderer/comms-model.js.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const CommsModel = require("../renderer/comms-model.js");
const SessionTree = require("../renderer/session-tree.js");

const key = (id) => (id == null ? null : id.includes(":") ? id : `cli:${id}`);
const link = (id, parent, extra = {}) => ({
  key: `cli:${id}`, parent: `cli:${parent}`, name: id, task: "do it", createdAt: 1000, reported: false,
  parentDeleted: false, adopted: false, online: true, busy: false, endedNotice: false, ...extra,
});
let seq = 0;
const ev = (kind, from, to, ts, extra = {}) => ({
  id: `e${++seq}`, ts, kind, fromKey: key(from), toKey: key(to), from: from ?? "relay", to: to ?? "relay",
  size: 10, preview: "p", status: "delivered", ...extra,
});
const st = (ref, status, ts) => ({ id: `s${++seq}`, ts, kind: "status", ref, status });
const comms = (root, events, peers = {}) => ({ root: `cli:${root}`, keys: [], events, peers });
const build = (over) => CommsModel.build({ comms: null, links: [], heldByKind: {}, current: null, live: {}, now: 0, filter: null, ...over });
const node = (m, id) => m.nodes.find((n) => n.id === id);
const edge = (m, from, to) => m.edges.find((e) => e.from === from && e.to === to);
const rootPeer = { "cli:r": { name: "Root", online: true, busy: false, kind: "cli" } };

test("tree nodes from links, outside counterparts from events, a released child marked", () => {
  const links = [link("a", "r", { createdAt: 2000 }), link("b", "r", { createdAt: 1000 }), link("c", "a")];
  const events = [ev("task", "r", "a", 10), ev("task", "r", "b", 20), ev("task", "r", "x", 30), ev("message", "ext:term", "a", 40)];
  const peers = { ...rootPeer, "cli:x": { name: "X", online: false, busy: false, kind: "cli" }, "ext:term": { name: "Term", online: true, busy: false, kind: "extension" } };
  const m = build({ comms: comms("r", events, peers), links, current: "a" });
  assert.deepEqual(m.nodes.map((n) => n.id), ["r", "b", "a", "c", "x", "ext:term"]);
  assert.deepEqual(m.nodes.map((n) => [n.parent, n.depth, n.inTree, n.released]), [
    [null, 0, true, false], ["r", 1, true, false], ["r", 1, true, false], ["a", 2, true, false],
    [null, null, false, true], [null, null, false, false],
  ]);
  assert.equal(node(m, "x").name, "X");
  assert.equal(node(m, "x").state, "closed");
  assert.equal(node(m, "ext:term").name, "Term");
  assert.equal(node(m, "ext:term").state, "idle", "waiting-task is only for a child");
  assert.equal(node(m, "r").state, "idle", "waiting-task is only for a child");
  assert.equal(node(m, "a").current, true);
  assert.equal(node(m, "r").current, false);
  assert.equal(m.unsupported, false);
  assert.deepEqual(edge(m, "ext:term", "a"), { from: "ext:term", to: "a", tree: false, count: 1, size: 10, last: 40, live: null, held: 0 }, "delivered to an idle recipient: processed");
});

test("a renamed session stays one node; rows keep the name at the time", () => {
  const links = [link("a", "r", { name: "renamed", reported: true })];
  const events = [
    ev("message", "a", "r", 10, { from: "old" }), ev("message", "a", "r", 20, { from: "renamed" }),
    ev("message", "o", "r", 30, { from: "o1" }), ev("message", "o", "r", 40, { from: "o2" }),
  ];
  const m = build({ comms: comms("r", events, rootPeer), links });
  assert.deepEqual(m.nodes.map((n) => n.id), ["r", "a", "o"]);
  assert.equal(node(m, "a").name, "renamed");
  assert.equal(node(m, "o").name, "o2");
  assert.equal(node(m, "r").name, "Root");
  assert.deepEqual(m.rows.map((r) => r.from), ["old", "renamed", "o1", "o2"]);
  assert.equal(edge(m, "a", "r").count, 2);
  assert.equal(m.edges.length, 2);
});

test("working child: node working, parent edge in-progress since the task event", () => {
  const links = [link("a", "r", { busy: true }), link("b", "r", { busy: true, createdAt: 1500 })];
  const m = build({ comms: comms("r", [ev("task", "r", "a", 5000)], rootPeer), links });
  assert.equal(node(m, "a").state, "working");
  assert.deepEqual(edge(m, "r", "a"), { from: "r", to: "a", tree: true, count: 1, size: 10, last: 5000, live: "in-progress", since: 5000, held: 0 });
  // no task event in the log (it predates the log): the edge still carries the live state, since createdAt
  assert.deepEqual(edge(m, "r", "b"), { from: "r", to: "b", tree: true, count: 0, size: 0, last: null, live: "in-progress", since: 1500, held: 0 });
  assert.equal(node(m, "b").state, "working");
});

test("not reported: child->parent edge waiting-report; endedNotice -> ended-no-report", () => {
  const links = [link("a", "r"), link("b", "r", { online: false, endedNotice: true })];
  const m = build({ comms: comms("r", [ev("task", "r", "a", 3000), ev("task", "r", "b", 3100)], rootPeer), links });
  assert.equal(edge(m, "a", "r").live, "waiting-report");
  assert.equal(edge(m, "a", "r").since, 3000);
  assert.equal(edge(m, "a", "r").count, 0);
  assert.equal(edge(m, "a", "r").tree, true);
  assert.equal(edge(m, "r", "a").live, null, "a is idle, not working");
  assert.equal(edge(m, "b", "r").live, "ended-no-report");
  assert.equal(edge(m, "b", "r").since, undefined);
  assert.equal(node(m, "b").state, "closed");
});

test("idle after report: waiting-task", () => {
  const links = [link("a", "r", { reported: true }), link("b", "r"), link("c", "r", { task: null })];
  const events = [ev("task", "r", "a", 100), ev("report", "a", "r", 400), ev("task", "r", "b", 500)];
  const m = build({ comms: comms("r", events, rootPeer), links });
  assert.equal(node(m, "a").state, "waiting-task");
  assert.equal(node(m, "a").waitingSince, 400);
  assert.equal(edge(m, "a", "r").live, null);
  assert.equal(edge(m, "r", "a").live, null);
  assert.equal(node(m, "b").state, "idle");
  assert.equal(node(m, "b").waitingSince, undefined);
  assert.equal(node(m, "c").state, "waiting-task", "no task event and no link task");
  assert.equal(edge(m, "c", "r"), undefined, "a task-less child owes no report");
  assert.equal(edge(m, "b", "r").live, "waiting-report");
});

test("a message waits only until its recipient processed it: queued, then reading while the recipient is busy", () => {
  const links = [
    link("a", "r", { reported: true, online: false }), link("b", "r", { reported: true, busy: true }), link("c", "r"),
    link("d", "r", { reported: true, busy: true }), link("e", "r", { reported: true, busy: true }),
  ];
  const events = [
    ev("message", "r", "a", 10, { id: "ma", status: "queued" }),
    ev("message", "r", "b", 20, { id: "mb", status: "queued" }), st("mb", "delivered", 25),
    ev("message", "r", "c", 30),
    ev("task", "r", "d", 40), ev("report", "d", "r", 50), ev("message", "r", "d", 60, { id: "md", status: "queued" }), st("md", "taken", 65),
    ev("message", "r", "e", 70), ev("message", "e", "r", 80), // r is idle: e's message is processed
  ];
  const m = build({ comms: comms("r", events, rootPeer), links });
  assert.deepEqual([edge(m, "r", "a").live, edge(m, "r", "a").since], ["queued", 10], "not delivered yet: since sent");
  assert.deepEqual([edge(m, "r", "b").live, edge(m, "r", "b").since], ["reading", 25], "busy recipient: since delivery");
  assert.equal(edge(m, "r", "c").live, null, "c->r waiting-report outranks it on the pair");
  assert.equal(edge(m, "c", "r").live, "waiting-report");
  assert.deepEqual([edge(m, "r", "d").live, edge(m, "r", "d").since], ["reading", 65], "taken by the app counts as delivered");
  assert.equal(edge(m, "d", "r").live, null, "r->d came later");
  assert.equal(edge(m, "r", "e").live, null, "answered and processed: no clock");
  assert.equal(edge(m, "e", "r").live, null, "delivered to an idle recipient: no clock");
});

test("queued only for a closed app session: other peers drain or flush without a status", () => {
  const peers = { ...rootPeer, "mcp:vs": { name: "VS", online: true, busy: false, kind: "mcp" }, "mcp:off": { name: "Off", online: false, busy: false, kind: "mcp" } };
  const events = [ev("message", "r", "mcp:vs", 10, { status: "queued" }), ev("message", "r", "mcp:off", 20, { status: "queued" })];
  const m = build({ comms: comms("r", events, peers) });
  assert.equal(edge(m, "r", "mcp:vs").live, null);
  assert.equal(edge(m, "r", "mcp:off").live, null, "an inbox drain writes no status: a gone peer is not queued");
  const out = build({ comms: comms("r", [ev("message", "r", "x", 30, { status: "queued" })], rootPeer), live: { x: { online: false } } });
  assert.deepEqual([edge(out, "r", "x").live, edge(out, "r", "x").since], ["queued", 30], "a closed app session outside the tree");
});

test("reading only in the turn that read it: an old message is not read again by a later turn", () => {
  const links = [link("a", "r", { reported: true })];
  const events = [ev("task", "r", "a", 1000), ev("report", "a", "r", 20_000)];
  const at = (busySince) => edge(build({ comms: comms("r", events, rootPeer), links, live: { r: { online: true, busy: true, busySince } } }), "a", "r");
  assert.deepEqual([at(19_000).live, at(19_000).since], ["reading", 20_000], "the report started this turn");
  assert.equal(at(24_000).live, "reading", "within the 5 s slack (taken as the turn starts)");
  assert.equal(at(60_000).live, null, "a later turn: the report was processed before");
});

test("after delivery: discarded/dropped get no clock; delivered after reopen to a busy recipient reads; a task in progress outranks reading", () => {
  const links = [link("a", "r", { reported: true, busy: true }), link("b", "r", { reported: true, busy: true }), link("c", "r", { busy: true }), link("d", "r", { reported: true, busy: true })];
  const events = [
    ev("message", "r", "a", 10, { id: "m1" }), st("m1", "discarded", 15),
    ev("message", "r", "b", 20, { id: "m2" }), st("m2", "dropped", 25),
    ev("task", "r", "c", 30),
    ev("message", "r", "d", 40, { id: "m4", status: "awaiting-reopen" }), st("m4", "delivered", 45),
  ];
  const m = build({ comms: comms("r", events, rootPeer), links });
  assert.equal(edge(m, "r", "a").live, null);
  assert.equal(edge(m, "r", "b").live, null);
  assert.equal(edge(m, "r", "c").live, "in-progress");
  assert.deepEqual([edge(m, "r", "d").live, edge(m, "r", "d").since], ["reading", 45]);
});

test("a report to a busy parent is being read; once the parent is idle the clock stops", () => {
  const links = [link("a", "r", { reported: true })];
  const events = [ev("task", "r", "a", 10), ev("report", "a", "r", 20)];
  const busy = build({ comms: comms("r", events, { "cli:r": { ...rootPeer["cli:r"], busy: true } }), links });
  assert.deepEqual([edge(busy, "a", "r").live, edge(busy, "a", "r").since], ["reading", 20]);
  const idle = build({ comms: comms("r", events, rootPeer), links });
  assert.equal(edge(idle, "a", "r").live, null);
  assert.equal(idle.edges.some((e) => e.live), false);
});

test("held badge from heldByKind; relay/user badges on the recipient, not nodes", () => {
  const links = [link("a", "r", { reported: true }), link("b", "r", { reported: true })];
  const events = [
    ev("report", "a", "r", 10), ev("task", "r", "a", 5), ev("message", "b", "a", 20),
    ev("notice", null, "a", 30), ev("user", null, "a", 40), ev("notice", null, "r", 50),
  ];
  const heldByKind = { "cli:r": { child: 2, parent: 0, other: 1 }, "cli:a": { parent: 3, other: 4 } };
  const m = build({ comms: comms("r", events, rootPeer), links, heldByKind });
  assert.deepEqual(m.nodes.map((n) => n.id), ["r", "a", "b"]);
  assert.equal(edge(m, "a", "r").held, 0);
  assert.equal(edge(m, "r", "a").held, 3);
  assert.equal(edge(m, "b", "a").held, 0);
  assert.deepEqual(node(m, "r").held, { child: 2, parent: 0, other: 1 });
  assert.deepEqual(node(m, "a").held, { child: 0, parent: 3, other: 4 });
  assert.deepEqual(node(m, "b").held, { child: 0, parent: 0, other: 0 });
  assert.equal(edge(m, "b", "a").tree, false);
  assert.equal(m.edges.length, 3);
  assert.deepEqual(node(m, "a").badges, { relay: 1, user: 1 });
  assert.deepEqual(node(m, "r").badges, { relay: 1, user: 0 });
  assert.deepEqual(node(m, "b").badges, { relay: 0, user: 0 });
  assert.deepEqual([node(m, "a").sent, node(m, "a").received], [1, 2]);
  assert.deepEqual([node(m, "r").sent, node(m, "r").received], [1, 1]);
  assert.equal(m.rows.length, 6);
  assert.equal(m.stats.heldNow, 10);
});

test("create card -> a proposed ghost node under its parent", () => {
  const cards = [{ kind: "create", id: "c1", name: "helper" }, { kind: "permission", id: "p1" }];
  const m = build({ comms: comms("r", [], rootPeer), links: [link("a", "r")], live: { r: { cards } } });
  assert.deepEqual(m.nodes.map((n) => n.id), ["r", "a", "proposed:c1"]);
  const g = node(m, "proposed:c1");
  assert.deepEqual([g.name, g.state, g.parent, g.inTree, g.depth, g.released], ["helper", "proposed", "r", true, 1, false]);
  assert.deepEqual(node(m, "r").cards, cards);
  assert.deepEqual(node(m, "a").cards, []);
});

test("closed session and awaiting-reopen edge", () => {
  const links = [link("a", "r", { reported: true, online: false }), link("b", "r", { reported: true })];
  const events = [
    ev("message", "r", "a", 10, { status: "awaiting-reopen" }),
    ev("message", "r", "b", 20, { id: "m2", status: "awaiting-reopen" }), st("m2", "delivered", 30),
  ];
  const m = build({ comms: comms("r", events, rootPeer), links });
  assert.equal(node(m, "a").state, "closed");
  assert.equal(edge(m, "r", "a").live, "awaiting-reopen");
  assert.equal(edge(m, "r", "a").since, 10);
  assert.equal(edge(m, "r", "b").live, null, "delivered after reopen to an idle recipient");
  assert.equal(node(m, "r").state, "idle");
});

test("ctx and keeper copied onto the node", () => {
  const ctx = { pct: 85, level: "warn", label: "85%" };
  const keeper = { phase: "countdown", pingsSent: 1, pings: 3, compactAt: 9000 };
  const m = build({ comms: comms("r", [], rootPeer), links: [link("a", "r")], live: { a: { ctx, keeper } } });
  assert.deepEqual(node(m, "a").ctx, ctx);
  assert.deepEqual(node(m, "a").keeper, keeper);
  assert.equal("ctx" in node(m, "r"), false);
  assert.equal("keeper" in node(m, "r"), false);
});

test("status events fold into rows; redelivery does not add a row", () => {
  const links = [link("a", "r", { reported: true })];
  const m2 = ev("message", "r", "a", 20, { id: "m2", status: "queued" });
  const events = [
    ev("message", "r", "a", 10, { id: "m1", status: "queued" }), st("m1", "delivered", 15), st("m1", "taken", 16),
    m2, st("m2", "delivered", 25), { ...m2 }, st("m2", "discarded", 26),
    ev("message", "a", "r", 30, { id: "m3", status: "delivered" }),
  ];
  const m = build({ comms: comms("r", events, rootPeer), links });
  assert.deepEqual(m.rows, [
    { id: "m1", ts: 10, kind: "message", from: "r", to: "a", size: 10, preview: "p", status: "taken" },
    { id: "m2", ts: 20, kind: "message", from: "r", to: "a", size: 10, preview: "p", status: "discarded" },
    { id: "m3", ts: 30, kind: "message", from: "a", to: "r", size: 10, preview: "p", status: "delivered" },
  ]);
  assert.equal(edge(m, "r", "a").count, 2);
  assert.equal(edge(m, "r", "a").size, 20);
  assert.deepEqual([node(m, "a").received, node(m, "a").sent], [2, 1]);
  assert.equal(m.stats.messages, 3);
});

test("stats: totals, avg task->report over reported children only, counts by status", () => {
  const links = [link("a", "r", { reported: true }), link("b", "r", { reported: true }), link("c", "r")];
  const events = [
    ev("task", "r", "a", 1000, { size: 100 }), ev("task", "r", "b", 2000, { size: 200 }), ev("task", "r", "c", 2500, { size: 300 }),
    ev("report", "b", "r", 3000, { size: 40 }), ev("report", "a", "r", 4000, { size: 50 }), ev("report", "a", "r", 9000, { size: 60 }),
    ev("message", "r", "c", 5000, { status: "blocked", size: 1 }),
    ev("message", "r", "a", 6000, { id: "md", status: "delivered", size: 2 }), st("md", "discarded", 6100),
    ev("message", "r", "b", 7000, { id: "mx", status: "awaiting-reopen", size: 3 }), st("mx", "dropped", 7100),
    ev("notice", null, "c", 8000, { size: 4 }),
  ];
  const heldByKind = { "cli:r": { child: 1, parent: 0, other: 0 }, "cli:c": { child: 0, parent: 2, other: 0 } };
  const m = build({ comms: comms("r", events, rootPeer), links, heldByKind });
  assert.deepEqual(m.stats, { messages: 10, size: 760, avgTaskToReport: 2000, heldNow: 3, discarded: 1, dropped: 1, blocked: 1 });
});

test("filter by node and by edge narrows rows and stats", () => {
  const links = [link("a", "r", { reported: true }), link("b", "r", { reported: true })];
  const events = [
    ev("task", "r", "a", 1000, { id: "t1" }), ev("task", "r", "b", 1100, { id: "t2" }),
    ev("report", "a", "r", 4000, { id: "r1" }), ev("report", "b", "r", 1600, { id: "r2" }),
    ev("message", "b", "a", 5000, { id: "x1", status: "blocked" }), ev("notice", null, "a", 6000, { id: "n1" }),
  ];
  const heldByKind = { "cli:r": { child: 1 }, "cli:a": { parent: 2, other: 5 }, "cli:b": { parent: 7 } };
  const base = { comms: comms("r", events, rootPeer), links, heldByKind };
  const all = build(base);
  assert.deepEqual(all.rows.map((r) => r.id), ["t1", "t2", "r2", "r1", "x1", "n1"]);
  assert.deepEqual(all.stats, { messages: 6, size: 60, avgTaskToReport: 1750, heldNow: 15, discarded: 0, dropped: 0, blocked: 1 });
  const byNode = build({ ...base, filter: { node: "a" } });
  assert.deepEqual(byNode.rows.map((r) => r.id), ["t1", "r1", "x1", "n1"]);
  assert.deepEqual(byNode.stats, { messages: 4, size: 40, avgTaskToReport: 3000, heldNow: 7, discarded: 0, dropped: 0, blocked: 1 });
  const byEdge = build({ ...base, filter: { from: "r", to: "a" } });
  assert.deepEqual(byEdge.rows.map((r) => r.id), ["t1"]);
  assert.deepEqual(byEdge.stats, { messages: 1, size: 10, avgTaskToReport: null, heldNow: 2, discarded: 0, dropped: 0, blocked: 0 });
  const reverse = build({ ...base, filter: { from: "a", to: "r" } });
  assert.deepEqual(reverse.rows.map((r) => r.id), ["r1"]);
  assert.equal(reverse.stats.heldNow, 0, "child->parent held is on the parent node, not the edge");
  // the graph does not follow the filter
  assert.equal(byEdge.nodes.length, 3);
  assert.equal(byEdge.edges.length, all.edges.length);
});

test("comms null (old broker): nodes and live state from links, rows empty, unsupported true", () => {
  const links = [link("a", "r", { busy: true, createdAt: 1200 }), link("b", "r", { online: false, createdAt: 1300 }), link("c", "a", { reported: true, createdAt: 1400 })];
  const m = build({ links, current: "c", heldByKind: { "cli:r": { child: 2 } } });
  assert.equal(m.unsupported, true);
  assert.deepEqual(m.nodes.map((n) => [n.id, n.depth, n.state]), [["r", 0, "closed"], ["a", 1, "working"], ["c", 2, "waiting-task"], ["b", 1, "closed"]]);
  assert.equal(node(m, "c").current, true);
  assert.deepEqual(m.edges.map((e) => [e.from, e.to, e.live, e.since, e.count]), [
    ["a", "r", "waiting-report", 1200, 0], ["r", "a", "in-progress", 1200, 0], ["b", "r", "waiting-report", 1300, 0],
  ]);
  assert.equal(edge(m, "a", "r").held, 0);
  assert.deepEqual(node(m, "r").held, { child: 2, parent: 0, other: 0 });
  assert.deepEqual(m.rows, []);
  assert.deepEqual(m.stats, { messages: 0, size: 0, avgTaskToReport: null, heldNow: 2, discarded: 0, dropped: 0, blocked: 0 });
  assert.deepEqual(build({}).nodes, [], "no current session, no tree");
});

test("held on the target node: one held child message at the parent is not repeated on each child edge", () => {
  const links = [link("a", "r", { reported: true }), link("b", "r", { reported: true })];
  const events = [ev("report", "a", "r", 10), ev("report", "b", "r", 20), ev("message", "r", "a", 30), ev("message", "o", "r", 40)];
  const heldByKind = { "cli:r": { child: 1 }, "cli:a": { parent: 2 }, "cli:o": { other: 5 } };
  const base = { comms: comms("r", events, rootPeer), links, heldByKind };
  const m = build(base);
  assert.deepEqual(node(m, "r").held, { child: 1, parent: 0, other: 0 });
  assert.deepEqual([edge(m, "a", "r").held, edge(m, "b", "r").held, edge(m, "o", "r").held], [0, 0, 0]);
  assert.equal(edge(m, "r", "a").held, 2);
  assert.deepEqual(node(m, "o").held, { child: 0, parent: 0, other: 5 });
  assert.equal(m.stats.heldNow, 3, "outside nodes' held belong to other trees");
  assert.equal(build({ ...base, filter: { node: "o" } }).stats.heldNow, 5);
  assert.equal(build({ ...base, filter: { node: "r" } }).stats.heldNow, 1);
  assert.equal(build({ ...base, filter: { from: "r", to: "a" } }).stats.heldNow, 2);
  assert.equal(build({ ...base, filter: { from: "a", to: "r" } }).stats.heldNow, 0);
  assert.equal(build({ ...base, filter: { from: "o", to: "r" } }).stats.heldNow, 0);
});

test("live online/busy from an open view override links and peers", () => {
  const links = [link("a", "r"), link("b", "r")];
  const live = { r: { online: true }, a: { busy: true }, b: { online: false } };
  const m = build({ links, current: "r", live });
  assert.deepEqual(m.nodes.map((n) => [n.id, n.state]), [["r", "idle"], ["a", "working"], ["b", "closed"]]);
  assert.equal(edge(m, "r", "a").live, "in-progress");
  const peers = { "cli:r": { name: "Root", online: false, busy: false, kind: "cli" } };
  assert.equal(node(build({ comms: comms("r", [], peers), links, live: { r: { online: true, busy: true } } }), "r").state, "working");
});

test("names: an empty peer name falls back to the event's name; a root without peers takes the open view's name", () => {
  const events = [ev("message", "ext:9", "r", 10, { from: "terminal-a" })];
  const m = build({ comms: comms("r", events, { ...rootPeer, "ext:9": { name: "", online: false, busy: false, kind: "extension" } }), links: [link("a", "r")] });
  assert.equal(node(m, "ext:9").name, "terminal-a", "a peer that left the registry");
  // an older broker (no peers): the root has no link, its open view knows its relay name
  const old = build({ links: [link("a", "r")], current: "a", live: { r: { online: true, name: "mama-1a2b" } } });
  assert.equal(node(old, "r").name, "mama-1a2b");
  assert.equal(node(build({ links: [link("a", "r")], current: "a" }), "r").name, "r", "nothing knows it: its id");
  // the broker's and the link's names come first
  assert.equal(node(build({ comms: comms("r", [], rootPeer), links: [link("a", "r")], live: { r: { name: "view" } } }), "r").name, "Root");
  assert.equal(node(build({ links: [link("a", "r")], current: "a", live: { a: { name: "view" } } }), "a").name, "a");
});

test("inTree: a session with a parent or children", () => {
  const tree = SessionTree.index([link("a", "r"), link("o", "gone", { parentDeleted: true })]);
  assert.equal(CommsModel.inTree(tree, "a"), true);
  assert.equal(CommsModel.inTree(tree, "r"), true);
  assert.equal(CommsModel.inTree(tree, "o"), false, "an orphan is cut off");
  assert.equal(CommsModel.inTree(tree, "zzz"), false);
});
