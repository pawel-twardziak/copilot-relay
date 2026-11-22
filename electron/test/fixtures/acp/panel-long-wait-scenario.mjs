// panel-scenario.mjs whose first prompt pauses for LONG_MS before its last answer, its groups already in the chat, for
// the UI checks that act while a turn runs for a while (scripts/ui-check/checks.mjs: drawer-esc).
import scenario from "./panel-scenario.mjs";

export const LONG_MS = 60_000;
const [first, ...rest] = scenario.prompts;
const last = first.findIndex((step) => step.u?.messageId === "m2");

export default {
  prompts: [[...first.slice(0, last), { wait: LONG_MS }, ...first.slice(last)], ...rest],
};
