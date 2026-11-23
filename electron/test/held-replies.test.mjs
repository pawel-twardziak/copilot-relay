// Tests for the pure rules of held child replies in electron/renderer/held-replies.js (wait note, sidebar count, titles, switch).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const HeldReplies = createRequire(import.meta.url)("../renderer/held-replies.js");

test("approvedPrompt adds the wait note from one minute on", () => {
  assert.equal(HeldReplies.WAIT_NOTE_MS, 60000);
  assert.equal(HeldReplies.approvedPrompt("P", 0, 59_999), "P");
  assert.equal(
    HeldReplies.approvedPrompt("P", 0, 60_000),
    "P\n\n(This reply waited 1 min for your user's approval. The list of your children above may be out of date: call list_sessions for their current state.)",
  );
  assert.match(HeldReplies.approvedPrompt("P", 0, 7 * 60_000 + 59_000), /waited 7 min/);
});

test("sidebarCount uses the view when there is one, else the broker's count", () => {
  assert.equal(HeldReplies.sidebarCount({ view: { held: [1, 2] }, brokerHeld: { "cli:a": 5 }, sessionId: "a" }), 2);
  assert.equal(HeldReplies.sidebarCount({ view: null, brokerHeld: { "cli:a": 5 }, sessionId: "a" }), 5);
  assert.equal(HeldReplies.sidebarCount({ view: null, brokerHeld: undefined, sessionId: "a" }), 0);
});

test("titles and the switch rule", () => {
  assert.equal(HeldReplies.markTitle(1), "1 reply from sub-sessions waits for your approval");
  assert.equal(HeldReplies.markTitle(3), "3 replies from sub-sessions wait for your approval");
  assert.equal(HeldReplies.listTitle(3), "Replies from sub-sessions (3)");
  assert.equal(HeldReplies.showSwitch({ hasChildren: false, held: 0 }), false);
  assert.equal(HeldReplies.showSwitch({ hasChildren: false, held: 1 }), true);
  assert.equal(HeldReplies.showSwitch({ hasChildren: true, held: 0 }), true);
});

test("comeBackLine has a singular form", () => {
  assert.equal(HeldReplies.comeBackLine(1), "1 reply from sub-sessions will come back when the session is open again.");
  assert.equal(HeldReplies.comeBackLine(2), "2 replies from sub-sessions will come back when the session is open again.");
});
