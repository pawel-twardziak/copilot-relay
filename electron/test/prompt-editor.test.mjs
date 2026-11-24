// Tests for the pure part of electron/renderer/prompt-editor.js: what picking a template does to the own part.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const { pickTemplate, createPromptEditor, commandHint, WINDOWS_QUOTES } = createRequire(import.meta.url)("../renderer/prompt-editor.js");

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

// A DOM-less stand-in for the app's h: just enough element (attributes as properties, children, class lookup) for
// createPromptEditor to build and the tests to read back.
class FakeEl {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.className = "";
    this.value = "";
    this.hidden = false;
    this.textContent = "";
  }
  setAttribute(k, v) {
    if (k === "maxlength") this.maxLength = Number(v);
    else this[k] = v;
  }
  addEventListener() {}
  append(...kids) {
    this.children.push(...kids);
  }
  focus() {}
  querySelector(sel) {
    const cls = sel.slice(1);
    for (const c of this.children) {
      if (!(c instanceof FakeEl)) continue;
      if (c.className.split(" ").includes(cls)) return c;
      const found = c.querySelector(sel);
      if (found) return found;
    }
    return null;
  }
}
function h(tag, attrs = {}, ...kids) {
  const el = new FakeEl(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c);
  return el;
}
const base = { defaultPart: "", childPart: null, templates: [], own: "", h };

test("the command field shows the stored command and the Settings one as placeholder", () => {
  const e = createPromptEditor({ ...base, command: { value: "cop --x", settings: "copilot" } });
  const input = e.el.querySelector(".pe-command");
  assert.equal(input.value, "cop --x");
  assert.equal(input.placeholder, "Settings: copilot");
  assert.equal(input.maxLength, 4000);
  assert.equal(e.command(), "cop --x");
});

test("the command field's hint names the Windows quoting rule only on Windows", () => {
  // the fake element keeps text children as strings
  const hintOf = (platform) => createPromptEditor({ ...base, command: { value: "", settings: "copilot", platform } }).el.querySelector(".pe-command-row").querySelector(".hint").children.join("");
  assert.equal(hintOf("linux"), "Empty: the command from Settings. May carry arguments; the app adds --acp --stdio at the end.");
  assert.equal(hintOf(undefined), hintOf("linux"));
  assert.equal(hintOf("win32"), 'Empty: the command from Settings. May carry arguments; the app adds --acp --stdio at the end. On Windows only double quotes ("…") group an argument.');
  assert.equal(commandHint("win32"), hintOf("win32"));
  assert.equal(WINDOWS_QUOTES, 'On Windows only double quotes ("…") group an argument.');
});

test("without command there is no field", () => {
  const e = createPromptEditor(base);
  assert.equal(e.el.querySelector(".pe-command"), null);
  assert.equal(e.command(), "");
});
