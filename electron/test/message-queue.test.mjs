// Tests for the pure queue rules in electron/renderer/message-queue.js (wrapper, tool tracker, delivery conditions).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const MQ = createRequire(import.meta.url)("../renderer/message-queue.js");
const { MARKER, END, END_MORE, OLD_ENDS, CONTINUE_PROMPT, CONTINUE_LABEL, isContinuePrompt, createFollowUp, ABORT_TEXT, wrap, unwrap, isAbortChunk, createToolTracker, canDeliverMidTurn, canDeliverIdle, pauseOnStop, statusText, takeBack } = MQ;

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

test("tracker adopts an unknown id only on an explicit pending/in_progress status", () => {
  const t = createToolTracker();
  t.update({ sessionUpdate: "tool_call_update", toolCallId: "a" }); // content-only update, no status
  assert.equal(t.size(), 0);
  t.update(upd("b", "pending"));
  assert.equal(t.size(), 1);
  t.update({ sessionUpdate: "tool_call_update", toolCallId: "b" }); // a known one stays in flight
  assert.equal(t.size(), 1);
  assert.equal(t.update(upd("b", "completed")), true);
});

// --- the chain: overlapping prompts of one view (a mid-turn delivery interrupts the running prompt)

const { createChain } = MQ;

test("chain: A cancelled + B end_turn, A answers first: no Stopped. for A, the chain ends once", () => {
  const c = createChain();
  const a = c.start();
  const b = c.start({ midTurn: true });
  assert.equal(c.marker(ABORT_TEXT).record, b);
  const ra = c.returned(a, "cancelled");
  assert.deepEqual([ra.showStopped, ra.ended], [false, false]);
  assert.equal(c.active(), true);
  const rb = c.returned(b, "end_turn");
  assert.deepEqual([rb.showStopped, rb.ended], [false, true]);
  assert.equal(c.active(), false);
});

test("chain: A cancelled + B end_turn, B answers first: no Stopped. for A, the chain ends once", () => {
  const c = createChain();
  const a = c.start();
  const b = c.start({ midTurn: true });
  c.marker(ABORT_TEXT);
  const rb = c.returned(b, "end_turn");
  assert.deepEqual([rb.showStopped, rb.ended], [false, false]);
  const ra = c.returned(a, "cancelled");
  assert.deepEqual([ra.showStopped, ra.ended], [false, true]);
});

test("chain: a user Stop during B shows Stopped. for B only", () => {
  const c = createChain();
  const a = c.start();
  const b = c.start({ midTurn: true });
  c.marker(ABORT_TEXT);
  c.stop();
  assert.equal(c.returned(a, "cancelled").showStopped, false);
  const rb = c.returned(b, "cancelled");
  assert.deepEqual([rb.showStopped, rb.ended], [true, true]);
});

test("chain: a user Stop of a plain prompt shows Stopped.", () => {
  const c = createChain();
  const a = c.start();
  c.stop();
  const ra = c.returned(a, "cancelled");
  assert.deepEqual([ra.showStopped, ra.ended], [true, true]);
});

test("chain: the marker is swallowed only while a switch is pending, once per mid-turn send", () => {
  const c = createChain();
  c.start();
  assert.equal(c.marker(ABORT_TEXT), null); // no mid-turn send: a Stop of yours shows it
  const b = c.start({ midTurn: true });
  assert.equal(c.marker("Info: Operation cancelled by user."), null); // exact chunk only
  assert.equal(c.marker(ABORT_TEXT).record, b);
  assert.equal(c.marker(ABORT_TEXT), null); // once
  const d = c.start({ midTurn: true });
  assert.equal(c.marker(ABORT_TEXT).record, d); // again for the next send
});

test("chain: the switch point drops the tools in flight", () => {
  const c = createChain();
  c.start();
  c.toolUpdate(call("t1", "pending"));
  assert.equal(c.toolUpdate(upd("t1", "completed")), true);
  c.start({ midTurn: true });
  c.toolUpdate(call("t2", "pending")); // started just before the queued prompt arrived: killed
  assert.equal(c.inFlight(), 1);
  assert.deepEqual(c.marker(ABORT_TEXT).dropped, ["t2"]);
  assert.equal(c.inFlight(), 0);
});

test("chain: tools of a chain without a mid-turn send are not dropped when it ends", () => {
  const c = createChain();
  const a = c.start();
  c.toolUpdate(call("t1", "pending"));
  assert.deepEqual(c.returned(a, "cancelled").dropped, []);
});

test("chain: tools still in flight when a chain with a mid-turn send ends (no marker came) are dropped", () => {
  const c = createChain();
  const a = c.start();
  const b = c.start({ midTurn: true });
  c.toolUpdate(call("t2", "pending"));
  assert.equal(c.returned(a, "cancelled").ended, false);
  assert.deepEqual(c.returned(b, "end_turn").dropped, ["t2"]);
});

test("chain: no tool tracking outside a chain; a new chain starts with no tools in flight", () => {
  const c = createChain();
  c.toolUpdate(call("x", "pending"));
  assert.equal(c.inFlight(), 0);
  const a = c.start();
  c.toolUpdate(call("t1", "pending"));
  c.returned(a, "end_turn");
  c.start();
  assert.equal(c.inFlight(), 0);
});

test("chain: a mid-turn send that fails before the marker restores A's interrupted flag", () => {
  const c = createChain();
  const a = c.start();
  const b = c.start({ midTurn: true });
  assert.equal(a.interrupted, true);
  const rb = c.failed(b);
  assert.equal(rb.ended, false);
  assert.equal(a.interrupted, false);
  assert.equal(c.midTurnBlocked(), false); // the switch is no longer pending
  c.stop();
  const ra = c.returned(a, "cancelled");
  assert.deepEqual([ra.showStopped, ra.ended], [true, true]); // your Stop of A is reported again
});

test("chain: a mid-turn send that fails after the marker leaves A interrupted", () => {
  const c = createChain();
  const a = c.start();
  const b = c.start({ midTurn: true });
  c.marker(ABORT_TEXT);
  c.failed(b);
  assert.equal(a.interrupted, true);
  assert.equal(c.returned(a, "cancelled").showStopped, false);
});

test("chain: a second mid-turn send interrupts only the prompts not interrupted yet", () => {
  const c = createChain();
  const a = c.start();
  const b = c.start({ midTurn: true });
  c.marker(ABORT_TEXT);
  const d = c.start({ midTurn: true });
  assert.deepEqual(d.interrupts, [b]);
  c.failed(d);
  assert.equal(a.interrupted, true);
  assert.equal(b.interrupted, false);
});

test("chain: a Stop blocks mid-turn delivery until the chain ends", () => {
  const c = createChain();
  assert.equal(c.midTurnBlocked(), false);
  c.stop(); // no chain: nothing to stop
  const a0 = c.start();
  assert.equal(c.midTurnBlocked(), false);
  c.returned(a0, "end_turn");
  const a = c.start();
  c.stop();
  assert.equal(c.midTurnBlocked(), true);
  assert.equal(c.returned(a, "cancelled").ended, true);
  assert.equal(c.midTurnBlocked(), false);
  c.start();
  assert.equal(c.midTurnBlocked(), false);
});

test("chain: a second mid-turn send is blocked while a switch is pending", () => {
  const c = createChain();
  const a = c.start();
  assert.equal(c.midTurnBlocked(), false);
  c.start({ midTurn: true });
  assert.equal(c.midTurnBlocked(), true);
  c.marker(ABORT_TEXT);
  assert.equal(c.midTurnBlocked(), false);
  c.returned(a, "cancelled");
});

test("chain: the mid-turn prompt keeps its delivery for the switch point", () => {
  const c = createChain();
  c.start();
  const delivery = {};
  c.start({ midTurn: true, delivery });
  assert.equal(c.marker(ABORT_TEXT).record.delivery, delivery);
});

test("chain: finishing a record twice changes nothing", () => {
  const c = createChain();
  const a = c.start();
  const b = c.start();
  c.returned(a, "end_turn");
  assert.equal(c.failed(a).ended, false);
  assert.equal(c.active(), true);
  assert.equal(c.returned(b, "end_turn").ended, true);
});

test("takeBack: your queued messages go in front of the draft, one per line; relay items stay", () => {
  const a = { kind: "app", text: "check X" };
  const r = { kind: "relay", text: "[from b] hi", from: "b" };
  const b = { kind: "app", text: "and Y\ntoo" };
  const res = takeBack([a, r, b], "draft text");
  assert.equal(res.text, "check X\nand Y\ntoo\ndraft text");
  assert.equal(res.caret, "check X\nand Y\ntoo".length);
  assert.deepEqual(res.rest, [r]);
});

test("takeBack: an empty or blank draft adds nothing after the taken messages", () => {
  const res = takeBack([{ kind: "app", text: "one" }, { kind: "app", text: "two" }], "  ");
  assert.equal(res.text, "one\ntwo");
  assert.equal(res.caret, "one\ntwo".length);
  assert.deepEqual(res.rest, []);
});

test("takeBack: null when nothing of yours is queued", () => {
  assert.equal(takeBack([], "x"), null);
  assert.equal(takeBack([{ kind: "relay", text: "hi", from: "b" }], ""), null);
});

const ENDING = "[End of the queued message. Reply to it (to another session: with relay-send_message) and end your response there.]";
const ENDING_MORE = "[End of the queued message. Reply to it (to another session: with relay-send_message) and end your response there. More queued messages follow; do not go back to your earlier task yet.]";
const EARLIER = [
  "[End of the queued message. Handle it now. Then go back to the task you were doing and finish it, unless this message changes or cancels that task.]",
  "[End of the queued message. If it asks you something, answer it now in a short visible reply to the user (your thinking is not shown to them), then go back to the task you were doing and finish it, unless this message changes or cancels that task. Repeat the answer in your final message if the task goes on after it.]",
];

test("answer ending", () => {
  assert.equal(END, ENDING);
  assert.equal(END_MORE, ENDING_MORE);
  assert.ok(wrap("x").endsWith("\n\n" + END));
  assert.ok(wrap("x", { more: true }).endsWith("\n\n" + END_MORE));
  assert.equal(unwrap(wrap("x")), "x");
  assert.equal(unwrap(wrap("x", { more: true })), "x");
  assert.deepEqual(OLD_ENDS, EARLIER);
  for (const e of OLD_ENDS) assert.equal(unwrap(MARKER + "\nx\n\n" + e), "x");
});

test("continue prompt", () => {
  assert.equal(
    CONTINUE_PROMPT,
    "[continue after queued messages]\nContinue the task you were working on before the queued message(s) above, taking them into account. If they changed the task, follow the change; if they cancelled it, do not continue and say so in one sentence.",
  );
  assert.equal(isContinuePrompt(CONTINUE_PROMPT), true);
  assert.equal(isContinuePrompt(CONTINUE_PROMPT + " "), false);
  assert.equal(isContinuePrompt("x\n" + CONTINUE_PROMPT), false);
  assert.equal(isContinuePrompt(""), false);
  assert.equal(CONTINUE_LABEL, "↻ continuing the task");
});

test("chain stopped flag", () => {
  const c = createChain();
  const rec = c.start();
  c.stop();
  const end = c.returned(rec, "cancelled");
  assert.equal(end.ended, true);
  assert.equal(end.stopped, true);
  const rec2 = c.start();
  const end2 = c.returned(rec2, "end_turn");
  assert.equal(end2.ended, true);
  assert.equal(end2.stopped, false);
  const a = c.start();
  const b = c.start({ midTurn: true });
  assert.equal(c.returned(a, "cancelled").stopped, false);
  assert.equal(c.returned(b, "end_turn").stopped, false);
});

test("follow-up, one answer", () => {
  const f = createFollowUp();
  f.interrupted();
  assert.equal(f.answerDue(), true);
  assert.equal(f.afterTurn({ queued: 0 }), "continue");
  assert.equal(f.answerDue(), false);
  assert.equal(f.afterTurn({ queued: 0 }), "none");
});

test("follow-up, two answers", () => {
  const f = createFollowUp();
  f.interrupted();
  assert.equal(f.afterTurn({ queued: 1 }), "pump");
  assert.equal(f.answerDue(), true);
  assert.equal(f.afterTurn({ queued: 0 }), "continue");
});

test("follow-up, Stop", () => {
  const f = createFollowUp();
  f.interrupted();
  assert.equal(f.afterTurn({ stopped: true, queued: 0 }), "none");
  assert.equal(f.answerDue(), false);
  f.interrupted();
  assert.equal(f.afterTurn({ stopped: true, queued: 2, paused: true }), "none");
  assert.equal(f.answerDue(), true);
  assert.equal(f.afterTurn({ queued: 0 }), "continue");
  // an item queued while Copilot winds down after the Stop (queue not paused): the stopped task is dropped
  f.interrupted();
  assert.equal(f.afterTurn({ stopped: true, queued: 1, paused: false }), "none");
  assert.equal(f.answerDue(), false);
});

test("follow-up, paused / dead", () => {
  const f = createFollowUp();
  f.interrupted();
  assert.equal(f.afterTurn({ queued: 0, paused: true }), "none");
  assert.equal(f.answerDue(), true);
  assert.equal(f.afterTurn({ dead: true }), "none");
  assert.equal(f.answerDue(), false);
});

test("follow-up, own prompt", () => {
  const f = createFollowUp();
  f.interrupted();
  f.userPrompt();
  assert.equal(f.answerDue(), false);
  assert.equal(f.afterTurn({ queued: 0 }), "none");
});

test("follow-up, normal turn", () => {
  const f = createFollowUp();
  assert.equal(f.answerDue(), false);
  assert.equal(f.afterTurn({ queued: 1 }), "none");
});

test("follow-up, undo of a send that failed before its switch point", () => {
  const f = createFollowUp();
  const undo = f.interrupted();
  undo();
  assert.equal(f.answerDue(), false);
  assert.equal(f.afterTurn({ queued: 0 }), "none");
  // a task already waiting stays waiting
  f.interrupted();
  const undo2 = f.interrupted();
  undo2();
  assert.equal(f.answerDue(), true);
});

test("follow-up, drop", () => {
  const f = createFollowUp();
  f.interrupted();
  f.drop();
  assert.equal(f.answerDue(), false);
  assert.equal(f.afterTurn({ queued: 0 }), "none");
});

test("follow-up, a chain that failed sends no continue prompt and drops the task", () => {
  const f = createFollowUp();
  f.interrupted();
  assert.equal(f.afterTurn({ failed: true, queued: 0 }), "none");
  assert.equal(f.answerDue(), false);
  f.interrupted();
  assert.equal(f.afterTurn({ failed: true, queued: 2 }), "none");
  assert.equal(f.answerDue(), false);
});

test("chain: failed tells whether it was before the switch point", () => {
  const c = MQ.createChain();
  const a = c.start();
  const b = c.start({ midTurn: true });
  assert.equal(c.failed(b).beforeSwitch, true);
  const d = c.start({ midTurn: true });
  assert.ok(c.marker(ABORT_TEXT));
  const end = c.failed(d);
  assert.equal(end.beforeSwitch, false);
  assert.equal(end.ended, false);
  const last = c.returned(a, "cancelled");
  assert.equal(last.ended, true);
  assert.equal(c.failed(a).ended, false); // already finished
});

test("chain: a prompt that failed after its switch point marks the chain failed, in either return order", () => {
  for (const failedFirst of [true, false]) {
    const c = MQ.createChain();
    const a = c.start();
    const b = c.start({ midTurn: true });
    assert.ok(c.marker(ABORT_TEXT));
    let end;
    if (failedFirst) {
      assert.equal(c.failed(b).ended, false);
      end = c.returned(a, "cancelled");
    } else {
      assert.equal(c.returned(a, "cancelled").ended, false);
      end = c.failed(b);
    }
    assert.equal(end.ended, true);
    assert.equal(end.failed, true);
  }
  // a failure before the switch point does not count, and a new chain starts clean
  const c = MQ.createChain();
  const a = c.start();
  const b = c.start({ midTurn: true });
  assert.equal(c.failed(b).failed, false);
  assert.equal(c.returned(a, "end_turn").failed, false);
});
