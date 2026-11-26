// Pure model of the Communication panel (no DOM): the tree's sessions and their counterparts as graph nodes, the
// messages between them as edges with their live state, the log rows (latest status folded in) and the statistics.
// Loaded as a classic <script> (sets globalThis.CommsModel) and via require() in tests.
"use strict";
(function () {

const Tree = globalThis.SessionTree ?? require("./session-tree.js");

const PREFIX = "cli:";
const LINKED = new Set(["task", "message", "report"]); // kinds between sessions (they make edges)
const HELD_KINDS = ["child", "parent", "other"];

/** A broker key's node id: the bare session id for "cli:" keys, the key itself for other peers; null for relay/user. */
const nodeId = (key) => (typeof key !== "string" ? null : key.startsWith(PREFIX) ? key.slice(PREFIX.length) : key);
const ms = (v) => {
  const t = typeof v === "number" ? v : new Date(v ?? 0).getTime();
  return Number.isNaN(t) ? 0 : t;
};
const pairKey = (from, to) => JSON.stringify([from, to]);

/** True when the session has a parent or at least one child in a SessionTree index. */
function inTree(tree, sessionId) {
  return tree?.parentOf?.get(sessionId) != null || (tree?.childrenOf?.get(sessionId)?.length ?? 0) > 0;
}

/** The top of id's tree (cycle-safe). */
function rootOf(tree, id) {
  const seen = new Set([id]);
  let cur = id;
  for (let p = tree.parentOf.get(cur); p != null && !seen.has(p); p = tree.parentOf.get(cur)) {
    seen.add(p);
    cur = p;
  }
  return cur;
}

/** Non-status events once per id, in time order, each with its latest status folded in and its node ids. */
function messagesOf(events) {
  const sorted = [...events].sort((a, b) => ms(a.ts) - ms(b.ts)); // stable: equal times keep the broker's order
  const latest = new Map();
  const seen = new Set();
  const out = [];
  for (const e of sorted) {
    if (e.kind === "status") latest.set(e.ref, e.status);
    else if (!seen.has(e.id)) {
      seen.add(e.id);
      out.push(e);
    }
  }
  return out.map((e, seq) => ({ e, seq, src: nodeId(e.fromKey), dst: nodeId(e.toKey), status: latest.get(e.id) ?? e.status }));
}

/**
 * input = { comms: {root, keys, events, peers} | null, links, heldByKind, current, live, now, filter }
 * -> { nodes, edges, rows, stats, unsupported }  (see the Communication panel design, section 6)
 */
function build(input = {}) {
  const comms = input.comms ?? null;
  const tree = Tree.index(input.links ?? []);
  const heldByKind = input.heldByKind ?? {};
  const live = input.live ?? {};
  const filter = input.filter ?? null;
  const msgs = messagesOf(comms?.events ?? []);

  // tree membership: the root and its descendants (SessionTree order: createdAt)
  const rootId = comms ? nodeId(comms.root) : input.current != null ? rootOf(tree, input.current) : null;
  const treeIds = rootId == null ? [] : [rootId, ...Tree.descendants(tree, rootId)];
  const inTreeSet = new Set(treeIds);
  const keyOf = new Map(treeIds.map((id) => [id, id === rootId && comms ? comms.root : PREFIX + id]));
  const treeParent = (id) => (inTreeSet.has(id) && id !== rootId ? tree.parentOf.get(id) : null);
  const outside = [];
  for (const m of msgs) {
    for (const [id, k] of [[m.src, m.e.fromKey], [m.dst, m.e.toKey]]) {
      if (id == null || keyOf.has(id)) continue;
      keyOf.set(id, k);
      outside.push(id);
    }
  }

  // facts per node from the events
  const lastName = new Map();
  const firstTask = new Map(); // pairKey(parent, child) -> first task ts
  const tasked = new Set(); // ids that got a task event
  const released = new Set();
  const lastReport = new Map();
  const counts = new Map(); // id -> { sent, received, relay, user }
  const count = (id) => counts.get(id) ?? { sent: 0, received: 0, relay: 0, user: 0 };
  const bump = (id, field) => {
    if (id == null) return;
    if (!counts.has(id)) counts.set(id, count(id));
    counts.get(id)[field] += 1;
  };
  for (const m of msgs) {
    if (m.src != null && typeof m.e.from === "string") lastName.set(m.src, m.e.from);
    if (m.dst != null && typeof m.e.to === "string") lastName.set(m.dst, m.e.to);
    if (m.e.kind === "notice") bump(m.dst, "relay");
    else if (m.e.kind === "user") bump(m.dst, "user");
    if (!LINKED.has(m.e.kind)) continue;
    bump(m.src, "sent");
    bump(m.dst, "received");
    if (m.e.kind === "task") {
      tasked.add(m.dst);
      const k = pairKey(m.src, m.dst);
      if (!firstTask.has(k)) firstTask.set(k, ms(m.e.ts));
      if (inTreeSet.has(m.src) && !inTreeSet.has(m.dst)) released.add(m.dst);
    } else if (m.e.kind === "report") lastReport.set(m.src, ms(m.e.ts));
  }

  // online/busy: links for children, peers for the root and outside nodes; neither -> closed
  const facts = (id) => {
    const l = tree.link.get(id);
    const p = comms?.peers?.[keyOf.get(id)];
    return (treeParent(id) != null ? l ?? p : p ?? l) ?? {};
  };
  const stateOf = (id) => {
    const f = facts(id);
    const l = tree.link.get(id);
    if (f.online !== true) return "closed";
    if (f.busy === true) return "working";
    if (l?.reported === true || (!tasked.has(id) && !l?.task)) return "waiting-task";
    return "idle";
  };
  const depth = new Map();
  const makeNode = (id, inTreeNode) => {
    const parent = inTreeNode ? treeParent(id) ?? null : null;
    if (inTreeNode) depth.set(id, parent == null ? 0 : depth.get(parent) + 1);
    const c = count(id);
    const node = {
      id, name: comms?.peers?.[keyOf.get(id)]?.name ?? tree.link.get(id)?.name ?? lastName.get(id) ?? id,
      inTree: inTreeNode, released: released.has(id), parent, depth: inTreeNode ? depth.get(id) : null, state: stateOf(id),
    };
    if (node.state === "waiting-task" && lastReport.has(id)) node.waitingSince = lastReport.get(id);
    if (live[id]?.ctx) node.ctx = live[id].ctx;
    if (live[id]?.keeper) node.keeper = live[id].keeper;
    Object.assign(node, {
      cards: [...(live[id]?.cards ?? [])], badges: { relay: c.relay, user: c.user }, sent: c.sent, received: c.received,
      current: id === input.current,
    });
    return node;
  };
  const treeNodes = treeIds.map((id) => makeNode(id, true));
  const ghosts = [];
  for (const id of treeIds) {
    for (const card of live[id]?.cards ?? []) {
      if (card?.kind !== "create") continue;
      ghosts.push({
        id: `proposed:${card.id}`, name: card.name, inTree: true, released: false, parent: id, depth: depth.get(id) + 1,
        state: "proposed", cards: [], badges: { relay: 0, user: 0 }, sent: 0, received: 0, current: false,
      });
    }
  }
  const nodes = [...treeNodes, ...ghosts, ...outside.map((id) => makeNode(id, false))];
  const stateById = new Map(nodes.map((n) => [n.id, n.state]));

  // edges: one per direction of each pair that exchanged task/message/report events
  const edges = new Map();
  const lastOf = new Map(); // pairKey -> { event, message } (the edge's last event and last message)
  const ensure = (from, to) => {
    const k = pairKey(from, to);
    if (!edges.has(k)) {
      const isTree = treeParent(to) === from || treeParent(from) === to;
      edges.set(k, { from, to, tree: isTree, count: 0, size: 0, last: null, live: null, held: 0 });
      lastOf.set(k, { event: null, message: null });
    }
    return edges.get(k);
  };
  for (const m of msgs) {
    if (!LINKED.has(m.e.kind) || m.src == null || m.dst == null) continue;
    const edge = ensure(m.src, m.dst);
    edge.count += 1;
    edge.size += Number(m.e.size) || 0;
    edge.last = ms(m.e.ts);
    const last = lastOf.get(pairKey(m.src, m.dst));
    last.event = m;
    if (m.e.kind === "message") last.message = m;
  }

  // live state, at most one per edge, in priority order
  const setLive = (edge, state, since) => {
    if (edge.live) return;
    edge.live = state;
    if (since !== undefined) edge.since = since;
  };
  for (const id of treeIds) {
    const parent = treeParent(id);
    if (parent == null) continue;
    const l = tree.link.get(id) ?? {};
    const since = firstTask.get(pairKey(parent, id)) ?? ms(l.createdAt);
    if (l.endedNotice === true) setLive(ensure(id, parent), "ended-no-report");
    else if (l.reported !== true) setLive(ensure(id, parent), "waiting-report", since);
    if (stateById.get(id) === "working" && l.reported !== true) setLive(ensure(parent, id), "in-progress", since);
  }
  for (const [k, edge] of edges) {
    const { message } = lastOf.get(k);
    if (message?.status === "awaiting-reopen") setLive(edge, "awaiting-reopen", ms(message.e.ts));
  }
  const ranked = new Set([...edges].filter(([, e]) => e.live).map(([k]) => k)); // pairs a higher state applies to
  for (const [k, edge] of edges) {
    const back = pairKey(edge.to, edge.from);
    const { event } = lastOf.get(k);
    if (edge.live || ranked.has(back) || event?.e.kind !== "message") continue;
    const answer = lastOf.get(back)?.event;
    if (!answer || answer.seq < event.seq) setLive(edge, "waiting-reply", ms(event.e.ts));
  }

  // held messages into the edge's target, by kind
  const heldOf = (id, kind) => Number(heldByKind[keyOf.get(id)]?.[kind]) || 0;
  const kindOf = (edge) => (treeParent(edge.from) === edge.to ? "child" : treeParent(edge.to) === edge.from ? "parent" : "other");
  for (const edge of edges.values()) edge.held = heldOf(edge.to, kindOf(edge));

  // rows and statistics, narrowed by the filter (the graph is not)
  const match = !filter
    ? () => true
    : filter.node != null
      ? (m) => m.src === filter.node || m.dst === filter.node
      : (m) => m.src === filter.from && m.dst === filter.to;
  const shown = msgs.filter(match);
  const rows = shown.map(({ e, status }) => ({ id: e.id, ts: e.ts, kind: e.kind, from: e.from, to: e.to, size: e.size, preview: e.preview, status }));

  const spans = [];
  for (const id of treeIds) {
    const parent = treeParent(id);
    if (parent == null) continue;
    const task = shown.find((m) => m.e.kind === "task" && m.src === parent && m.dst === id);
    const report = task && shown.find((m) => m.e.kind === "report" && m.src === id && m.dst === parent && m.seq > task.seq);
    if (report) spans.push(ms(report.e.ts) - ms(task.e.ts));
  }
  const heldTotal = (id) => HELD_KINDS.reduce((sum, kind) => sum + heldOf(id, kind), 0);
  const heldNow = !filter
    ? nodes.filter((n) => n.state !== "proposed").reduce((sum, n) => sum + heldTotal(n.id), 0)
    : filter.node != null
      ? (keyOf.has(filter.node) ? heldTotal(filter.node) : 0)
      : edges.get(pairKey(filter.from, filter.to))?.held ?? 0;
  const withStatus = (s) => shown.filter((m) => m.status === s).length;
  const stats = {
    messages: shown.length,
    size: shown.reduce((sum, m) => sum + (Number(m.e.size) || 0), 0),
    avgTaskToReport: spans.length ? spans.reduce((a, b) => a + b, 0) / spans.length : null,
    heldNow,
    discarded: withStatus("discarded"),
    dropped: withStatus("dropped"),
    blocked: withStatus("blocked"),
  };

  return { nodes, edges: [...edges.values()], rows, stats, unsupported: comms === null };
}

const CommsModel = { build, inTree };
globalThis.CommsModel = CommsModel;
if (typeof module !== "undefined") module.exports = CommsModel;
})();
