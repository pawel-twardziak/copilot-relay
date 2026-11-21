// Pure rules for the per-session message queue (no DOM): the wrapper around a message delivered mid-turn,
// tool-call tracking, the chain of overlapping prompts, and when the queue may deliver.
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
      // an update without a status (content only) does not start a tool the tracker has not seen
      if (u.status === "pending" || u.status === "in_progress") ids.add(id);
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

/**
 * The prompts of one view that are pending at once: a mid-turn delivery is a second `session/prompt` that
 * interrupts the running one, and the app treats the whole chain as one turn.
 *
 * Record (one per prompt, from start()): { midTurn, delivery, interrupted, interrupts }
 *   interrupted: a later mid-turn prompt took over, so its "cancelled" answer is not a Stop of yours;
 *   interrupts: the records this mid-turn prompt marked interrupted (restored if it fails before its switch point);
 *   delivery: opaque, handed back at the switch point (the relay acknowledgement of a mid-turn relay item).
 * The switch point is Copilot's abort marker (an agent chunk of exactly ABORT_TEXT) after a mid-turn send.
 */
function createChain() {
  const records = [];
  let tracker = createToolTracker(); // tools in flight in the running chain
  let pendingSwitch = null; // the mid-turn record until its abort marker shows it took over
  let stopping = false; // you stopped the chain: nothing more goes out mid-turn until it has ended
  let midTurnSent = false; // a queued item was delivered during this chain

  const none = { ended: false, dropped: [] };
  /** The record's prompt is over; the chain ends with the last one (tools still in flight then are returned when
   *  a mid-turn prompt may have killed them: no switch point told). */
  function finish(record) {
    const i = records.indexOf(record);
    if (i < 0) return none;
    records.splice(i, 1);
    if (pendingSwitch === record) pendingSwitch = null;
    if (records.length) return none;
    pendingSwitch = null;
    stopping = false;
    return { ended: true, dropped: midTurnSent ? tracker.drop() : [] };
  }

  return {
    /** A prompt of the view is pending. */
    active: () => records.length > 0,
    /** A prompt goes out; midTurn: it interrupts the pending ones (they answer "cancelled" when it ends). */
    start({ midTurn = false, delivery = null } = {}) {
      if (!records.length) {
        tracker = createToolTracker();
        midTurnSent = false;
        stopping = false;
      }
      const record = { midTurn, delivery, interrupted: false, interrupts: [] };
      if (midTurn) {
        record.interrupts = records.filter((r) => !r.interrupted);
        for (const r of record.interrupts) r.interrupted = true;
        midTurnSent = true;
        pendingSwitch = record;
      }
      records.push(record);
      return record;
    },
    /** A tool update of the chain; true at a boundary (a tool finished and none is in flight). Ignored outside a chain. */
    toolUpdate: (u) => records.length > 0 && tracker.update(u),
    inFlight: () => tracker.size(),
    /** Nothing more goes out mid-turn: a switch is pending (the turn's tools are not known to be settled) or you stopped. */
    midTurnBlocked: () => pendingSwitch !== null || stopping,
    /** An agent chunk: the switch point when it is the abort marker of a pending mid-turn send (it is not shown).
     *  Returns { record, dropped } (the mid-turn record, the tools it killed) or null. */
    marker(text) {
      if (!pendingSwitch || !isAbortChunk(text)) return null;
      const record = pendingSwitch;
      pendingSwitch = null;
      return { record, dropped: tracker.drop() }; // a killed tool stays "pending" forever
    },
    /** The record's prompt answered `stop`. showStopped: a "cancelled" that was a Stop of yours, not an interruption. */
    returned(record, stop) {
      const showStopped = stop === "cancelled" && !record.interrupted;
      return { showStopped, ...finish(record) };
    },
    /** The record's prompt failed. Before its switch point it never took over: the prompts it was to interrupt are
     *  still running, and a Stop of them is reported again. */
    failed(record) {
      if (pendingSwitch === record) for (const r of record.interrupts) r.interrupted = false;
      return finish(record);
    },
    /** You stopped the turn (no effect outside a chain). */
    stop() {
      if (records.length) stopping = true;
    },
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

const MessageQueue = { MARKER, END, ABORT_TEXT, wrap, unwrap, isAbortChunk, createToolTracker, createChain, canDeliverMidTurn, canDeliverIdle, pauseOnStop, statusText };
globalThis.MessageQueue = MessageQueue;
if (typeof module !== "undefined") module.exports = MessageQueue;
