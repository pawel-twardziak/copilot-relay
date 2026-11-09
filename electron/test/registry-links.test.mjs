// Tests for parent-child links and per-pair message budgets in src/registry.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Registry } from "../../src/registry.mjs";

const ok = () => true;

test("relay and user are reserved: a child requested as relay gets another name", () => {
  const r = new Registry();
  const p = r.upsert({ key: "cli:c", name: "relay", kind: "cli" });
  assert.notEqual(p.name, "relay");
  assert.throws(() => r.rename("cli:c", "relay"), /reserved/);
});

test("a taken name yields a suffixed final name", () => {
  const r = new Registry();
  r.upsert({ key: "a", name: "badacz", kind: "cli" });
  assert.equal(r.upsert({ key: "b", name: "badacz", kind: "cli" }).name, "badacz-2");
});

test("linked messages use the pair budget, not the global one", () => {
  const r = new Registry({ maxAgentMessages: 1, maxPairMessages: 2 });
  r.upsert({ key: "p", name: "p", kind: "cli", push: ok });
  r.upsert({ key: "c", name: "c", kind: "cli", parentKey: "p", push: ok });
  assert.match(r.send("c", "p", "1"), /delivered/);
  assert.match(r.send("p", "c", "2"), /delivered/);
  assert.match(r.send("c", "p", "3"), /budget/);
  assert.equal(r.budget, 1);
});

test("a human prompt in either session refills only that pair", () => {
  const r = new Registry({ maxAgentMessages: 5, maxPairMessages: 1 });
  for (const n of ["p1", "c1", "p2", "c2"]) {
    r.upsert({ key: n, name: n, kind: "cli", push: ok, parentKey: n[0] === "c" ? "p" + n[1] : null });
  }
  assert.match(r.send("c1", "p1", "x"), /delivered/);
  assert.match(r.send("c2", "p2", "x"), /delivered/);
  assert.match(r.send("c1", "p1", "x"), /budget/);
  assert.match(r.send("c2", "p2", "x"), /budget/);
  r.humanPrompt("p1");
  assert.match(r.send("c1", "p1", "x"), /delivered/);
  assert.match(r.send("c2", "p2", "x"), /budget/);
  // the child side refills too
  assert.match(r.send("c1", "p1", "x"), /budget/);
  r.humanPrompt("c1");
  assert.match(r.send("p1", "c1", "x"), /delivered/);
  // sendFromUser passes the target's key
  assert.match(r.send("c2", "p2", "x"), /budget/);
  r.sendFromUser("p2", "hi");
  assert.match(r.send("c2", "p2", "x"), /delivered/);
});

test("unlinked messages still use the global budget", () => {
  const r = new Registry({ maxAgentMessages: 2, maxPairMessages: 9 });
  r.upsert({ key: "a", name: "a", kind: "cli", push: ok });
  r.upsert({ key: "b", name: "b", kind: "cli", push: ok });
  assert.match(r.send("a", "b", "1"), /delivered/);
  assert.match(r.send("b", "a", "2"), /delivered/);
  assert.equal(r.budget, 0);
  assert.match(r.send("a", "b", "3"), /budget/);
});

test("pushTo is false for an offline peer", () => {
  const r = new Registry();
  const got = [];
  r.upsert({ key: "a", name: "a", kind: "cli", push: (m) => (got.push(m), true) });
  assert.equal(r.pushTo("a", { text: "x" }), true);
  assert.equal(got.length, 1);
  assert.equal(r.pushTo("missing", { text: "x" }), false);
  r.disconnect("a");
  assert.equal(r.pushTo("a", { text: "y" }), false);
  assert.equal(got.length, 1);
  r.remove("a");
});

test("links, control and describe", () => {
  const r = new Registry();
  const control = { id: 1 };
  r.upsert({ key: "p", name: "p", kind: "cli" });
  const c = r.upsert({ key: "c", name: "c", kind: "cli", parentKey: "p", control });
  r.upsert({ key: "x", name: "x", kind: "cli" });
  assert.equal(c.control, control);
  assert.equal(r.describe(c).parentKey, "p");
  assert.equal(r.describe(r.get("p")).parentKey, null);
  assert.equal(r.isLinked("p", "c"), true);
  assert.equal(r.isLinked("c", "p"), true);
  assert.equal(r.isLinked("p", "x"), false);
  r.disconnect("c");
  assert.equal(r.get("c").control, null);
  r.remove("c");
});
