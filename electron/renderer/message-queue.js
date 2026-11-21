// Pure rules for the per-session message queue (no DOM): the wrapper around a message delivered mid-turn,
// tool-call tracking, and when the queue may deliver.
// Loaded as a classic <script> (sets globalThis.MessageQueue) and via require() in tests.
//
// Queue item: { id, kind: "app" | "relay", text, prompt, from, human, fromCwd, deliveryId, command }
// `text` is what the bubble shows, `prompt` what is sent, `command` is true for a slash command.
"use strict";

const MARKER = "[queued message, delivered during your work]";
const END = "[End of the queued message. Handle it now. Then go back to the task you were doing and finish it, unless this message changes or cancels that task.]";
const ABORT_TEXT = "Info: Operation cancelled by user";

const wrap = (text) => `${MARKER}\n${text}\n\n${END}`;

/** The inner text of a wrapped message, or null when `text` is not one. */
function unwrap(text) {
  const head = `${MARKER}\n`;
  const tail = `\n\n${END}`;
  if (text.length < head.length + tail.length || !text.startsWith(head) || !text.endsWith(tail)) return null;
  return text.slice(head.length, text.length - tail.length);
}

const isAbortChunk = (text) => text === ABORT_TEXT;

const isTerminal = (status) => status === "completed" || status === "failed";

/** Tools in flight: from `tool_call` until a `tool_call_update` with status completed or failed. */
function createToolTracker() {
  const ids = new Set();
  return {
    /** True only when a tracked tool just finished and no other is in flight (a safe point between tools). */
    update(u) {
      const id = u?.toolCallId;
      if (id == null) return false;
      if (u.sessionUpdate === "tool_call") {
        if (!isTerminal(u.status)) ids.add(id);
        return false;
      }
      if (u.sessionUpdate !== "tool_call_update") return false;
      if (isTerminal(u.status)) return ids.delete(id) && ids.size === 0;
      ids.add(id);
      return false;
    },
    size: () => ids.size,
    /** Returns the ids still in flight and forgets them. */
    drop() {
      const out = [...ids];
      ids.clear();
      return out;
    },
    reset: () => ids.clear(),
  };
}

const canDeliverMidTurn = (s) =>
  !!(s.enabled && !s.paused && s.prompting && !s.edit && !s.historyOp && !s.holdInbox && !s.deleting && !s.dead && s.inFlight === 0 && s.head && !s.head.command);

const canDeliverIdle = (s) => !!(!s.busy && !s.paused && !s.edit && !s.historyOp && !s.holdInbox && !s.deleting && !s.dead && s.queued > 0);

const pauseOnStop = ({ enabled, queued }) => !!(enabled && queued > 0);

function statusText({ busy, dead, deleting, queued = 0, paused }) {
  if (deleting) return "Deleting session…";
  if (busy) return `Working…${queued > 0 ? ` (${queued} queued)` : ""}${paused ? " (queue paused)" : ""}`;
  if (dead) return "Copilot process ended";
  if (queued > 0) return paused ? `Queue paused (${queued})` : `${queued} message(s) waiting`;
  return "";
}

const MessageQueue = { MARKER, END, ABORT_TEXT, wrap, unwrap, isAbortChunk, createToolTracker, canDeliverMidTurn, canDeliverIdle, pauseOnStop, statusText };
globalThis.MessageQueue = MessageQueue;
if (typeof module !== "undefined") module.exports = MessageQueue;
