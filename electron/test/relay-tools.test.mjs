// Detection of sessions that cannot call the relay tools, and the fallback note.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentRelayTools,
  fallbackNote,
  isRelayCall,
  neededTool,
  NOTE_MARK,
  RELAY_TOOLS,
  stripNote,
} from "../relay-tools.mjs";

const both = { report_result: true, send_message: true };
const none = { report_result: false, send_message: false };
const selected = (agentName, tools) => ({ type: "subagent.selected", data: { agentName, tools } });

test("default agent has both", () => {
  assert.deepEqual(RELAY_TOOLS, ["report_result", "send_message"]);
  assert.deepEqual(agentRelayTools("", []), both);
  assert.deepEqual(agentRelayTools(undefined, []), both);
});

test("limited from subagent.selected", () => {
  assert.deepEqual(agentRelayTools("limited", [selected("limited", ["read"])]), none);
});

test("relay/* and *", () => {
  assert.deepEqual(agentRelayTools("limited", [selected("limited", ["read", "relay/*"])]), both);
  assert.deepEqual(agentRelayTools("limited", [selected("limited", ["*"])]), both);
  assert.deepEqual(agentRelayTools("limited", [selected("limited", ["relay/report_result"])]), {
    report_result: true,
    send_message: false,
  });
  assert.equal(agentRelayTools("limited", [selected("limited", ["relay-send_message"])]).send_message, true);
});

test("last selected of that agent wins", () => {
  const events = [selected("limited", ["read"]), selected("other", ["read"]), selected("limited", ["relay/*"])];
  assert.deepEqual(agentRelayTools("limited", events), both);
});

test("baseline fallback", () => {
  const baseline = (name) => ({
    type: "session.tool_baseline",
    data: { surface: "responses:capi:none:agent=limited", tools: [{ name, deferred: false }] },
  });
  assert.deepEqual(agentRelayTools("limited", [baseline("view")]), none);
  assert.equal(agentRelayTools("limited", [baseline("relay_send_message")]).send_message, true);
  assert.equal(agentRelayTools("limited", [baseline("relay_send_message")]).report_result, false);
});

test("a missing tools list means all tools", () => {
  assert.deepEqual(agentRelayTools("limited", [selected("limited", undefined)]), both);
  const baseline = { type: "session.tool_baseline", data: { surface: "x:agent=limited" } };
  assert.deepEqual(agentRelayTools("limited", [baseline]), both);
});

test("switch back to default", () => {
  const events = [selected("limited", ["read"]), { type: "subagent.deselected", data: {} }];
  assert.deepEqual(agentRelayTools("", events), both);
});

test("unknown agent", () => {
  assert.deepEqual(agentRelayTools("x", []), both);
});

test("isRelayCall", () => {
  assert.equal(isRelayCall("relay-report_result", "report_result"), true);
  assert.equal(isRelayCall("relay_report_result", "report_result"), true);
  assert.equal(isRelayCall("report_result", "report_result"), false);
  assert.equal(isRelayCall("relay-send_message", "report_result"), false);
  assert.equal(isRelayCall(undefined, "report_result"), false);
});

test("neededTool", () => {
  assert.equal(neededTool({ origin: { kind: "owner" }, parentKey: "cli:p", reported: false }), "report_result");
  assert.equal(neededTool({ origin: { kind: "owner" }, parentKey: "cli:p", reported: true }), null);
  assert.equal(neededTool({ origin: { kind: "owner" }, parentKey: null, reported: false }), null);
  assert.equal(
    neededTool({ origin: { kind: "relay", fromKey: "cli:p" }, parentKey: "cli:p", reported: false }),
    "report_result",
  );
  assert.equal(
    neededTool({ origin: { kind: "relay", fromKey: "cli:p" }, parentKey: "cli:p", reported: true }),
    "send_message",
  );
  assert.equal(
    neededTool({ origin: { kind: "relay", fromKey: "cli:o" }, parentKey: "cli:p", reported: false }),
    "send_message",
  );
  assert.equal(neededTool({ origin: { kind: "relay" }, parentKey: "cli:p", reported: false }), null);
  assert.equal(neededTool({ origin: null, parentKey: "cli:p", reported: false }), null);
});

test("note and strip", () => {
  const note = fallbackNote({ toName: "p", kind: "report" });
  assert.ok(note.startsWith(`${NOTE_MARK}\n`));
  assert.ok(note.includes('"p" as your report'));
  assert.ok(!note.includes("as your reply"));
  assert.ok(fallbackNote({ toName: "p", kind: "message" }).includes('"p" as your reply'));
  assert.equal(stripNote(`hi\n\n${note}`), "hi");
  assert.equal(stripNote("hi there"), "hi there");
});
