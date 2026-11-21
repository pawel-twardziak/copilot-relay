// Where each ACP session/update goes: the log (main text), the main agent's work group or a subagent's group (no DOM).
// Loaded as a classic <script> (sets globalThis.Activity) and via require() in tests.
"use strict";

const toolCalls = globalThis.ToolCalls ?? require("./tool-calls.js");

const AGENT_ID = /agent_id:\s*([0-9a-f-]{36})/i;
const AGENT_DONE = /status:\s*(idle|completed)\b/i;
const TASK_ENDS = new Set(["completed", "failed", "interrupted"]);

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
  const messageOf = new Map(); // groupId -> messageId of the message lastText is built from

  function setStatus(group, status, changes) {
    if (group.status === status) return;
    group.status = status;
    changes.push({ type: "status", groupId: group.id, status });
  }

  function addText(group, u) {
    const text = u.content?.type === "text" ? u.content.text : "";
    if (!text) return;
    const continues = u.messageId != null && messageOf.get(group.id) === u.messageId;
    group.lastText = continues ? (group.lastText ?? "") + text : text;
    messageOf.set(group.id, u.messageId);
  }

  /** A task group finished: take over a standalone group (parallel sync) whose last message is the result. */
  function merge(taskGroup, update, changes) {
    const text = resultText(update).trim();
    if (!text || taskGroup.agentId) return;
    const standalone = [...groups.values()].find((g) => !g.anchored && !g.mergedInto && g.agentId && g.lastText?.trim() === text);
    if (!standalone) return;
    standalone.mergedInto = taskGroup.id;
    link(taskGroup, standalone.agentId);
    taskGroup.lastText = standalone.lastText;
    changes.push({ type: "merged", from: standalone.id, into: taskGroup.id });
  }

  /** What an update owned by `group` says about its status. */
  function ownedStatus(group, u, replaying, changes) {
    const failed = u.sessionUpdate === "agent_message_chunk" && !u.messageId && /^Error:/.test(u.content?.text ?? "");
    if (failed) return setStatus(group, "failed", changes);
    if (u.sessionUpdate === "agent_message_chunk") addText(group, u);
    if (group.mode !== "sync" && group.status !== "running" && !replaying) setStatus(group, "running", changes);
  }

  function readAgentResult(u, changes) {
    const text = resultText(u);
    const id = AGENT_ID.exec(text)?.[1];
    const group = id && groups.get(byAgent.get(id));
    if (group && AGENT_DONE.test(text)) setStatus(group, "completed", changes);
  }

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
    if (group.mode === "sync" && TASK_ENDS.has(update.status)) {
      if (update.status === "completed") merge(group, update, changes);
      setStatus(group, update.status, changes);
    }
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
    if (known?.readsAgent) readAgentResult(u, changes);
    if (known) return known.task ? linkResult(u, known, changes) : routed(known, changes);
    const readsAgent = u.title === "read_agent";
    tools.set(id, { to: "work", readsAgent });
    if (readsAgent) readAgentResult(u, changes);
    return { to: "work", changes };
  }

  function routed(dest, changes) {
    return dest.to === "group" ? { to: "group", groupId: dest.groupId, changes } : { to: dest.to, changes };
  }

  return {
    route(u, { replaying = false } = {}) {
      const changes = [];
      const type = u.sessionUpdate;
      const isTool = type === "tool_call" || type === "tool_call_update";
      const owner = toolCalls.agentOf(u);
      if (owner) {
        const group = groupOwnedBy(owner, changes);
        ownedStatus(group, u, replaying, changes);
        if (isTool && !tools.has(u.toolCallId)) tools.set(u.toolCallId, { to: "group", groupId: group.id });
        return { to: "group", groupId: group.id, changes };
      }
      if (isTool) return routeTool(u, changes);
      if (type === "agent_thought_chunk") return { to: "work", changes };
      return { to: "main", changes };
    },
    settle() {
      const changes = [];
      for (const g of groups.values()) {
        if (g.mergedInto || g.status !== "running") continue;
        setStatus(g, g.mode === "sync" ? "interrupted" : "quiet", changes); // a sync task that never ended was stopped
      }
      return changes;
    },
    running() {
      return [...groups.values()].filter((g) => !g.mergedInto && g.status === "running").map((g) => g.id);
    },
    group(groupId) {
      return groups.get(groupId) ?? null;
    },
  };
}

const MARKS = { running: "●", completed: "✓", failed: "✗", interrupted: "⊘", quiet: "○" };

/** The one-line header of a group: `3 tools · 1 thought · <running tool>`, or `subagent · <title> · N tools · <last line>`. */
function headerText({ kind, title = "", tools = 0, thoughts = 0, runningTitle = "", lastLine = "", waiting = false }) {
  const plural = (n, w) => (n ? `${n} ${w}${n === 1 ? "" : "s"}` : "");
  if (kind === "work") return [plural(tools, "tool"), plural(thoughts, "thought"), waiting ? "⏸ permission" : runningTitle].filter(Boolean).join(" · ");
  const tail = waiting ? "⏸ permission" : lastLine;
  return ["subagent", title === "subagent" ? "" : title, plural(tools, "tool"), tail].filter(Boolean).join(" · ");
}

const Activity = { create: createActivity, headerText, MARKS };
globalThis.Activity = Activity;
if (typeof module !== "undefined") module.exports = Activity;
