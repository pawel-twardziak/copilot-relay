// Tests for the pure rules of held child replies in electron/renderer/held-replies.js (wait note, sidebar count, titles, switch).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const HeldReplies = createRequire(import.meta.url)("../renderer/held-replies.js");

const { shouldHold, showSwitch, approvedPrompt, sidebarCount, kindOf, listTitle, switchLabel, discardLine, markTitle, comeBackLine } = HeldReplies;

test("kinds and their order", () => {
  assert.deepEqual(HeldReplies.KINDS, ["parent", "other", "user", "child"]);
  assert.deepEqual(HeldReplies.SWITCH_KINDS, ["child", "parent", "other", "user"]);
});

test("kindOf", () => {
  assert.equal(kindOf({ fromChild: true }), "child");
  assert.equal(kindOf({ fromChild: true, heldAs: "user" }), "child");
  for (const k of ["parent", "other", "user"]) assert.equal(kindOf({ heldAs: k }), k);
  assert.equal(kindOf({ heldAs: "nonsense" }), null);
  assert.equal(kindOf({ fromChild: false }), null);
  assert.equal(kindOf({}), null);
});

test("shouldHold: child, parent and other need the switch and a delivery id", () => {
  for (const kind of ["child", "parent", "other"]) {
    assert.equal(shouldHold({ kind, on: true, deliveryId: "d", prompting: false, cameBack: false }), true);
    assert.equal(shouldHold({ kind, on: false, deliveryId: "d", prompting: true, cameBack: true }), false);
    assert.equal(shouldHold({ kind, on: true, deliveryId: undefined, prompting: true, cameBack: false }), false);
  }
});

test("shouldHold: a user message is held during a turn or when it comes back", () => {
  const base = { kind: "user", on: true, deliveryId: "d" };
  assert.equal(shouldHold({ ...base, prompting: false, cameBack: false }), false);
  assert.equal(shouldHold({ ...base, prompting: true, cameBack: false }), true);
  assert.equal(shouldHold({ ...base, prompting: false, cameBack: true }), true);
  assert.equal(shouldHold({ ...base, on: false, prompting: true, cameBack: true }), false);
});

test("shouldHold: a message without a kind is never held", () => {
  assert.equal(shouldHold({ kind: null, on: true, deliveryId: "d", prompting: true, cameBack: true }), false);
});

test("showSwitch per kind", () => {
  const none = { hasChildren: false, hasParent: false, onRelay: false, held: 0 };
  assert.equal(showSwitch({ ...none, kind: "user" }), true);
  assert.equal(showSwitch({ ...none, kind: "child" }), false);
  assert.equal(showSwitch({ ...none, kind: "child", hasChildren: true }), true);
  assert.equal(showSwitch({ ...none, kind: "parent" }), false);
  assert.equal(showSwitch({ ...none, kind: "parent", hasParent: true }), true);
  assert.equal(showSwitch({ ...none, kind: "other" }), false);
  assert.equal(showSwitch({ ...none, kind: "other", onRelay: true }), true);
  for (const kind of ["child", "parent", "other"]) assert.equal(showSwitch({ ...none, kind, held: 1 }), true);
});

test("approvedPrompt: the note depends on the kind", () => {
  const t = 5 * 60000;
  assert.equal(HeldReplies.WAIT_NOTE_MS, 60000);
  assert.equal(approvedPrompt("P", 0, 59999, "parent"), "P");
  assert.equal(approvedPrompt("P", 0, t, "parent"), "P\n\n(This message waited 5 min for your user's approval. The list of your relatives above may be out of date: call list_sessions for their current state.)");
  assert.equal(approvedPrompt("P", 0, t, "other"), "P\n\n(This message waited 5 min for your user's approval.)");
  assert.equal(approvedPrompt("P", 0, t, "user"), "P");
  assert.match(approvedPrompt("P", 0, t), /This reply waited 5 min/);
  assert.equal(
    approvedPrompt("P", 0, 60_000),
    "P\n\n(This reply waited 1 min for your user's approval. The list of your children above may be out of date: call list_sessions for their current state.)",
  );
  assert.match(approvedPrompt("P", 0, 7 * 60_000 + 59_000, "other"), /waited 7 min/);
});

test("sidebarCount: the view, else the broker's counts by kind, else the old count", () => {
  assert.equal(sidebarCount({ view: { held: [1, 2, 3] }, brokerByKind: {}, brokerHeld: {}, sessionId: "s" }), 3);
  assert.equal(sidebarCount({ view: null, brokerByKind: { "cli:s": { child: 1, parent: 2, other: 1 } }, brokerHeld: { "cli:s": 1 }, sessionId: "s" }), 4);
  assert.equal(sidebarCount({ view: null, brokerByKind: {}, brokerHeld: { "cli:s": 2 }, sessionId: "s" }), 2);
  assert.equal(sidebarCount({ view: null, brokerByKind: undefined, brokerHeld: undefined, sessionId: "s" }), 0);
});

test("titles, labels and lines for every kind", () => {
  assert.equal(listTitle("parent", 2), "Orders from parent (2)");
  assert.equal(listTitle("other", 1), "Other sessions (1)");
  assert.equal(listTitle("user", 3), "Your messages (3)");
  assert.equal(listTitle("child", 3), "Replies from sub-sessions (3)");
  assert.equal(switchLabel("child"), "Sub-session replies");
  assert.equal(switchLabel("parent"), "Parent orders");
  assert.equal(switchLabel("other"), "Other sessions");
  assert.equal(switchLabel("user"), "My messages while busy");
  assert.equal(discardLine("child", "x"), "Discarded a reply from x.");
  assert.equal(discardLine("parent", "x"), "Discarded an order from x.");
  assert.equal(discardLine("other", "x"), "Discarded a message from x.");
  assert.equal(discardLine("user", "x"), "Discarded your message.");
  assert.equal(markTitle(1), "1 message waits for your approval");
  assert.equal(markTitle(3), "3 messages wait for your approval");
  assert.equal(comeBackLine(1), "1 held message will come back when the session is open again.");
  assert.equal(comeBackLine(2), "2 held messages will come back when the session is open again.");
});

test("insertByArrival orders by arrivedAt and is stable for equal times", () => {
  const list = [];
  for (const [id, arrivedAt] of [["b", 20], ["c", 30], ["a", 10], ["b2", 20]]) HeldReplies.insertByArrival(list, { id, arrivedAt });
  assert.deepEqual(list.map((x) => x.id), ["a", "b", "b2", "c"]);
});
