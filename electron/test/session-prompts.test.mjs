// Tests for electron/session-prompts.mjs: the prompt parts, their store and the per-process instructions folder.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  CHILD_PART,
  applyPromptSettings,
  clearPromptDirs,
  composePrompt,
  createPromptStore,
  effectiveChildPart,
  instructionsEnv,
  normalizeTemplates,
  writePromptDir,
} from "../session-prompts.mjs";

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "prompts-test-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test("composePrompt joins the non-empty parts in order", () => {
  assert.equal(composePrompt({ defaultPart: " A ", childPart: "B", own: "C", isChild: true }), "A\n\nB\n\nC");
  assert.equal(composePrompt({ defaultPart: " A ", childPart: "B", own: "C", isChild: false }), "A\n\nC");
  assert.equal(composePrompt({ defaultPart: " ", childPart: "\n", own: "  ", isChild: true }), "");
  assert.equal(composePrompt({ isChild: true }), "");
});

test('effectiveChildPart: absent means the built-in text, "" means none', () => {
  assert.equal(effectiveChildPart(undefined), CHILD_PART);
  assert.equal(effectiveChildPart(5), CHILD_PART);
  assert.equal(effectiveChildPart(""), "");
  assert.equal(effectiveChildPart("X"), "X");
  assert.match(CHILD_PART, /^This session is the child of another session/);
  assert.match(CHILD_PART, /before you can finish\.$/);
});

test("normalizeTemplates keeps well-formed entries only", () => {
  const out = normalizeTemplates([
    null,
    "x",
    { name: "no id" },
    { id: 3 },
    { id: "a", name: "A", text: "ta" },
    { id: "a", name: "dup", text: "dup" },
    { id: "b" },
    { id: "c", name: 1, text: 2 },
  ]);
  assert.deepEqual(out, [
    { id: "a", name: "A", text: "ta" },
    { id: "b", name: "", text: "" },
    { id: "c", name: "", text: "" },
  ]);
  assert.deepEqual(normalizeTemplates({}), []);
  assert.deepEqual(normalizeTemplates(undefined), []);
});

test("applyPromptSettings stores only well-typed prompt keys", () => {
  const stored = () => ({ relay: true, promptDefault: "D", promptChild: "C", promptTemplates: [{ id: "a", name: "A", text: "ta" }] });
  // absent keys keep what is stored
  assert.deepEqual(applyPromptSettings(stored(), {}), stored());
  // present but undefined, or of another type: kept too (never the text "undefined")
  assert.deepEqual(applyPromptSettings(stored(), { promptDefault: undefined, promptChild: undefined, promptTemplates: undefined }), stored());
  assert.deepEqual(applyPromptSettings(stored(), { promptDefault: 5, promptChild: { x: 1 }, promptTemplates: "x" }), stored());
  // text is stored as it is, "" included
  assert.deepEqual(applyPromptSettings(stored(), { promptDefault: "", promptChild: "" }), { ...stored(), promptDefault: "", promptChild: "" });
  assert.deepEqual(applyPromptSettings(stored(), { promptDefault: "D2", promptChild: "C2" }), { ...stored(), promptDefault: "D2", promptChild: "C2" });
  // null: the child part goes back to the built-in text (no key)
  const back = applyPromptSettings(stored(), { promptChild: null });
  assert.equal("promptChild" in back, false);
  assert.equal(effectiveChildPart(back.promptChild), CHILD_PART);
  // templates: normalized, [] empties the list
  assert.deepEqual(applyPromptSettings(stored(), { promptTemplates: [{ id: "b", name: "B" }, { name: "no id" }] }).promptTemplates, [{ id: "b", name: "B", text: "" }]);
  assert.deepEqual(applyPromptSettings(stored(), { promptTemplates: [] }).promptTemplates, []);
});

test("the prompt store", (t) => {
  const file = path.join(tmp(t), "sub", "session-prompts.json");
  const s = createPromptStore(file);
  assert.equal(s.get("nope"), "");
  s.set("s1", "x");
  assert.equal(s.get("s1"), "x");
  s.copy("s1", "s2");
  assert.equal(s.get("s2"), "x");
  s.set("s1", "");
  assert.equal(s.get("s1"), "");
  assert.ok(!("s1" in JSON.parse(fs.readFileSync(file, "utf8"))));
  s.delete("s2");
  assert.equal(s.get("s2"), "");
  fs.writeFileSync(file, "{not json");
  assert.equal(s.get("s1"), "");
  s.set("s3", "y");
  assert.equal(s.get("s3"), "y");
});

test("the prompt store: set throws when the file cannot be written", (t) => {
  const d = tmp(t);
  fs.writeFileSync(path.join(d, "blocker"), "");
  const s = createPromptStore(path.join(d, "blocker", "p.json"));
  assert.throws(() => s.set("a", "b"));
});

test("writePromptDir writes the instructions file and remove() deletes the directory", (t) => {
  const root = tmp(t);
  const a = writePromptDir(root, "hello");
  const b = writePromptDir(root, "other");
  assert.notEqual(a.dir, b.dir);
  assert.equal(path.dirname(a.dir), path.join(root, "run"));
  assert.equal(fs.readFileSync(path.join(a.dir, ".github", "instructions", "session.instructions.md"), "utf8"), "hello\n");
  a.remove();
  assert.ok(!fs.existsSync(a.dir));
  assert.doesNotThrow(() => a.remove());
  assert.ok(fs.existsSync(b.dir));
});

test("clearPromptDirs removes everything under run/", (t) => {
  const root = tmp(t);
  const a = writePromptDir(root, "x");
  writePromptDir(root, "y");
  clearPromptDirs(root);
  assert.ok(!fs.existsSync(a.dir));
  assert.deepEqual(fs.readdirSync(path.join(root, "run")), []);
  assert.doesNotThrow(() => clearPromptDirs(path.join(root, "missing")));
});

test("instructionsEnv appends to the user's directories", () => {
  const input = { COPILOT_CUSTOM_INSTRUCTIONS_DIRS: "/u", A: "1" };
  assert.equal(instructionsEnv(input, "/d").COPILOT_CUSTOM_INSTRUCTIONS_DIRS, "/u,/d");
  assert.equal(input.COPILOT_CUSTOM_INSTRUCTIONS_DIRS, "/u");
  assert.equal(instructionsEnv({ A: "1" }, "/d").COPILOT_CUSTOM_INSTRUCTIONS_DIRS, "/d");
  assert.deepEqual(instructionsEnv(input, null), input);
});

test("instructionsEnv refuses a directory with a comma", () => {
  assert.throws(() => instructionsEnv({}, "/a,b"), /contains a comma/);
});

test("a stored value that is not text reads as empty", (t) => {
  const file = path.join(tmp(t), "p.json");
  fs.writeFileSync(file, JSON.stringify({ s: 7 }));
  assert.equal(createPromptStore(file).get("s"), "");
});
