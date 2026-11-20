// Tests for parent-child links and per-pair message budgets in src/registry.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Registry, nameSuffix, uniqueName } from "../../src/registry.mjs";

const ok = () => true;

test("a name gets the key's 6-hex suffix and keeps it across renames", () => {
  const r = new Registry();
  const p = r.upsert({ key: "cli:aaa", name: "api-tests", kind: "cli" });
  assert.equal(p.name, `api-tests-${nameSuffix("cli:aaa")}`);
  assert.match(p.name, /^api-tests-[0-9a-f]{6}$/);
  assert.equal(r.rename("cli:aaa", "docs"), `docs-${nameSuffix("cli:aaa")}`);
});
test("a requested name already carrying the own suffix is not suffixed twice", () => {
  const r = new Registry();
  const n = `x-${nameSuffix("cli:aaa")}`;
  assert.equal(r.upsert({ key: "cli:aaa", name: n, kind: "cli" }).name, n);
});
test("same base for two keys gives two different names; a suffix collision extends to 8", () => {
  assert.notEqual(uniqueName("w", "cli:a", () => false), uniqueName("w", "cli:b", () => false));
  const six = uniqueName("w", "cli:a", () => false);
  assert.equal(uniqueName("w", "cli:a", (n) => n === six), `w-${nameSuffix("cli:a", 8)}`);
});
test("a long base is cut so the full name stays within 32 chars", () => {
  const n = uniqueName("a".repeat(40), "cli:a", () => false);
  assert.ok(n.length <= 32 && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(n));
});
test("an old base name does not reach the renamed session", () => {
  const r = new Registry();
  r.upsert({ key: "cli:s", name: "sender", kind: "cli", push: () => true });
  r.upsert({ key: "cli:t", name: "old", kind: "cli", push: () => true });
  const oldFull = r.get("cli:t").name;
  r.rename("cli:t", "new");
  assert.match(r.send("cli:s", oldFull, "hi"), new RegExp(`^No session "${oldFull}"`));
});
test("reserved names still get another name", () => {
  const r = new Registry();
  const p = r.upsert({ key: "cli:c", name: "relay", kind: "cli" });
  assert.equal(p.name, `relay-session-${nameSuffix("cli:c")}`);
  assert.throws(() => r.rename("cli:c", "relay"), /reserved/);
  assert.throws(() => r.rename("cli:c", "user"), /reserved/);
});

test("linked messages use the pair budget, not the global one", () => {
  const r = new Registry({ maxAgentMessages: 1, maxPairMessages: 2 });
  r.upsert({ key: "p", name: "p", kind: "cli", push: ok });
  r.upsert({ key: "c", name: "c", kind: "cli", parentKey: "p", push: ok });
  assert.match(r.send("c", r.get("p").name, "1"), /delivered/);
  assert.match(r.send("p", r.get("c").name, "2"), /delivered/);
  assert.match(r.send("c", r.get("p").name, "3"), /budget/);
  assert.equal(r.budget, 1);
});

test("a human prompt in either session refills only that pair", () => {
  const r = new Registry({ maxAgentMessages: 5, maxPairMessages: 1 });
  for (const n of ["p1", "c1", "p2", "c2"]) {
    r.upsert({ key: n, name: n, kind: "cli", push: ok, parentKey: n[0] === "c" ? "p" + n[1] : null });
  }
  assert.match(r.send("c1", r.get("p1").name, "x"), /delivered/);
  assert.match(r.send("c2", r.get("p2").name, "x"), /delivered/);
  assert.match(r.send("c1", r.get("p1").name, "x"), /budget/);
  assert.match(r.send("c2", r.get("p2").name, "x"), /budget/);
  r.humanPrompt("p1");
  assert.match(r.send("c1", r.get("p1").name, "x"), /delivered/);
  assert.match(r.send("c2", r.get("p2").name, "x"), /budget/);
  // the child side refills too
  assert.match(r.send("c1", r.get("p1").name, "x"), /budget/);
  r.humanPrompt("c1");
  assert.match(r.send("p1", r.get("c1").name, "x"), /delivered/);
  // sendFromUser passes the target's key
  assert.match(r.send("c2", r.get("p2").name, "x"), /budget/);
  r.sendFromUser("p2", "hi");
  assert.match(r.send("c2", r.get("p2").name, "x"), /delivered/);
});

test("unlinked messages still use the global budget", () => {
  const r = new Registry({ maxAgentMessages: 2, maxPairMessages: 9 });
  r.upsert({ key: "a", name: "a", kind: "cli", push: ok });
  r.upsert({ key: "b", name: "b", kind: "cli", push: ok });
  assert.match(r.send("a", r.get("b").name, "1"), /delivered/);
  assert.match(r.send("b", r.get("a").name, "2"), /delivered/);
  assert.equal(r.budget, 0);
  assert.match(r.send("a", r.get("b").name, "3"), /budget/);
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

test("a sender with a folder: the push carries fromCwd and the prompt a folder line", () => {
  const r = new Registry();
  const got = [];
  r.upsert({ key: "x", name: "x", kind: "cli", cwd: "/a b", push: ok });
  r.upsert({ key: "y", name: "y", kind: "cli", push: (m) => (got.push(m), true) });
  r.send("x", r.get("y").name, "hello");
  assert.equal(got[0].fromCwd, "/a b");
  assert.match(got[0].prompt, new RegExp(String.raw`^\[from ${r.get("x").name}\]\n\[folder "/a b"\]\nhello`));
});

test("a sender without a folder: no fromCwd and no folder line", () => {
  const r = new Registry();
  const got = [];
  r.upsert({ key: "x", name: "x", kind: "cli", push: ok });
  r.upsert({ key: "y", name: "y", kind: "cli", push: (m) => (got.push(m), true) });
  r.send("x", r.get("y").name, "hello");
  assert.equal("fromCwd" in got[0], false);
  assert.match(got[0].prompt, new RegExp(String.raw`^\[from ${r.get("x").name}\]\nhello`));
});

test("a message queued while the recipient is offline keeps fromCwd in the inbox", () => {
  const r = new Registry();
  r.upsert({ key: "x", name: "x", kind: "cli", cwd: "/a b", push: ok });
  r.upsert({ key: "y", name: "y", kind: "mcp" });
  r.send("x", r.get("y").name, "hello");
  const item = r.get("y").inbox[0];
  assert.equal(item.fromCwd, "/a b");
  assert.match(item.prompt, new RegExp(String.raw`^\[from ${r.get("x").name}\]\n\[folder "/a b"\]\nhello`));
});

test("an explicit name is recognised as the peer's current name, so registration does not rename", () => {
  const r = new Registry();
  const p = r.upsert({ key: "cli:e", name: "Worker One", kind: "cli" });
  assert.equal(r.freeName("Worker One", "cli:e"), p.name);
  assert.equal(r.freeName(p.name, "cli:e"), p.name);
  assert.notEqual(r.freeName("other", "cli:e"), p.name);
});

test("upsert records whether the stream is the desktop app's; a re-attach updates it", () => {
  const r = new Registry();
  assert.equal(r.upsert({ key: "cli:a", name: "a", kind: "cli", app: true }).app, true);
  assert.equal(r.upsert({ key: "cli:b", name: "b", kind: "cli" }).app, false);
  assert.equal(r.upsert({ key: "cli:a", kind: "cli", app: false }).app, false);
  assert.equal(r.upsert({ key: "cli:a", kind: "cli" }).app, false); // not said: kept
  assert.equal(r.upsert({ key: "cli:a", kind: "cli", app: true }).app, true);
});
