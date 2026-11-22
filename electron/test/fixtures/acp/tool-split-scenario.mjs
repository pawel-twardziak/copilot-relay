// A scenario of the UI checks (scripts/ui-check/checks.mjs: split-header) for the scripted agent: a work group whose
// tools end in different ways (two completed, one failed, one that never ends), then one whose tools all complete.
const text = (messageId, t) => ({ u: { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: t } } });
const thought = (messageId, t) => ({ u: { sessionUpdate: "agent_thought_chunk", messageId, content: { type: "text", text: t } } });
const call = (toolCallId, title) => ({ u: { sessionUpdate: "tool_call", toolCallId, title, kind: "execute", status: "pending" } });
const update = (toolCallId, fields) => ({ u: { sessionUpdate: "tool_call_update", toolCallId, ...fields } });

export const RUNNING_TITLE = "sleep 30";
export const RUNNING_MS = 2000; // how long the first turn waits with its last tool running

export default {
  prompts: [
    [
      thought("th1", "Trying the edits."),
      call("t1", "edit a.txt"),
      update("t1", { status: "completed" }),
      call("t2", "edit b.txt"),
      update("t2", { status: "failed", rawOutput: { message: "No match found" } }),
      call("t3", "edit b.txt"),
      update("t3", { status: "completed" }),
      call("t4", RUNNING_TITLE),
      { wait: RUNNING_MS },
      text("m1", "Edited both files."),
      { end: "end_turn" },
    ],
    [
      call("t5", "cat a.txt"),
      update("t5", { status: "completed" }),
      call("t6", "cat b.txt"),
      update("t6", { status: "completed" }),
      text("m2", "Both look right."),
      { end: "end_turn" },
    ],
  ],
};
