// The scenario of the UI checks child-card-params and child-config-retry (scripts/ui-check/checks.mjs): like
// child-prompt-scenario.mjs (every prompt plays { relay: "prompt" }, each session in a folder gets its own id), and
// the sessions have a model option and an agent option. In a folder named other-b only the model m-a is offered (and
// no agent option), so a child asked to run m-b there is refused by resolveConfig after its start.
import path from "node:path";

const select = (id, name, currentValue, values) => ({
  id,
  name,
  type: "select",
  currentValue,
  options: values.map((value) => ({ value, name: value || "Default" })),
});

export default {
  uniqueIds: true,
  prompts: Array.from({ length: 100 }, () => [{ relay: "prompt" }]),
  configOptions: (cwd) =>
    path.basename(cwd) === "other-b"
      ? [select("model", "Model", "m-a", ["m-a"])]
      : [select("model", "Model", "m-a", ["m-a", "m-b"]), select("agent", "Agent", "", ["", "rev"])],
};
