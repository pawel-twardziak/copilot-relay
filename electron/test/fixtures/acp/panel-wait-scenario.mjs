// panel-scenario.mjs with two pauses, for the UI checks that act while a turn runs (scripts/ui-check/checks.mjs):
// - prompt 1: the sync subagent's last message stops halfway ("a.txt has " … WAIT_MS … "two lines.");
// - prompt 2: after the parallel sync subagents' texts, before the completions that merge their standalone groups.
// The chat it gives is the same as panel-scenario's.
import scenario from "./panel-scenario.mjs";

export const WAIT_MS = 3000;
const [first, second, ...rest] = scenario.prompts;

const split = first.flatMap((step) => {
  const u = step.u;
  if (u?.messageId !== "s2") return [step];
  const half = (t) => ({ u: { ...u, content: { ...u.content, text: t } } });
  return [half("a.txt has "), { wait: WAIT_MS }, half("two lines.")];
});
const beforeMerge = second.findIndex((step) => step.u?.sessionUpdate === "tool_call_update" && step.u.toolCallId === "t7");

export default {
  prompts: [split, [...second.slice(0, beforeMerge), { wait: WAIT_MS }, ...second.slice(beforeMerge)], ...rest],
};
