// Tests for the pure part of electron/renderer/prompt-editor.js: what picking a template does to the own part.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const { pickTemplate } = createRequire(import.meta.url)("../renderer/prompt-editor.js");

const rev = { text: "Review only." };

test("pickTemplate replaces an empty text", () => {
  assert.deepEqual(pickTemplate({ text: "", lastTemplateText: null }, rev), { text: "Review only.", lastTemplateText: "Review only." });
  // only blanks: nothing typed that could be lost
  assert.deepEqual(pickTemplate({ text: "  \n", lastTemplateText: "Other." }, rev), { text: "Review only.", lastTemplateText: "Review only." });
});

test("pickTemplate replaces the untouched text of the last template", () => {
  assert.deepEqual(pickTemplate({ text: "Other.", lastTemplateText: "Other." }, rev), { text: "Review only.", lastTemplateText: "Review only." });
  // the same template again over its own untouched text
  assert.deepEqual(pickTemplate({ text: "Review only.", lastTemplateText: "Review only." }, rev), { text: "Review only.", lastTemplateText: "Review only." });
});

test("pickTemplate asks when the text was typed or edited", () => {
  assert.deepEqual(pickTemplate({ text: "Mine.", lastTemplateText: null }, rev), { ask: true });
  assert.deepEqual(pickTemplate({ text: "Other. Be brief.", lastTemplateText: "Other." }, rev), { ask: true });
  assert.deepEqual(pickTemplate({ text: "Review only. Be brief.", lastTemplateText: "Review only." }, rev), { ask: true });
});
