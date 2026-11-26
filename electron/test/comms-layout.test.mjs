// Tests for the Communication panel's graph layout in electron/renderer/comms-layout.js.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const CommsLayout = createRequire(import.meta.url)("../renderer/comms-layout.js");

const FONT = 13;
const node = (id, parent = null, depth = 0, extra = {}) => ({ id, name: id, inTree: true, released: false, parent, depth, state: "idle", ...extra });
const outside = (id) => node(id, null, null, { inTree: false });
const edge = (from, to, tree = false, count = 1) => ({ from, to, tree, count });
const run = (nodes, edges, width, height, font = FONT) => CommsLayout.layout(nodes, edges, { width, height, font });
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
function assertMinimum(out, font = FONT) {
  for (const n of out.nodes) {
    assert.ok(n.w >= 140, `${n.id} width ${n.w}`);
    assert.ok(n.h >= font * 3.2, `${n.id} height ${n.h}`);
  }
}
/** The segments [x1, y1, x2, y2] of an edge path ("M x y L x y ..."). */
function segments(path) {
  assert.match(path, /^M -?[\d.]+ -?[\d.]+( L -?[\d.]+ -?[\d.]+)+$/, `a polyline: ${path}`);
  const n = path.match(/-?\d+(\.\d+)?/g).map(Number);
  const out = [];
  for (let i = 0; i + 3 < n.length; i += 2) out.push(n.slice(i, i + 4));
  return out;
}
/** Whether a segment meets the open rectangle r grown by m px (Liang-Barsky). */
function meets([x1, y1, x2, y2], r, m = 0) {
  const dx = x2 - x1, dy = y2 - y1;
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, x1 - (r.x - m)], [dx, r.x + r.w + m - x1], [-dy, y1 - (r.y - m)], [dy, r.y + r.h + m - y1]]) {
    if (p === 0) {
      if (q <= 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 >= t1) return false;
  }
  return true;
}
/** Every edge inside the SVG and never within 1 px of a box other than its two ends'. */
function assertEdgesClear(out) {
  for (const e of out.edges) {
    for (const seg of segments(e.path)) {
      const [x1, y1, x2, y2] = seg;
      const inside = Math.min(x1, x2) >= 0 && Math.min(y1, y2) >= 0 && Math.max(x1, x2) <= out.width && Math.max(y1, y2) <= out.height;
      assert.ok(inside, `edge ${e.from}->${e.to} [${seg}] leaves the ${out.width}x${out.height} SVG`);
      for (const n of out.nodes) {
        if (n.id === e.from || n.id === e.to) continue;
        assert.ok(!meets(seg, n, 1), `edge ${e.from}->${e.to} [${seg}] grazes ${n.id}`);
      }
    }
  }
}
/** The labels (out.label sized, centred on their points) outside the SVG or on a box, another edge or another label. */
function labelConflicts(out) {
  const rect = (e) => ({ x: e.labelX - out.label.w / 2, y: e.labelY - out.label.h / 2, w: out.label.w, h: out.label.h });
  const bad = [];
  out.edges.forEach((e, i) => {
    const r = rect(e);
    const why = [];
    if (r.x < 0 || r.y < 0 || r.x + r.w > out.width || r.y + r.h > out.height) why.push("outside");
    for (const n of out.nodes) if (overlap(r, n)) why.push(`on box ${n.id}`);
    out.edges.forEach((f, j) => {
      if (j === i) return;
      if (segments(f.path).some((seg) => meets(seg, r))) why.push(`on edge ${f.from}->${f.to}`);
      if (overlap(r, rect(f))) why.push(`on label ${f.from}->${f.to}`);
    });
    if (why.length) bad.push(`label ${e.from}->${e.to} ${why.join(", ")}`);
  });
  return bad;
}
/** Every label clear of the boxes, the other edges' lines and the other labels, inside the SVG. */
const assertLabelsClear = (out) => assert.deepEqual(labelConflicts(out), []);
/** No routed (non-tree) line runs along a tree line closer than 4 px for more than 3 px. */
function assertOffTrunks(out, nodes) {
  const parent = new Map(nodes.map((n) => [n.id, n.parent]));
  const isTree = (e) => parent.get(e.to) === e.from || parent.get(e.from) === e.to;
  const tree = out.edges.filter(isTree).flatMap((e) => segments(e.path));
  for (const e of out.edges.filter((x) => !isTree(x))) {
    for (const [x1, y1, x2, y2] of segments(e.path)) {
      for (const [u1, v1, u2, v2] of tree) {
        const along = (a1, a2, b1, b2) => Math.min(Math.max(a1, a2), Math.max(b1, b2)) - Math.max(Math.min(a1, a2), Math.min(b1, b2));
        const near =
          (y1 === y2 && v1 === v2 && Math.abs(y1 - v1) < 4 && along(x1, x2, u1, u2) > 3) ||
          (x1 === x2 && u1 === u2 && Math.abs(x1 - u1) < 4 && along(y1, y2, v1, v2) > 3);
        assert.ok(!near, `routed ${e.from}->${e.to} [${[x1, y1, x2, y2]}] runs along a tree line [${[u1, v1, u2, v2]}]`);
      }
    }
  }
}
/** The distance between two segments (0 when they cross). */
function segDist(a, b) {
  const pd = ([px, py], [x1, y1, x2, y2]) => {
    const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l2)) : 0;
    return Math.hypot(px - x1 - t * dx, py - y1 - t * dy);
  };
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const [a1, a2, b1, b2] = [a.slice(0, 2), a.slice(2), b.slice(0, 2), b.slice(2)];
  if (cross(a1, a2, b1) * cross(a1, a2, b2) < 0 && cross(b1, b2, a1) * cross(b1, b2, a2) < 0) return 0;
  return Math.min(pd(a1, b), pd(a2, b), pd(b1, a), pd(b2, a));
}
/** The two lines of every pair at least 2o - 1 px apart everywhere (o = 0.035 of the box width). */
function assertPairsApart(out) {
  const o = 0.035 * out.nodes[0].w;
  for (const e of out.edges) {
    const back = out.edges.find((f) => f.from === e.to && f.to === e.from);
    if (!back || e.from > e.to) continue;
    let min = Infinity;
    for (const a of segments(e.path)) for (const b of segments(back.path)) min = Math.min(min, segDist(a, b));
    assert.ok(min >= 2 * o - 1, `pair ${e.from}<->${e.to}: lines ${min.toFixed(1)} px apart, want >= ${(2 * o - 1).toFixed(1)}`);
  }
}
/**
 * Tree edges of different children: an outgoing (parent -> child) and a return (child -> parent) line never share a
 * line (collinear closer than 2 px over more than 1 px; crossing at a right angle is fine), and two straight
 * (diagonal) lines never cross. Edges in the same direction from one parent may share its bus.
 */
function assertDirectionsApart(out, nodes) {
  const parent = new Map(nodes.map((n) => [n.id, n.parent]));
  const tree = out.edges
    .filter((e) => parent.get(e.to) === e.from || parent.get(e.from) === e.to)
    .map((e) => ({ e, down: parent.get(e.to) === e.from, child: parent.get(e.to) === e.from ? e.to : e.from }));
  const along = (a1, a2, b1, b2) => Math.min(Math.max(a1, a2), Math.max(b1, b2)) - Math.max(Math.min(a1, a2), Math.min(b1, b2));
  for (const a of tree) {
    for (const b of tree) {
      if (a.child === b.child || (a.down === b.down && parent.get(a.child) === parent.get(b.child))) continue;
      for (const [x1, y1, x2, y2] of segments(a.e.path)) {
        for (const [u1, v1, u2, v2] of segments(b.e.path)) {
          const what = `${a.e.from}->${a.e.to} [${[x1, y1, x2, y2]}] and ${b.e.from}->${b.e.to} [${[u1, v1, u2, v2]}]`;
          const shared =
            (y1 === y2 && v1 === v2 && Math.abs(y1 - v1) < 2 && along(x1, x2, u1, u2) > 1) ||
            (x1 === x2 && u1 === u2 && Math.abs(x1 - u1) < 2 && along(y1, y2, v1, v2) > 1);
          assert.ok(!shared, `opposite directions share a line: ${what}`);
          const diagonal = x1 !== x2 && y1 !== y2 && u1 !== u2 && v1 !== v2;
          assert.ok(!diagonal || segDist([x1, y1, x2, y2], [u1, v1, u2, v2]) > 0, `straight lines cross: ${what}`);
        }
      }
    }
  }
}
const axisAligned = (path) => segments(path).every(([x1, y1, x2, y2]) => x1 === x2 || y1 === y2);
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
  assertLabelsClear(out);
  // the same group with every child answering: each direction on its own bus, pairs apart
  const both = run([node("root"), ...kids], kids.flatMap((k) => [edge("root", k.id, true), edge(k.id, "root", true)]), 280, 300);
  assertEdgesClear(both);
  assertPairsApart(both);
  assertDirectionsApart(both, [node("root"), ...kids]);
  assertLabelsClear(both);
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

test("ordinary trees fit without scroll at the UI font (14 px): the gaps give way before a scroll", () => {
  for (const [count, width] of [[3, 280], [3, 340], [6, 420]]) {
    const kids = children(count);
    const nodes = [node("root"), ...kids];
    const edges = kids.flatMap((k, i) => (i === 1 ? [edge("root", k.id, true), edge(k.id, "root", true)] : [edge("root", k.id, true)]));
    const out = run(nodes, edges, width, 300, 14);
    const what = `root + ${count} at ${width}x300`;
    assert.equal(out.scrollY, false, what);
    assert.equal(out.scrollX, false, what);
    assertMinimum(out, 14);
    assertNoOverlap(out.nodes);
    assertInside(out);
    assertEdgesClear(out);
    assertLabelsClear(out);
  }
});

test("routed edges stay off a wrapped group's trunk and inside the SVG", () => {
  const kids = children(4);
  const nodes = [node("root"), ...kids];
  const edges = [...kids.map((k) => edge("root", k.id, true)), edge("c0", "c2"), edge("c2", "c0"), edge("c1", "c3")];
  const out = run(nodes, edges, 280, 600, 14);
  assertEdgesClear(out);
  assertOffTrunks(out, nodes);
  assertLabelsClear(out);
  const outside3 = [node("r"), node("a", "r", 1), node("b", "r", 1), outside("x")];
  const flat = run(outside3, [edge("a", "b"), edge("b", "a"), edge("r", "x"), edge("x", "r")], 630, 211, 14);
  assertEdgesClear(flat);
  assertLabelsClear(flat);
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

test("outside nodes sit right of the tree; their edges are routed clear of the boxes", () => {
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
  assert.equal(out.outsidePlacement, "right");
  for (const e of out.edges.filter((x) => !(x.from === "root" && x.to === "c0"))) {
    assert.ok(axisAligned(e.path), `${e.from}->${e.to} runs in right angles`);
  }
  assertEdgesClear(out);
  assertLabelsClear(out);
  // routed edges start and end on box borders, not at the centres
  for (const e of out.edges) {
    const segs = segments(e.path);
    const [x0, y0] = segs[0], [, , x1, y1] = segs[segs.length - 1];
    for (const [id, x, y] of [[e.from, x0, y0], [e.to, x1, y1]]) {
      const b = m.get(id);
      const onBorder = Math.min(Math.abs(x - b.x), Math.abs(x - b.x - b.w), Math.abs(y - b.y), Math.abs(y - b.y - b.h)) <= 0.5;
      assert.ok(onBorder, `${e.from}->${e.to} end on ${id}'s border`);
    }
  }
  // a nested tree with outside nodes at 420 px: no horizontal scroll (column right or rows below), all clear
  const nested = [node("root"), node("a", "root", 1), node("b", "root", 1), node("a1", "a", 2), node("a2", "a", 2), node("b1", "b", 2), outside("x"), outside("y")];
  const nestedEdges = [edge("root", "a", true), edge("a", "a1", true), edge("a1", "x"), edge("x", "a1"), edge("root", "y"), edge("b1", "a2")];
  const deep = run(nested, nestedEdges, 420, 400);
  assert.equal(deep.scrollX, false);
  assertMinimum(deep);
  assertNoOverlap(deep.nodes);
  assertEdgesClear(deep);
  assertLabelsClear(deep);
});

test("outside nodes move into rows below a tree the right-hand column would make too wide", () => {
  const nodes = [node("root"), ...children(2), outside("x")];
  const edges = [edge("root", "c0", true), edge("root", "c1", true), edge("c1", "x"), edge("x", "c1")];
  const out = run(nodes, edges, 280, 400);
  assert.equal(out.outsidePlacement, "below");
  assert.equal(out.scrollX, false);
  assert.equal(out.width, 280);
  const m = byId(out);
  const treeBottom = Math.max(...["root", "c0", "c1"].map((id) => m.get(id).y + m.get(id).h));
  assert.ok(m.get("x").y > treeBottom, "below every tree node");
  assertMinimum(out);
  assertNoOverlap(out.nodes);
  assertInside(out);
  assertEdgesClear(out);
  assertLabelsClear(out);
  // several outside nodes below wrap into rows like children
  const many = run([...nodes, outside("y"), outside("z")], edges, 280, 400);
  assert.equal(many.outsidePlacement, "below");
  assert.equal(many.scrollX, false);
  assertNoOverlap(many.nodes);
  // wide enough: they stay on the right
  assert.equal(run(nodes, edges, 600, 400).outsidePlacement, "right");
});

test("outside nodes go where the graph fits without scrolling: root, 2 children and 1 outside at 420 x 300", () => {
  const nodes = [node("root"), ...children(2), outside("x")];
  const edges = [edge("root", "c0", true), edge("c0", "root", true), edge("root", "c1", true), edge("c1", "root", true), edge("x", "root"), edge("root", "x")];
  const out = run(nodes, edges, 420, 300, 14);
  assert.equal(out.scrollX, false);
  assert.equal(out.scrollY, false);
  assertMinimum(out, 14);
  assertNoOverlap(out.nodes);
  assertInside(out);
  assertEdgesClear(out);
  // wider boxes (long names) that fit neither way: the placement without a horizontal scroll
  const wide = CommsLayout.layout(nodes, edges, { width: 420, height: 300, font: 14, minNode: 190 });
  assert.equal(wide.scrollX, false, `${wide.outsidePlacement} ${wide.width}x${wide.height}`);
  assertNoOverlap(wide.nodes);
  assertInside(wide);
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
  // siblings: two routed edges side by side
  check(out, "c0", "c1");
  assertEdgesClear(out);
  assertLabelsClear(out);
  // a wrapped group's routed edges
  const kids = children(5);
  const wrapped = run([node("root"), ...kids], [edge("root", "c3", true), edge("c3", "root", true)], 280, 300);
  check(wrapped, "root", "c3");
  assertEdgesClear(wrapped);
  assertPairsApart(out);
  // wide one-row groups of pairs: the lines stay apart, no pair crosses another, labels clear
  for (const [count, width, height] of [[3, 700, 300], [4, 900, 300], [6, 1100, 300], [6, 1300, 500], [4, 700, 400]]) {
    const kids = children(count);
    const row = run([node("root"), ...kids], kids.flatMap((k) => [edge("root", k.id, true), edge(k.id, "root", true)]), width, height, 14);
    assertPairsApart(row);
    assertEdgesClear(row);
    assertLabelsClear(row);
    assertDirectionsApart(row, [node("root"), ...kids]);
  }
  // an outside node's routed edges
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
  assert.deepEqual(
    { ...empty, label: undefined },
    { width: 300, height: 200, scrollX: false, scrollY: false, outsidePlacement: "right", label: undefined, nodes: [], edges: [] },
  );
  assert.deepEqual(empty.label, { w: 28.5, h: 17 }, "the label pill: 2.2 x 1.3 font sizes, rounded to 0.5 px");
  const one = run([node("root"), outside("x")], [edge("root", "gone"), edge("x", "x"), edge("root", "x")], 300, 200);
  assert.deepEqual(one.edges.map((e) => `${e.from}>${e.to}`), ["root>x"]);
  // a ghost ("proposed") child is laid out under its parent like the others
  const ghost = run([node("root"), node("proposed:1", "root", 1, { state: "proposed" })], [], 420, 300);
  const m = byId(ghost);
  assert.ok(m.get("proposed:1").y > m.get("root").y + m.get("root").h);
});

test("seeded random trees: no edge grazes a box or runs along a trunk, pairs stay apart, labels clear but in saturated spots", () => {
  // labels: a short route through a gap other lines also cross can have no clear place on its line (measured about
  // 0.1-0.5% of labels in random graphs; every focused case above asserts none), so the set gets a small budget
  let labels = 0;
  const conflicts = [];
  for (const font of [13, 14]) {
  let seed = 20261126;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  for (let run_ = 0; run_ < 60; run_++) {
    const dense = run_ % 3 === 2;
    const count = dense ? 6 + Math.floor(rnd() * 14) : 2 + Math.floor(rnd() * 8);
    const nodes = [node("n0")];
    for (let i = 1; i < count; i++) {
      const parent = !dense && i < 7 && rnd() < 0.8 ? "n0" : `n${Math.floor(rnd() * i)}`;
      nodes.push(node(`n${i}`, parent, 1));
    }
    for (let i = 0, k = Math.floor(rnd() * 4); i < k; i++) nodes.push(outside(`x${i}`));
    const edges = [];
    const seen = new Set();
    const add = (from, to) => {
      if (from === to || seen.has(`${from}>${to}`)) return;
      seen.add(`${from}>${to}`);
      edges.push(edge(from, to));
    };
    for (const n of nodes) {
      if (!n.parent) continue;
      add(n.parent, n.id);
      if (rnd() < 0.5) add(n.id, n.parent);
    }
    for (let i = 0, k = 1 + Math.floor(rnd() * 4); i < k; i++) {
      const a = pick(nodes).id, b = pick(nodes).id;
      add(a, b);
      if (rnd() < 0.5) add(b, a);
    }
    for (const x of nodes.filter((n) => !n.inTree)) add(pick(nodes.filter((n) => n.inTree)).id, x.id);
    const width = 280 + Math.floor(rnd() * 500), height = 200 + Math.floor(rnd() * 500);
    const out = run(nodes, edges, width, height, font);
    const what = `font ${font} run ${run_} (${count} tree nodes, ${width}x${height})`;
    assert.equal(out.edges.length, edges.length, what);
    assert.equal(out.scrollX, out.width > width, what);
    assert.equal(out.scrollY, out.height > height, what);
    assertMinimum(out, font);
    assertNoOverlap(out.nodes);
    assertInside(out);
    assertEdgesClear(out);
    assertOffTrunks(out, nodes);
    assertPairsApart(out);
    assertDirectionsApart(out, nodes);
    labels += out.edges.length;
    conflicts.push(...labelConflicts(out).map((x) => `${what}: ${x}`));
  }
  }
  assert.ok(conflicts.length <= labels * 0.005, `${conflicts.length} of ${labels} labels crowded:\n${conflicts.join("\n")}`);
});
