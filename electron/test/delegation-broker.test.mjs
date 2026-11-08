// Tests for the durable delegation service (src/delegation.mjs, src/delegation-store.mjs).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { Delegation } from "../../src/delegation.mjs";
import { DelegationStore } from "../../src/delegation-store.mjs";
import { Registry } from "../../src/registry.mjs";

const dirs = [];
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const req = { name: "badacz", task: "do it", agent: "", model: "" };
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup({ sweepDelayMs = 0, registry = new Registry() } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deleg-"));
  dirs.push(dir);
  const file = path.join(dir, "delegations.json");
  const store = new DelegationStore(file);
  let n = 0;
  const d = new Delegation({ registry, store, sweepDelayMs, newId: () => `id${++n}` });
  const parentPush = [];
  const parentControl = [];
  const childPush = [];
  const childControl = [];
  const parentPeer = {
    key: "cli:parent", name: "mama", kind: "cli",
    push: (m) => (parentPush.push(m), true),
    control: (...a) => parentControl.push(a),
  };
  registry.upsert(parentPeer);
  registry.upsert({
    key: "cli:child", name: "badacz", kind: "cli",
    push: (m) => (childPush.push(m), true),
    control: (...a) => childControl.push(a),
  });
  d.link("cli:child", "cli:parent");
  return { dir, file, store, registry, d, parentPush, parentControl, childPush, childControl, parentPeer };
}

test("create_session is refused for a child", () => {
  const { d, childControl } = setup();
  assert.match(d.requestCreate("cli:child", req), /cannot create/i);
  assert.equal(childControl.length, 0);
});

test("create_session is refused when the app connection is down", () => {
  const { d, registry, parentControl } = setup();
  registry.disconnect("cli:parent");
  clearTimeout(registry.get("cli:parent").offlineTimer);
  assert.match(d.requestCreate("cli:parent", req), /not connected/i);
  assert.equal(parentControl.length, 0);
});

test("create_session returns a request id and emits session_request", () => {
  const { d, parentControl } = setup();
  assert.match(d.requestCreate("cli:parent", req), /Do not wait/);
  assert.equal(parentControl[0][0], "session_request");
  assert.equal(parentControl[0][1].name, "badacz");
  assert.equal(parentControl[0][1].task, "do it");
  assert.equal(typeof parentControl[0][1].requestId, "string");
});

test("a report reaches the parent and stays on disk until acked", () => {
  const { d, store, file, parentPush, childControl } = setup();
  d.report("cli:child", "wynik");
  assert.equal(parentPush[0].wake, true);
  assert.equal(parentPush[0].from, "badacz");
  assert.equal(parentPush[0].human, false);
  assert.match(parentPush[0].prompt, /^\[from badacz\]\nwynik/);
  assert.equal(store.pending("cli:parent").length, 1);
  assert.equal(new DelegationStore(file).pending("cli:parent").length, 1);
  assert.deepEqual(childControl.at(-1), ["reported", {}]);
  assert.ok(d.ack("cli:parent", parentPush[0].deliveryId));
  assert.equal(store.pending("cli:parent").length, 0);
  assert.equal(d.ack("cli:parent", parentPush[0].deliveryId), false);
});

test("report_result works once and is refused for a non-child", () => {
  const { d } = setup();
  d.report("cli:child", "a");
  assert.match(d.report("cli:child", "b"), /already/i);
  assert.match(d.report("cli:parent", "x"), /not a delegated/i);
});

test("a report made with the budget spent is still delivered", () => {
  const registry = new Registry({ maxAgentMessages: 0, maxPairMessages: 0 });
  const { d, parentPush } = setup({ registry });
  assert.match(registry.send("cli:child", "mama", "hi"), /budget/);
  d.report("cli:child", "wynik");
  assert.equal(parentPush.length, 1);
  assert.equal(parentPush[0].wake, true);
});

test("a report for an offline parent is delivered on attach", () => {
  const { d, registry, store, parentPeer, parentPush } = setup();
  registry.disconnect("cli:parent");
  clearTimeout(registry.get("cli:parent").offlineTimer);
  d.report("cli:child", "wynik");
  assert.equal(parentPush.length, 0);
  assert.equal(store.pending("cli:parent").length, 1);
  registry.upsert(parentPeer);
  d.attached("cli:parent");
  assert.equal(parentPush.length, 1);
  assert.match(parentPush[0].prompt, /wynik/);
});

test("an unacknowledged report survives a new store and is redelivered", () => {
  const { d, file } = setup();
  d.report("cli:child", "wynik");
  const store2 = new DelegationStore(file);
  const push = [];
  const registry2 = new Registry();
  registry2.upsert({ key: "cli:parent", name: "mama", kind: "cli", push: (m) => (push.push(m), true) });
  const d2 = new Delegation({ registry: registry2, store: store2, sweepDelayMs: 1000 });
  d2.attached("cli:parent");
  assert.equal(push.length, 1);
  assert.match(push[0].prompt, /wynik/);
});

test("attached restores parentKey from the store", () => {
  const { file } = setup();
  const registry2 = new Registry();
  registry2.upsert({ key: "cli:child", name: "badacz", kind: "cli", push: () => true });
  const d2 = new Delegation({ registry: registry2, store: new DelegationStore(file), sweepDelayMs: 1000 });
  assert.equal(registry2.get("cli:child").parentKey, null);
  d2.attached("cli:child");
  assert.equal(registry2.get("cli:child").parentKey, "cli:parent");
});

test("the created notice does not wake and is not persisted", () => {
  const { d, store, parentPush } = setup();
  d.outcome("cli:parent", { requestId: "r", kind: "created", name: "badacz", text: "Session created: badacz" });
  assert.equal(parentPush[0].wake, false);
  assert.equal(parentPush[0].from, "relay");
  assert.equal(parentPush[0].prompt, "[from relay]\nSession created: badacz");
  assert.equal(store.pending("cli:parent").length, 0);
});

test("rejected, limit, invalid and failed outcomes wake and persist", () => {
  const { d, store, parentPush } = setup();
  for (const kind of ["rejected", "limit", "invalid", "failed"]) {
    d.outcome("cli:parent", { requestId: kind, kind, name: "x", text: `text ${kind}` });
  }
  assert.equal(parentPush.length, 4);
  assert.ok(parentPush.every((m) => m.wake === true && m.deliveryId));
  assert.equal(store.pending("cli:parent").length, 4);
});

test("a child gone without a report notifies the parent once", () => {
  const { d, store, parentPush } = setup();
  d.childGone("cli:child");
  d.childGone("cli:child");
  assert.equal(store.pending("cli:parent").length, 1);
  assert.equal(parentPush.length, 1);
  assert.equal(parentPush[0].wake, true);
  assert.match(parentPush[0].text, /Session "badacz" ended without reporting a result\. You can ask the user to reopen it\./);
});

test("a child gone after reporting produces no notice", () => {
  const { d, store, parentPush } = setup();
  d.report("cli:child", "done");
  d.ack("cli:parent", parentPush[0].deliveryId);
  d.childGone("cli:child");
  assert.equal(parentPush.length, 1);
  assert.equal(store.pending("cli:parent").length, 0);
});

test("attached sweeps offline unreported children, but not online ones", async () => {
  const { d, registry, store, parentPush } = setup();
  registry.upsert({ key: "cli:child2", name: "drugi", kind: "cli", push: () => true });
  d.link("cli:child2", "cli:parent");
  registry.disconnect("cli:child");
  clearTimeout(registry.get("cli:child").offlineTimer);
  d.attached("cli:parent");
  await tick();
  assert.equal(store.pending("cli:parent").length, 1);
  assert.match(parentPush[0].text, /"badacz"/);
  d.childGone("cli:child");
  assert.equal(store.pending("cli:parent").length, 1);
});

test("a child that re-registers before the sweep produces no notice", async () => {
  const { d, registry, store, parentPush } = setup({ sweepDelayMs: 5 });
  registry.disconnect("cli:child");
  clearTimeout(registry.get("cli:child").offlineTimer);
  d.attached("cli:parent");
  registry.upsert({ key: "cli:child", name: "badacz", kind: "cli", push: () => true });
  await tick(30);
  assert.equal(parentPush.length, 0);
  assert.equal(store.pending("cli:parent").length, 0);
});

test("a corrupt store file is preserved aside and not overwritten", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deleg-"));
  dirs.push(dir);
  const file = path.join(dir, "delegations.json");
  writeFileSync(file, "{ not json");
  const orig = console.error;
  console.error = () => {};
  let store;
  try {
    store = new DelegationStore(file);
  } finally {
    console.error = orig;
  }
  store.link("c", "p", "n");
  const aside = readdirSync(dir).filter((f) => f.startsWith("delegations.json.corrupt-"));
  assert.equal(aside.length, 1);
  assert.equal(readFileSync(path.join(dir, aside[0]), "utf8"), "{ not json");
  assert.equal(new DelegationStore(file).parentOf("c"), "p");
});

test("a non-ENOENT read error throws instead of starting empty", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deleg-"));
  dirs.push(dir);
  const sub = path.join(dir, "isdir");
  mkdirSync(sub);
  assert.throws(() => new DelegationStore(sub), /EISDIR/);
});

// ---------- MCP list and tool guard ----------
import { delegationToolsAllowed, formatList } from "../../src/mcp.mjs";

test("list_sessions marks parent and child with current names", () => {
  const registry = new Registry();
  registry.upsert({ key: "cli:parent", name: "parent-name", kind: "cli" });
  registry.upsert({ key: "cli:child", name: "child-name", kind: "cli", parentKey: "cli:parent" });
  registry.upsert({ key: "cli:other", name: "other-name", kind: "cli" });
  assert.match(formatList(registry, "cli:child"), /- parent-name .*your parent/);
  assert.match(formatList(registry, "cli:parent"), /- child-name .*your child/);
  assert.doesNotMatch(formatList(registry, "cli:child"), /other-name.*your (parent|child)/);
  assert.doesNotMatch(formatList(registry, "cli:other"), /your (parent|child)/);
  registry.rename("cli:parent", "renamed");
  assert.match(formatList(registry, "cli:child"), /- renamed .*your parent/);
});

test("delegation tools exist only for desktop aliases", () => {
  assert.equal(delegationToolsAllowed("app:123"), true);
  assert.equal(delegationToolsAllowed("cli:abc"), false);
  assert.equal(delegationToolsAllowed(null), false);
});
