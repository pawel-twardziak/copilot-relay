// Merging ACP tool call updates into what the view shows for a tool (no DOM).
// Loaded as a classic <script> (sets globalThis.ToolCalls) and via require() in tests.
"use strict";

const RUNNING = new Set(["pending", "in_progress"]);

/** The tool's data after update u: the fields u carries (null/undefined ones are not updates) over prev.
 *  A finished tool is never set back to running: session/load replays a subagent's tool update (completed) before
 *  its tool_call (pending). */
function merge(prev, u) {
  const next = { ...prev, ...Object.fromEntries(Object.entries(u).filter(([, v]) => v != null)) };
  if (prev.status && !RUNNING.has(prev.status) && RUNNING.has(next.status)) next.status = prev.status;
  return next;
}

const ToolCalls = { merge };
globalThis.ToolCalls = ToolCalls;
if (typeof module !== "undefined") module.exports = ToolCalls;
