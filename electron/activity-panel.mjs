// The "Tool and subagent details" setting: where the details of activity groups open.
const MODES = ["off", "subagents", "all"];

/** "off" (the details open inline), "subagents" (subagent groups open in the side panel) or "all" (every group does). */
export function normalizePanelMode(value) {
  return MODES.includes(value) ? value : "off";
}
