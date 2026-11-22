// A scenario of the UI checks (scripts/ui-check/checks.mjs: changes-records) for the scripted agent: one edit whose
// pending tool call names no path, then its completed update with a diff of notes.txt (relative to the session folder).
export default {
  prompts: [
    [
      { u: { sessionUpdate: "tool_call", toolCallId: "e1", title: "apply_patch", kind: "edit", status: "pending" } },
      {
        u: {
          sessionUpdate: "tool_call_update",
          toolCallId: "e1",
          status: "completed",
          content: [{ type: "diff", path: "notes.txt", oldText: "", newText: "hello\n" }],
        },
      },
      { u: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Wrote notes.txt." } } },
      { end: "end_turn" },
    ],
  ],
};
