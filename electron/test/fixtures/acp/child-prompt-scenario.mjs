// The scenario of the UI check child-prompt (scripts/ui-check/checks.mjs): like link-scenario.mjs (every prompt plays
// { relay: "prompt" }, so "create_session <name> <task>" calls that relay tool), and the agent gives each session in
// a folder its own id: a delegated child starts in its parent's folder.
export default { uniqueIds: true, prompts: Array.from({ length: 100 }, () => [{ relay: "prompt" }]) };
