// The scenario of the UI checks fallback-* (scripts/ui-check/checks.mjs): the reply fallback of a session whose agent
// has no relay tools. The sessions have an agent option ("" = Copilot's default agent, or "limited", whose tools list
// has no relay tools: setting it writes that subagent.selected to the session's history, see scripted-agent.mjs).
// A prompt that names a relay tool ("create_session_json <json>", "send_message <to> <text>"…) calls it, as in
// link-scenario.mjs. A delegated child's first prompt carries its task: TASK, or TASK_WAIT for a turn that first runs a
// tool and waits for its permission (and a moment after it, so a message queued meanwhile is delivered mid-turn); the
// child never calls a relay tool and ends the turn with RESULT. A message delivered mid-turn is answered with ANSWER,
// the app's continue prompt with FINAL. Anything else (a relay notice) does nothing.
export const TASK = "Count the files.";
export const TASK_WAIT = "Count the files slowly.";
export const RESULT = "There are 3 files.";
export const ANSWER = "Noted, thanks.";
export const FINAL = "Done: there are 3 files.";

const MID_TURN = "[queued message, delivered during your work]\n"; // MessageQueue.MARKER
const CONTINUE = "[continue after queued messages]\n"; // MessageQueue.CONTINUE_PROMPT's first line
const RELAY_TOOL = /(?:^|\n\n)(adopt_session|release_session|send_message|report_result|create_session_json|create_session) [^\n]*$/;

let said = 0;
const say = (text) => ({ u: { sessionUpdate: "agent_message_chunk", messageId: `fb-${++said}`, content: { type: "text", text } } });
const waitForPermission = [
  { u: { sessionUpdate: "tool_call", toolCallId: "fb1", title: "ls", kind: "execute", status: "pending" } },
  { perm: { toolCallId: "fb1", title: "ls", kind: "execute", status: "pending" } },
  { u: { sessionUpdate: "tool_call_update", toolCallId: "fb1", status: "completed" } },
  { wait: 400 },
];

export default {
  agentTools: { limited: ["read"] },
  configOptions: [
    {
      id: "agent",
      name: "Agent",
      type: "select",
      currentValue: "",
      options: [
        { value: "", name: "Default" },
        { value: "limited", name: "Limited" },
      ],
    },
  ],
  // the relay tool first: the parent's create_session_json prompt holds the task too
  prompts: (text) => {
    if (RELAY_TOOL.test(text)) return [{ relay: "prompt" }];
    if (text.startsWith(CONTINUE)) return [say(FINAL)];
    if (text.startsWith(MID_TURN)) return [say(ANSWER)];
    if (text.includes(TASK_WAIT)) return [...waitForPermission, say(RESULT)];
    if (text.includes(TASK)) return [say(RESULT)];
    return [];
  },
};
