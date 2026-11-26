// Pure helpers for the session list, chat zoom and images (no DOM).
// Loaded as a classic <script> (sets globalThis.UiState) and via require() in tests.
"use strict";

/** When a session was last used: its last message or tool call (main: last-activity.mjs), else Copilot's updatedAt,
 *  which also moves when the session is only opened or closed. */
const activityAt = (s) => s.lastActivityAt ?? s.updatedAt;
const time = (s) => new Date(activityAt(s) ?? 0).getTime();

const NO_TREE = { parentOf: new Map(), childrenOf: new Map() };

/**
 * The sidebar's structure, built from session trees (a root and all its descendants by the links): a tree with a
 * pinned member goes to `pinned`, else one with an open member to `open`, else to the group of its root's folder.
 * Every row is listed once. Trees (and groups) are ordered by their newest member.
 * rows: the listed sessions plus open views Copilot does not list (unique ids). tree: a SessionTree.index result.
 * query: lower-cased filter text; a tree stays whole when any member matches, and while filtering every group is
 * shown expanded (the stored state is untouched).
 * Returns { pinned: Row[], open: Row[], groups: { cwd, rows, count, collapsed }[] }, Row = { s, depth, showProject }
 * (showProject: its folder is shown, in Pinned always, elsewhere when it differs from its root's).
 */
function listModel(rows, { pinned = new Set(), open = new Set(), collapsed = new Set(), query = "", tree = NO_TREE } = {}) {
  const match = (s) => `${s.title ?? ""} ${s.cwd ?? ""} ${s.sessionId}`.toLowerCase().includes(query);
  const byId = new Map(rows.map((s) => [s.sessionId, s]));
  const done = new Set();
  const trees = [];
  const build = (rootId) => {
    const members = [];
    const emit = (id, depth) => {
      done.add(id);
      members.push({ s: byId.get(id), depth });
      for (const c of tree.childrenOf.get(id) ?? []) if (byId.has(c) && !done.has(c)) emit(c, depth + 1);
    };
    emit(rootId, 0);
    trees.push({ root: byId.get(rootId), members, latest: Math.max(...members.map(({ s }) => time(s))) });
  };
  const isRoot = (id) => {
    const p = tree.parentOf.get(id) ?? null;
    return p === null || p === id || !byId.has(p);
  };
  for (const s of rows) if (!done.has(s.sessionId) && isRoot(s.sessionId)) build(s.sessionId);
  for (const s of rows) if (!done.has(s.sessionId)) build(s.sessionId); // cycle members

  const top = [];
  const opened = [];
  const groups = new Map();
  for (const t of trees) {
    if (query && !t.members.some(({ s }) => match(s))) continue;
    const has = (set) => t.members.some(({ s }) => set.has(s.sessionId));
    if (has(pinned)) top.push(t);
    else if (has(open)) opened.push(t);
    else {
      if (!groups.has(t.root.cwd)) groups.set(t.root.cwd, []);
      groups.get(t.root.cwd).push(t);
    }
  }
  const byLatest = (a, b) => b.latest - a.latest;
  const flatten = (list, inPinned = false) =>
    [...list].sort(byLatest).flatMap((t) => t.members.map(({ s, depth }) => ({ s, depth, showProject: inPinned || s.cwd !== t.root.cwd })));
  const out = [...groups.entries()].map(([cwd, list]) => {
    const groupRows = flatten(list);
    return { cwd, rows: groupRows, count: groupRows.length, collapsed: collapsed.has(cwd) && !query, latest: Math.max(...list.map((t) => t.latest)) };
  });
  out.sort((a, b) => b.latest - a.latest);
  return { pinned: flatten(top, true), open: flatten(opened), groups: out.map(({ latest, ...g }) => g) };
}

// Chat text scale: Left Ctrl + wheel / + / - / 0
const CHAT_SCALE = { min: 0.7, max: 2, step: 0.1 };
/** dir: 1 bigger, -1 smaller, 0 back to 100 %. Rounded to one decimal so repeated steps don't drift. */
function stepScale(current, dir) {
  if (dir === 0) return 1;
  const base = Number.isFinite(current) ? current : 1;
  const next = Math.round((base + dir * CHAT_SCALE.step) * 10) / 10;
  return Math.min(CHAT_SCALE.max, Math.max(CHAT_SCALE.min, next));
}

// `@path` / `@"path with spaces"` mentions, the same syntax main.mjs attaches images from (MENTION_RE there)
const MENTION_RE = /(?:^|\s)@(?:"([^"]+)"|(\S+))/g;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
/** Image files mentioned in a prompt, in order, each once. */
function imageMentions(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(MENTION_RE)) {
    const raw = m[1] ?? m[2].replace(/[.,;:!?)]+$/, "");
    // URLs are not shown: a relay message must not make the app fetch something (file: URLs are local paths)
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^file:/i.test(raw) && !/^[a-z]:[\\/]/i.test(raw)) continue;
    if (IMAGE_EXT.test(raw) && !out.includes(raw)) out.push(raw);
  }
  return out;
}

// Image viewer: the image is drawn at translate(x, y) scale(scale), origin top-left, in stage coordinates
const VIEWER_ZOOM = { min: 0.1, max: 10 };
/** Scale that fits the image into the stage, never above 100 %. */
function fitScale(iw, ih, vw, vh) {
  if (!(iw > 0 && ih > 0)) return 1;
  return Math.min(1, vw / iw, vh / ih);
}
/** Zoom by `factor` around the stage point (cx, cy): the image point under it stays there. */
function zoomAt({ scale, x, y }, factor, cx, cy) {
  const next = Math.min(VIEWER_ZOOM.max, Math.max(VIEWER_ZOOM.min, scale * factor));
  if (next === scale) return { scale, x, y };
  const k = next / scale;
  return { scale: next, x: cx - (cx - x) * k, y: cy - (cy - y) * k };
}

/** False for a report the view has already taken (the broker redelivers until it is acknowledged). No id: always true. */
function acceptDelivery(seen, id) {
  if (id == null) return true;
  if (seen.has(id)) return false;
  seen.add(id);
  return true;
}

// updates that belong to a running turn; the rest (commands, usage, title) can arrive at any time
const TURN_UPDATES = new Set(["user_message_chunk", "agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"]);

/**
 * When to acknowledge one delivered prompt to the broker: on its first turn update or its successful return,
 * whichever comes first, once. A prompt that fails before any update is not acknowledged and its id is forgotten,
 * so the broker's redelivery is accepted (see acceptDelivery).
 */
function deliveryAck(id, seen, ack) {
  let acked = false;
  const started = () => {
    if (acked) return;
    acked = true;
    ack(id);
  };
  return {
    update: (u) => TURN_UPDATES.has(u?.sessionUpdate) && started(),
    returned: started,
    failed: () => {
      if (!acked) seen.delete(id);
    },
  };
}

/** The side panel's geometry (activity panel): minimum width, the width the chat keeps, default width, the gap left
 *  beside the drawer when the panel overlays a narrow window. */
const PANEL = { min: 280, chatMin: 480, def: 420, drawerGap: 40 };

/** Below chatMin + min the panel overlays the chat (narrow) instead of sharing the row; width is the stored one
 *  (or the default) kept within [min, what the layout leaves]. */
function panelLayout(viewWidth, stored) {
  const narrow = viewWidth < PANEL.chatMin + PANEL.min;
  const want = Number.isFinite(stored) ? stored : PANEL.def;
  const room = viewWidth - (narrow ? PANEL.drawerGap : PANEL.chatMin);
  return { narrow, width: Math.max(PANEL.min, Math.min(want, room)) };
}

const UiState = { PANEL, panelLayout, listModel, activityAt, CHAT_SCALE, stepScale, imageMentions, VIEWER_ZOOM, fitScale, zoomAt, acceptDelivery, deliveryAck };
globalThis.UiState = UiState;
if (typeof module !== "undefined") module.exports = UiState;
