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

const UiState = { listModel };
globalThis.UiState = UiState;
if (typeof module !== "undefined") module.exports = UiState;
