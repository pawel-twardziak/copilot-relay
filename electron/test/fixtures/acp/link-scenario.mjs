// The scenario of the UI check link-e2e (scripts/ui-check/checks.mjs) for the scripted agent (scripted-agent.mjs):
// every prompt plays { relay: "prompt" }, so "adopt_session <name>", "release_session <name>", "send_message <to> <text>"
// and "report_result <text>" call that relay tool (also the check held-e2e)
// whichever prompt they are, and the relay's notices (prompts too) do nothing. More prompts than the check sends.
const PROMPTS = 100;

export default { prompts: Array.from({ length: PROMPTS }, () => [{ relay: "prompt" }]) };
