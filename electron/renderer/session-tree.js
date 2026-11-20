// Pure sub-session tree model (no DOM): parent/child index, cascade order, sidebar nesting, pruning.
// Loaded as a classic <script> (sets globalThis.SessionTree) and via require() in tests.
"use strict";

const PREFIX = "cli:";
const strip = (k) => (typeof k === "string" && k.startsWith(PREFIX) ? k.slice(PREFIX.length) : null);
const when = (l) => {
  const t = typeof l?.createdAt === "number" ? l.createdAt : new Date(l?.createdAt ?? 0).getTime();
  return Number.isNaN(t) ? 0 : t;
};

/** links: snapshot array (keys "cli:<id>"). Ids everywhere else are bare session ids. */
function index(links = []) {
  const parentOf = new Map();
  const childrenOf = new Map();
  const link = new Map();
  for (const l of links) {
    const id = strip(l.key);
    if (id === null) continue;
    link.set(id, l);
    const parent = l.parentDeleted ? null : strip(l.parent);
    parentOf.set(id, parent);
    if (parent !== null && parent !== id) {
      if (!childrenOf.has(parent)) childrenOf.set(parent, []);
      childrenOf.get(parent).push(id);
    }
  }
  for (const list of childrenOf.values()) list.sort((a, b) => when(link.get(a)) - when(link.get(b)));
  return { parentOf, childrenOf, link };
}

/** All descendants of id, depth-first, cycle-safe (never includes id itself). */
function descendants(idx, id) {
  const out = [];
  const seen = new Set([id]);
  const walk = (cur) => {
    for (const c of idx.childrenOf.get(cur) ?? []) {
      if (seen.has(c)) continue;
      seen.add(c);
      out.push(c);
      walk(c);
    }
  };
  walk(id);
  return out;
}

/** Open descendants of id, deepest first (post-order), excluding id. */
function closeOrder(idx, id, isOpen) {
  const out = [];
  const seen = new Set([id]);
  const walk = (cur) => {
    for (const c of idx.childrenOf.get(cur) ?? []) {
      if (seen.has(c)) continue;
      seen.add(c);
      walk(c);
      if (isOpen(c)) out.push(c);
    }
  };
  walk(id);
  return out;
}

/** Orders a group's sessions as a tree: roots keep group order, children sit under an in-group parent. */
function nest(sessions, idx) {
  const inGroup = new Map(sessions.map((s) => [s.sessionId, s]));
  const done = new Set();
  const out = [];
  const emit = (id, depth) => {
    done.add(id);
    out.push({ s: inGroup.get(id), depth });
    for (const c of idx.childrenOf.get(id) ?? []) if (inGroup.has(c) && !done.has(c)) emit(c, depth + 1);
  };
  const isRoot = (id) => {
    const p = idx.parentOf.get(id) ?? null;
    return p === null || p === id || !inGroup.has(p);
  };
  for (const s of sessions) if (!done.has(s.sessionId) && isRoot(s.sessionId)) emit(s.sessionId, 0);
  for (const s of sessions) if (!done.has(s.sessionId)) emit(s.sessionId, 0); // cycle members
  return out;
}

function relation(idx, id) {
  return {
    parent: idx.parentOf.get(id) ?? null,
    parentDeleted: idx.link.get(id)?.parentDeleted === true,
    children: (idx.childrenOf.get(id) ?? []).map((c) => ({ id: c, grandchildren: (idx.childrenOf.get(c) ?? []).length })),
  };
}

/** cli: keys missing from a successful list: linked sessions, and parents that still have (non-orphaned) children.
 *  Never a key whose link is online (a child being created is connected before Copilot lists it).
 *  exclude: bare ids never reported (open, being deleted, deleted — a new session may not be listed yet). */
function pruneCandidates(links, sessions, { listOk, exclude = new Set() } = {}) {
  if (!listOk) return [];
  const have = new Set(sessions.map((s) => s.sessionId));
  const online = new Set(links.filter((l) => l.online === true).map((l) => l.key));
  const out = new Set();
  const consider = (key) => {
    const id = strip(key);
    if (id !== null && !have.has(id) && !exclude.has(id) && !online.has(key)) out.add(key);
  };
  for (const l of links) {
    consider(l.key);
    if (!l.parentDeleted) consider(l.parent);
  }
  return [...out];
}

const SessionTree = { index, descendants, closeOrder, nest, relation, pruneCandidates };
globalThis.SessionTree = SessionTree;
if (typeof module !== "undefined") module.exports = SessionTree;
