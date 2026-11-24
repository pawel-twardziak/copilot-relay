// Tests for the pure delegation helpers used by the main process.
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { shellLine } from "../copilot-command.mjs";
import {
  PendingRequests,
  answerFields,
  cardStart,
  createdText,
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

// ---- the card's start values ----
const startOpts = [
  opt("model", "gpt-a", ["gpt-a", "gpt-b", "gpt-b"]),
  { ...opt("agent", "", ["", "reviewer"]), options: [{ value: "", name: "Default" }, { value: "reviewer", name: "Reviewer" }, { value: "reviewer", name: "Again" }] },
];
const parentOf = (extra = {}) => ({
  cwd: "/work/parent",
  tier: "default",
  storedCommand: "copilot --stored",
  command: "copilot --resolved",
  configOptions: startOpts,
  name: "Boss",
  ...extra,
});
const req = (extra = {}) => ({ requestId: "r", name: "kid", task: "t", agent: "", model: "", folder: "", prompt: "", context: "", command: "", ...extra });
const isDir = (p) => p === "/work/other";
const noFrom = { cwd: false, tier: false, agent: false, model: false, own: false, command: false };

test("cardStart takes valid parent values", () => {
  const s = cardStart(
    req({ folder: "/work/other", prompt: "be brief", context: "long_context", agent: "reviewer", model: "gpt-b", command: "copilot --foo" }),
    parentOf(),
    { isDir },
  );
  assert.equal(s.cwd, "/work/other");
  assert.equal(s.tier, "long_context");
  assert.equal(s.agent, "reviewer");
  assert.equal(s.model, "gpt-b");
  assert.equal(s.own, "be brief");
  assert.equal(s.command, "copilot --resolved --foo");
  assert.deepEqual(s.from, { cwd: true, tier: true, agent: true, model: true, own: true, command: true });
  assert.deepEqual(s.notes, {});
  assert.equal(s.parentName, "Boss");
  assert.equal(s.currentModel, "gpt-a");
});

test("cardStart falls back with a note", () => {
  const p = parentOf();
  const rel = cardStart(req({ folder: "rel/dir" }), p, { isDir });
  assert.equal(rel.cwd, "/work/parent");
  assert.equal(rel.notes.cwd, 'Asked for the folder "rel/dir", which is not an existing absolute path.');
  const gone = cardStart(req({ folder: "/nope" }), p, { isDir });
  assert.equal(gone.cwd, "/work/parent");
  assert.match(gone.notes.cwd, /"\/nope"/);
  const tier = cardStart(req({ context: "huge" }), p, { isDir });
  assert.equal(tier.tier, "default");
  assert.equal(tier.notes.tier, 'Asked for the context "huge", which is not 200k or 1M.');
  const agent = cardStart(req({ agent: "ghost" }), p, { isDir });
  assert.equal(agent.agent, "");
  assert.equal(agent.notes.agent, 'Asked for the agent "ghost", which is not offered here. Valid agents: "" (default), reviewer.');
  const none = cardStart(req({ agent: "ghost" }), parentOf({ configOptions: noAgent }), { isDir });
  assert.equal(none.notes.agent, 'Asked for the agent "ghost", but there are no custom agents available.');
  const model = cardStart(req({ model: "ghost" }), p, { isDir });
  assert.equal(model.model, "");
  assert.equal(model.notes.model, 'Asked for the model "ghost", which is not offered here. Valid models: gpt-a, gpt-b.');
  const cmd = cardStart(req({ command: "node x" }), p, { isDir });
  assert.equal(cmd.command, "copilot --stored");
  assert.equal(cmd.notes.command, 'Asked for a command that was not taken: Only the copilot command is allowed, not "node".');
  for (const s of [rel, gone, tier, agent, none, model, cmd]) assert.deepEqual(s.from, noFrom);
});

test("cardStart without proposals keeps today's card", () => {
  const s = cardStart(req(), parentOf(), { isDir });
  assert.equal(s.command, "copilot --stored");
  assert.equal(s.own, "");
  assert.equal(s.cwd, "/work/parent");
  assert.equal(s.tier, "default");
  assert.deepEqual(s.notes, {});
  assert.deepEqual(s.from, noFrom);
  assert.equal(cardStart(req(), parentOf({ name: "" }), { isDir }).parentName, "the session");
  assert.equal(cardStart(req(), parentOf({ configOptions: [] }), { isDir }).currentModel, null);
});

test("cardStart deduplicates the lists", () => {
  const s = cardStart(req(), parentOf(), { isDir });
  assert.deepEqual(s.models, [{ value: "gpt-a", name: "gpt-a" }, { value: "gpt-b", name: "gpt-b" }]);
  assert.deepEqual(s.agents, [{ value: "", name: "Default" }, { value: "reviewer", name: "Reviewer" }]);
});

test("answerFields normalises the card's values", () => {
  const ctx = { parentCwd: "/work/parent", parentTier: "long_context" };
  assert.deepEqual(answerFields({ cwd: "/a/b/../c", tier: "default", agent: "x", model: "y" }, ctx), { cwd: "/a/c", tier: "default", agent: "x", model: "y" });
  assert.deepEqual(answerFields({ cwd: "rel", tier: "huge", agent: 1, model: null }, ctx), { cwd: "/work/parent", tier: "long_context", agent: "", model: "" });
  assert.deepEqual(answerFields({}, ctx), { cwd: "/work/parent", tier: "long_context", agent: "", model: "" });
  assert.deepEqual(answerFields(undefined, ctx), { cwd: "/work/parent", tier: "long_context", agent: "", model: "" });
  assert.deepEqual(answerFields("x", ctx).cwd, "/work/parent");
});

test("createdText names another folder only", () => {
  assert.equal(
    createdText({ name: "kid", childCwd: "/a", parentCwd: "/b" }),
    'Session "kid" was created in the folder "/a" and has started on its task. It will send you its result with report_result.',
  );
  assert.equal(
    createdText({ name: "kid", childCwd: "/a/", parentCwd: path.resolve("/a") }),
    'Session "kid" was created and has started on its task. It will send you its result with report_result.',
  );
});

test("cardStart never looks at a remote folder", () => {
  const calls = [];
  for (const folder of ["\\\\host\\share", "//host/share", "/\\host\\share", "\\/host/share"]) {
    const s = cardStart(req({ folder }), parentOf(), { isDir: (p) => (calls.push(p), true) });
    assert.equal(s.cwd, "/work/parent");
    assert.equal(s.from.cwd, false);
    assert.equal(s.notes.cwd, `Asked for the folder "${folder}", which is not an existing absolute path.`);
  }
  assert.deepEqual(calls, []);
});

test("a quoted parent command keeps its quotes when arguments are appended", () => {
  const line = shellLine("C:\\Program Files\\gh\\copilot.exe", [], { platform: "win32", isFile: () => true });
  const s = cardStart(req({ command: "copilot --foo" }), parentOf({ command: line }), { isDir });
  assert.equal(s.command, '"C:\\Program Files\\gh\\copilot.exe" --foo');
});
