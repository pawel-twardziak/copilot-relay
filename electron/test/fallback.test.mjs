// The reply fallback's chain state, its turn-end decision and the pending forwards (electron/fallback.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createChainState, createPending, decideForward, originOf, relayToolsAfterSet, relayToolsFor } from "../fallback.mjs";
import { readEvents } from "../history.mjs";

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

test("with no chain running, text and titles are not collected", () => {
  const c = createChainState();
  c.update(toolCall("view"));
  c.update(chunk("before any chain"));
  assert.deepEqual(c.snapshot(), { seq: null, origin: null, text: "", titles: [], lastStop: null, reported: false });
  c.start({ seq: "s1", origin: fromParent });
  c.prompt();
  c.update(chunk("in the chain"));
  c.start(); // the chain ended
  c.update(toolCall("edit"));
  c.update(chunk("between chains"));
  assert.deepEqual(c.snapshot(), { seq: null, origin: null, text: "", titles: [], lastStop: null, reported: false });
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

test("relayToolsFor reads the agent's tools from the real readEvents shape", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fallback-events-"));
  try {
    const events = [
      { type: "session.start", data: {} },
      { type: "subagent.selected", data: { agentName: "limited", agentDisplayName: "limited", tools: ["read"] } },
      { type: "subagent.selected", data: { agentName: "relayok", agentDisplayName: "relayok", tools: ["read", "relay/*"] } },
    ];
    writeFileSync(path.join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const read = () => readEvents(dir); // { events, lines }
    assert.deepEqual(relayToolsFor({ agent: "limited", readEvents: read }), none);
    assert.deepEqual(relayToolsFor({ agent: "relayok", readEvents: read }), both);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("relayToolsFor: a reader that throws means both tools; the default agent reads nothing", () => {
  const throwing = () => {
    throw new Error("no history");
  };
  assert.deepEqual(relayToolsFor({ agent: "limited", readEvents: throwing }), both);
  let reads = 0;
  const reader = () => (reads++, { events: [], lines: [] });
  assert.deepEqual(relayToolsFor({ agent: "", readEvents: reader }), both);
  assert.deepEqual(relayToolsFor({ agent: undefined, readEvents: reader }), both);
  assert.equal(reads, 0);
});

test("pending: a taken forward put back keeps its id", () => {
  const p = createPending();
  const id = p.add("s", { toKey: "cli:p", toName: "boss", kind: "report", text: "one" });
  const f = p.take("s", id);
  assert.equal(p.add("s", f), id);
  assert.deepEqual(p.list("s").map((x) => x.id), [id]);
});

// Copilot writes subagent.selected to events.jsonl about 500 ms after set_config_option answers (live, CLI 1.0.117):
// right after the app set the agent, the note waits a little for it (relayToolsAfterSet).
const LIMITED = { type: "subagent.selected", data: { agentName: "limited", tools: ["read"] } };
/** A fake clock and an events reader whose subagent.selected for limited appears at appearAt ms (never: Infinity). */
function slowHistory({ appearAt = Infinity, start = 10_000 } = {}) {
  let t = start;
  let reads = 0;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    readEvents: () => {
      reads++;
      return { events: [{ type: "session.start", data: {} }, ...(t >= start + appearAt ? [LIMITED] : [])], lines: [] };
    },
    reads: () => reads,
    elapsed: () => t - start,
  };
}
const afterSet = (h, agent, agentSetAt) => relayToolsAfterSet({ agent, readEvents: h.readEvents, agentSetAt, now: h.now, sleep: h.sleep });

test("relayToolsAfterSet: the event appears 300 ms after the app set the agent: found (no tools)", async () => {
  const h = slowHistory({ appearAt: 300 });
  assert.deepEqual(await afterSet(h, "limited", { value: "limited", at: h.now() }), none);
  assert.equal(h.elapsed(), 300);
  assert.equal(h.reads(), 4); // at 0, 100, 200, 300 ms
});

test("relayToolsAfterSet: the event never appears: gives up 2 s after the set, with today's answer", async () => {
  const h = slowHistory();
  assert.deepEqual(await afterSet(h, "limited", { value: "limited", at: h.now() - 500 }), both);
  assert.equal(h.elapsed(), 1500); // the deadline counts from the set, not from the call
  assert.equal(h.reads(), 16);
});

test("relayToolsAfterSet: a set of another agent, or one 2 s old, reads once and does not wait", async () => {
  for (const agentSetAt of [{ value: "relayok", at: 10_000 }, { value: "limited", at: 10_000 - 2000 }, null, undefined]) {
    const h = slowHistory({ appearAt: 300 });
    assert.deepEqual(await afterSet(h, "limited", agentSetAt), both, JSON.stringify(agentSetAt));
    assert.equal(h.reads(), 1);
    assert.equal(h.elapsed(), 0);
  }
});

test("relayToolsAfterSet: the event already there: one read, no wait", async () => {
  const h = slowHistory({ appearAt: 0 });
  assert.deepEqual(await afterSet(h, "limited", { value: "limited", at: h.now() }), none);
  assert.equal(h.reads(), 1);
  assert.equal(h.elapsed(), 0);
});

test("relayToolsAfterSet: the default agent reads nothing", async () => {
  for (const agent of ["", undefined]) {
    const h = slowHistory({ appearAt: 300 });
    assert.deepEqual(await afterSet(h, agent, { value: "", at: h.now() }), both);
    assert.equal(h.reads(), 0);
    assert.equal(h.elapsed(), 0);
  }
});

test("relayToolsAfterSet: a reader that throws counts as no event yet", async () => {
  let t = 0;
  let reads = 0;
  const readEvents = () => {
    reads++;
    if (t < 200) throw new Error("not written yet");
    return { events: [{ type: "session.start", data: {} }, LIMITED], lines: [] };
  };
  const tools = await relayToolsAfterSet({ agent: "limited", readEvents, agentSetAt: { value: "limited", at: 0 }, now: () => t, sleep: async (ms) => void (t += ms) });
  assert.deepEqual(tools, none);
  assert.equal(reads, 3);
});

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "fallback-pending-"));
const fwd = (text, over = {}) => ({ toKey: "cli:p", toName: "boss", kind: "report", text, ...over });

test("file-backed pending: a new instance on the same file lists what was added, with its flags", () => {
  const dir = tmp();
  const file = path.join(dir, "fallback-pending.json");
  try {
    const p = createPending({ file });
    const a = p.add("s", fwd("one", { old: true }));
    const b = p.add("s", fwd("two", { kind: "message", error: "no answer" }));
    const again = createPending({ file });
    assert.deepEqual(again.list("s"), [
      { id: a, toKey: "cli:p", toName: "boss", kind: "report", text: "one", old: true },
      { id: b, toKey: "cli:p", toName: "boss", kind: "message", text: "two", error: "no answer" },
    ]);
    assert.deepEqual(again.list("t"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file-backed pending: take and drop write through; a taken forward added again keeps its id", () => {
  const dir = tmp();
  const file = path.join(dir, "fallback-pending.json");
  try {
    const p = createPending({ file });
    const a = p.add("s", fwd("one"));
    const b = p.add("s", fwd("two"));
    p.add("t", fwd("other"));
    const f = p.take("s", a);
    assert.deepEqual(createPending({ file }).list("s").map((x) => x.id), [b]);
    assert.equal(p.add("s", f), a);
    assert.deepEqual(createPending({ file }).list("s").map((x) => x.id), [b, a]);
    p.drop("s");
    const after = createPending({ file });
    assert.deepEqual(after.list("s"), []);
    assert.equal(after.list("t").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file-backed pending: ids are unique across instances", () => {
  const dir = tmp();
  const file = path.join(dir, "fallback-pending.json");
  try {
    const first = createPending({ file }).add("s", fwd("one"));
    const second = createPending({ file }).add("s", fwd("two"));
    const third = createPending({ file }).add("s", fwd("three"));
    assert.equal(new Set([first, second, third]).size, 3);
    assert.equal(createPending({ file }).list("s").length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file-backed pending: a garbled file reads as empty, an unwritable one keeps working in memory", () => {
  const dir = tmp();
  try {
    const garbled = path.join(dir, "garbled.json");
    writeFileSync(garbled, "{ not json");
    const p = createPending({ file: garbled });
    assert.deepEqual(p.list("s"), []);
    const id = p.add("s", fwd("one"));
    assert.deepEqual(p.list("s").map((x) => x.id), [id]);
    // a file whose parent is a regular file: every write fails
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "x");
    const q = createPending({ file: path.join(blocker, "pending.json") });
    const warn = console.warn;
    const warned = [];
    console.warn = (m) => warned.push(m);
    try {
      const qid = q.add("s", fwd("two"));
      assert.deepEqual(q.list("s").map((x) => x.id), [qid]);
      assert.equal(q.take("s", qid).text, "two");
    } finally {
      console.warn = warn;
    }
    assert.equal(warned.length, 1, "logged once");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file-backed pending: a claimed forward stays on disk until it is settled; a second claim gets null", () => {
  const dir = tmp();
  const file = path.join(dir, "fallback-pending.json");
  try {
    const p = createPending({ file });
    const a = p.add("s", fwd("one"));
    const f = p.claim("s", a);
    assert.equal(f.text, "one");
    assert.equal(p.claim("s", a), null, "a second answer during the send");
    assert.equal(p.take("s", a), null);
    assert.deepEqual(p.list("s"), [], "not offered while it is being sent");
    p.add("s", fwd("two")); // another write meanwhile must keep the claimed one on disk
    assert.deepEqual(createPending({ file }).list("s").map((x) => x.text), ["one", "two"], "a quit mid-send keeps it");
    p.settle("s", a);
    assert.deepEqual(createPending({ file }).list("s").map((x) => x.text), ["two"]);
    assert.equal(p.claim("s", a), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file-backed pending: release puts a claimed forward back with its flags; a drop meanwhile wins", () => {
  const dir = tmp();
  const file = path.join(dir, "fallback-pending.json");
  try {
    const p = createPending({ file });
    const a = p.add("s", fwd("one", { old: true }));
    p.claim("s", a);
    p.release("s", a, { old: undefined, error: "no answer" });
    assert.deepEqual(createPending({ file }).list("s"), [{ id: a, toKey: "cli:p", toName: "boss", kind: "report", text: "one", error: "no answer" }]);
    p.claim("s", a);
    p.drop("s");
    p.release("s", a, { old: true });
    assert.deepEqual(p.list("s"), []);
    assert.deepEqual(createPending({ file }).list("s"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file-backed pending: a garbled file is logged once", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "garbled.json");
    writeFileSync(file, "{ not json");
    const warn = console.warn;
    const warned = [];
    console.warn = (m) => warned.push(m);
    try {
      createPending({ file });
      createPending({ file: path.join(dir, "missing.json") }); // a missing file is no news
    } finally {
      console.warn = warn;
    }
    assert.equal(warned.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
