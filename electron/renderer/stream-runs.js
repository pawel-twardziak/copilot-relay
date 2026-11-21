// Which streamed block (run) a chunk goes to (no DOM).
// Loaded as a classic <script> (sets globalThis.StreamRuns) and via require() in tests.
//
// Background subagents stream their answers into the parent session at the same time, each under its own
// messageId: their chunks alternate. A run with a messageId therefore stays findable for the whole view, so every
// chunk lands in its own message's block (one block per message and type, thinking apart from the answer). A chunk
// without a messageId (replayed prompts) continues the current block of its type until something else is appended.
"use strict";

function create() {
  const byId = new Map(); // "type messageId" -> run
  let current = null;
  const key = (type, messageId) => `${type} ${messageId}`;
  return {
    /** The block this chunk continues, or null: a new block is needed. */
    find(type, messageId) {
      if (messageId) return byId.get(key(type, messageId)) ?? null;
      return current && current.type === type && !current.messageId ? current : null;
    },
    /** A new block was appended: { type, messageId?, ... }. */
    add(run) {
      if (run.messageId) byId.set(key(run.type, run.messageId), run);
      current = run;
    },
    /** Something else was appended to the log: chunks without a messageId start a new block. */
    close() {
      current = null;
    },
  };
}

const StreamRuns = { create };
globalThis.StreamRuns = StreamRuns;
if (typeof module !== "undefined") module.exports = StreamRuns;
