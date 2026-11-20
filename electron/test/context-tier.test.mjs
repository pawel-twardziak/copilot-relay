// Tests for electron/context-tier.mjs: the context window tier (200k / 1M) and its per-session store.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { contextOption, createTierStore, effectiveTier, isContextChoice, tierArgs, withContextOption } from "../context-tier.mjs";

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

test("tierArgs gives the Copilot flag only for the long tier", () => {
  assert.deepEqual(tierArgs("long_context"), ["--context", "long_context"]);
  assert.deepEqual(tierArgs("default"), []);
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
