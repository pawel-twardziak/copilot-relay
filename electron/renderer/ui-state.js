// Pure helpers for the session list, chat zoom and images (no DOM).
// Loaded as a classic <script> (sets globalThis.UiState) and via require() in tests.
"use strict";

const time = (s) => new Date(s.updatedAt ?? 0).getTime();
const newestFirst = (a, b) => time(b) - time(a);

/**
 * The sidebar's structure: pinned sessions on top, then one group per project folder (newest first).
 * query: lower-cased filter text; while filtering every group is shown expanded (the stored state is untouched).
 */
function listModel(sessions, { pinned = new Set(), collapsed = new Set(), query = "" } = {}) {
  const match = (s) => !query || `${s.title ?? ""} ${s.cwd ?? ""} ${s.sessionId}`.toLowerCase().includes(query);
  const top = [];
  const groups = new Map();
  for (const s of sessions) {
    if (!match(s)) continue;
    if (pinned.has(s.sessionId)) {
      top.push(s); // shown in the pinned section instead of its project
      continue;
    }
    if (!groups.has(s.cwd)) groups.set(s.cwd, []);
    groups.get(s.cwd).push(s);
  }
  const out = [...groups.entries()].map(([cwd, list]) => ({
    cwd,
    sessions: list.sort(newestFirst),
    count: list.length,
    collapsed: collapsed.has(cwd) && !query,
  }));
  out.sort((a, b) => time(b.sessions[0]) - time(a.sessions[0]));
  return { pinned: top.sort(newestFirst), groups: out };
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
    if (IMAGE_EXT.test(raw) && !out.includes(raw)) out.push(raw);
  }
  return out;
}

const UiState = { listModel, CHAT_SCALE, stepScale, imageMentions };
globalThis.UiState = UiState;
if (typeof module !== "undefined") module.exports = UiState;
