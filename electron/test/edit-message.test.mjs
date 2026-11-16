// Tests for the pure helpers behind editing a message (electron/renderer/edit-message.js).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const EM = createRequire(import.meta.url)("../renderer/edit-message.js");

test("isOwnMessage: your messages, not relay ones from other sessions", () => {
  assert.equal(EM.isOwnMessage({ relay: false, human: false, hidden: false, text: "hi" }), true);
  assert.equal(EM.isOwnMessage({ relay: true, human: false, hidden: false, text: "hi" }), false);
  assert.equal(EM.isOwnMessage({ relay: true, human: true, hidden: false, text: "hi" }), true);
  assert.equal(EM.isOwnMessage({ relay: false, human: false, hidden: true, text: "hi" }), false);
  assert.equal(EM.isOwnMessage({ relay: false, human: false, hidden: false, text: "  " }), false);
  assert.equal(EM.isOwnMessage({ relay: false, human: false, hidden: false, text: "[from relay]\nnote\n\nhi" }), false);
});

test("notesPrefix: the notes runPrompt put in front of your text", () => {
  assert.equal(EM.notesPrefix("hi", undefined), "");
  assert.equal(EM.notesPrefix("hi", "hi"), "");
  assert.equal(EM.notesPrefix("n1\n\nn2\n\nhi", "hi"), "n1\n\nn2");
  assert.equal(EM.notesPrefix("something else", "hi"), "");
});

test("editRefusal: commands can't replace a message", () => {
  const R = "Commands can't replace a message. Cancel the edit to run a command.";
  assert.equal(EM.editRefusal("/context", { agentAvailable: false }), R);
  assert.equal(EM.editRefusal("/rename x", { agentAvailable: false }), R);
  assert.equal(EM.editRefusal("/agent foo", { agentAvailable: true }), R);
  assert.equal(EM.editRefusal("  /agent foo", { agentAvailable: false }), R);
  assert.equal(EM.editRefusal("fix the bug", { agentAvailable: true }), null);
});

test("editBanner: singular and plural count", () => {
  assert.equal(
    EM.editBanner(1),
    "Editing a message. Sending replaces it and everything after it (1 message). Files changed by the agent are not reverted. Esc to cancel.",
  );
  assert.match(EM.editBanner(3), /\(3 messages\)/);
});
