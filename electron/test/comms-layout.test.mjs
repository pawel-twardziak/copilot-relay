// Tests for the Communication panel's graph layout in electron/renderer/comms-layout.js.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const CommsLayout = createRequire(import.meta.url)("../renderer/comms-layout.js");

const FONT = 13;
const node = (id, parent = null, depth = 0, extra = {}) => ({ id, name: id, inTree: true, released: false, parent, depth, state: "idle", ...extra });
const outside = (id) => node(id, null, null, { inTree: false });
const edge = (from, to, tree = false, count = 1) => ({ from, to, tree, count });
const run = (nodes, edges, width, height) => CommsLayout.layout(nodes, edges, { width, height, font: FONT });
const children = (n, parent = "root") => Array.from({ length: n }, (_, i) => node(`c${i}`, parent, 1));

const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
function assertNoOverlap(nodes) {
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++) assert.ok(!overlap(nodes[i], nodes[j]), `${nodes[i].id} overlaps ${nodes[j].id}`);
}
function assertInside(out) {
  for (const n of out.nodes) {
    assert.ok(n.x >= 0 && n.y >= 0, `${n.id} at ${n.x},${n.y}`);
    assert.ok(n.x + n.w <= out.width && n.y + n.h <= out.height, `${n.id} beyond ${out.width}x${out.height}`);
  }
}
function assertMinimum(out) {
  for (const n of out.nodes) {
    assert.ok(n.w >= 140, `${n.id} width ${n.w}`);
    assert.ok(n.h >= FONT * 3.2, `${n.id} height ${n.h}`);
  }
}
/** Points along an edge path (M/L polylines and M/Q arcs). */
function samples(path) {
  const nums = path.match(/-?\d+(\.\d+)?/g).map(Number);
  const pts = [];
  if (path.includes("Q")) {
    const [x0, y0, cx, cy, x2, y2] = nums;
    for (let t = 0; t <= 1.0001; t += 0.02) {
      const u = 1 - t;
      pts.push([u * u * x0 + 2 * u * t * cx + t * t * x2, u * u * y0 + 2 * u * t * cy + t * t * y2]);
    }
    return pts;
  }
  for (let i = 0; i + 3 < nums.length; i += 2) {
    const [ax, ay, bx, by] = nums.slice(i, i + 4);
    for (let t = 0; t <= 1.0001; t += 0.05) pts.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
  }
  return pts;
}
/** No edge passes through a box other than its two ends'. */
function assertEdgesClear(out) {
  for (const e of out.edges) {
    for (const [x, y] of samples(e.path)) {
      for (const n of out.nodes) {
        if (n.id === e.from || n.id === e.to) continue;
        const inside = x > n.x + 0.5 && x < n.x + n.w - 0.5 && y > n.y + 0.5 && y < n.y + n.h - 0.5;
        assert.ok(!inside, `edge ${e.from}->${e.to} crosses ${n.id} at ${x},${y}`);
      }
    }
  }
}
const byId = (out) => new Map(out.nodes.map((n) => [n.id, n]));

test("root and two children at 420x300 fit without scroll, nodes larger than the minimum", () => {
  const out = run([node("root"), ...children(2)], [edge("root", "c0", true), edge("root", "c1", true)], 420, 300);
  assert.equal(out.scrollX, false);
  assert.equal(out.scrollY, false);
  assert.equal(out.width, 420);
  assert.equal(out.height, 300);
  assert.equal(out.nodes.length, 3);
  for (const n of out.nodes) assert.ok(n.w > 140, `${n.id} width ${n.w}`);
  assertNoOverlap(out.nodes);
  assertInside(out);
  const m = byId(out);
  assert.ok(m.get("c0").y > m.get("root").y + m.get("root").h, "children below the root");
  assert.equal(m.get("c0").y, m.get("c1").y, "two children in one row");
  assert.equal(out.edges.length, 2);
  for (const e of out.edges) {
    assert.match(e.path, /^M [\d.]+ [\d.]+ L [\d.]+ [\d.]+$/, "a straight tree edge");
    const [x0, y0, x1, y1] = e.path.match(/[\d.]+/g).map(Number);
    const root = m.get("root"), child = m.get(e.to);
    assert.equal(y0, root.y + root.h, "starts on the root's bottom border");
    assert.equal(y1, child.y, "ends on the child's top border");
    assert.ok(x0 >= root.x && x0 <= root.x + root.w && x1 >= child.x && x1 <= child.x + child.w);
  }
  assertEdgesClear(out);
});

test("twelve children at 280 px wrap into rows; node width >= 140; scroll only vertical if rows exceed the height", () => {
  const kids = children(12);
  const out = run([node("root"), ...kids], kids.map((k) => edge("root", k.id, true)), 280, 300);
  assertMinimum(out);
  assert.equal(out.scrollX, false);
  assert.equal(out.width, 280);
  assert.equal(out.scrollY, true);
  assert.ok(out.height > 300);
  assertNoOverlap(out.nodes);
  assertInside(out);
  const rows = new Set(out.nodes.filter((n) => n.id !== "root").map((n) => n.y));
  assert.ok(rows.size > 1, "the children wrap into several rows");
  assertEdgesClear(out);
  // the same group in a tall area: no scroll at all, still the minimum width fits
  const tall = run([node("root"), ...kids], kids.map((k) => edge("root", k.id, true)), 280, 2000);
  assert.equal(tall.scrollX, false);
  assert.equal(tall.scrollY, false);
  assertMinimum(tall);
  // ordinary trees (up to six children) need no horizontal scroll at 280 and 420 px
  for (const width of [280, 340, 420]) {
    const six = children(6);
    const r = run([node("root"), ...six], six.map((k) => edge("root", k.id, true)), width, 300);
    assert.equal(r.scrollX, false, `six children at ${width} px`);
    assertMinimum(r);
    assertNoOverlap(r.nodes);
    assertEdgesClear(r);
  }
});

test("a deep chain larger than the area scrolls; no node below the minimum", () => {
  const chain = [node("n0")];
  for (let i = 1; i < 10; i++) chain.push(node(`n${i}`, `n${i - 1}`, i));
  const edges = chain.slice(1).map((n) => edge(n.parent, n.id, true));
  const out = run(chain, edges, 280, 300);
  assert.equal(out.scrollY, true);
  assert.equal(out.scrollX, false);
  assert.ok(out.height > 300);
  assertMinimum(out);
  for (const n of out.nodes) assert.equal(n.w, 140, "at the minimum when it does not fit");
  assertNoOverlap(out.nodes);
  assertInside(out);
  // too narrow even for one column: horizontal scroll, never a smaller box
  const narrow = run([node("root"), ...children(2)], [edge("root", "c0", true)], 150, 100);
  assert.equal(narrow.scrollX, true);
  assert.equal(narrow.scrollY, true);
  assert.ok(narrow.width > 150);
  assertMinimum(narrow);
  assertNoOverlap(narrow.nodes);
  assertInside(narrow);
});

test("outside nodes sit right of the tree; their edges are arcs", () => {
  const nodes = [node("root"), node("c0", "root", 1), node("c1", "root", 1), outside("x1"), outside("x2")];
  const edges = [edge("root", "c0", true), edge("root", "x1"), edge("c1", "x2"), edge("x2", "c1"), edge("c0", "c1")];
  const out = run(nodes, edges, 420, 300);
  const m = byId(out);
  const treeRight = Math.max(...["root", "c0", "c1"].map((id) => m.get(id).x + m.get(id).w));
  for (const id of ["x1", "x2"]) assert.ok(m.get(id).x > treeRight, `${id} right of the tree`);
  assert.equal(m.get("x1").x, m.get("x2").x, "one column");
  assert.ok(m.get("x2").y > m.get("x1").y + m.get("x1").h, "stacked vertically");
  assertMinimum(out);
  assertNoOverlap(out.nodes);
  assertInside(out);
  for (const e of out.edges) {
    if (e.from === "root" && e.to === "c0") assert.doesNotMatch(e.path, /Q/);
    else assert.match(e.path, /^M [\d.]+ [\d.]+ Q [\d.]+ [\d.]+ [\d.]+ [\d.]+$/, `${e.from}->${e.to} is an arc`);
  }
  assertEdgesClear(out);
  // arcs start and end on box borders, not at the centres
  for (const e of out.edges.filter((x) => x.path.includes("Q"))) {
    const n = e.path.match(/[\d.]+/g).map(Number);
    for (const [id, x, y] of [[e.from, n[0], n[1]], [e.to, n[4], n[5]]]) {
      const b = m.get(id);
      const onBorder = Math.min(Math.abs(x - b.x), Math.abs(x - b.x - b.w), Math.abs(y - b.y), Math.abs(y - b.y - b.h)) <= 0.5;
      assert.ok(onBorder, `${e.from}->${e.to} end on ${id}'s border`);
    }
  }
  // a nested tree beside the column at 420 px: no horizontal scroll, arcs clear of every box
  const nested = [node("root"), node("a", "root", 1), node("b", "root", 1), node("a1", "a", 2), node("a2", "a", 2), node("b1", "b", 2), outside("x"), outside("y")];
  const nestedEdges = [edge("root", "a", true), edge("a", "a1", true), edge("a1", "x"), edge("x", "a1"), edge("root", "y"), edge("b1", "a2")];
  const deep = run(nested, nestedEdges, 420, 400);
  assert.equal(deep.scrollX, false);
  assertMinimum(deep);
  assertNoOverlap(deep.nodes);
  assertEdgesClear(deep);
});

test("a pair in both directions gets two offset edges with distinct label points", () => {
  const dist = (a, b) => Math.hypot(a.labelX - b.labelX, a.labelY - b.labelY);
  const check = (out, a, b) => {
    const there = out.edges.find((e) => e.from === a && e.to === b);
    const back = out.edges.find((e) => e.from === b && e.to === a);
    assert.ok(there && back);
    assert.notEqual(there.path, back.path);
    assert.ok(dist(there, back) >= FONT, `labels ${a}<->${b} ${dist(there, back)} px apart`);
    return [there, back];
  };
  // straight tree edges: parallel lines
  const out = run([node("root"), ...children(2)], [edge("root", "c0", true), edge("c0", "root", true), edge("c0", "c1"), edge("c1", "c0")], 420, 300);
  const [down, upw] = check(out, "root", "c0");
  const [a0, b0, a1, b1] = down.path.match(/[\d.]+/g).map(Number);
  const [c1, d1, c0, d0] = upw.path.match(/[\d.]+/g).map(Number); // reversed: from the child to the root
  assert.ok(Math.abs((a1 - a0) * (d1 - d0) - (b1 - b0) * (c1 - c0)) < 40, "parallel");
  assert.ok(Math.abs(a0 - c0) > 2, "offset sideways");
  // sibling arcs: two arcs
  check(out, "c0", "c1");
  assertEdgesClear(out);
  // a wrapped group's routed edges
  const kids = children(5);
  const wrapped = run([node("root"), ...kids], [edge("root", "c3", true), edge("c3", "root", true)], 280, 300);
  check(wrapped, "root", "c3");
  assertEdgesClear(wrapped);
  // an outside node's arcs
  const ext = run([node("root"), outside("x")], [edge("root", "x"), edge("x", "root")], 420, 300);
  check(ext, "root", "x");
});

test("a larger area gives larger nodes (fit grows)", () => {
  const nodes = [node("root"), ...children(2)];
  const edges = [edge("root", "c0", true), edge("root", "c1", true)];
  const small = run(nodes, edges, 420, 300);
  const large = run(nodes, edges, 800, 600);
  assert.ok(large.nodes[0].w > small.nodes[0].w, `${large.nodes[0].w} > ${small.nodes[0].w}`);
  assert.ok(large.nodes[0].h > small.nodes[0].h);
  const gap = (out) => byId(out).get("c1").x - (byId(out).get("c0").x + byId(out).get("c0").w);
  assert.ok(gap(large) > gap(small), "gaps grow with the nodes");
  assert.equal(large.scrollX || large.scrollY, false);
  // capped: a single root in a huge panel stays at most 320 px wide
  const huge = run([node("root")], [], 3000, 2000);
  assert.equal(huge.nodes[0].w, 320);
  assert.equal(huge.width, 3000);
  // deterministic
  assert.deepEqual(run(nodes, edges, 420, 300), small);
});

test("no nodes: the area without scroll; edges to unknown nodes and to themselves are skipped", () => {
  const empty = run([], [edge("a", "b")], 300, 200);
  assert.deepEqual(empty, { width: 300, height: 200, scrollX: false, scrollY: false, nodes: [], edges: [] });
  const one = run([node("root"), outside("x")], [edge("root", "gone"), edge("x", "x"), edge("root", "x")], 300, 200);
  assert.deepEqual(one.edges.map((e) => `${e.from}>${e.to}`), ["root>x"]);
  // a ghost ("proposed") child is laid out under its parent like the others
  const ghost = run([node("root"), node("proposed:1", "root", 1, { state: "proposed" })], [], 420, 300);
  const m = byId(ghost);
  assert.ok(m.get("proposed:1").y > m.get("root").y + m.get("root").h);
});
