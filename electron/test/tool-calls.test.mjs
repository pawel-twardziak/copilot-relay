// Tests for merging ACP tool call updates (electron/renderer/tool-calls.js).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const TC = createRequire(import.meta.url)("../renderer/tool-calls.js");

test("an update fills in the fields it carries and keeps the rest", () => {
  const d = TC.merge({ title: "read", status: "pending", kind: "read" }, { status: "completed", rawOutput: "ok", title: null });
  assert.deepEqual(d, { title: "read", status: "completed", kind: "read", rawOutput: "ok" });
});

test("a replayed tool_call after its completed update does not set it back to pending", () => {
  // session/load of a subagent's tool: the update (completed) comes before the call (pending)
  let d = TC.merge({}, { status: "completed", rawOutput: "files" });
  d = TC.merge(d, { status: "pending", title: "Viewing /tmp", kind: "read" });
  assert.equal(d.status, "completed");
  assert.equal(d.title, "Viewing /tmp"); // the call's other fields still arrive
});

test("a finished tool stays finished; a running one may finish or fail", () => {
  for (const done of ["completed", "failed", "interrupted"])
    for (const late of ["pending", "in_progress"]) assert.equal(TC.merge({ status: done }, { status: late }).status, done);
  assert.equal(TC.merge({ status: "in_progress" }, { status: "failed" }).status, "failed");
  assert.equal(TC.merge({ status: "pending" }, { status: "in_progress" }).status, "in_progress");
  assert.equal(TC.merge({ status: "completed" }, { status: "interrupted" }).status, "interrupted"); // a mid-turn switch marks it
});

test("merge does not change the object it was given", () => {
  const prev = { status: "pending" };
  TC.merge(prev, { status: "completed" });
  assert.equal(prev.status, "pending");
});

test("agentOf: the subagent that owns an update, from Copilot's _meta", () => {
  assert.equal(TC.agentOf({ _meta: { "github.com/copilot": { agentId: "a-1" } } }), "a-1");
  assert.equal(TC.agentOf({ status: "pending" }), null); // the main agent's
  assert.equal(TC.agentOf(null), null);
});

test("a subagent's permission card outlives the turn; a Stop or the main agent's turn end closes it", () => {
  // a background subagent keeps running after the main turn ends, and main still holds its question open
  assert.equal(TC.keepCardAtTurnEnd({ agentId: "a-1", stopped: false }), true);
  // Stop answers every open question as cancelled (main's cancelTurn)
  assert.equal(TC.keepCardAtTurnEnd({ agentId: "a-1", stopped: true }), false);
  assert.equal(TC.keepCardAtTurnEnd({ agentId: null, stopped: false }), false);
});
