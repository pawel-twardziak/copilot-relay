// The session header (scripts/ui-check/checks.mjs, header-*): config options as Copilot 1.0.116+ gives them for a
// model with a long-context tier, Copilot's own context option among them (its real id is unknown: "context_size").
const select = (id, name, category, currentValue, options) => ({ id, name, category, type: "select", currentValue, options: options.map(([value, n]) => ({ value, name: n })) });

export default {
  prompts: [],
  configOptions: [
    select("model", "Model", "model", "claude-sonnet-5.5", [["claude-sonnet-5.5", "Claude Sonnet 5.5"], ["gpt-5.5", "GPT-5.5"]]),
    select("context_size", "Context size", "context", "default", [["default", "200K"], ["long_context", "1M"]]),
    select("allow_all", "Permissions", "permissions", "off", [["off", "Ask"], ["on", "Allow all"]]),
  ],
};
