// The scenario of the Communication panel's UI checks (comms-* in scripts/ui-check/checks.mjs): like link-scenario.mjs
// every prompt plays { relay: "prompt" } ("create_session_json <json>", "send_message <to> <text>", "report_result
// <text>", "release_session <name>" call that relay tool). Two more:
//   a prompt whose last line is "work" shows a finished tool call (an Activity entry in mode "all");
//   a prompt that holds SLOW and calls no tool (a task given with create_session) asks a permission and waits for its
//   answer, so the session works on its task for as long as the check needs.
export const SLOW = "(take your time)";

const work = (n) => [
  { u: { sessionUpdate: "tool_call", toolCallId: `ls${n}`, title: "ls", kind: "execute", status: "completed", rawInput: { command: "ls" } } },
  { u: { sessionUpdate: "agent_message_chunk", messageId: `m${n}`, content: { type: "text", text: "Looked around." } } },
  { end: "end_turn" },
];
const slow = (n) => [
  { u: { sessionUpdate: "tool_call", toolCallId: `w${n}`, title: "echo ok", kind: "execute", status: "pending" } },
  { perm: { toolCallId: `w${n}`, title: "echo ok", kind: "execute", status: "pending" } },
  { u: { sessionUpdate: "tool_call_update", toolCallId: `w${n}`, status: "completed" } },
  { end: "end_turn" },
];

export default {
  prompts: (text, n) => {
    if (/(?:^|\n)work$/.test(text)) return work(n);
    if (text.includes(SLOW) && !/create_session/.test(text)) return slow(n);
    return [{ relay: "prompt" }];
  },
};
