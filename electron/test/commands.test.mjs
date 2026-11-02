// Tests for the pure slash-command / agent helpers in electron/renderer/commands.js.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const {
  commandToken,
  filterCommands,
  insertCommand,
  parseAgentCommand,
  parseRenameCommand,
  isCommandPrompt,
  matchAgent,
  agentPickerModel,
} = createRequire(import.meta.url)("../renderer/commands.js");

const opts = [
  { value: "", name: "Copilot" },
  { value: "pirate", name: "pirate" },
  { value: "az-infra", name: "Azure Infra" },
];

test("commandToken", () => {
  assert.equal(commandToken("/co", 3), "co");
  assert.equal(commandToken("/", 1), "");
  assert.equal(commandToken("/compact x", 10), null);
  assert.equal(commandToken("a /b", 4), null);
  assert.equal(commandToken(" /b", 3), null);
  assert.equal(commandToken("/compact\nfoo", 4), "com");
});

test("filterCommands", () => {
  const cmds = [{ name: "compact" }, { name: "context" }, { name: "superpowers:brainstorming" }, { name: "reco" }];
  assert.deepEqual(filterCommands(cmds, "co").map((c) => c.name), ["compact", "context", "reco"]);
  assert.deepEqual(filterCommands(cmds, "BRAIN").map((c) => c.name), ["superpowers:brainstorming"]);
  assert.equal(filterCommands(cmds, "").length, 4);
});

test("insertCommand", () => {
  assert.deepEqual(insertCommand("/co  focus on tests", "compact"), { text: "/compact focus on tests", caret: 9 });
  assert.deepEqual(insertCommand("/co", "compact"), { text: "/compact ", caret: 9 });
});

test("parseAgentCommand", () => {
  assert.deepEqual(parseAgentCommand("  /agent  Pirate "), { arg: "Pirate" });
  assert.deepEqual(parseAgentCommand("/agent"), { arg: "" });
  assert.equal(parseAgentCommand("/agentx"), null);
  assert.equal(parseAgentCommand("use /agent pirate"), null);
});

test("parseRenameCommand", () => {
  assert.deepEqual(parseRenameCommand("/rename  My  name"), { name: "My  name" });
  assert.equal(parseRenameCommand("/rename"), null);
});

test("isCommandPrompt", () => {
  assert.equal(isCommandPrompt("  /context"), true);
  assert.equal(isCommandPrompt("hi /context"), false);
});

test("matchAgent", () => {
  assert.equal(matchAgent(opts, "PIRATE").value, "pirate");
  assert.equal(matchAgent(opts, "azure infra").value, "az-infra");
  assert.equal(matchAgent(opts, "default").value, "");
  assert.equal(matchAgent(opts, "copilot").value, "");
  assert.equal(matchAgent(opts, "nobody"), null);
});

test("agentPickerModel", () => {
  const m = agentPickerModel({ id: "agent", currentValue: "gone", options: [...opts, { value: "pirate", name: "dup" }] });
  assert.deepEqual(m.entries.map((e) => e.value), ["", "pirate", "az-infra", "gone"]);
  assert.equal(m.entries.at(-1).name, "gone (not found)");
  assert.equal(m.show, true);
  assert.equal(m.current, "gone");
  assert.equal(agentPickerModel(undefined).show, false);
  assert.equal(agentPickerModel({ id: "agent", currentValue: "", options: [opts[0]] }).show, false);
});
