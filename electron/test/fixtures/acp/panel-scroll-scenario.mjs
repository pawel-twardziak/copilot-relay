// A scenario for the UI checks of scrolling (scripts/ui-check/checks.mjs: panel-follows … forced-scroll), in a short
// window (500 px high) so that the log and the panel overflow:
// - prompt 1: a long answer (the log overflows), a pause, a work group (a thought, a tool), a sync task whose
//   subagent group appears, a pause, then the subagent's message in PARTS long paragraphs ("Part 1." …), a pause
//   after each;
// - prompt 2: a short answer.
export const PARTS = 12;
export const WAIT_MS = 500; // after each part
const SYNC = "66666666-6666-4666-8666-666666666666";

const meta = (agentId) => (agentId ? { _meta: { "github.com/copilot": { agentId } } } : {});
const text = (messageId, t, agentId) => ({ u: { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: t }, ...meta(agentId) } });
const words = (n, line) => Array.from({ length: n }, () => line).join(" ");
const answer = Array.from({ length: 10 }, (_, i) => `Paragraph ${i + 1}. ${words(4, "The answer goes on about the folder, its files and what each of them holds.")}`).join("\n\n");
const part = (k) => `Part ${k}. ${words(4, "The subagent reads the next file and notes what it finds there, line by line.")}\n\n`;

export default {
  prompts: [
    [
      text("m1", answer),
      { wait: 1500 },
      { u: { sessionUpdate: "agent_thought_chunk", messageId: "th1", content: { type: "text", text: "Listing the folder." } } },
      { u: { sessionUpdate: "tool_call", toolCallId: "t1", title: "ls", kind: "execute", status: "completed", rawInput: { command: "ls" } } },
      {
        u: {
          sessionUpdate: "tool_call",
          toolCallId: "t2",
          title: "Explain the files",
          kind: "other",
          status: "pending",
          rawInput: { agent_type: "explore", name: "explain-the-files", description: "Explain the files", prompt: "Explain the files.", mode: "sync" },
        },
      },
      { wait: 1000 },
      ...Array.from({ length: PARTS }, (_, i) => [text("s1", part(i + 1), SYNC), { wait: WAIT_MS }]).flat(),
      { u: { sessionUpdate: "tool_call_update", toolCallId: "t2", status: "completed", content: [{ type: "content", content: { type: "text", text: "Explained." } }], rawOutput: { content: "Explained." } } },
      text("m2", "Done."),
      { end: "end_turn" },
    ],
    [text("m3", "Second answer."), { end: "end_turn" }],
  ],
};
