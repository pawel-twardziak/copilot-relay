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
  assert.equal(a.group("g1").status, "running");
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
