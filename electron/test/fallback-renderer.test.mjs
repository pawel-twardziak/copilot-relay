// Tests for the window's side of the reply fallback in electron/renderer/fallback.js (note strip, card and system lines,
// the switch), and its parity with electron/relay-tools.mjs (the note main builds).
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
import { NOTE_MARK, fallbackNote } from "../relay-tools.mjs";

const require = createRequire(import.meta.url);
const Fallback = require("../renderer/fallback.js");
const MessageQueue = require("../renderer/message-queue.js");

const NAMES = ["p", "", 'say "hi"', "zażółć gęślą", "a\n\nb", `x\n\n${NOTE_MARK}\ny`];

test("NOTE_MARK equals the main side's", () => {
  assert.equal(Fallback.NOTE_MARK, NOTE_MARK);
});

test("strip removes the note main builds, for every name and kind", () => {
  for (const toName of NAMES) {
    for (const kind of ["report", "message"]) {
      const note = fallbackNote({ toName, kind });
      assert.equal(Fallback.stripNote(`hi\n\n${note}`), "hi", `${kind} to ${JSON.stringify(toName)}`);
      assert.equal(Fallback.stripNote(`notes\n\nhi\n\n${note}`), "notes\n\nhi");
    }
  }
});

test("strip keeps unwrap", () => {
  const note = fallbackNote({ toName: "p", kind: "report" });
  for (const more of [false, true]) {
    const inner = MessageQueue.unwrap(MessageQueue.wrap(`hi\n\n${note}`, { more }));
    assert.equal(Fallback.stripNote(inner), "hi");
  }
});

test("strip leaves a text without a whole trailing note unchanged", () => {
  const note = fallbackNote({ toName: "p", kind: "report" });
  for (const text of [
    "hi there",
    "",
    `hi\n\n${NOTE_MARK}`, // the marker alone
    `hi\n\n${NOTE_MARK}\nsomething else`, // the marker, then not the note
    `hi\n\n${NOTE_MARK} and more`,
    `hi\n\n${note}\n\nmore text after it`, // not trailing
    `hi\n\n${note}.`, // not the whole note at the end
    `hi\n${note}`, // not its own block
    note, // nothing in front of it: never sent so (the note always follows text)
  ]) {
    assert.equal(Fallback.stripNote(text), text, JSON.stringify(text));
  }
});

test("strip takes only the trailing note when the text quotes the marker", () => {
  const note = fallbackNote({ toName: "p", kind: "message" });
  const text = `quote:\n\n${NOTE_MARK}\nnot a note`;
  assert.equal(Fallback.stripNote(`${text}\n\n${note}`), text);
});

test("cardText asks for a report or a message", () => {
  assert.equal(Fallback.cardText({ toName: "parent", kind: "report" }), 'This session has no relay tools. Send this reply to "parent" as its report?');
  assert.equal(Fallback.cardText({ toName: "other", kind: "message" }), 'This session has no relay tools. Send this reply to "other" as a message?');
});

test("sentLine says where it went and the broker's answer", () => {
  assert.equal(Fallback.sentLine({ toName: "parent", kind: "report", result: "Report delivered to your parent session." }), 'Sent this reply to "parent" as its report (no relay tools). Relay: Report delivered to your parent session.');
  assert.equal(Fallback.sentLine({ toName: "o", kind: "message" }), 'Sent this reply to "o" as a message (no relay tools).');
  assert.equal(Fallback.droppedLine({ toName: "o" }), 'Did not send this reply to "o".');
  assert.equal(Fallback.OLD_BROKER, "The relay broker is too old for this. Update it in Settings → Relay.");
  assert.equal(Fallback.notSentLine("connection refused"), "Not sent: connection refused");
});

test("showSwitch: only when the session cannot answer or has a pending forward", () => {
  assert.equal(Fallback.showSwitch({ cannotAnswer: false, pending: 0 }), false);
  assert.equal(Fallback.showSwitch({}), false);
  assert.equal(Fallback.showSwitch({ cannotAnswer: true, pending: 0 }), true);
  assert.equal(Fallback.showSwitch({ cannotAnswer: false, pending: 1 }), true);
  assert.equal(Fallback.showSwitch({ cannotAnswer: true, pending: 2 }), true);
});

test("fallback.js loads beside the other window scripts (one global scope)", () => {
  // classic scripts share their top-level names: a clash is a SyntaxError that leaves Fallback undefined in the window
  const dir = new URL("../renderer/", import.meta.url);
  const html = fs.readFileSync(new URL("index.html", dir), "utf8");
  const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]).filter((s) => !s.startsWith("..") && s !== "app.js");
  assert.ok(srcs.includes("fallback.js"));
  const ctx = vm.createContext({});
  for (const src of srcs) {
    try {
      vm.runInContext(fs.readFileSync(new URL(src, dir), "utf8"), ctx, { filename: src });
    } catch (e) {
      if (e?.name !== "ReferenceError") throw e; // a DOM global a script reads at load (no window here)
    }
  }
  assert.equal(typeof vm.runInContext("Fallback.stripNote", ctx), "function");
});

const X = { kind: "relay", fromKey: "cli:x", from: "x" };
const xOrigin = { kind: "relay", fromKey: "cli:x", fromName: "x" };
const meta = (over) => Fallback.promptMeta({ fbSeq: null, midTurn: false, isContinue: false, isCmd: false, answer: false, item: null, source: "relay", customAgent: true, newId: () => "n1", ...over });

test("promptMeta: a chain's first prompt starts it and asks for the note", () => {
  assert.deepEqual(meta({ item: X }), { meta: { seq: "n1", first: true, origin: xOrigin }, asksNote: true, starts: true, fbSeq: { id: "n1", origin: xOrigin } });
  // an owner turn typed in the app
  assert.deepEqual(meta({ source: "app" }).meta, { seq: "n1", first: true, origin: { kind: "owner" } });
  // a running chain is replaced (the caller ends it first)
  assert.equal(meta({ item: X, fbSeq: { id: "old", origin: xOrigin } }).fbSeq.id, "n1");
});

test("promptMeta: the default agent never asks for the note (its prompt goes out as before)", () => {
  const r = meta({ item: X, customAgent: false });
  assert.equal(r.asksNote, false);
  assert.deepEqual(r.meta, { seq: "n1", first: true, origin: xOrigin });
});

test("promptMeta: later prompts of a chain carry its id, no note, no new chain", () => {
  const fbSeq = { id: "c1", origin: xOrigin };
  const later = { meta: { seq: "c1", first: false, origin: xOrigin }, asksNote: false, starts: false, fbSeq };
  assert.deepEqual(meta({ fbSeq, midTurn: true, answer: true, item: { kind: "relay", fromKey: "cli:y", from: "y" } }), later); // mid-turn
  assert.deepEqual(meta({ fbSeq, midTurn: true, answer: true, item: { kind: "relay", from: "relay" } }), later); // mid-turn, no origin
  assert.deepEqual(meta({ fbSeq, answer: true, item: { kind: "relay", fromKey: "cli:z", from: "z" } }), later); // pumped answer
  assert.deepEqual(meta({ fbSeq, isContinue: true }), later); // the continue prompt
  assert.deepEqual(meta({ fbSeq, answer: true, isCmd: true, source: "app" }), later); // a command answered in the follow-up
});

test("promptMeta: outside a chain a follow-up prompt has no meta and starts none", () => {
  const none = { meta: null, asksNote: false, starts: false, fbSeq: null };
  assert.deepEqual(meta({ midTurn: true, answer: true, item: X }), none);
  assert.deepEqual(meta({ answer: true, item: X }), none); // pumped answer after a stopped chain
  assert.deepEqual(meta({ isContinue: true }), none);
});

test("promptMeta: a command or a sender-less message starts no chain", () => {
  const none = { meta: null, asksNote: false, starts: true, fbSeq: null };
  assert.deepEqual(meta({ isCmd: true, source: "app" }), none);
  assert.deepEqual(meta({ isCmd: true, item: X, fbSeq: { id: "c1", origin: xOrigin } }), none);
  assert.deepEqual(meta({ item: { kind: "relay", from: "relay" } }), none); // a broker notice
  assert.deepEqual(meta({ source: "human", item: { kind: "relay", from: "user" } }), none);
});

test("chainEnds: the chain stays open for the continue prompt and while answers are due", () => {
  assert.equal(Fallback.chainEnds({ afterTurn: "continue", answerDue: false, stopped: false, failed: false }), false);
  assert.equal(Fallback.chainEnds({ afterTurn: "pump", answerDue: true, stopped: false, failed: false }), false);
  assert.equal(Fallback.chainEnds({ afterTurn: "none", answerDue: true, stopped: false, failed: false }), false); // queue paused, task waits
  assert.equal(Fallback.chainEnds({ afterTurn: "none", answerDue: false, stopped: false, failed: false }), true);
  assert.equal(Fallback.chainEnds({ afterTurn: "none", answerDue: true, stopped: true, failed: false }), true); // Stop paused the queue
  assert.equal(Fallback.chainEnds({ afterTurn: "none", answerDue: false, stopped: false, failed: true }), true);
  assert.equal(Fallback.chainEnds({ afterTurn: "pump", answerDue: true, stopped: false, failed: true }), true);
});

test("customAgent: only a non-empty agent option value", () => {
  assert.equal(Fallback.customAgent(undefined), false);
  assert.equal(Fallback.customAgent(null), false);
  assert.equal(Fallback.customAgent({ id: "agent", currentValue: "" }), false);
  assert.equal(Fallback.customAgent({ id: "agent", currentValue: "limited" }), true);
});

test("originOf: a relay item with a sender key, an owner turn, else none", () => {
  assert.deepEqual(Fallback.originOf({ kind: "relay", fromKey: "cli:p", from: "parent" }, "relay"), { kind: "relay", fromKey: "cli:p", fromName: "parent" });
  assert.deepEqual(Fallback.originOf({ kind: "relay", fromKey: "cli:p" }, "relay"), { kind: "relay", fromKey: "cli:p", fromName: "" });
  assert.equal(Fallback.originOf({ kind: "relay", from: "relay" }, "relay"), null); // a broker notice: no key
  assert.equal(Fallback.originOf({ kind: "relay", fromKey: "" }, "relay"), null);
  assert.deepEqual(Fallback.originOf(null, "app"), { kind: "owner" });
  assert.deepEqual(Fallback.originOf({ kind: "app" }, "app"), { kind: "owner" });
  assert.equal(Fallback.originOf(null, "relay"), null);
  assert.equal(Fallback.originOf(null, "human"), null);
});
