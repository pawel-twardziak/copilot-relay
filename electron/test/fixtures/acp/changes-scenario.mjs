// A scenario of the UI checks (scripts/ui-check/checks.mjs: changes-records, changes-browser) for the scripted agent:
// one edit whose pending tool call names no path, then its completed update with a diff of notes.txt (relative to the
// session folder). The second prompt makes the same edit again.
const edit = (toolCallId, messageId) => [
  { u: { sessionUpdate: "tool_call", toolCallId, title: "apply_patch", kind: "edit", status: "pending" } },
  {
    u: {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "completed",
      content: [{ type: "diff", path: "notes.txt", oldText: "", newText: "hello\n" }],
    },
  },
  { u: { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: "Wrote notes.txt." } } },
  { end: "end_turn" },
];

export default { prompts: [edit("e1", "m1"), edit("e2", "m2")] };
