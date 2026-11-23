// Tests for the pure delegation helpers used by the main process.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PendingRequests,
  childPrompt,
  REMINDER,
  findModelOption,
  isRelayTool,
  linkCardOf,
  reloadWarning,
  resolveConfig,
  unreportedChildren,
  withDeadline,
} from "../delegation.mjs";

const MODEL_ID = "model";
const opt = (id, currentValue, values) => ({
  id,
  category: id === "agent" ? "_agent" : id,
  type: "select",
  currentValue,
  options: values.map((value) => ({ value, name: value })),
});
const options = [opt("model", "gpt-a", ["gpt-a", "gpt-b", "gpt-b"]), opt("agent", "", ["", "reviewer"])];
const noAgent = [opt("model", "gpt-a", ["gpt-a", "gpt-b"])];

test("findModelOption finds the option by id", () => {
  assert.equal(findModelOption(options).id, MODEL_ID);
  assert.equal(findModelOption([opt("agent", "", [""])]), undefined);
  assert.equal(findModelOption(undefined), undefined);
});

test("an unknown model is an error listing valid values once", () => {
  const { error } = resolveConfig(options, { model: "nope" });
  assert.match(error, /gpt-a.*gpt-b/s);
  assert.equal(error.match(/gpt-b/g).length, 1);
});

test("an unknown agent is an error listing valid agents", () => {
  assert.match(resolveConfig(options, { agent: "x" }).error, /reviewer/);
});

test("no agent option at all is an error when an agent is requested", () => {
  assert.match(resolveConfig(noAgent, { agent: "x" }).error, /no custom agents/i);
});

test("a valid model and agent become sets", () => {
  assert.deepEqual(resolveConfig(options, { model: "gpt-b", agent: "reviewer" }).sets, [
    { configId: MODEL_ID, value: "gpt-b" },
    { configId: "agent", value: "reviewer" },
  ]);
});

test("a value equal to the current one emits no set", () => {
  assert.deepEqual(resolveConfig(options, { model: "gpt-a" }).sets, []);
});

test("omitted agent sets nothing; omitted model inherits", () => {
  assert.deepEqual(resolveConfig(options, { inheritedModel: "gpt-b" }).sets, [{ configId: MODEL_ID, value: "gpt-b" }]);
  assert.deepEqual(resolveConfig(options, { agent: "" }).sets, []);
});

test("an inherited model that is unavailable is skipped, not an error", () => {
  assert.deepEqual(resolveConfig(options, { inheritedModel: "gone" }), { sets: [] });
});

test("an explicit model wins over the inherited one", () => {
  assert.deepEqual(resolveConfig(options, { model: "gpt-b", inheritedModel: "gpt-a" }).sets, [
    { configId: MODEL_ID, value: "gpt-b" },
  ]);
});

test("a card answered after its parent closed finds nothing", () => {
  const p = new PendingRequests();
  p.add({ requestId: "r", parentSessionId: "p" });
  p.dropForParent("p");
  assert.equal(p.take("r"), undefined);
});

test("take returns the request once and keeps other parents' requests", () => {
  const p = new PendingRequests();
  const r = { requestId: "r", parentSessionId: "p" };
  p.add(r);
  p.add({ requestId: "s", parentSessionId: "q" });
  p.dropForParent("p");
  p.add(r);
  assert.equal(p.take("r"), r);
  assert.equal(p.take("r"), undefined);
  assert.equal(p.take("s").parentSessionId, "q");
});

test("the child prompt names the parent, the task and report_result", () => {
  const t = childPrompt({ parentName: "glowna", task: "Sprawdź X" });
  assert.match(t, /^\[from glowna\]\n/);
  assert.match(t, /Sprawdź X/);
  assert.match(t, /report_result/);
});

test("childPrompt keeps the headers, the task and the reminder", () => {
  const t = childPrompt({ parentName: "p", task: "T", folder: "/f" });
  assert.ok(t.startsWith('[from p]\n[folder "/f"]\n'), t);
  assert.ok(t.includes(REMINDER));
  assert.ok(t.endsWith("T"));
  assert.doesNotMatch(t, /cannot see this session's chat/);
});

test("the child prompt carries the parent folder line when there is one", () => {
  assert.match(childPrompt({ parentName: "glowna", task: "t", folder: "/p" }), /^\[from glowna\]\n\[folder "\/p"\]\n/);
  assert.doesNotMatch(childPrompt({ parentName: "glowna", task: "t" }), /\[folder/);
});

test("unreportedChildren returns children without a report from any iterable", () => {
  const entries = new Map([
    ["a", { parentSessionId: "p", reported: false }],
    ["b", { parentSessionId: "p", reported: true }],
    ["c", { reported: false }],
    ["d", { parentSessionId: "q" }],
  ]);
  assert.deepEqual(unreportedChildren(entries.values()), [entries.get("a"), entries.get("d")]);
});

test("unreportedChildren counts adopted children", () => {
  const entries = [{ parentSessionId: "p", adopted: true, reported: false }, { parentSessionId: "p", adopted: true, reported: true }];
  assert.deepEqual(unreportedChildren(entries), [entries[0]]);
});

test("isRelayTool knows the relay's six tools by their prefixed title", () => {
  for (const n of ["send_message", "list_sessions", "create_session", "report_result", "adopt_session", "release_session"])
    assert.equal(isRelayTool(`relay-${n}`), true);
  assert.equal(isRelayTool("relay-adopt_session-x"), false);
  assert.equal(isRelayTool("adopt_session"), false);
  assert.equal(isRelayTool(undefined), false);
});

test("linkCardOf turns the broker's request into the window's card", () => {
  assert.deepEqual(
    linkCardOf("s1", { requestId: "r", kind: "release", childKey: "cli:abc", childName: "c", childCwd: "/w", parentName: "p", task: "t" }),
    { sessionId: "s1", requestId: "r", kind: "release", childSessionId: "abc", childName: "c", childCwd: "/w", parentName: "p", task: "t" },
  );
});

test("the reload warning names what it stops and discards", () => {
  assert.equal(reloadWarning(1, 0).message, "Reloading stops 1 delegated session.");
  assert.equal(reloadWarning(2, 1).message, "Reloading stops 2 delegated sessions and discards 1 waiting request for a new session.");
  assert.equal(reloadWarning(0, 2).message, "Reloading discards 2 waiting requests for a new session.");
});

test("the reload warning mentions open reopen cards of the stopped sessions", () => {
  const base = "A reloaded window cannot show their cards. Stopped sessions stay in the list and can be resumed.";
  assert.equal(reloadWarning(1, 0).detail, base);
  assert.equal(reloadWarning(1, 0, 1).detail, `${base} 1 open reopen request of theirs is asked again when they are resumed.`);
  assert.equal(reloadWarning(2, 0, 3).detail, `${base} 3 open reopen requests of theirs are asked again when they are resumed.`);
});

test("PendingRequests reports its size and can be emptied", () => {
  const p = new PendingRequests();
  p.add({ requestId: "a", parentSessionId: "x" });
  p.add({ requestId: "b", parentSessionId: "y" });
  assert.equal(p.size, 2);
  p.clear();
  assert.equal(p.size, 0);
  assert.equal(p.take("a"), undefined);
});

test("withDeadline passes a result through and rejects when the deadline passes", async () => {
  assert.equal(await withDeadline(Promise.resolve(7), Date.now() + 1000, "late"), 7);
  await assert.rejects(withDeadline(new Promise(() => {}), Date.now() + 5, "late"), /late/);
  await assert.rejects(withDeadline(Promise.reject(new Error("own")), Date.now() + 1000, "late"), /own/);
});
