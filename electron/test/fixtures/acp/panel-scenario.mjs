// The scenario of the UI checks (scripts/ui-check) for the scripted agent (scripted-agent.mjs): three prompts with
// fixed ids, shaped like what real Copilot sends (see docs/superpowers/specs/2026-11-21-activity-groups-design.md,
// "What ACP sends").
const SYNC = "11111111-1111-4111-8111-111111111111"; // prompt 1: the sync task's subagent
const BG = "22222222-2222-4222-8222-222222222222"; // prompt 1: the background subagent (prompt 2: its tool)
const PA = "33333333-3333-4333-8333-333333333333"; // prompt 2: the parallel sync subagents
const PB = "44444444-4444-4444-8444-444444444444";
const LOST = "55555555-5555-4555-8555-555555555555"; // prompt 3: an agent no task started

const meta = (agentId) => (agentId ? { _meta: { "github.com/copilot": { agentId } } } : {});
const text = (messageId, t, agentId) => ({ u: { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: t }, ...meta(agentId) } });
const thought = (messageId, t) => ({ u: { sessionUpdate: "agent_thought_chunk", messageId, content: { type: "text", text: t } } });
const call = (toolCallId, fields, agentId) => ({ u: { sessionUpdate: "tool_call", toolCallId, ...fields, ...meta(agentId) } });
const update = (toolCallId, fields, agentId) => ({ u: { sessionUpdate: "tool_call_update", toolCallId, ...fields, ...meta(agentId) } });
const result = (t) => ({ content: [{ type: "content", content: { type: "text", text: t } }], rawOutput: { content: t } });
const plan = (...entries) => ({ u: { sessionUpdate: "plan", entries: entries.map(([content, status]) => ({ content, status })) } });
const task = (title, prompt, mode) => ({ title, kind: "other", status: "pending", rawInput: { agent_type: "explore", name: title.toLowerCase().replace(/\W+/g, "-"), description: title, prompt, mode } });

export default {
  prompts: [
    [
      text("m1", "I'll look around first."),
      thought("th1", "Listing the folder."),
      call("t1", { title: "ls", kind: "execute", status: "pending", rawInput: { command: "ls" } }),
      update("t1", { status: "completed", ...result("a.txt\nb.txt") }),
      plan(["Read a.txt", "pending"], ["Summarize it", "pending"]),
      call("t2", { title: "cat b.txt", kind: "read", status: "completed", ...result("hello") }),
      plan(["Read a.txt", "completed"], ["Summarize it", "pending"]),
      call("t3", task("Summarize a.txt", "Read a.txt\nand summarize it.", "sync")),
      text("s1", "Reading a.txt.", SYNC),
      call("s1t", { title: "view a.txt", kind: "read", status: "pending" }, SYNC),
      update("s1t", { status: "completed", ...result("two lines") }, SYNC),
      text("s2", "a.txt has two lines.", SYNC),
      update("t3", { status: "completed", ...result("a.txt has two lines.") }),
      call("t4", task("Watch the build", "Watch the build log.", "background")),
      update("t4", { status: "completed", ...result(`Agent started in background with agent_id: ${BG}. You'll be notified when it finishes.`) }),
      text("b1", "Watching the build log.", BG),
      text("m2", "a.txt has two lines; the build is being watched."),
      { end: "end_turn" },
    ],
    [
      call("t6", task("Check the docs", "Check the docs.", "sync")),
      call("t7", task("Check the tests", "Check the tests.", "sync")),
      // they start in the opposite order: neither can be told apart, so each gets a standalone group
      text("pb1", "Tests: all pass.", PB),
      text("pa1", "Docs: ", PA),
      text("pa1", "up to date.", PA),
      update("t7", { status: "completed", ...result("Tests: all pass.") }),
      update("t6", { status: "completed", ...result("Docs: up to date.") }),
      // as in a replay, a task's update before its tool_call: the badge it made is replaced by the task's group
      update("t5", { status: "completed", ...result("Config is fine.") }),
      call("t5", { ...task("Check the config", "Check the config.", "sync"), status: "completed" }),
      call("b1t", { title: "echo done > out.txt", kind: "execute", status: "pending" }, BG),
      { perm: { toolCallId: "b1t", title: "echo done > out.txt", kind: "execute", status: "pending" } }, // no _meta, as Copilot asks
      update("b1t", { status: "completed" }, BG),
      text("m3", "Docs and tests are fine."),
      { end: "end_turn" },
    ],
    [
      text("x1", "A note from a subagent no task started.", LOST),
      text("m4", "Nothing else to do."),
      { end: "end_turn" },
    ],
  ],
};
