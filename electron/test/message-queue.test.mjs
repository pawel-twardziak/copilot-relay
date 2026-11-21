// Tests for the pure queue rules in electron/renderer/message-queue.js (wrapper, tool tracker, delivery conditions).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const MQ = createRequire(import.meta.url)("../renderer/message-queue.js");
const { MARKER, END, ABORT_TEXT, wrap, unwrap, isAbortChunk, createToolTracker, canDeliverMidTurn, canDeliverIdle, pauseOnStop, statusText } = MQ;

test("wrap/unwrap round trip", () => {
  assert.equal(unwrap(wrap("hi")), "hi");
  assert.equal(unwrap(wrap("[from backend-a1b2c3]\nhello")), "[from backend-a1b2c3]\nhello");
  assert.equal(unwrap(wrap("a\n\nb")), "a\n\nb");
});

test("unwrap needs both ends", () => {
  assert.equal(unwrap(MARKER + "\nhi"), null);
  assert.equal(unwrap("hi\n\n" + END), null);
  assert.equal(unwrap("plain"), null);
});

test("isAbortChunk is exact", () => {
  assert.equal(isAbortChunk("Info: Operation cancelled by user"), true);
  assert.equal(isAbortChunk("Info: Operation cancelled by userThe ping…"), false);
  assert.equal(isAbortChunk("x Info: Operation cancelled by user"), false);
  assert.equal(ABORT_TEXT, "Info: Operation cancelled by user");
});

const call = (id, status) => ({ sessionUpdate: "tool_call", toolCallId: id, status });
const upd = (id, status) => ({ sessionUpdate: "tool_call_update", toolCallId: id, status });

test("tracker boundary", () => {
  const t = createToolTracker();
  assert.equal(t.update(call("a", "pending")), false);
  assert.equal(t.update(upd("a", "completed")), true);
  assert.equal(t.size(), 0);
});

test("tracker waits for parallel tools", () => {
  const t = createToolTracker();
  t.update(call("a", "pending"));
  t.update(call("b", "pending"));
  assert.equal(t.update(upd("a", "completed")), false);
  assert.equal(t.size(), 1);
  assert.equal(t.update(upd("b", "failed")), true);
});

test("tracker ignores unknown completions", () => {
  const t = createToolTracker();
  assert.equal(t.update(upd("x", "completed")), false);
  assert.equal(t.size(), 0);
});

test("tracker adopts a non-terminal update for an unknown id, not a terminal tool_call", () => {
  const t = createToolTracker();
  t.update(upd("a", "in_progress"));
  assert.equal(t.size(), 1);
  t.update(call("b", "completed"));
  assert.equal(t.size(), 1);
});

test("tracker drop", () => {
  const t = createToolTracker();
  t.update(call("a", "pending"));
  t.update(call("b", "pending"));
  assert.deepEqual(t.drop(), ["a", "b"]);
  assert.equal(t.size(), 0);
});

test("tracker reset clears", () => {
  const t = createToolTracker();
  t.update(call("a", "pending"));
  t.reset();
  assert.equal(t.size(), 0);
});

const mid = { enabled: true, paused: false, prompting: true, edit: null, historyOp: false, holdInbox: false, deleting: false, dead: false, inFlight: 0, head: { command: false } };

test("canDeliverMidTurn", () => {
  assert.equal(canDeliverMidTurn(mid), true);
  for (const patch of [{ enabled: false }, { paused: true }, { prompting: false }, { inFlight: 1 }, { head: { command: true } }, { head: undefined }, { edit: {} }, { historyOp: true }, { holdInbox: true }, { deleting: true }, { dead: true }]) {
    assert.equal(canDeliverMidTurn({ ...mid, ...patch }), false, JSON.stringify(patch));
  }
});

const idle = { busy: false, paused: false, edit: null, historyOp: false, holdInbox: false, deleting: false, dead: false, queued: 1 };

test("canDeliverIdle", () => {
  assert.equal(canDeliverIdle(idle), true);
  for (const patch of [{ paused: true }, { busy: true }, { queued: 0 }, { edit: {} }, { historyOp: true }, { holdInbox: true }, { deleting: true }, { dead: true }]) {
    assert.equal(canDeliverIdle({ ...idle, ...patch }), false, JSON.stringify(patch));
  }
});

test("pauseOnStop", () => {
  assert.equal(pauseOnStop({ enabled: true, queued: 2 }), true);
  assert.equal(pauseOnStop({ enabled: true, queued: 0 }), false);
  assert.equal(pauseOnStop({ enabled: false, queued: 2 }), false);
});

test("statusText", () => {
  assert.equal(statusText({ busy: true, queued: 2 }), "Working… (2 queued)");
  assert.equal(statusText({ busy: true, queued: 2, paused: true }), "Working… (2 queued) (queue paused)");
  assert.equal(statusText({ busy: false, queued: 2, paused: true }), "Queue paused (2)");
  assert.equal(statusText({ busy: false, queued: 1 }), "1 message(s) waiting");
  assert.equal(statusText({ deleting: true, busy: true }), "Deleting session…");
  assert.equal(statusText({ dead: true }), "Copilot process ended");
  assert.equal(statusText({}), "");
});
