// Tests for electron/renderer/message-text.js (what of a user message is shown and searchable).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const MessageText = require("../renderer/message-text.js");
const MessageQueue = require("../renderer/message-queue.js");
const { relayBody, searchableUserText, shownUserText } = MessageText;

test("relayBody strips from and folder lines", () => {
  assert.equal(relayBody('[from api-1]\n[folder "/x"]\nhello'), "hello");
  assert.equal(relayBody("[from api-1]\nhello"), "hello");
  assert.equal(relayBody("plain [from x]"), "plain [from x]");
});

test("searchableUserText of a queued relay message", () => {
  assert.equal(searchableUserText(MessageQueue.wrap("[from a]\nhi")), "hi");
  assert.equal(searchableUserText(MessageQueue.CONTINUE_PROMPT), MessageQueue.CONTINUE_LABEL);
});

test("shownUserText keeps the relay header", () => {
  assert.equal(shownUserText(MessageQueue.wrap("[from a]\nhi")), "[from a]\nhi");
  assert.equal(shownUserText("plain"), "plain");
});

test("shown and searchable text drop the reply fallback's note", async () => {
  const { fallbackNote } = await import("../relay-tools.mjs");
  const raw = `[from p]\nthe task\n\n${fallbackNote({ toName: "p", kind: "report" })}`;
  assert.equal(shownUserText(raw), "[from p]\nthe task");
  assert.equal(searchableUserText(raw), "the task");
});

test("the renderer scripts share one global scope without clashing", async () => {
  const fs = await import("node:fs");
  const vm = await import("node:vm");
  const dir = new URL("../renderer/", import.meta.url);
  const ctx = vm.createContext({});
  ctx.globalThis = ctx;
  const load = (f) => vm.runInContext(fs.readFileSync(new URL(f, dir), "utf8"), ctx, { filename: f });
  load("file-links.js");
  load("message-queue.js");
  const before = new Set(Object.keys(ctx));
  load("message-text.js");
  load("find-text.js");
  load("find-bar.js");
  // the new scripts leak only their own global
  assert.deepEqual(Object.keys(ctx).filter((k) => !before.has(k)).sort(), ["FindBar", "FindText", "MessageText"]);
  // what app.js declares at top level must not clash with them
  vm.runInContext("const shownUserText = (raw) => MessageText.shownUserText(raw);", ctx);
});
