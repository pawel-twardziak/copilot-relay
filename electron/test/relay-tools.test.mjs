// Detection of sessions that cannot call the relay tools, and the fallback note.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentIsLastSelected,
  agentRelayTools,
  agentSlug,
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

test("a later baseline of the agent beats an older subagent.selected", () => {
  const base = (names) => ({
    type: "session.tool_baseline",
    data: { surface: "responses:capi:none:agent=limited", tools: names.map((name) => ({ name, deferred: false })) },
  });
  // the agent file gained relay/* and the session was reloaded: no new subagent.selected, a new baseline
  assert.deepEqual(agentRelayTools("limited", [selected("limited", ["read"]), base(["view", "relay_report_result", "relay_send_message"])]), both);
  // the other order: the newer selected wins
  assert.deepEqual(agentRelayTools("limited", [base(["view", "relay_report_result", "relay_send_message"]), selected("limited", ["read"])]), none);
  // a baseline of another agent (written after switching to it) does not count
  const other = { type: "session.tool_baseline", data: { surface: "x:agent=other", tools: [{ name: "relay_send_message" }] } };
  assert.deepEqual(agentRelayTools("limited", [selected("limited", ["read"]), selected("other", ["*"]), other]), none);
  // nor a default-agent baseline (empty name), even with no switch recorded before it
  const plain = { type: "session.tool_baseline", data: { surface: "x:agent=", tools: [{ name: "relay_send_message" }] } };
  assert.deepEqual(agentRelayTools("limited", [selected("limited", ["read"]), plain]), none);
  // a later baseline without a tools list means all tools
  assert.deepEqual(agentRelayTools("limited", [selected("limited", ["read"]), { type: "session.tool_baseline", data: { surface: "x:agent=limited" } }]), both);
});

// A real session (Copilot 1.0.117): the agent's `name:` ("Poeta wspomnień") is the option value and subagent.selected's
// agentName, but the baseline's surface carries the file name ("poeta-wspomnien"). The agent file gained all tools and
// the session was resumed: a new baseline, no new subagent.selected.
const relayBase = (surfaceAgent, names) => ({
  type: "session.tool_baseline",
  data: { surface: `responses:capi:none:agent=${surfaceAgent}`, tools: names.map((name) => ({ name, deferred: false })) },
});
const POET = "Poeta wspomnień";

// Copilot 1.0.117 puts the agent's definition id (its file name, the baseline surface's name) on the envelope.
const selectedDef = (agentName, tools, def) => ({ __copilotSelectedAgentDefinitionId: def, ...selected(agentName, tools) });

test("with the definition id, a baseline counts only when its surface names it", () => {
  const sel = selectedDef(POET, ["edit"], "poeta-wspomnien");
  const relay = ["relay-report_result", "relay-send_message"];
  // the real session: gained all tools, resumed, a new baseline under the file name
  assert.deepEqual(agentRelayTools(POET, [sel, relayBase("poeta-wspomnien", ["view"]), relayBase("poeta-wspomnien", relay)]), both);
  // another agent's baseline after the selection, with no switch recorded: not this agent's
  assert.deepEqual(agentRelayTools(POET, [sel, relayBase("explore", relay)]), none);
  // a baseline without a surface: not this agent's
  assert.deepEqual(agentRelayTools(POET, [sel, { type: "session.tool_baseline", data: { tools: [{ name: "relay-send_message" }] } }]), none);
});

test("without the definition id (older CLIs), a baseline with no surface never counts by order", () => {
  const noSurface = { type: "session.tool_baseline", data: { tools: [{ name: "relay-send_message" }] } };
  assert.deepEqual(agentRelayTools(POET, [selected(POET, ["edit"]), noSurface]), none);
});

test("agentIsLastSelected", () => {
  const dese = { type: "subagent.deselected", data: {} };
  assert.equal(agentIsLastSelected(POET, [selected(POET, ["edit"])]), true);
  assert.equal(agentIsLastSelected(POET, [selected(POET, ["edit"]), dese]), false);
  assert.equal(agentIsLastSelected(POET, [selected(POET, ["edit"]), selected("x", [])]), false);
  assert.equal(agentIsLastSelected(POET, [selected(POET, ["edit"]), { ...selected("x", []), agentId: "t" }]), true);
  assert.equal(agentIsLastSelected(POET, []), false);
});

test("a baseline after the agent's own selection counts, whatever name its surface carries", () => {
  const events = [
    { type: "session.start", data: {} },
    selected(POET, ["edit"]),
    relayBase("poeta-wspomnien", ["view", "skill", "sql"]),
    { type: "session.shutdown", data: {} },
    { type: "session.resume", data: {} },
    relayBase("poeta-wspomnien", ["view", "relay-report_result", "relay-send_message"]),
  ];
  assert.deepEqual(agentRelayTools(POET, events), both);
  assert.deepEqual(agentRelayTools(POET, events.slice(0, 5)), none); // before the new baseline: still the old list
});

test("a baseline after another agent's selection does not count for this one", () => {
  const events = [
    selected(POET, ["edit"]),
    selected("Poeta sensu życia", ["*"]),
    relayBase("poeta-sensu-zycia", ["relay-report_result", "relay-send_message"]),
  ];
  assert.deepEqual(agentRelayTools(POET, events), none);
});

test("a sub-agent's events (agentId on the envelope) never count", () => {
  const sub = { ...relayBase("explore", ["relay-report_result", "relay-send_message"]), agentId: "task-1" };
  assert.deepEqual(agentRelayTools(POET, [selected(POET, ["edit"]), sub]), none);
  const subSel = { ...selected(POET, ["*"]), agentId: "task-1" };
  assert.deepEqual(agentRelayTools(POET, [selected(POET, ["edit"]), subSel]), none);
});

test("a name without Latin letters or digits matches no default-agent baseline", () => {
  const events = [
    selected("Поэт", ["edit"]),
    relayBase("poet", ["view"]),
    { type: "subagent.deselected", data: {} },
    relayBase("", ["relay-report_result", "relay-send_message"]),
  ];
  assert.deepEqual(agentRelayTools("Поэт", events), none);
  assert.equal(agentSlug("Поэт"), "");
});

test("after a switch back to the default, a later baseline is not the agent's", () => {
  const events = [selected(POET, ["edit"]), { type: "subagent.deselected", data: {} }, relayBase("other", ["relay-send_message"])];
  assert.deepEqual(agentRelayTools(POET, events), none);
});

test("a baseline is matched by the agent's name or by its file-style name", () => {
  assert.deepEqual(agentRelayTools(POET, [relayBase("poeta-wspomnien", ["view"])]), none);
  assert.deepEqual(agentRelayTools(POET, [relayBase("Poeta wspomnień", ["view"])]), none);
  assert.deepEqual(agentRelayTools("Poeta sensu życia", [relayBase("poeta-sensu-zycia", ["view"])]), none);
  assert.deepEqual(agentRelayTools("Łąka Ćma", [relayBase("laka-cma", ["view"])]), none);
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

test("strip takes only a whole trailing note", () => {
  const note = fallbackNote({ toName: "p", kind: "message" });
  for (const text of [`hi\n\n${NOTE_MARK}`, `hi\n\n${NOTE_MARK}\nsomething else`, `hi\n\n${note}\n\nmore`, `hi\n\n${note}.`, `hi\n${note}`]) {
    assert.equal(stripNote(text), text, JSON.stringify(text));
  }
  const quoted = `quote:\n\n${NOTE_MARK}\nnot a note`;
  assert.equal(stripNote(`${quoted}\n\n${note}`), quoted);
  const odd = fallbackNote({ toName: `x\n\n${NOTE_MARK}\ny`, kind: "report" }); // a name with the marker in it
  assert.equal(stripNote(`hi\n\n${odd}`), "hi");
});
