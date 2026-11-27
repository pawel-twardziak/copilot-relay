// The reply fallback's chain state, its turn-end decision and the pending forwards (electron/fallback.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createChainState, createPending, decideForward, originOf } from "../fallback.mjs";

const chunk = (text, agentId) => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
  ...(agentId ? { _meta: { "github.com/copilot": { agentId } } } : {}),
});
const toolCall = (title, agentId) => ({
  sessionUpdate: "tool_call",
  toolCallId: `t-${title}`,
  title,
  ...(agentId ? { _meta: { "github.com/copilot": { agentId } } } : {}),
});

const PARENT = "cli:parent";
const fromParent = { kind: "relay", fromKey: PARENT, fromName: "boss" };
const fromOther = { kind: "relay", fromKey: "cli:other", fromName: "peer" };
const owner = { kind: "owner" };
const none = { report_result: false, send_message: false };
const both = { report_result: true, send_message: true };
const snap = (over = {}) => ({ seq: "s1", origin: fromParent, text: "the result", titles: [], lastStop: "end_turn", ...over });

test("chain keeps the text after the last top-level tool call and records titles", () => {
  const c = createChainState();
  c.start({ seq: "s1", origin: fromParent });
  c.prompt();
  c.update(chunk("looking"));
  c.update(toolCall("view"));
  c.update(chunk("Done: "));
  c.update(chunk("all good."));
  c.stopped("end_turn");
  assert.deepEqual(c.snapshot(), { seq: "s1", origin: fromParent, text: "Done: all good.", titles: ["view"], lastStop: "end_turn", reported: false });
});

test("a subagent's chunk and tool call are ignored", () => {
  const c = createChainState();
  c.start({ seq: "s1", origin: fromParent });
  c.prompt();
  c.update(chunk("top"));
  c.update(chunk("sub text", "agent-1"));
  c.update(toolCall("relay-report_result", "agent-1"));
  assert.equal(c.snapshot().text, "top");
  assert.deepEqual(c.snapshot().titles, []);
});

test("the abort marker is ignored", () => {
  const c = createChainState();
  c.start({ seq: "s1", origin: fromParent });
  c.prompt();
  c.update(chunk("partial"));
  c.update(chunk("Info: Operation cancelled by user"));
  assert.equal(c.snapshot().text, "partial");
});

test("start resets the chain; a new prompt starts a new last message, titles stay", () => {
  const c = createChainState();
  c.start({ seq: "s1", origin: fromParent });
  c.prompt();
  c.update(toolCall("relay-report_result"));
  c.update(chunk("first"));
  c.prompt();
  assert.equal(c.snapshot().text, "");
  assert.deepEqual(c.snapshot().titles, ["relay-report_result"]);
  c.start({ seq: "s2", origin: owner, reported: true });
  assert.deepEqual(c.snapshot(), { seq: "s2", origin: owner, text: "", titles: [], lastStop: null, reported: true });
});

test("stopped records the stop of the most recently started prompt only", () => {
  const c = createChainState();
  c.start({ seq: "s1", origin: fromParent });
  const first = c.prompt();
  const mid = c.prompt(); // delivered while the first still runs
  c.stopped("end_turn", mid);
  c.stopped("cancelled", first); // the interrupted prompt returns after the mid-turn one started
  assert.equal(c.snapshot().lastStop, "end_turn");
});

test("decideForward: each condition false once", () => {
  const base = { tools: none, parentKey: PARENT, reported: false };
  assert.equal(decideForward({ ...base, snapshot: snap({ lastStop: "cancelled" }) }), null);
  assert.equal(decideForward({ ...base, snapshot: snap({ lastStop: "failed" }) }), null);
  assert.equal(decideForward({ ...base, snapshot: snap({ lastStop: null }) }), null);
  assert.equal(decideForward({ ...base, tools: both, snapshot: snap() }), null);
  assert.equal(decideForward({ ...base, tools: { report_result: true, send_message: false }, snapshot: snap() }), null);
  assert.equal(decideForward({ ...base, snapshot: snap({ titles: ["view", "relay-report_result"] }) }), null);
  assert.equal(decideForward({ ...base, snapshot: snap({ titles: ["relay_report_result"] }) }), null);
  assert.equal(decideForward({ ...base, snapshot: snap({ text: "" }) }), null);
  assert.equal(decideForward({ ...base, snapshot: snap({ text: "  \n " }) }), null);
  assert.equal(decideForward({ ...base, snapshot: snap({ origin: null }) }), null);
  assert.equal(decideForward({ ...base, reported: true, snapshot: snap({ origin: owner }) }), null);
  assert.equal(decideForward({ ...base, parentKey: null, snapshot: snap({ origin: owner }) }), null);
});

test("decideForward: the positive cases", () => {
  const base = { tools: none, parentKey: PARENT, reported: false };
  assert.deepEqual(decideForward({ ...base, snapshot: snap() }), { toKey: PARENT, kind: "report" });
  assert.deepEqual(decideForward({ ...base, reported: true, snapshot: snap() }), { toKey: PARENT, kind: "message" });
  assert.deepEqual(decideForward({ ...base, snapshot: snap({ origin: fromOther }) }), { toKey: "cli:other", kind: "message" });
  assert.deepEqual(decideForward({ ...base, snapshot: snap({ origin: owner }) }), { toKey: PARENT, kind: "report" });
  // a relay call of the other tool is no double send of this one
  assert.deepEqual(decideForward({ ...base, snapshot: snap({ titles: ["relay-send_message"] }) }), { toKey: PARENT, kind: "report" });
});

test("chain with a mid-turn delivery forwards once", () => {
  const c = createChainState();
  c.start({ seq: "s1", origin: fromParent });
  c.prompt();
  c.update(chunk("working on it"));
  c.stopped("cancelled"); // interrupted by the mid-turn delivery
  c.prompt(); // the mid-turn message
  c.update(chunk("noted"));
  c.stopped("end_turn");
  c.prompt(); // the continue prompt
  c.update(toolCall("view"));
  c.update(chunk("Final report."));
  c.stopped("end_turn");
  const forwards = [decideForward({ snapshot: c.snapshot(), tools: none, parentKey: PARENT, reported: false })].filter(Boolean);
  assert.deepEqual(forwards, [{ toKey: PARENT, kind: "report" }]);
});

test("a chain whose last prompt is cancelled forwards nothing", () => {
  const c = createChainState();
  c.start({ seq: "s1", origin: fromParent });
  c.prompt();
  c.update(chunk("half"));
  c.stopped("cancelled");
  assert.equal(decideForward({ snapshot: c.snapshot(), tools: none, parentKey: PARENT, reported: false }), null);
});

test("agent changed before the continue: the tools read at the end decide", () => {
  const c = createChainState();
  c.start({ seq: "s1", origin: fromParent });
  c.prompt(); // the agent had the relay tools here
  c.update(chunk("first part"));
  c.stopped("end_turn");
  c.prompt(); // continue, after a switch to an agent without them
  c.update(chunk("the answer"));
  c.stopped("end_turn");
  assert.deepEqual(decideForward({ snapshot: c.snapshot(), tools: none, parentKey: PARENT, reported: false }), { toKey: PARENT, kind: "report" });
  assert.equal(decideForward({ snapshot: c.snapshot(), tools: both, parentKey: PARENT, reported: false }), null);
});

test("originOf keeps a relay origin with a key and the owner, nothing else", () => {
  assert.deepEqual(originOf({ kind: "relay", fromKey: "cli:a", fromName: "a", extra: 1 }), { kind: "relay", fromKey: "cli:a", fromName: "a" });
  assert.deepEqual(originOf({ kind: "relay", fromKey: "cli:a" }), { kind: "relay", fromKey: "cli:a", fromName: "" });
  assert.deepEqual(originOf({ kind: "owner" }), { kind: "owner" });
  assert.equal(originOf({ kind: "relay", fromName: "relay" }), null); // a broker notice has no key
  assert.equal(originOf({ kind: "relay", fromKey: "" }), null);
  assert.equal(originOf(null), null);
  assert.equal(originOf("x"), null);
});

test("pending: add, take, list, drop", () => {
  const p = createPending();
  const a = p.add("s", { toKey: "cli:p", toName: "boss", kind: "report", text: "one" });
  const b = p.add("s", { toKey: "cli:p", toName: "boss", kind: "message", text: "two" });
  p.add("t", { toKey: "cli:x", toName: "x", kind: "message", text: "other session" });
  assert.notEqual(a, b);
  assert.deepEqual(p.list("s").map((f) => [f.id, f.text]), [[a, "one"], [b, "two"]]);
  assert.deepEqual(p.take("s", a), { id: a, toKey: "cli:p", toName: "boss", kind: "report", text: "one" });
  assert.equal(p.take("s", a), null);
  assert.equal(p.take("nope", b), null);
  assert.deepEqual(p.list("s").map((f) => f.id), [b]);
  p.drop("s");
  assert.deepEqual(p.list("s"), []);
  assert.equal(p.list("t").length, 1);
});

test("pending: a taken forward put back keeps its id", () => {
  const p = createPending();
  const id = p.add("s", { toKey: "cli:p", toName: "boss", kind: "report", text: "one" });
  const f = p.take("s", id);
  assert.equal(p.add("s", f), id);
  assert.deepEqual(p.list("s").map((x) => x.id), [id]);
});
