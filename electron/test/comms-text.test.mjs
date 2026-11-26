// Tests for the Communication panel's words in electron/renderer/comms-text.js.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const T = createRequire(import.meta.url)("../renderer/comms-text.js");

const node = (id, state = "idle", extra = {}) => ({ id, name: id, inTree: true, released: false, state, cards: [], held: { child: 0, parent: 0, other: 0 }, badges: { relay: 0, user: 0 }, sent: 0, received: 0, ...extra });
const NOW = 1_000_000;
const edge = (from, to, live, ago = null) => ({ from, to, live, since: ago == null ? undefined : NOW - ago * 1000, count: 1, size: 1 });

test("the status line puts the clock first, in short words", () => {
  const edges = [edge("p", "c", "in-progress", 192), edge("c", "p", "waiting-report", 192), edge("x", "p", "reading", 65)];
  assert.equal(T.statusOf(node("c", "working"), edges, NOW), "3:12 working");
  assert.equal(T.statusOf(node("c", "idle"), [edges[1]], NOW), "3:12 report due");
  assert.equal(T.statusOf(node("p", "working"), edges, NOW), "1:05 reading");
  assert.equal(T.statusOf(node("c", "closed"), [edge("p", "c", "queued", 40)], NOW), "0:40 queued");
  assert.equal(T.statusOf(node("p", "working"), [edge("a", "p", "reading", 300), edge("b", "p", "reading", 12)], NOW), "0:12 reading", "the newest");
  assert.equal(T.liveText(edge("a", "p", "reading", 12), NOW), "recipient is processing it · 0:12");
  assert.equal(T.liveText(edge("a", "p", "queued", 40), NOW), "queued, not delivered yet · 0:40");
  assert.equal(T.hasTimer({ edges: [edge("a", "p", "reading", 12)], nodes: [] }), true);
  assert.equal(T.statusOf(node("c"), [edge("c", "p", "ended-no-report")], NOW), "ended, no report");
  assert.equal(T.statusOf(node("c", "closed"), [edge("p", "c", "awaiting-reopen", 30)], NOW), "awaiting reopen");
  assert.equal(T.statusOf(node("c", "waiting-task"), [], NOW), "idle");
  assert.equal(T.statusOf(node("c", "closed"), [], NOW), "closed");
  assert.equal(T.statusOf(node("g", "proposed"), [], NOW), "proposed");
  assert.equal(T.statusOf(node("c", "working"), [edge("p", "c", "in-progress", 3725)], NOW), "1:02:05 working");
});

test("the keeper comes first while it runs", () => {
  const keeper = (phase) => ({ phase, compactAt: NOW + 103_000, pingsSent: 2, pings: 5 });
  assert.equal(T.statusOf(node("c", "idle", { keeper: keeper("countdown") }), [], NOW), "⏳1:43 idle");
  assert.equal(T.statusOf(node("c", "idle", { keeper: keeper("pinging") }), [], NOW), "♻2/5 idle");
  assert.equal(T.statusOf(node("c", "idle", { keeper: keeper("compacting") }), [], NOW), "⏳ compacting");
  assert.equal(T.statusOf(node("c", "idle", { keeper: keeper("idle") }), [], NOW), "idle");
});

test("the box width fits the longest name and status line and does not change while a clock ticks", () => {
  const measure = (text, bold) => text.length * (bold ? 8 : 7); // a fixed-pitch stand-in
  const nodes = [node("a-rather-long-session-name"), node("c", "working")];
  const at = (ago) => T.nodeWidth({ nodes, edges: [edge("p", "c", "in-progress", ago)], now: NOW, font: 14, measure });
  assert.equal(at(5), at(9)); // 0:05 -> 0:09
  assert.ok(at(5) >= "a-rather-long-session-name".length * 8 + 1.2 * 14, `${at(5)}`);
  // a status longer than every name sets the width
  const status = T.nodeWidth({ nodes: [node("c", "working")], edges: [edge("p", "c", "in-progress", 5)], now: NOW, font: 14, measure });
  assert.ok(status >= "0:00 working".length * 7 + 1.2 * 14);
  // the corner badges make room on the name line
  const held = T.nodeWidth({ nodes: [node("abc", "idle", { held: { child: 12, parent: 0, other: 0 } })], now: NOW, font: 14, measure });
  const plain = T.nodeWidth({ nodes: [node("abc")], now: NOW, font: 14, measure });
  assert.ok(held > plain);
  // names and status lines apart: the view narrows the boxes to the status lines' width before it lets the graph scroll
  const both = T.nodeWidths({ nodes: [node("a-rather-long-session-name"), node("c", "working")], edges: [edge("p", "c", "in-progress", 5)], now: NOW, font: 14, measure });
  assert.ok(both.name > both.status, JSON.stringify(both));
  assert.equal(T.nodeWidth({ nodes: [node("a-rather-long-session-name"), node("c", "working")], edges: [edge("p", "c", "in-progress", 5)], now: NOW, font: 14, measure }), both.name);
});

test("the corner badges: held by kind and the cards that wait for an answer", () => {
  const n = node("c", "idle", { held: { child: 2, parent: 1, other: 0 }, cards: [{ kind: "permission", id: "p" }, { kind: "create", id: "g" }] });
  assert.deepEqual(T.cornerOf(n).map((p) => [p.kind, p.text]), [["held", "3"], ["asks", "?"]]);
  assert.match(T.cornerOf(n)[0].title, /2 from sub-sessions, 1 from the parent/);
  assert.match(T.cornerOf(n)[1].title, /a permission question$/);
  assert.deepEqual(T.cornerOf(node("q")), []);
});

test("timers: a model with a timed live edge or a running keeper ticks", () => {
  assert.equal(T.hasTimer({ nodes: [], edges: [edge("p", "c", "in-progress", 1)] }), true);
  assert.equal(T.hasTimer({ nodes: [node("c", "idle", { keeper: { phase: "countdown" } })], edges: [] }), true);
  assert.equal(T.hasTimer({ nodes: [node("c")], edges: [edge("c", "p", "ended-no-report")] }), false);
});
