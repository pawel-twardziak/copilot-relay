// Tests for routing ACP updates to the log, work and subagent groups (electron/renderer/activity.js).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
require("../renderer/tool-calls.js");
const Activity = require("../renderer/activity.js");

const meta = (agentId) => (agentId ? { _meta: { "github.com/copilot": { agentId } } } : {});
const chunk = (type, messageId, text, agentId) => ({ sessionUpdate: type, messageId, content: { type: "text", text }, ...meta(agentId) });
const call = (id, fields, agentId) => ({ sessionUpdate: "tool_call", toolCallId: id, ...fields, ...meta(agentId) });
const update = (id, fields, agentId) => ({ sessionUpdate: "tool_call_update", toolCallId: id, ...fields, ...meta(agentId) });

test("main text goes to the log, main tools and thoughts to the work group", () => {
  const a = Activity.create();
  assert.equal(a.route(chunk("agent_message_chunk", "m1", "Hi")).to, "main");
  assert.equal(a.route(chunk("agent_thought_chunk", "m2", "hm")).to, "work");
  assert.equal(a.route(call("t1", { title: "ls", rawInput: { command: "ls" } })).to, "work");
});

test("a task call creates an anchored subagent group and owns its later updates", () => {
  const a = Activity.create();
  const r = a.route(call("task1", { title: "Summarize a.txt", rawInput: { agent_type: "explore", prompt: "Read a.txt", mode: "sync" } }));
  assert.deepEqual(r.changes, [{ type: "created", groupId: "g1", title: "Summarize a.txt", prompt: "Read a.txt", anchored: true, replacesTool: null }]);
  assert.deepEqual([r.to, r.groupId, r.task], ["group", "g1", true]);
  assert.equal(a.route(update("task1", { status: "completed" })).groupId, "g1");
  assert.equal(a.group("g1").mode, "sync");
  assert.equal(a.group("g1").taskToolCallId, "task1");
  assert.equal(a.group("g1").status, "completed");
});

test("background: the agent_id in the task result links the subagent", () => {
  const a = Activity.create();
  a.route(call("task1", { title: "B", rawInput: { agent_type: "explore", prompt: "p", mode: "background" } }));
  a.route(update("task1", { status: "completed", content: [{ type: "content", content: { type: "text", text: "Agent started in background with agent_id: 545ca39a-d731-47a0-aac7-dc4b29d53701. You'll be notified" } }] }));
  const r = a.route(chunk("agent_message_chunk", "s1", "x", "545ca39a-d731-47a0-aac7-dc4b29d53701"));
  assert.deepEqual([r.to, r.groupId, r.changes.length], ["group", "g1", 0]);
  assert.equal(a.group("g1").agentId, "545ca39a-d731-47a0-aac7-dc4b29d53701");
});

test("one unlinked sync task takes the first new agentId; two make standalone groups", () => {
  const a = Activity.create();
  a.route(call("t1", { title: "One", rawInput: { agent_type: "explore", prompt: "p", mode: "sync" } }));
  assert.equal(a.route(chunk("agent_message_chunk", "s1", "x", "A")).groupId, "g1");
  const b = Activity.create();
  b.route(call("t1", { title: "One", rawInput: { agent_type: "explore", prompt: "p", mode: "sync" } }));
  b.route(call("t2", { title: "Two", rawInput: { agent_type: "explore", prompt: "q", mode: "sync" } }));
  const r = b.route(chunk("agent_message_chunk", "s1", "x", "B"));
  assert.deepEqual(r.changes, [{ type: "created", groupId: "g3", title: "subagent", prompt: null, anchored: false, replacesTool: null }]);
});

test("main text between subagent chunks stays in the log", () => {
  const a = Activity.create();
  a.route(call("t1", { title: "One", rawInput: { agent_type: "explore", prompt: "p", mode: "sync" } }));
  const to = [chunk("agent_message_chunk", "s1", "a", "A"), chunk("agent_message_chunk", "m1", "main"), chunk("agent_message_chunk", "s1", "b", "A")]
    .map((u) => a.route(u).to);
  assert.deepEqual(to, ["group", "main", "group"]);
});

test("replay: a subagent tool's update before its tool_call goes to the subagent group", () => {
  const a = Activity.create();
  a.route(chunk("agent_message_chunk", "s1", "x", "A")); // standalone g1
  assert.equal(a.route(update("v1", { status: "completed" }, "A")).groupId, "g1");
  assert.equal(a.route(call("v1", { title: "Viewing /tmp", status: "pending" }, "A")).groupId, "g1");
});

test("an owner-less update for a subagent's tool stays in that subagent's group", () => {
  const a = Activity.create();
  a.route(chunk("agent_message_chunk", "s1", "x", "A"));
  a.route(call("v1", { title: "Viewing" }, "A"));
  assert.equal(a.route(update("v1", { status: "completed" })).groupId, "g1");
});

test("replay: a task recognised late replaces the badge already routed to work", () => {
  const a = Activity.create();
  assert.equal(a.route(update("t9", { status: "completed" })).to, "work");
  const r = a.route(call("t9", { title: "Late", rawInput: { agent_type: "explore", prompt: "p", mode: "sync" } }));
  assert.equal(r.changes[0].replacesTool, "t9");
  assert.deepEqual([r.to, r.task], ["group", true]);
});

const bgTask = (a) => a.route(call("task1", { title: "B", rawInput: { agent_type: "explore", prompt: "p", mode: "background" } }));

test("a non-UUID after agent_id: does not link the subagent", () => {
  const a = Activity.create();
  bgTask(a);
  a.route(update("task1", { status: "completed", content: [{ type: "content", content: { type: "text", text: "agent_id: explore" } }] }));
  assert.equal(a.group("g1").agentId, null);
});

test("the link falls back to a string rawOutput.content", () => {
  const a = Activity.create();
  bgTask(a);
  a.route(update("task1", { status: "completed", rawOutput: { content: "Agent started with agent_id: 545ca39a-d731-47a0-aac7-dc4b29d53701." } }));
  assert.equal(a.group("g1").agentId, "545ca39a-d731-47a0-aac7-dc4b29d53701");
});

test("other main-agent update types go to the log", () => {
  const a = Activity.create();
  for (const sessionUpdate of ["user_message_chunk", "plan", "usage_update"]) {
    assert.deepEqual(a.route({ sessionUpdate }), { to: "main", changes: [] });
  }
});

const A = "545ca39a-d731-47a0-aac7-dc4b29d53701";
const statuses = (r) => r.changes.filter((c) => c.type === "status").map((c) => [c.groupId, c.status]);
const syncTask = (id, title = "T") => call(id, { title, rawInput: { agent_type: "explore", prompt: "p", mode: "sync" } });
const bgTaskLinked = (a, id, agentId) => {
  a.route(call(id, { title: "B", rawInput: { agent_type: "explore", prompt: "p", mode: "background" } }));
  a.route(update(id, { status: "completed", content: [{ type: "content", content: { type: "text", text: `Agent started in background with agent_id: ${agentId}.` } }] }));
};

test("sync: the task's status is the group's; interrupted, then late updates run again and complete", () => {
  const a = Activity.create();
  a.route(syncTask("t1"));
  assert.deepEqual(statuses(a.route(chunk("agent_message_chunk", "s1", "x", A))), []);
  assert.deepEqual(statuses(a.route(update("t1", { status: "interrupted" }))), [["g1", "interrupted"]]);
  assert.deepEqual(statuses(a.route(chunk("agent_message_chunk", "s1", "y", A))), [["g1", "running"]]);
  assert.deepEqual(statuses(a.route(update("t1", { status: "completed" }))), [["g1", "completed"]]);
});

test("background: quiet after settle without evidence, running on a new update, completed by read_agent", () => {
  const a = Activity.create();
  bgTaskLinked(a, "t1", A);
  assert.deepEqual(a.settle(), [{ type: "status", groupId: "g1", status: "quiet" }]);
  assert.deepEqual(statuses(a.route(chunk("agent_message_chunk", "s2", "z", A))), [["g1", "running"]]);
  a.route(call("r1", { title: "read_agent", rawInput: { agent_id: A } }));
  const r = a.route(update("r1", { status: "completed", rawOutput: { content: `Agent is idle (waiting for messages). agent_id: ${A}, agent_type: explore, status: idle` } }));
  assert.equal(r.to, "work");
  assert.deepEqual(statuses(r), [["g1", "completed"]]);
});

test("two subagents failing back to back mark their own groups failed", () => {
  const a = Activity.create();
  a.route(syncTask("t1"));
  a.route(syncTask("t2"));
  const fail = (agentId) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Error: Execution failed: 400" }, _meta: { "github.com/copilot": { agentId } } });
  const ra = a.route(fail("A"));
  const rb = a.route(fail("B"));
  assert.notEqual(ra.groupId, rb.groupId);
  assert.deepEqual(statuses(ra), [[ra.groupId, "failed"]]);
  assert.deepEqual(statuses(rb), [[rb.groupId, "failed"]]);
});

test("parallel sync: a finished task takes the standalone group whose last message equals its result", () => {
  const a = Activity.create();
  a.route(syncTask("t1", "One"));
  a.route(syncTask("t2", "Two"));
  a.route(chunk("agent_message_chunk", "sa", "alpha", "A")); // g3
  a.route(chunk("agent_message_chunk", "sb", "be", "B")); // g4
  a.route(chunk("agent_message_chunk", "sb", "ta", "B"));
  const r = a.route(update("t2", { status: "completed", rawOutput: { content: "beta\n" } }));
  assert.ok(r.changes.some((c) => c.type === "merged" && c.from === "g4" && c.into === "g2"));
  assert.deepEqual(statuses(r), [["g2", "completed"]]);
  assert.equal(a.route(chunk("agent_message_chunk", "sb2", "more", "B")).groupId, "g2");
  assert.ok(!a.route(update("t1", { status: "completed", rawOutput: { content: "no match" } })).changes.some((c) => c.type === "merged"));
});

test("replaying: background groups get no running phase; settle gives quiet", () => {
  const a = Activity.create();
  bgTaskLinked(a, "t1", A);
  a.settle(); // quiet
  assert.deepEqual(statuses(a.route(chunk("agent_message_chunk", "s3", "x", A), { replaying: true })), []);
  assert.deepEqual(a.settle(), []); // already quiet
});

test("running() lists running groups", () => {
  const a = Activity.create();
  a.route(syncTask("t1"));
  bgTaskLinked(a, "t2", A);
  assert.deepEqual(a.running(), ["g1", "g2"]);
  a.route(update("t1", { status: "completed" }));
  assert.deepEqual(a.running(), ["g2"]);
});

test("headerText: work group counts, running tool and singulars", () => {
  assert.equal(Activity.headerText({ kind: "work", tools: 3, thoughts: 1 }), "3 tools · 1 thought");
  assert.equal(Activity.headerText({ kind: "work", tools: 3, thoughts: 1, runningTitle: "grep" }), "3 tools · 1 thought · grep");
  assert.equal(Activity.headerText({ kind: "work", tools: 1, thoughts: 2 }), "1 tool · 2 thoughts");
  assert.equal(Activity.headerText({ kind: "work", tools: 0, thoughts: 1 }), "1 thought");
});

test("headerText: subagent title, tools, last line and the permission wait", () => {
  const base = { kind: "subagent", title: "Summarize a.txt", tools: 2 };
  assert.equal(Activity.headerText({ ...base, lastLine: "writing" }), "subagent · Summarize a.txt · 2 tools · writing");
  assert.equal(Activity.headerText({ ...base, lastLine: "writing", waiting: true }), "subagent · Summarize a.txt · 2 tools · ⏸ permission");
  assert.equal(Activity.headerText({ kind: "subagent", title: "subagent", tools: 1 }), "subagent · 1 tool");
  assert.equal(Activity.headerText({ kind: "subagent", title: "x", tools: 0 }), "subagent · x");
});

test("MARKS", () => {
  assert.deepEqual(Activity.MARKS, { running: "●", completed: "✓", failed: "✗", interrupted: "⊘", quiet: "○" });
});

test("headerText: a waiting work group shows the permission mark in place of the running tool", () => {
  assert.equal(Activity.headerText({ kind: "work", tools: 2, thoughts: 0, runningTitle: "ls", waiting: true }), "2 tools · ⏸ permission");
});
