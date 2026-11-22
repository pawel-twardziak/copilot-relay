// panel-scenario.mjs whose last prompt is followed, LATE_MS after its answer, by a message from another subagent no task
// started: a group created while the turn is over, for the UI checks that act in between (scripts/ui-check/checks.mjs:
// edit-dim).
import scenario from "./panel-scenario.mjs";

export const LATE_MS = 3000;
export const LATE_TEXT = "A late note from a subagent.";
const LATE = "66666666-6666-4666-8666-666666666666";
const late = { u: { sessionUpdate: "agent_message_chunk", messageId: "y1", content: { type: "text", text: LATE_TEXT }, _meta: { "github.com/copilot": { agentId: LATE } } } };
const last = scenario.prompts.at(-1);

export default {
  prompts: [...scenario.prompts.slice(0, -1), [...last, { wait: LATE_MS }, late]],
};
