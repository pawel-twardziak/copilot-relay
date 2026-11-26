// Pure sub-session tree model (no DOM): parent/child index, cascade order, pruning.
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

function relation(idx, id) {
  return {
    parent: idx.parentOf.get(id) ?? null,
    parentDeleted: idx.link.get(id)?.parentDeleted === true,
    children: (idx.childrenOf.get(id) ?? []).map((c) => ({ id: c, grandchildren: (idx.childrenOf.get(c) ?? []).length })),
  };
}

/** cli: keys missing from a successful list: linked sessions, and parents that still have (non-orphaned) children.
 *  Never a key whose link is online (a child being created is connected before Copilot lists it).
 *  exclude: bare ids never reported (open, being deleted, deleted — a new session may not be listed yet).
 *  Sanity bound: nothing when the list is empty while links exist, or when more than half of the known cli: keys
 *  would go (such a list is more likely broken than that many sessions deleted). */
function pruneCandidates(links, sessions, { listOk, exclude = new Set() } = {}) {
  if (!listOk || (!sessions.length && links.length)) return [];
  const have = new Set(sessions.map((s) => s.sessionId));
  const online = new Set(links.filter((l) => l.online === true).map((l) => l.key));
  const known = new Set();
  const out = new Set();
  const consider = (key) => {
    const id = strip(key);
    if (id === null) return;
    known.add(key);
    if (!have.has(id) && !exclude.has(id) && !online.has(key)) out.add(key);
  };
  for (const l of links) {
    consider(l.key);
    if (!l.parentDeleted) consider(l.parent);
  }
  return out.size * 2 > known.size ? [] : [...out];
}

const SessionTree = { index, descendants, closeOrder, relation, pruneCandidates };
globalThis.SessionTree = SessionTree;
if (typeof module !== "undefined") module.exports = SessionTree;
