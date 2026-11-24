// Tests for electron/renderer/folder-row.js: the folder shown with a "Change…" button.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const { createFolderRow, CHANGE } = createRequire(import.meta.url)("../renderer/folder-row.js");

// A DOM-less stand-in for the app's h: attributes as properties, children, class lookup, click handlers.
class FakeEl {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.className = "";
    this.textContent = "";
    this.disabled = false;
    this.title = "";
    this.handlers = {};
  }
  setAttribute(k, v) {
    this[k] = v;
  }
  addEventListener(type, fn) {
    this.handlers[type] = fn;
  }
  append(...kids) {
    for (const k of kids) {
      if (typeof k === "string") this.textContent += k;
      else this.children.push(k);
    }
  }
  click() {
    return this.handlers.click?.();
  }
  querySelector(sel) {
    const cls = sel.slice(1);
    for (const c of this.children) {
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
const parts = (row) => [row.el.querySelector(".folder-path"), row.el.querySelector(".folder-change")];

test("the row shows the start folder and a Change… button", () => {
  const row = createFolderRow({ value: "/a", pick: async () => null, h });
  const [path, button] = parts(row);
  assert.equal(row.el.className, "folder-row");
  assert.equal(row.value(), "/a");
  assert.equal(path.textContent, "/a");
  assert.equal(path.title, "/a");
  assert.equal(button.textContent, CHANGE);
  assert.equal(CHANGE, "Change…");
  assert.equal(row.el._row, row);
});

test("a picked folder replaces the value, null keeps it, and pick gets the current one", async () => {
  const seen = [];
  const answers = ["/b", null];
  const row = createFolderRow({ value: "/a", pick: async (cur) => (seen.push(cur), answers.shift()), h });
  const [path, button] = parts(row);
  await button.click();
  assert.equal(row.value(), "/b");
  assert.equal(path.textContent, "/b");
  assert.equal(path.title, "/b");
  await button.click();
  assert.equal(row.value(), "/b");
  assert.deepEqual(seen, ["/a", "/b"]);
});

test("set changes the value and the text", () => {
  const row = createFolderRow({ value: "/a", pick: async () => null, h });
  row.set("/c");
  assert.equal(row.value(), "/c");
  assert.equal(parts(row)[0].textContent, "/c");
});

test("setDisabled disables the button", () => {
  const row = createFolderRow({ value: "/a", pick: async () => null, h });
  row.setDisabled(true);
  assert.equal(parts(row)[1].disabled, true);
  row.setDisabled(false);
  assert.equal(parts(row)[1].disabled, false);
});

test("a click while a pick runs does not start a second one", async () => {
  let calls = 0;
  let done;
  const row = createFolderRow({ value: "/a", pick: () => (calls++, new Promise((r) => (done = r))), h });
  const button = parts(row)[1];
  const first = button.click();
  button.click();
  assert.equal(calls, 1);
  done("/b");
  await first;
  assert.equal(row.value(), "/b");
  parts(row)[1].click();
  assert.equal(calls, 2, "a pick is possible again afterwards");
});

test("a pick that fails keeps the value, warns, and leaves the button usable", async (t) => {
  const warned = [];
  t.mock.method(console, "warn", (...a) => warned.push(a.join(" ")));
  let calls = 0;
  const row = createFolderRow({ value: "/a", pick: async () => (calls++, Promise.reject(new Error("no window"))), h });
  const button = parts(row)[1];
  await button.click(); // resolves: the failure does not escape the click handler
  assert.equal(row.value(), "/a");
  assert.equal(parts(row)[0].textContent, "/a");
  assert.equal(warned.length, 1);
  assert.match(warned[0], /no window/);
  await button.click();
  assert.equal(calls, 2, "a pick is possible again afterwards");
});
