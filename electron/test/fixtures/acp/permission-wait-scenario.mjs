// The scenario of the UI check session-prompt-edit (scripts/ui-check/checks.mjs): every prompt asks a permission and
// waits for its answer before it answers, so a turn runs for as long as the check needs. More prompts than it sends.
const turn = (i) => [
  { u: { sessionUpdate: "tool_call", toolCallId: `w${i}`, title: "echo ok", kind: "execute", status: "pending" } },
  { perm: { toolCallId: `w${i}`, title: "echo ok", kind: "execute", status: "pending" } },
  { u: { sessionUpdate: "tool_call_update", toolCallId: `w${i}`, status: "completed" } },
  { u: { sessionUpdate: "agent_message_chunk", messageId: `m${i}`, content: { type: "text", text: `Done ${i}.` } } },
  { end: "end_turn" },
];

export default { prompts: Array.from({ length: 20 }, (_, i) => turn(i + 1)) };
