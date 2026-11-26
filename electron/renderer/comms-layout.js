// Pure layout of the Communication panel's graph: where each node box and edge path goes in an SVG that fits the
// graph area (no DOM). Input = CommsModel.build's nodes and edges; the view (comms-view.js) draws the result.
// Loaded as a classic <script> (sets globalThis.CommsLayout) and via require() in tests.
"use strict";
(function () {

// Proportions. Every length scales with one factor s >= 1 from the minimum box (minNode x font * H_PER_FONT).
const H_PER_FONT = 3.2; // box height at the minimum: a name line and a status line
const MAX_NODE = 320; // box width cap (px): a single root in a huge panel stays readable, not absurd
const GAP_X = 0.25; // horizontal gap / box width; also the indent of a wrapped group (its trunk runs in it)
const GAP_Y = 0.7; // vertical gap / box height
const PAD = 0.08; // margin around the graph / box width
const OUT_GAP = GAP_X; // gap before the "outside the tree" column / box width
const PAIR = 0.035; // half the distance between the two directions of a pair / box width
const BUS = 0.75; // a wrapped row's bus runs this share of the gap above the row (the drop below it holds the label)
// an arc's control point lies this share of the chord beside the chord's middle (candidates, most liked first)
const BOWS = [0.2, 0.12, 0.3, 0.08, 0.45, 0.04, 0.6, 0.8, 1, 1.3, 1.7];
const ARCS = BOWS.flatMap((bow) => [[1, bow], [-1, bow]]); // [side, bow]: candidates in order of preference

const half = (v) => Math.round(v * 2) / 2;
const up = (v) => Math.ceil(v * 2 - 1e-9) / 2;
const rowOf = (subs, gx) => subs.reduce((sum, b) => sum + b.w, 0) + gx * (subs.length - 1);
const num = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);

/**
 * The block of a subtree at the minimum size: { w, h, items: [{ id, x, y }], trunks: [{ child, x, y }] }, coordinates
 * relative to the block. The children of a node go in one row centred under it when the row fits `avail`; else (two
 * or more children) they wrap into rows under it, indented by one horizontal gap, with a trunk down the indent (x)
 * and a bus above each row (y). A child's subtree stays inside its row, so a row is as tall as its tallest subtree
 * and no edge crosses a box. ctx = { g, kids, memo, up: ancestors (a cycle guard) }.
 */
function block(id, avail, ctx) {
  const key = `${id}\0${avail}`;
  if (ctx.memo.has(key)) return ctx.memo.get(key);
  const { g } = ctx;
  ctx.up.add(id);
  const ch = (ctx.kids.get(id) ?? []).filter((c) => !ctx.up.has(c));
  const sized = (room) => ch.map((c) => block(c, room, ctx));
  let subs = sized(avail);
  const wrap = subs.length > 1 && rowOf(subs, g.gx) > avail;
  if (wrap) subs = sized(avail - g.gx);
  ctx.up.delete(id);
  const res = place(id, avail, g, subs, wrap);
  ctx.memo.set(key, res);
  return res;
}

/** Places a node and its sized child blocks (see block). */
function place(id, avail, g, subs, wrap) {
  const items = [{ id, x: 0, y: 0 }];
  const trunks = [];
  if (!subs.length) return { w: g.w, h: g.h, items, trunks };
  const move = (b, dx, dy) => {
    for (const it of b.items) items.push({ id: it.id, x: it.x + dx, y: it.y + dy });
    for (const t of b.trunks) trunks.push({ child: t.child, x: t.x + dx, y: t.y + dy });
  };
  const top = g.h + g.gy;
  if (!wrap) {
    const rowW = rowOf(subs, g.gx);
    const w = Math.max(g.w, rowW);
    items[0].x = (w - g.w) / 2;
    let x = (w - rowW) / 2;
    let rowH = 0;
    for (const b of subs) {
      move(b, x, top);
      x += b.w + g.gx;
      rowH = Math.max(rowH, b.h);
    }
    return { w, h: top + rowH, items, trunks };
  }
  let x = g.gx, y = top, rowH = 0, w = g.w;
  for (const b of subs) {
    if (x > g.gx && x + b.w > avail) {
      y += rowH + g.gy;
      x = g.gx;
      rowH = 0;
    }
    move(b, x, y);
    trunks.push({ child: b.items[0].id, x: g.gx / 2, y: y - g.gy * BUS });
    x += b.w + g.gx;
    rowH = Math.max(rowH, b.h);
    w = Math.max(w, x - g.gx);
  }
  return { w, h: y + rowH, items, trunks };
}

/** A point of the quadratic curve (p0, c, p2) at t. */
function bez([p0, c, p2], t) {
  const u = 1 - t;
  return [u * u * p0[0] + 2 * u * t * c[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p2[1]];
}

const inBox = (b, [x, y], m = 0) => x > b.x - m && x < b.x + b.w + m && y > b.y - m && y < b.y + b.h + m;

/** The t in [from, to] where a curve starting inside box b at `from` first leaves it. */
function exit(b, q, from, to) {
  let lo = from, hi = to;
  for (let i = 1; i <= 40; i++) {
    const t = from + ((to - from) * i) / 40;
    if (!inBox(b, bez(q, t))) {
      hi = t;
      break;
    }
    lo = t;
  }
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (inBox(b, bez(q, mid))) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** The part of the curve q between t0 and t1, as a quadratic curve (the blossom of q). */
function part([p0, c, p2], t0, t1) {
  const at = (s, t) =>
    [0, 1].map((i) => (1 - s) * (1 - t) * p0[i] + ((1 - s) * t + s * (1 - t)) * c[i] + s * t * p2[i]);
  return [at(t0, t0), at(t0, t1), at(t1, t1)];
}

/** An SVG path: "M p L p L p ..." for a polyline, "M p Q c p" for a quadratic arc. */
function pathOf(cmd, pts) {
  const p = pts.map(([x, y]) => `${half(x)} ${half(y)}`);
  return cmd === "Q" ? `M ${p[0]} Q ${p[1]} ${p[2]}` : `M ${p[0]} ${p.slice(1).map((q) => `L ${q}`).join(" ")}`;
}

/**
 * Lays the graph out in an SVG of at least the area.
 *   nodes, edges: CommsModel.build's (node.parent, node.inTree; edge.from, edge.to)
 *   opts = { width, height, font, minNode = 140 }  (the graph area in px, the UI font size in px)
 * -> { width, height, scrollX, scrollY, nodes: [{ id, x, y, w, h }], edges: [{ from, to, path, labelX, labelY }] }
 *   x, y = a box's top left corner; all values rounded to 0.5 px. The boxes and gaps take the largest scale at which
 *   the graph fits the area (box width at most 320 px), never below minNode x font * 3.2; when even that does not fit,
 *   width/height exceed the area and scrollX/scrollY say which axis scrolls. Tree edges (parent <-> child) are
 *   straight lines (or a trunk-and-bus polyline into a wrapped row), others quadratic arcs bowed clear of the boxes;
 *   both directions of a pair are offset sideways and get distinct label points.
 */
function layout(nodes = [], edges = [], opts = {}) {
  const area = { w: num(opts.width, 1), h: num(opts.height, 1) };
  const font = num(opts.font, 13);
  const minNode = num(opts.minNode, 140);
  const g = { w: minNode, h: font * H_PER_FONT, gx: minNode * GAP_X, pad: minNode * PAD, out: minNode * OUT_GAP };
  g.gy = g.h * GAP_Y;

  // the tree: children per parent in the model's order (createdAt, ghosts after), roots = in-tree nodes without one
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map();
  const parentOf = new Map();
  const roots = [];
  for (const n of nodes) {
    if (!n.inTree) continue;
    const p = n.parent != null && n.parent !== n.id && byId.get(n.parent)?.inTree ? n.parent : null;
    if (p == null) {
      roots.push(n.id);
      continue;
    }
    parentOf.set(n.id, p);
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(n.id);
  }
  const hasOutside = nodes.some((n) => !n.inTree);
  const treeAvail = Math.max(g.w, area.w - 2 * g.pad - (hasOutside ? g.out + g.w : 0));
  const ctx = { g, kids, memo: new Map(), up: new Set() };
  const unit = new Map(); // id -> { x, y } top left at the minimum size
  const trunkOf = new Map(); // child id -> trunk point of its wrapped group
  let treeW = 0, treeH = 0;
  for (const r of roots) {
    const b = block(r, treeAvail, ctx);
    const y = g.pad + (treeH ? treeH + g.gy : 0);
    for (const it of b.items) unit.set(it.id, { x: g.pad + it.x, y: y + it.y });
    for (const t of b.trunks) trunkOf.set(t.child, { x: g.pad + t.x, y: y + t.y });
    treeW = Math.max(treeW, b.w);
    treeH = y - g.pad + b.h;
  }
  // outside nodes (and any in-tree node the tree did not reach) in one column on the right, ordered by the topmost
  // tree node each exchanged messages with and level with it when there is room (short arcs); the others below
  const anchor = new Map();
  for (const e of edges) {
    for (const [out, peer] of [[e.from, e.to], [e.to, e.from]]) {
      const y = unit.get(peer)?.y;
      if (y !== undefined && !unit.has(out)) anchor.set(out, Math.min(anchor.get(out) ?? Infinity, y));
    }
  }
  const column = nodes
    .filter((n) => !unit.has(n.id))
    .map((n, i) => ({ id: n.id, i, at: anchor.get(n.id) ?? Infinity }))
    .sort((p, q) => p.at - q.at || p.i - q.i);
  const colX = g.pad + (treeW ? treeW + g.out : 0);
  let colEnd = g.pad - g.gy;
  for (const c of column) {
    const y = Math.max(colEnd + g.gy, Number.isFinite(c.at) ? c.at : 0);
    unit.set(c.id, { x: colX, y });
    colEnd = y + g.h;
  }
  const colH = column.length ? colEnd - g.pad : 0;
  const W1 = (column.length ? colX + g.w : g.pad + treeW) + g.pad;
  const H1 = Math.max(treeH, colH) + 2 * g.pad;

  // fit: the largest scale that fits (1 px spare for rounding), clamped to [1, the width cap]
  const s = Math.max(1, Math.min((area.w - 1) / W1, (area.h - 1) / H1, MAX_NODE / minNode));
  const contentW = W1 * s, contentH = H1 * s;
  const width = Math.max(area.w, up(contentW));
  const height = Math.max(area.h, up(contentH));
  const offX = Math.max(0, (area.w - contentW) / 2);
  const w = up(g.w * s), h = up(g.h * s);
  const box = new Map();
  const outNodes = nodes.filter((n) => unit.has(n.id)).map((n) => {
    const u = unit.get(n.id);
    const b = { id: n.id, x: half(offX + u.x * s), y: half(u.y * s), w, h };
    box.set(n.id, { ...b, cx: b.x + w / 2, cy: b.y + h / 2, parent: parentOf.get(n.id), index: box.size });
    return b;
  });

  // edges
  const o = g.w * PAIR * s; // half the distance between a pair's two lines
  const k = font * 0.8; // a pair's label sits this far beside its line
  const has = new Set(edges.map((e) => `${e.from}\0${e.to}`));
  const inBounds = (c) => [Math.min(width, Math.max(0, c[0])), Math.min(height, Math.max(0, c[1]))];
  // the arc from a to b bowed by cand = [side, bow] and shifted sideways by d px: the curve from centre to centre,
  // drawn from box border to box border; n = the unit normal of a -> b
  const arcOf = (a, b, [side, bow], d) => {
    const dx = b.cx - a.cx, dy = b.cy - a.cy, len = Math.hypot(dx, dy) || 1;
    const n = [dy / len, -dx / len];
    const at = (x, y, by) => [x + n[0] * by, y + n[1] * by];
    const c = inBounds(at((a.cx + b.cx) / 2, (a.cy + b.cy) / 2, side * bow * len + d));
    const q = [at(a.cx, a.cy, d), c, at(b.cx, b.cy, d)];
    return { pts: part(q, exit(a, q, 0, 0.5), exit(b, q, 1, 0.5)), n };
  };
  const hits = (arc, rest) => {
    let n = 0;
    for (let t = 0.05; t < 0.96; t += 0.05) if (rest.some((r) => inBox(r, bez(arc, t), 2))) n++;
    return n;
  };
  // one bow per pair (canonical order a, b): the first candidate whose arcs (both offsets for a two-way pair) clear
  // every other box, else the least blocked
  const bows = new Map();
  const bowOf = (a, b, both) => {
    const key = `${a.id}\0${b.id}`;
    if (bows.has(key)) return bows.get(key);
    const rest = [...box.values()].filter((n) => n !== a && n !== b);
    let best = null;
    for (const cand of ARCS) {
      const n = (both ? [-o, o] : [0]).reduce((sum, d) => sum + hits(arcOf(a, b, cand, d).pts, rest), 0);
      if (!best || n < best.n) best = { cand, n };
      if (!n) break;
    }
    bows.set(key, best.cand);
    return best.cand;
  };

  const outEdges = [];
  for (const e of edges) {
    const a = box.get(e.from), b = box.get(e.to);
    if (!a || !b || a === b) continue;
    const both = has.has(`${e.to}\0${e.from}`);
    const childOf = b.parent === a.id ? b : a.parent === b.id ? a : null;
    let pts, cmd, label;
    if (childOf) {
      const parent = childOf === b ? a : b, child = childOf;
      const side = both ? (parent === a ? -1 : 1) : 0;
      const trunk = trunkOf.get(child.id);
      if (trunk) {
        const tx = offX + trunk.x * s, by = trunk.y * s, d = side * o;
        pts = [[tx + d, parent.y + h], [tx + d, by + d], [child.cx + d, by + d], [child.cx + d, child.y]];
        label = [child.cx + d + side * k, (by + d + child.y) / 2];
      } else {
        const sx = parent.cx, sy = parent.y + h, ex = child.cx, ey = child.y;
        const dx = ex - sx, dy = ey - sy, len = Math.hypot(dx, dy);
        const nx = dy / len, ny = -dx / len; // the normal of parent -> child
        const lim = w / 2 - 2;
        const shift = Math.max(-lim, Math.min(lim, side * o * (nx - (dx * ny) / dy)));
        pts = [[sx + shift, sy], [ex + shift, ey]];
        label = [(sx + ex) / 2 + shift + side * k * nx, (sy + ey) / 2 + side * k * ny];
      }
      if (parent !== a) pts.reverse();
      cmd = "L";
    } else {
      const [first, second] = a.index < b.index ? [a, b] : [b, a];
      const side = both ? (first === a ? -1 : 1) : 0;
      const arc = arcOf(first, second, bowOf(first, second, both), side * o);
      pts = first === a ? arc.pts : [...arc.pts].reverse();
      const mid = bez(arc.pts, 0.5);
      label = [mid[0] + side * k * arc.n[0], mid[1] + side * k * arc.n[1]];
      cmd = "Q";
    }
    outEdges.push({ from: e.from, to: e.to, path: pathOf(cmd, pts), labelX: half(label[0]), labelY: half(label[1]) });
  }

  return { width, height, scrollX: contentW > area.w, scrollY: contentH > area.h, nodes: outNodes, edges: outEdges };
}

const CommsLayout = { layout };
globalThis.CommsLayout = CommsLayout;
if (typeof module !== "undefined") module.exports = CommsLayout;
})();
