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
