// Tests for electron/session-setup.mjs: prompt and command saved together, one restart.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createPromptStore } from "../session-prompts.mjs";
import { saveSetup } from "../session-setup.mjs";

let dir, prompts, commands;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-test-"));
  prompts = createPromptStore(path.join(dir, "p.json"));
  commands = createPromptStore(path.join(dir, "c.json"), "session-commands");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const setup = (o) => saveSetup({ sessionId: "s", refusal: () => null, close: async () => {}, prompts, commands, ...o });

test("nothing changed: nothing is closed", async () => {
  prompts.set("s", "p");
  commands.set("s", "c");
  let closed = 0;
  assert.deepEqual(await setup({ own: "p", command: " c ", close: async () => void closed++ }), { unchanged: true });
  assert.equal(closed, 0);
});
test("a change of both is saved and closes once", async () => {
  let closed = 0;
  assert.deepEqual(await setup({ own: "p2", command: "c2 --x", close: async () => void closed++ }), { reopen: true });
  assert.deepEqual([prompts.get("s"), commands.get("s"), closed], ["p2", "c2 --x", 1]);
});
test("an empty command removes the entry", async () => {
  commands.set("s", "c");
  await setup({ own: "", command: "" });
  assert.equal(commands.get("s"), "");
});
test("a prompt that is not text is refused", async () => {
  assert.deepEqual(await setup({ own: 7, command: "c" }), { refused: "The session's prompt must be text." });
});
test("a refused command changes nothing", async () => {
  prompts.set("s", "p");
  assert.deepEqual(await setup({ own: "new", command: "a\nb" }), { refused: "The command must be one line." });
  assert.equal(prompts.get("s"), "p");
});
test("a guard's refusal changes nothing", async () => {
  assert.deepEqual(await setup({ own: "new", command: "c", refusal: () => "Wait until Copilot finishes this turn." }), { refused: "Wait until Copilot finishes this turn." });
  assert.equal(prompts.get("s"), "");
});
test("a failed close restores both", async () => {
  prompts.set("s", "p");
  commands.set("s", "c");
  await assert.rejects(setup({ own: "p2", command: "c2", close: async () => { throw new Error("stuck"); } }), /stuck/);
  assert.deepEqual([prompts.get("s"), commands.get("s")], ["p", "c"]);
});
test("a failed save of the command restores the prompt", async () => {
  prompts.set("s", "p");
  const broken = { get: () => "", set: () => { throw new Error("disk"); } };
  await assert.rejects(setup({ own: "p2", command: "c2", commands: broken }), /disk/);
  assert.equal(prompts.get("s"), "p");
});
