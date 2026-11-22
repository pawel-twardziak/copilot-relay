// Tests for the pure helpers of the Settings "Relay broker" section in electron/renderer/broker-restart.js.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const { restartQuestion, stepRow } = createRequire(import.meta.url)("../renderer/broker-restart.js");

test("restartQuestion", () => {
  assert.equal(restartQuestion({ working: 0, acpSessions: 0 }), null);
  assert.equal(restartQuestion({ working: 1, acpSessions: 0 }),
    "1 session is working; its relay tools will not answer for a few seconds. Restart the broker now?");
  assert.equal(restartQuestion({ working: 3, acpSessions: 2 }),
    "3 sessions are working; their relay tools will not answer for a few seconds. 2 sessions started from the broker's web page will end. Restart the broker now?");
  assert.equal(restartQuestion({ working: 0, acpSessions: 1 }),
    "1 session started from the broker's web page will end. Restart the broker now?");
});

test("stepRow", () => {
  assert.deepEqual(stepRow({ label: "Update", status: "done", detail: "abc1234 → def5678" }), { mark: "✓", text: "Update: abc1234 → def5678", cls: "done" });
  assert.deepEqual(stepRow({ label: "Start", status: "pending", detail: "" }), { mark: "○", text: "Start", cls: "pending" });
  assert.deepEqual(stepRow({ label: "Reconnect", status: "done", detail: "1 of 3 sessions reconnected", warning: true }), { mark: "!", text: "Reconnect: 1 of 3 sessions reconnected", cls: "warning" });
  assert.deepEqual(stepRow({ label: "Stop", status: "running", detail: "" }), { mark: "…", text: "Stop", cls: "running" });
  assert.deepEqual(stepRow({ label: "Check", status: "failed", detail: "Not a copilot-relay folder: /x" }), { mark: "✗", text: "Check: Not a copilot-relay folder: /x", cls: "failed" });
  assert.deepEqual(stepRow({ label: "Install", status: "skipped", detail: "" }), { mark: "–", text: "Install", cls: "skipped" });
});
