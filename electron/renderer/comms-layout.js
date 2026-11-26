// Pure layout of the Communication panel's graph: where each node box, edge path and edge label goes in an SVG that
// fits the graph area (no DOM). Input = CommsModel.build's nodes and edges; the view (comms-view.js) draws the result.
// Loaded as a classic <script> (sets globalThis.CommsLayout) and via require() in tests.
"use strict";
(function () {

// Proportions. Every length scales with one factor s >= 1 from the minimum box (minNode x font * H_PER_FONT).
const H_PER_FONT = 3.2; // box height at the minimum: a name line and a status line
const MAX_NODE = 320; // box width cap (px): a single root in a huge panel stays readable, not absurd
const GAP_X = 0.25; // horizontal gap / box width; also the indent of a wrapped group (its trunk runs in it)
const GAP_Y = 0.85; // vertical gap / box height (a label fits between a pair's buses and the row below)
const PAD = 0.13; // margin around the graph / box width (room for the routing lane outside the outer boxes)
const OUT_GAP = GAP_X; // gap before the "outside the tree" column / box width
const BELOW_GAP = 1.5; // gap above outside nodes placed below the tree / vertical gap
const PAIR = 0.035; // half the distance between the two directions of a pair / box width
const BUS = 0.7; // a wrapped row's bus runs this share of the gap above the row (the drop below it holds the label)
const LANE = 0.4; // routing lanes run this share of the smaller gap outside each box
const CLEAR = 2; // px a routed edge (either line of a pair) keeps from every box
const BEND = 0.15; // the routing cost of a bend, in box widths of length
const LABEL_W = 2.2, LABEL_H = 1.3; // the label pill the view may draw around a label point, in font sizes

const half = (v) => Math.round(v * 2) / 2;
const up = (v) => Math.ceil(v * 2 - 1e-9) / 2;
const rowOf = (subs, gx) => subs.reduce((sum, b) => sum + b.w, 0) + gx * (subs.length - 1);
const num = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

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
    trunks.push({ child: b.items[0].id, x: g.gx / 2, y: y - g.bus });
    x += b.w + g.gx;
    rowH = Math.max(rowH, b.h);
    w = Math.max(w, x - g.gx);
  }
  return { w, h: y + rowH, items, trunks };
}

/** Sorted distinct values (closer than 0.01 count as one). */
function distinct(values) {
  const out = [];
  for (const v of [...values].sort((a, b) => a - b)) if (!out.length || v - out[out.length - 1] > 0.01) out.push(v);
  return out;
}

/** The index of the value in a sorted list closest to v. */
function nearest(list, v) {
  let lo = 0, hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && v - list[lo - 1] < list[lo] - v ? lo - 1 : lo;
}

/** A binary min-heap of [cost, state]; equal costs leave in insertion order of the heap's structure (deterministic). */
function heap() {
  const a = [];
  const swap = (i, j) => ([a[i], a[j]] = [a[j], a[i]]);
  return {
    get size() {
      return a.length;
    },
    push(cost, state) {
      a.push([cost, state]);
      for (let i = a.length - 1, p; i > 0 && a[(p = (i - 1) >> 1)][0] > a[i][0]; i = p) swap(i, p);
    },
    pop() {
      const top = a[0], last = a.pop();
      if (a.length) {
        a[0] = last;
        for (let i = 0; ; ) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < a.length && a[l][0] < a[m][0]) m = l;
          if (r < a.length && a[r][0] < a[m][0]) m = r;
          if (m === i) break;
          swap(i, m);
          i = m;
        }
      }
      return top;
    },
  };
}

/**
 * An orthogonal router over the boxes: a grid of lanes `lane` px outside every box side (plus the port lines; lanes
 * a line offset by o would take out of `bounds` are left out), with every grid segment that comes within `clear` px of
 * a box blocked. route(a, b) -> the polyline from a port of a
 * (a side's middle, or 3/4 along the top or bottom: the middle belongs to tree edges) to a port of b, shortest with a
 * cost per bend, per reuse of a segment an earlier route took (spreads parallel routes) and per placed label crossed
 * (avoid) or for running along a tree line (parallel). -> { route, avoid, parallel }
 */
function router(boxes, lane, clear, bend, bounds, o) {
  const inX = (x) => x >= o + 1.5 && x <= bounds.w - o - 1.5, inY = (y) => y >= o + 1.5 && y <= bounds.h - o - 1.5;
  const xs = distinct(boxes.flatMap((b) => [b.x - lane, b.x + b.w + lane, b.cx, b.x + b.w * 0.75]).filter(inX));
  const ys = distinct(boxes.flatMap((b) => [b.y - lane, b.y + b.h + lane, b.cy]).filter(inY));
  const nx = xs.length, ny = ys.length;
  const hit = (x1, y1, x2, y2) =>
    boxes.some((b) => x2 > b.x - clear && x1 < b.x + b.w + clear && y2 > b.y - clear && y1 < b.y + b.h + clear);
  const free = [new Uint8Array(nx * ny), new Uint8Array(nx * ny)]; // [horizontal (i,j)-(i+1,j), vertical (i,j)-(i,j+1)]
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      if (i + 1 < nx) free[0][i * ny + j] = hit(xs[i], ys[j], xs[i + 1], ys[j]) ? 0 : 1;
      if (j + 1 < ny) free[1][i * ny + j] = hit(xs[i], ys[j], xs[i], ys[j + 1]) ? 0 : 1;
    }
  }
  const used = [new Float64Array(nx * ny), new Float64Array(nx * ny)];
  const extra = [new Float64Array(nx * ny), new Float64Array(nx * ny)]; // cost of crossing a placed label
  const DX = [1, -1, 0, 0], DY = [0, 0, 1, -1], BACK = [1, 0, 3, 2]; // directions: +x, -x, +y, -y
  const segOf = (i, j, d) => (d < 2 ? [0, (i + Math.min(0, DX[d])) * ny + j] : [1, i * ny + j + Math.min(0, DY[d])]);
  const ports = (b) =>
    [
      [b.x + b.w + lane, b.cy, 0, b.x + b.w, b.cy],
      [b.x - lane, b.cy, 1, b.x, b.cy],
      [b.x + b.w * 0.75, b.y + b.h + lane, 2, b.x + b.w * 0.75, b.y + b.h],
      [b.x + b.w * 0.75, b.y - lane, 3, b.x + b.w * 0.75, b.y],
    ]
      .filter(([x, y]) => inX(x) && inY(y))
      .map(([x, y, out, px, py]) => ({ node: nearest(xs, x) * ny + nearest(ys, y), out, p: [px, py] }));
  /** Makes every grid segment through rectangle r cost `cost` more (a placed label later routes go around). */
  function avoid(r, cost) {
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        if (i + 1 < nx && meets([xs[i], ys[j]], [xs[i + 1], ys[j]], r)) extra[0][i * ny + j] += cost;
        if (j + 1 < ny && meets([xs[i], ys[j]], [xs[i], ys[j + 1]], r)) extra[1][i * ny + j] += cost;
      }
    }
  }
  /** Makes the grid segments that run along the axis-aligned segment p-q closer than dist cost `cost` more. */
  function parallel(p, q, dist, cost) {
    const flat = p[1] === q[1];
    if (!flat && p[0] !== q[0]) return;
    const [lo, hi] = flat ? [Math.min(p[0], q[0]), Math.max(p[0], q[0])] : [Math.min(p[1], q[1]), Math.max(p[1], q[1])];
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        if (flat && i + 1 < nx && Math.abs(ys[j] - p[1]) < dist && xs[i + 1] > lo && xs[i] < hi) extra[0][i * ny + j] += cost;
        if (!flat && j + 1 < ny && Math.abs(xs[i] - p[0]) < dist && ys[j + 1] > lo && ys[j] < hi) extra[1][i * ny + j] += cost;
      }
    }
  }
  function route(a, b) {
    const dist = new Float64Array(nx * ny * 4).fill(Infinity);
    const prev = new Int32Array(nx * ny * 4).fill(-1);
    const q = heap();
    const starts = new Map();
    for (const p of ports(a)) {
      starts.set(p.node, p);
      dist[p.node * 4 + p.out] = 0;
      q.push(0, p.node * 4 + p.out);
    }
    const goals = new Map(ports(b).map((p) => [p.node, p]));
    let best = Infinity, end = -1;
    while (q.size) {
      const [c, st] = q.pop();
      if (c > dist[st]) continue;
      if (c >= best) break;
      const node = st >> 2, dir = st & 3, i = Math.floor(node / ny), j = node % ny;
      const goal = goals.get(node);
      if (goal && c + (dir === BACK[goal.out] ? 0 : bend) < best) {
        best = c + (dir === BACK[goal.out] ? 0 : bend);
        end = st;
      }
      for (let d = 0; d < 4; d++) {
        const i2 = i + DX[d], j2 = j + DY[d];
        if (d === BACK[dir] || i2 < 0 || j2 < 0 || i2 >= nx || j2 >= ny) continue;
        const [k, at] = segOf(i, j, d);
        if (!free[k][at]) continue;
        const len = Math.abs(xs[i2] - xs[i]) + Math.abs(ys[j2] - ys[j]);
        const nc = c + len * (1 + used[k][at]) + extra[k][at] + (d === dir ? 0 : bend);
        const ns = (i2 * ny + j2) * 4 + d;
        if (nc < dist[ns]) {
          dist[ns] = nc;
          prev[ns] = st;
          q.push(nc, ns);
        }
      }
    }
    if (end < 0) return [[a.cx, a.y + a.h], [b.cx, b.y]]; // unreachable (never with disjoint boxes and gaps)
    const chain = [];
    for (let st = end; st >= 0; st = prev[st]) chain.unshift(st);
    for (let n = 1; n < chain.length; n++) {
      const node = chain[n - 1] >> 2;
      const [k, at] = segOf(Math.floor(node / ny), node % ny, chain[n] & 3);
      used[k][at] += 1;
    }
    const grid = chain.map((st) => [xs[Math.floor((st >> 2) / ny)], ys[(st >> 2) % ny]]);
    const pts = [starts.get(chain[0] >> 2).p, ...grid, goals.get(end >> 2).p];
    return pts.filter((p, n) => {
      const a0 = pts[n - 1], a2 = pts[n + 1];
      return !a0 || !a2 || !((a0[0] === p[0] && p[0] === a2[0]) || (a0[1] === p[1] && p[1] === a2[1]));
    });
  }
  return { route, avoid, parallel };
}

/** Whether the segment p -> q meets the open rectangle r (Liang-Barsky). */
function meets(p, q, r) {
  const dx = q[0] - p[0], dy = q[1] - p[1];
  let t0 = 0, t1 = 1;
  for (const [a, b] of [[-dx, p[0] - r.x], [dx, r.x + r.w - p[0]], [-dy, p[1] - r.y], [dy, r.y + r.h - p[1]]]) {
    if (a === 0) {
      if (b <= 0) return false;
      continue;
    }
    if (a < 0) t0 = Math.max(t0, b / a);
    else t1 = Math.min(t1, b / a);
    if (t0 >= t1) return false;
  }
  return true;
}

/**
 * A label point for item (its pts, a pair's sideways shift, the preferred place `at`: a share of the length or "drop" =
 * the middle of the last segment): the first place along the line, from the preferred one outward, on the line or just
 * beside it (a pair's label only on the side away from its twin), where an lw x lh pill touches no box, no other line
 * and no placed label; else the least crowded place. -> { p, c: its crowding (0 = clear) }
 */
function labelPlace(item, lines, placed, boxes, lw, lh, bounds) {
  const segs = [];
  for (let n = 1; n < item.pts.length; n++) segs.push([item.pts[n - 1], item.pts[n]]);
  const lens = segs.map(([p, q]) => Math.hypot(q[0] - p[0], q[1] - p[1]));
  const total = lens.reduce((x, y) => x + y, 0);
  const pref = item.at === "drop" ? total - lens[lens.length - 1] / 2 : total * item.at;
  const pairSide = (m) => (item.both ? Math.sign(item.shift[0] * m[0] + item.shift[1] * m[1]) || 1 : null);
  const pointAt = (dist, side) => {
    let n = 0;
    while (n < segs.length - 1 && dist > lens[n]) dist -= lens[n++];
    const [p, q] = segs[n];
    const t = lens[n] ? Math.min(1, Math.max(0, dist / lens[n])) : 0;
    const m = lens[n] ? [-(q[1] - p[1]) / lens[n], (q[0] - p[0]) / lens[n]] : [0, 0]; // a unit normal of the segment
    const by = (pairSide(m) ?? side) * ((Math.abs(m[0]) * lw) / 2 + (Math.abs(m[1]) * lh) / 2 + 1);
    return [half(p[0] + (q[0] - p[0]) * t + m[0] * by), half(p[1] + (q[1] - p[1]) * t + m[1] * by)];
  };
  const crowd = (p) => crowdAt(item, p, lines, placed, boxes, lw, lh, bounds);
  let best = null;
  const step = 2;
  for (let k = 0; k <= (2 * total) / step + 1 && best?.c !== 0; k++) {
    const dist = pref + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * step;
    if (dist < 0 || dist > total) continue;
    for (const side of item.both ? [1] : [0, 1, -1]) {
      const p = pointAt(dist, side);
      const c = crowd(p);
      if (!best || c < best.c) best = { p, c };
      if (!c) break;
    }
  }
  return best ?? { p: item.pts[0], c: Infinity };
}

/**
 * How crowded an lw x lh label of item at p is: 10 per box and when it leaves the SVG (bounds), 1 per other line's
 * segment and per other placed label.
 */
function crowdAt(item, [x, y], lines, placed, boxes, lw, lh, bounds) {
  const r = { x: x - lw / 2, y: y - lh / 2, w: lw, h: lh };
  let n = r.x < 0 || r.y < 0 || r.x + lw > bounds.w || r.y + lh > bounds.h ? 10 : 0;
  for (const b of boxes) if (overlap(r, b)) n += 10;
  for (const other of lines) {
    if (other === item) continue;
    for (let k = 1; k < other.pts.length; k++) if (meets(other.pts[k - 1], other.pts[k], r)) n += 1;
  }
  for (const p of placed) if (p.item !== item && overlap(r, p)) n += 1;
  return n;
}

/** An SVG polyline path "M p L p ...". */
const pathOf = (pts) => pts.map(([x, y], i) => `${i ? "L" : "M"} ${half(x)} ${half(y)}`).join(" ");

/**
 * Lays the graph out in an SVG of at least the area.
 *   nodes, edges: CommsModel.build's (node.parent, node.inTree; edge.from, edge.to)
 *   opts = { width, height, font, minNode = 140 }  (the graph area in px, the UI font size in px)
 * -> { width, height, scrollX, scrollY, outsidePlacement: "right" | "below", label: { w, h },
 *      nodes: [{ id, x, y, w, h }], edges: [{ from, to, path, labelX, labelY }] }
 *   x, y = a box's top left corner; all values rounded to 0.5 px. The boxes and gaps take the largest scale at which
 *   the graph fits the area (box width at most 320 px), never below minNode x font * 3.2; when even that does not fit,
 *   width/height exceed the area and scrollX/scrollY say which axis scrolls. Outside nodes form a column on the right
 *   of the tree, or rows below it when that column would overflow the width. Tree edges (parent <-> child) are
 *   straight lines (or a trunk-and-bus polyline into a wrapped row); other edges run in right angles around the
 *   boxes, never closer than 2 px. Both directions of a pair are parallel lines. A label point is on (or, for a pair,
 *   just beside) its own edge, where a label pill of `label` size touches no box, other edge or other label when
 *   there is such a place.
 */
function layout(nodes = [], edges = [], opts = {}) {
  const area = { w: num(opts.width, 1), h: num(opts.height, 1) };
  const font = num(opts.font, 13);
  const minNode = num(opts.minNode, 140);
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
  // the gaps at the minimum size, from the normal proportions (t = 0) to the floors (t = 1): gy still holds a label
  // under a pair's lower bus above a wrapped row (bus = the bus's height above the row), the routing lane stays clear of
  // the boxes, the margin may shrink to 4 px (the router then drops lanes that would leave the SVG)
  const o1 = minNode * PAIR;
  const lh0 = half(font * LABEL_H);
  const gapsAt = (t) => {
    const g = { w: minNode, h: font * H_PER_FONT, gx: minNode * GAP_X, out: minNode * OUT_GAP };
    const mix = (normal, floor) => normal + (Math.min(normal, floor) - normal) * t;
    const lane0 = Math.min(g.gx, g.h * GAP_Y) * LANE;
    g.gy = mix(g.h * GAP_Y, lh0 + 2 * o1 + 5);
    g.lane = mix(lane0, o1 + CLEAR + 1);
    g.pad = mix(Math.max(minNode * PAD, lane0 + o1 + 1.5), 2 * CLEAR);
    g.bus = Math.min(g.gy - o1 - 2, Math.max(g.gy * BUS, lh0 + o1 + 3));
    return g;
  };
  // the arrangement at the minimum size for gaps g: { g, unit: id -> top left, trunkOf: child -> trunk point,
  // placement, W1, H1 }
  const arrange = (g) => {
    const unit = new Map(); // id -> { x, y } top left at the minimum size
    const trunkOf = new Map(); // child id -> trunk point of its wrapped group
    const placeTree = (avail) => {
      unit.clear();
      trunkOf.clear();
      const ctx = { g, kids, memo: new Map(), up: new Set() };
      let w = 0, h = 0;
      for (const r of roots) {
        const b = block(r, avail, ctx);
        const y = g.pad + (h ? h + g.gy : 0);
        for (const it of b.items) unit.set(it.id, { x: g.pad + it.x, y: y + it.y });
        for (const t of b.trunks) trunkOf.set(t.child, { x: g.pad + t.x, y: y + t.y });
        w = Math.max(w, b.w);
        h = y - g.pad + b.h;
      }
      return { w, h };
    };
    // outside nodes (and any in-tree node the tree did not reach): a column on the right when it fits the width, else
    // rows below the tree; ordered by the topmost tree node each exchanged messages with
    const others = nodes.filter((n) => !n.inTree).length;
    let tree = placeTree(Math.max(g.w, area.w - 2 * g.pad - (others ? g.out + g.w : 0)));
    let placement = "right";
    if (others && tree.w && 2 * g.pad + tree.w + g.out + g.w > area.w) {
      placement = "below";
      tree = placeTree(Math.max(g.w, area.w - 2 * g.pad));
    }
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
    let W1, H1;
    if (placement === "right") {
      // level with that tree node when there is room (short routes), else below the previous one
      const colX = g.pad + (tree.w ? tree.w + g.out : 0);
      let end = g.pad - g.gy;
      for (const c of column) {
        const y = Math.max(end + g.gy, Number.isFinite(c.at) ? c.at : 0);
        unit.set(c.id, { x: colX, y });
        end = y + g.h;
      }
      W1 = (column.length ? colX + g.w : g.pad + tree.w) + g.pad;
      H1 = Math.max(tree.h, column.length ? end - g.pad : 0) + 2 * g.pad;
    } else {
      // rows like wrapped children, under a wider gap that sets the group apart
      const top = g.pad + tree.h + g.gy * BELOW_GAP;
      let x = g.pad, y = top, rowsW = 0;
      for (const c of column) {
        if (x > g.pad && x + g.w > area.w - g.pad) {
          x = g.pad;
          y += g.h + g.gy;
        }
        unit.set(c.id, { x, y });
        rowsW = Math.max(rowsW, x + g.w - g.pad);
        x += g.w + g.gx;
      }
      W1 = Math.max(tree.w, rowsW) + 2 * g.pad;
      H1 = y + g.h + g.pad;
    }
    return { g, unit, trunkOf, placement, W1, H1 };
  };
  // fit: the largest scale that fits (1 px spare for rounding), clamped to [1, the width cap]. When even the minimum
  // does not fit, the gaps give way toward their floors (the least squeeze that fits) when that avoids the scroll; a
  // graph that scrolls anyway keeps the normal gaps.
  const fitOf = (a) => Math.min((area.w - 1) / a.W1, (area.h - 1) / a.H1);
  let chosen = arrange(gapsAt(0));
  if (fitOf(chosen) < 1 && fitOf(arrange(gapsAt(1))) >= 1) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 10; i++) {
      const mid = (lo + hi) / 2;
      if (fitOf(arrange(gapsAt(mid))) >= 1) hi = mid;
      else lo = mid;
    }
    chosen = arrange(gapsAt(hi));
  }
  const { g, unit, trunkOf, placement, W1, H1 } = chosen;
  // fit: the largest scale that fits (1 px spare for rounding), clamped to [1, the width cap]
  const s = Math.max(1, Math.min(fitOf(chosen), MAX_NODE / minNode));
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

  // edge paths and labels. Tree edges first (their lines and labels are fixed), then each other pair is routed around
  // the boxes and the labels placed so far, and its labels placed at once, so later routes go around them too.
  const o = g.w * PAIR * s; // half the distance between a pair's two lines
  const lane = g.lane * s;
  const grid = router([...box.values()], lane, o + CLEAR, g.w * BEND * s, { w: width, h: height }, o);
  const lw = half(font * LABEL_W), lh = half(font * LABEL_H);
  const boxes = [...box.values()];
  const bounds = { w: width, h: height };
  const has = new Set(edges.map((e) => `${e.from}\0${e.to}`));
  const items = []; // { e, a, b, both, pts, shift, at, label }
  for (const e of edges) {
    const a = box.get(e.from), b = box.get(e.to);
    if (a && b && a !== b) items.push({ e, a, b, both: has.has(`${e.to}\0${e.from}`) });
  }
  const lines = []; // the items drawn so far
  const placed = []; // label rectangles placed so far
  const rectAt = ([x, y]) => ({ x: x - lw / 2, y: y - lh / 2, w: lw, h: lh });
  const draw = (item, pts) => {
    item.pts = pts.map(([x, y]) => [half(x), half(y)]);
    lines.push(item);
  };
  for (const item of items) {
    const { a, b, both } = item;
    const child = b.parent === a.id ? b : a.parent === b.id ? a : null;
    if (!child) continue;
    const parent = child === b ? a : b;
    const side = both ? (parent === a ? -1 : 1) : 0;
    const trunk = trunkOf.get(child.id);
    let pts;
    if (trunk) {
      const tx = offX + trunk.x * s, by = trunk.y * s, d = side * o;
      pts = [[tx + d, parent.y + h], [tx + d, by + d], [child.cx + d, by + d], [child.cx + d, child.y]];
      item.shift = [d, d];
      item.at = "drop";
    } else {
      // the lines of a row fan out from the parent's bottom border in the children's order, so they never cross
      const row = kids.get(parent.id) ?? [child.id];
      const gap = w / (row.length + 1);
      const sx = parent.x + gap * (row.indexOf(child.id) + 1), sy = parent.y + h, ex = child.cx, ey = child.y;
      const dx = ex - sx, dy = ey - sy, len = Math.hypot(dx, dy);
      const nx = dy / len, ny = -dx / len; // the normal of parent -> child
      const lim = Math.min(w / 2 - 2, gap / 2 - 1);
      const slide = Math.max(-lim, Math.min(lim, side * o * (nx - (dx * ny) / dy)));
      pts = [[sx + slide, sy], [ex + slide, ey]];
      item.shift = [side * o * nx, side * o * ny];
      item.at = 0.5;
    }
    if (parent !== a) pts.reverse();
    item.tree = true;
    draw(item, pts);
  }
  const penalty = g.w * s * 4;
  // routed lines (a pair's at +-o from its route) keep 4 px from the tree's lines they run along (worse than crossing
  // a label); crossing a tree line is cheap
  for (const item of lines) {
    for (let n = 1; n < item.pts.length; n++) grid.parallel(item.pts[n - 1], item.pts[n], o + 4, 3 * penalty);
  }
  const commit = (item) => {
    const r = rectAt(item.label);
    placed.push({ ...r, item });
    // grown by a pair line's offset: the base route keeps both lines out
    grid.avoid({ x: r.x - o - 1, y: r.y - o - 1, w: r.w + 2 * o + 2, h: r.h + 2 * o + 2 }, penalty);
  };
  for (const item of lines) {
    item.label = labelPlace(item, lines, placed, boxes, lw, lh, bounds).p;
    commit(item);
  }
  const pairs = new Map(); // canonical pair -> its items
  for (const item of items) {
    if (item.tree) continue;
    const [first, second] = item.a.index < item.b.index ? [item.a, item.b] : [item.b, item.a];
    const key = `${first.id}\0${second.id}`;
    if (!pairs.has(key)) pairs.set(key, { first, second, items: [] });
    pairs.get(key).items.push(item);
  }
  // a pair's route, its lines (every corner moved (d, d), the ends sliding along their box border) and its labels;
  // -> { base, c: how crowded its labels are }
  const lay = (first, second, twins) => {
    const base = grid.route(first, second);
    for (const item of twins) {
      const d = item.both ? (first === item.a ? -o : o) : 0;
      const pts = base.map(([x, y], n) => {
        if (n > 0 && n < base.length - 1) return [x + d, y + d];
        const nb = base[n ? n - 1 : 1];
        return nb[0] === x ? [x + d, y] : [x, y + d];
      });
      if (first !== item.a) pts.reverse();
      Object.assign(item, { shift: [d, d], at: 0.5 });
      draw(item, pts);
    }
    let c = 0;
    for (const item of twins) {
      const at = labelPlace(item, lines, placed, boxes, lw, lh, bounds);
      item.label = at.p;
      c += at.c;
      placed.push({ ...rectAt(at.p), item });
    }
    placed.splice(placed.length - twins.length);
    return { base, c };
  };
  const undraw = (twins) => twins.forEach((item) => lines.splice(lines.indexOf(item), 1));
  // shortest pairs first: a short route has few places for its label, a long one can go around them. A pair whose
  // labels find no clear place is routed once more away from its first route; the less crowded one stays.
  const span = ({ first, second }) => Math.abs(first.cx - second.cx) + Math.abs(first.cy - second.cy);
  for (const { first, second, items: twins } of [...pairs.values()].sort((p, q) => span(p) - span(q))) {
    const one = lay(first, second, twins);
    if (one.c) {
      const kept = twins.map((item) => ({ pts: item.pts, label: item.label }));
      undraw(twins);
      const along = one.base.slice(1).map(([x, y], n) => {
        const [px, py] = one.base[n];
        return { x: Math.min(x, px) - 1, y: Math.min(y, py) - 1, w: Math.abs(x - px) + 2, h: Math.abs(y - py) + 2 };
      });
      along.forEach((r) => grid.avoid(r, penalty));
      const two = lay(first, second, twins);
      along.forEach((r) => grid.avoid(r, -penalty));
      if (two.c >= one.c) {
        undraw(twins);
        twins.forEach((item, n) => Object.assign(item, kept[n]));
        lines.push(...twins);
      }
    }
    twins.forEach(commit);
  }
  // repair: a label a later line could not avoid moves to a clear place on its line, if one exists now
  for (const item of lines) {
    const now = crowdAt(item, item.label, lines, placed, boxes, lw, lh, bounds);
    if (!now) continue;
    const again = labelPlace(item, lines, placed, boxes, lw, lh, bounds);
    if (again.c < now) {
      item.label = again.p;
      Object.assign(placed.find((p) => p.item === item), rectAt(again.p));
    }
  }
  const outEdges = items.map((item) => ({
    from: item.e.from, to: item.e.to, path: pathOf(item.pts), labelX: item.label[0], labelY: item.label[1],
  }));

  return {
    width, height, scrollX: contentW > area.w, scrollY: contentH > area.h, outsidePlacement: placement,
    label: { w: lw, h: lh }, nodes: outNodes, edges: outEdges,
  };
}

const CommsLayout = { layout };
globalThis.CommsLayout = CommsLayout;
if (typeof module !== "undefined") module.exports = CommsLayout;
})();
