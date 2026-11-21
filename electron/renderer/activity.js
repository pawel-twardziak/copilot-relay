// Where each ACP session/update goes: the log (main text), the main agent's work group or a subagent's group (no DOM).
// Loaded as a classic <script> (sets globalThis.Activity) and via require() in tests.
"use strict";

const toolCalls = globalThis.ToolCalls ?? require("./tool-calls.js");

const AGENT_ID = /agent_id:\s*([0-9a-f-]{36})/i;

function isTask(u) {
  const input = u.rawInput;
  return !!input && typeof input === "object" && !!input.agent_type && !!input.prompt;
}

/** The text of a task's result: the first text content item, else a string rawOutput.content. */
function resultText(u) {
  const item = Array.isArray(u.content) ? u.content.find((c) => typeof c?.content?.text === "string") : null;
  if (item) return item.content.text;
  const out = u.rawOutput?.content;
  return typeof out === "string" ? out : "";
}

function createActivity() {
  const tools = new Map(); // toolCallId -> { to, groupId?, task? }
  const groups = new Map(); // groupId -> group
  const byAgent = new Map(); // agentId -> groupId

  function addGroup(fields, changes, replacesTool = null) {
    const group = {
      id: `g${groups.size + 1}`,
      title: fields.title,
      prompt: fields.prompt,
      mode: fields.mode ?? null,
      anchored: fields.anchored,
      agentId: null,
      taskToolCallId: fields.taskToolCallId ?? null,
      status: "running",
      lastText: null,
    };
    groups.set(group.id, group);
    changes.push({ type: "created", groupId: group.id, title: group.title, prompt: group.prompt, anchored: group.anchored, replacesTool });
    return group;
  }

  function link(group, agentId) {
    group.agentId = agentId;
    byAgent.set(agentId, group.id);
  }

  function groupOwnedBy(agentId, changes) {
    const known = byAgent.get(agentId);
    if (known) return groups.get(known);
    const open = [...groups.values()].filter((g) => g.anchored && g.mode === "sync" && !g.agentId);
    const group = open.length === 1 ? open[0] : addGroup({ title: "subagent", prompt: null, anchored: false }, changes);
    link(group, agentId);
    return group;
  }

  function linkResult(update, dest, changes) {
    const match = AGENT_ID.exec(resultText(update));
    const group = groups.get(dest.groupId);
    if (match && !group.agentId) link(group, match[1]);
    return { to: "group", groupId: dest.groupId, task: true, changes };
  }

  function routeTool(u, changes) {
    const id = u.toolCallId;
    const known = tools.get(id);
    if (isTask(u)) {
      if (known?.task) return linkResult(u, known, changes);
      if (known && known.to === "group") return { to: "group", groupId: known.groupId, changes }; // a subagent's own tool
      const group = addGroup({ title: u.title, prompt: u.rawInput.prompt, mode: u.rawInput.mode, anchored: true, taskToolCallId: id }, changes, known ? id : null);
      const dest = { to: "group", groupId: group.id, task: true };
      tools.set(id, dest);
      return linkResult(u, dest, changes);
    }
    if (known) return known.task ? linkResult(u, known, changes) : routed(known, changes);
    tools.set(id, { to: "work" });
    return { to: "work", changes };
  }

  function routed(dest, changes) {
    return dest.to === "group" ? { to: "group", groupId: dest.groupId, changes } : { to: dest.to, changes };
  }

  return {
    route(u, { replaying = false } = {}) {
      void replaying;
      const changes = [];
      const type = u.sessionUpdate;
      const isTool = type === "tool_call" || type === "tool_call_update";
      const owner = toolCalls.agentOf(u);
      if (owner) {
        const group = groupOwnedBy(owner, changes);
        if (isTool && !tools.has(u.toolCallId)) tools.set(u.toolCallId, { to: "group", groupId: group.id });
        return { to: "group", groupId: group.id, changes };
      }
      if (isTool) return routeTool(u, changes);
      if (type === "agent_thought_chunk") return { to: "work", changes };
      return { to: "main", changes };
    },
    group(groupId) {
      return groups.get(groupId) ?? null;
    },
  };
}

const Activity = { create: createActivity };
globalThis.Activity = Activity;
if (typeof module !== "undefined") module.exports = Activity;
