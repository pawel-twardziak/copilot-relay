// Tests for electron/context-tier.mjs: the context window tier (200k / 1M) and its per-session store.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { contextOption, createTierStore, effectiveTier, isContextChoice, nativeContextOption, nativeValueFor, saveAndReopen, switchTier, tierArgs, withContextOption } from "../context-tier.mjs";

let dir;
let file;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tier-test-"));
  file = path.join(dir, "sub", "context-tiers.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test("effectiveTier: override wins, then the Settings default, then 200k", () => {
  assert.equal(effectiveTier("long_context", "default"), "long_context");
  assert.equal(effectiveTier("default", "long_context"), "default");
  assert.equal(effectiveTier(null, "long_context"), "long_context");
  assert.equal(effectiveTier("inherit", "long_context"), "long_context");
  assert.equal(effectiveTier(undefined, "bogus"), "default");
  assert.equal(effectiveTier("bogus", undefined), "default");
});

test("tierArgs always names the tier, so Copilot's own saved tier never applies", () => {
  assert.deepEqual(tierArgs("long_context"), ["--context", "long_context"]);
  assert.deepEqual(tierArgs("default"), ["--context", "default"]);
  assert.deepEqual(tierArgs("bogus"), ["--context", "default"]);
});

test("contextOption labels the Default entry with the Settings value", () => {
  const o = contextOption(null, "long_context");
  assert.equal(o.id, "context_tier");
  assert.equal(o.name, "Context");
  assert.equal(o.type, "select");
  assert.equal(o.currentValue, "inherit");
  assert.deepEqual(
    o.options.map((x) => [x.value, x.name]),
    [
      ["inherit", "Default (1M)"],
      ["default", "200k"],
      ["long_context", "1M"],
    ],
  );
  assert.equal(contextOption("default", undefined).currentValue, "default");
  assert.equal(contextOption(null, undefined).options[0].name, "Default (200k)");
});

test("withContextOption appends the select once and keeps Copilot's options", () => {
  const model = { id: "model", type: "select", options: [] };
  const out = withContextOption([model, { id: "context_tier" }], null, "default");
  assert.deepEqual(
    out.map((o) => o.id),
    ["model", "context_tier"],
  );
  assert.equal(out[0], model);
  assert.equal(out[1].name, "Context");
  assert.deepEqual(
    withContextOption(null, null, "default").map((o) => o.id),
    ["context_tier"],
  );
});

const sel = (id, extra = {}, options = [["default", "200K"], ["long_context", "1M"]]) => ({
  id,
  name: extra.name ?? id,
  category: extra.category,
  type: "select",
  currentValue: options[0][0],
  options: options.map(([value, name]) => ({ value, name })),
});

test("nativeContextOption finds Copilot's own context option by id, category, name or a long_context value", () => {
  const model = sel("model", {}, [["a"], ["b"]]);
  assert.equal(nativeContextOption([model]), null);
  assert.equal(nativeContextOption(null), null);
  for (const native of [
    sel("context_size"),
    sel("x", { category: "context" }),
    sel("x", { name: "Context window" }),
    sel("x", {}, [["small", "200K"], ["long_context", "1M"]]),
  ]) {
    assert.equal(nativeContextOption([model, native]), native);
  }
  // ours never counts, nor a select without options
  assert.equal(nativeContextOption([sel("context_tier")]), null);
  assert.equal(nativeContextOption([{ id: "context", type: "select" }]), null);
  assert.equal(nativeContextOption([{ id: "context", type: "boolean", options: [] }]), null);
});

test("nativeValueFor maps a tier to the option's value: exact value, then value or name", () => {
  const exact = sel("context");
  assert.equal(nativeValueFor(exact, "default"), "default");
  assert.equal(nativeValueFor(exact, "long_context"), "long_context");
  const named = sel("context", {}, [["s", "Default (200K)"], ["l", "Long (1M)"]]);
  assert.equal(nativeValueFor(named, "default"), "s");
  assert.equal(nativeValueFor(named, "long_context"), "l");
  const byValue = sel("context", {}, [["200k", "Standard"], ["1m", "Extended"]]);
  assert.equal(nativeValueFor(byValue, "default"), "200k");
  assert.equal(nativeValueFor(byValue, "long_context"), "1m");
  const unknown = sel("context", {}, [["a", "A"], ["b", "B"]]);
  assert.equal(nativeValueFor(unknown, "default"), null);
  assert.equal(nativeValueFor(unknown, "long_context"), null);
  assert.equal(nativeValueFor(null, "default"), null);
  assert.equal(nativeValueFor(exact, "bogus"), null);
});

test("withContextOption hides Copilot's own context option: one select", () => {
  const model = sel("model", {}, [["a"], ["b"]]);
  const out = withContextOption([model, sel("context_size")], null, "default");
  assert.deepEqual(
    out.map((o) => o.id),
    ["model", "context_tier"],
  );
});

test("store: set, get, inherit removes, copy, delete, and a new instance sees the same", () => {
  const s = createTierStore(file);
  s.set("a", "long_context");
  s.set("b", "default");
  assert.equal(s.get("a"), "long_context");
  assert.equal(s.get("b"), "default");
  s.set("b", "inherit");
  assert.equal(s.get("b"), null);
  s.set("b", "bogus");
  assert.equal(s.get("b"), null);
  s.copy("a", "c");
  assert.equal(s.get("c"), "long_context");
  s.copy("missing", "c");
  assert.equal(s.get("c"), null);
  s.delete("a");
  assert.equal(s.get("a"), null);
  s.set("d", "long_context");
  assert.equal(createTierStore(file).get("d"), "long_context");
});

test("store: a missing, empty or corrupt file reads as no overrides", () => {
  const s = createTierStore(file);
  assert.equal(s.get("x"), null);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
  assert.equal(s.get("x"), null);
  fs.writeFileSync(file, "{not json");
  assert.equal(s.get("x"), null);
  fs.writeFileSync(file, "[1,2]");
  assert.equal(s.get("0"), null);
  s.set("x", "long_context");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { x: "long_context" });
});

test("isContextChoice accepts the select's values only", () => {
  for (const v of ["inherit", "default", "long_context"]) assert.equal(isContextChoice(v), true);
  for (const v of ["", "1M", null, undefined, 1, "Default"]) assert.equal(isContextChoice(v), false);
});

test("store: copy and delete are best-effort, set reports a failed write", () => {
  fs.writeFileSync(path.join(dir, "sub"), "a file where the folder should be");
  const s = createTierStore(file);
  assert.doesNotThrow(() => s.copy("a", "b"));
  assert.doesNotThrow(() => s.delete("a"));
  assert.throws(() => s.set("a", "long_context"));
});

function fakeSwitch({ refusal = null, closeError = null, saved = null, storeFile = file, live = undefined } = {}) {
  const store = createTierStore(storeFile);
  if (saved) store.set("s1", saved);
  let closed = 0;
  const run = (value) =>
    switchTier({
      sessionId: "s1",
      value,
      tiers: store,
      refusal: () => refusal,
      close: async () => {
        closed++;
        if (closeError) throw closeError;
      },
      live,
    });
  return { store, run, closed: () => closed };
}

test("switchTier live: sets Copilot's option, saves the override, closes nothing", async () => {
  const seen = [];
  const f = fakeSwitch({ live: async () => (seen.push(f.store.get("s1")), [{ id: "model" }]) });
  assert.deepEqual(await f.run("long_context"), { configOptions: [{ id: "model" }] });
  assert.deepEqual(seen, ["long_context"], "saved before the live set");
  assert.equal(f.closed(), 0);
  assert.equal(f.store.get("s1"), "long_context");
});

test("switchTier live: a refusal changes nothing", async () => {
  let called = 0;
  const f = fakeSwitch({ refusal: "busy", saved: "default", live: async () => (called++, []) });
  assert.deepEqual(await f.run("long_context"), { refused: "busy" });
  assert.equal(called, 0);
  assert.equal(f.store.get("s1"), "default");
});

test("switchTier live: a failed set restores the override and is refused, nothing closed", async () => {
  const f = fakeSwitch({ saved: "default", live: async () => { throw new Error("nope"); } });
  assert.deepEqual(await f.run("long_context"), { refused: "nope" });
  assert.equal(f.store.get("s1"), "default");
  assert.equal(f.closed(), 0);
  const g = fakeSwitch({ live: async () => { throw new Error("nope"); }, storeFile: path.join(dir, "g.json") });
  await g.run("inherit");
  assert.equal(g.store.get("s1"), null, "no override before: none after");
});

test("switchTier: a refusal changes nothing and closes nothing", async () => {
  const f = fakeSwitch({ refusal: "Wait until Copilot finishes this turn.", saved: "default" });
  assert.deepEqual(await f.run("long_context"), { refused: "Wait until Copilot finishes this turn." });
  assert.equal(f.closed(), 0);
  assert.equal(f.store.get("s1"), "default");
});

test("switchTier: an unknown value is refused before anything else", async () => {
  const f = fakeSwitch();
  assert.deepEqual(await f.run("1M"), { refused: "Unknown context window: 1M" });
  assert.equal(f.closed(), 0);
});

test("switchTier: saves the override, then closes; the caller reopens", async () => {
  const f = fakeSwitch();
  assert.deepEqual(await f.run("long_context"), { reopen: true });
  assert.equal(f.closed(), 1);
  assert.equal(f.store.get("s1"), "long_context");
});

test("switchTier: a failed close restores the previous override and throws", async () => {
  const f = fakeSwitch({ closeError: new Error("Copilot did not exit"), saved: "default" });
  await assert.rejects(f.run("long_context"), /did not exit/);
  assert.equal(f.store.get("s1"), "default");
  const g = fakeSwitch({ closeError: new Error("stuck"), storeFile: path.join(dir, "other.json") });
  await assert.rejects(g.run("long_context"), /stuck/);
  assert.equal(g.store.get("s1"), null);
});

test("saveAndReopen restores on a failed close", async () => {
  const calls = [];
  const err = new Error("Copilot did not exit");
  await assert.rejects(
    saveAndReopen({
      prev: "old",
      save: () => calls.push("save"),
      restore: (prev) => calls.push(`restore ${prev}`),
      refusal: () => null,
      close: async () => {
        calls.push("close");
        throw err;
      },
    }),
    (e) => e === err,
  );
  assert.deepEqual(calls, ["save", "close", "restore old"]);
});

test("saveAndReopen refuses before saving", async () => {
  const calls = [];
  const res = await saveAndReopen({
    prev: "old",
    save: () => calls.push("save"),
    restore: () => calls.push("restore"),
    refusal: () => "Wait until Copilot finishes this turn.",
    close: async () => calls.push("close"),
  });
  assert.deepEqual(res, { refused: "Wait until Copilot finishes this turn." });
  assert.deepEqual(calls, []);
});

test("saveAndReopen saves, closes and answers reopen", async () => {
  const calls = [];
  const res = await saveAndReopen({ prev: null, save: () => calls.push("save"), restore: () => calls.push("restore"), refusal: () => null, close: async () => calls.push("close") });
  assert.deepEqual(res, { reopen: true });
  assert.deepEqual(calls, ["save", "close"]);
});
