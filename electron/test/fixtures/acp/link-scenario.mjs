// The scenario of the UI check link-e2e (scripts/ui-check/checks.mjs) for the scripted agent (scripted-agent.mjs):
// every prompt plays { relay: "prompt" }, so "adopt_session <name>" and "release_session <name>" call that relay tool
// whichever prompt they are, and the relay's notices (prompts too) do nothing. More prompts than the check sends.
const PROMPTS = 100;

export default { prompts: Array.from({ length: PROMPTS }, () => [{ relay: "prompt" }]) };
