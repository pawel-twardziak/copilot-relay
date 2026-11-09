// Tests for the pure delegation helpers used by the main process.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PendingRequests,
  childPrompt,
  findModelOption,
  limitError,
  reloadWarning,
  resolveConfig,
  unreportedChildren,
  withDeadline,
} from "../delegation.mjs";

const MODEL_ID = "model";
const children = (parent, n) => Array.from({ length: n }, () => ({ parentSessionId: parent }));
const opt = (id, currentValue, values) => ({
  id,
  category: id === "agent" ? "_agent" : id,
  type: "select",
  currentValue,
  options: values.map((value) => ({ value, name: value })),
});
const options = [opt("model", "gpt-a", ["gpt-a", "gpt-b", "gpt-b"]), opt("agent", "", ["", "reviewer"])];
const noAgent = [opt("model", "gpt-a", ["gpt-a", "gpt-b"])];

test("limits: 3 per parent, 5 in total", () => {
  assert.match(limitError(children("p", 3), "p"), /3/);
  assert.equal(limitError(children("p", 2), "p"), null);
  assert.match(limitError([...children("p", 2), ...children("q", 3)], "p"), /5/);
});

test("creations in progress count toward the limit", () => {
  assert.match(limitError(children("p", 2), "p", {}, ["p"]), /3/);
  assert.match(limitError(children("q", 4), "p", {}, ["p"]), /5/);
});

test("limits are configurable", () => {
  assert.match(limitError(children("p", 1), "p", { perParent: 1 }), /1/);
});

test("entries without a parent do not count toward the per-parent limit", () => {
  assert.equal(limitError([{}, {}, {}, { parentSessionId: null }], "p"), null);
});

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
  assert.match(t, /cannot see/);
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

test("the limit notices name the limit and say a slot frees up when a session is closed", () => {
  for (const [text, number] of [
    [limitError(children("p", 3), "p"), /limit is 3/],
    [limitError(children("q", 5), "p"), /limit is 5/],
  ]) {
    assert.match(text, number);
    assert.match(text, /frees up when a delegated session.* is closed/);
    assert.doesNotMatch(text, /report back|Wait for/);
  }
});

test("the reload warning names what it stops and discards", () => {
  assert.equal(reloadWarning(1, 0).message, "Reloading stops 1 delegated session.");
  assert.equal(reloadWarning(2, 1).message, "Reloading stops 2 delegated sessions and discards 1 waiting request for a new session.");
  assert.equal(reloadWarning(0, 2).message, "Reloading discards 2 waiting requests for a new session.");
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
