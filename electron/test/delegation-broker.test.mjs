// Tests for the durable delegation service (src/delegation.mjs, src/delegation-store.mjs).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { Delegation } from "../../src/delegation.mjs";
import { DelegationStore } from "../../src/delegation-store.mjs";
import { Registry, nameSuffix } from "../../src/registry.mjs";
import { onceDelivery } from "../../extension/copilot-relay/relay-client.mjs";

const dirs = [];
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const KID = `badacz-${nameSuffix("cli:child")}`; // the child's permanent registry name
const req = { name: "badacz", task: "do it", agent: "", model: "" };
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup({ registry = new Registry() } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deleg-"));
  dirs.push(dir);
  const file = path.join(dir, "delegations.json");
  const store = new DelegationStore(file);
  let n = 0;
  const d = new Delegation({ registry, store, newId: () => `id${++n}` });
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
  assert.equal(parentPush[0].from, KID);
  assert.equal(parentPush[0].human, false);
  assert.match(parentPush[0].prompt, new RegExp(String.raw`^\[from ${KID}\]\nwynik`));
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
  assert.match(registry.send("cli:child", registry.get("cli:parent").name, "hi"), /budget/);
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
  const d2 = new Delegation({ registry: registry2, store: store2 });
  d2.attached("cli:parent");
  assert.equal(push.length, 1);
  assert.match(push[0].prompt, /wynik/);
});

test("attached restores parentKey from the store", () => {
  const { file } = setup();
  const registry2 = new Registry();
  registry2.upsert({ key: "cli:child", name: "badacz", kind: "cli", push: () => true });
  const d2 = new Delegation({ registry: registry2, store: new DelegationStore(file) });
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

test("report says delivered when pushed, stored when the parent is away", () => {
  const online = setup();
  assert.match(online.d.report("cli:child", "wynik"), /delivered/i);
  const away = setup();
  away.registry.disconnect("cli:parent");
  clearTimeout(away.registry.get("cli:parent").offlineTimer);
  const answer = away.d.report("cli:child", "wynik");
  assert.match(answer, /stored/i);
  assert.doesNotMatch(answer, /delivered/i);
});

test("extension delivery injects a durable item once and acks it after the injection", async () => {
  const sent = [];
  const acks = [];
  const deliver = onceDelivery({ send: async (m) => sent.push(m.prompt), ack: (id) => acks.push(id), onError: () => assert.fail("no error") });
  await deliver({ prompt: "p", deliveryId: "d1" });
  await deliver({ prompt: "p", deliveryId: "d1" });
  assert.deepEqual(sent, ["p"]);
  assert.deepEqual(acks, ["d1"]);
});

test("extension delivery leaves plain messages alone and lets a failed injection be redelivered", async () => {
  const sent = [];
  const acks = [];
  const errors = [];
  let fail = true;
  const deliver = onceDelivery({
    send: async (m) => {
      if (fail) throw new Error("busy");
      sent.push(m.prompt);
    },
    ack: (id) => acks.push(id),
    onError: (e) => errors.push(e.message),
  });
  await deliver({ prompt: "p", deliveryId: "d1" });
  assert.deepEqual(errors, ["busy"]);
  assert.deepEqual(acks, []);
  fail = false;
  await deliver({ prompt: "p", deliveryId: "d1" });
  await deliver({ prompt: "x" });
  await deliver({ prompt: "x" });
  assert.deepEqual(sent, ["p", "x", "x"]);
  assert.deepEqual(acks, ["d1"]);
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
  assert.match(formatList(registry, "cli:child"), /- parent-name\S* .*your parent/);
  assert.match(formatList(registry, "cli:parent"), /- child-name\S* .*your child/);
  assert.doesNotMatch(formatList(registry, "cli:child"), /other-name.*your (parent|child)/);
  assert.doesNotMatch(formatList(registry, "cli:other"), /your (parent|child)/);
  registry.rename("cli:parent", "renamed");
  assert.match(formatList(registry, "cli:child"), /- renamed\S* .*your parent/);
});

test("delegation tools exist only for desktop aliases", () => {
  assert.equal(delegationToolsAllowed("app:123"), true);
  assert.equal(delegationToolsAllowed("cli:abc"), false);
  assert.equal(delegationToolsAllowed(null), false);
});

test("a report from a child with a folder carries fromCwd and keeps it through the on-disk queue", () => {
  const { d, file, registry, parentPush } = setup();
  registry.upsert({ key: "cli:child", name: "badacz", kind: "cli", cwd: "/kid dir", push: () => true });
  d.report("cli:child", "wynik");
  assert.equal(parentPush[0].fromCwd, "/kid dir");
  assert.match(parentPush[0].prompt, new RegExp(String.raw`^\[from ${KID}\]\n\[folder "\/kid dir"\]\nwynik`));
  const push = [];
  const registry2 = new Registry();
  registry2.upsert({ key: "cli:parent", name: "mama", kind: "cli", push: (m) => (push.push(m), true) });
  new Delegation({ registry: registry2, store: new DelegationStore(file) }).attached("cli:parent");
  assert.equal(push[0].fromCwd, "/kid dir");
  assert.match(push[0].prompt, new RegExp(String.raw`^\[from ${KID}\]\n\[folder "\/kid dir"\]\nwynik`));
});

test("a report from a child without a folder has no fromCwd; relay notices never get one", () => {
  const { d, parentPush } = setup();
  d.report("cli:child", "wynik");
  assert.equal("fromCwd" in parentPush[0], false);
  assert.match(parentPush[0].prompt, new RegExp(String.raw`^\[from ${KID}\]\nwynik`));
  d.outcome("cli:parent", { requestId: "r", kind: "created", name: "badacz", text: "ok" });
  assert.equal("fromCwd" in parentPush[1], false);
});

// ---- store schema: tasks, recipient outbox, reopen requests, forget ----
function freshStore() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deleg-"));
  dirs.push(dir);
  const file = path.join(dir, "delegations.json");
  return { file, store: new DelegationStore(file) };
}

test("link records createdAt once and setTask works only once", async () => {
  const { store } = freshStore();
  store.link("cli:c", "cli:p", "c");
  const created = store.linkOf("cli:c").createdAt;
  assert.equal(typeof created, "number");
  await tick(5);
  store.link("cli:c", "cli:p", "c2");
  assert.equal(store.linkOf("cli:c").createdAt, created);
  assert.equal(store.setTask("cli:c", "do it"), true);
  assert.equal(store.setTask("cli:c", "other"), false);
  assert.equal(store.taskOf("cli:c"), "do it");
  store.link("cli:c", "cli:p", "c3");
  assert.equal(store.taskOf("cli:c"), "do it");
  assert.equal(store.setTask("cli:none", "x"), false);
  assert.equal(store.taskOf("cli:none"), "");
  assert.equal(store.linkOf("cli:none"), null);
  assert.deepEqual(store.allLinks().map(([k]) => k), ["cli:c"]);
});

test("an old file with parentKey outbox items and no reopens loads", () => {
  const { file } = freshStore();
  writeFileSync(file, JSON.stringify({
    links: { "cli:c": { parent: "cli:p", name: "c", reported: false, ended: false } },
    outbox: { a: { id: "a", parentKey: "cli:p", from: "c", text: "t", prompt: "t" } },
  }));
  const store = new DelegationStore(file);
  assert.equal(store.pending("cli:p").length, 1);
  assert.equal(store.pending("cli:p")[0].toKey, "cli:p");
  assert.deepEqual(store.reopensFrom("cli:p"), []);
  assert.equal(store.taskOf("cli:c"), "");
});

test("descendantsOf walks the subtree in createdAt order", async () => {
  const { store } = freshStore();
  store.link("cli:a", "cli:p", "a");
  await tick(5);
  store.link("cli:b", "cli:p", "b");
  await tick(5);
  store.link("cli:c", "cli:a", "c");
  assert.deepEqual(store.descendantsOf("cli:p"), ["cli:a", "cli:c", "cli:b"]);
  assert.deepEqual(store.descendantsOf("cli:c"), []);
});

test("descendantsOf terminates on a cycle and on a self-parent", () => {
  const { store } = freshStore();
  store.link("cli:a", "cli:b", "a");
  store.link("cli:b", "cli:a", "b");
  store.link("cli:c", "cli:c", "c");
  assert.deepEqual(store.descendantsOf("cli:a"), ["cli:b"]);
  assert.deepEqual(store.descendantsOf("cli:b"), ["cli:a"]);
  assert.deepEqual(store.descendantsOf("cli:c"), []);
});

test("awaiting items are not pending until released", () => {
  const { file, store } = freshStore();
  store.enqueue({ id: "i1", toKey: "cli:x", text: "t", awaiting: "r1" });
  assert.equal(store.pending("cli:x").length, 0);
  assert.equal(store.awaitingFor("r1").length, 1);
  store.release("r1");
  assert.equal(store.pending("cli:x").length, 1);
  assert.equal(store.awaitingFor("r1").length, 0);
  assert.equal(new DelegationStore(file).pending("cli:x").length, 1);
});

test("dropAwaiting removes and returns the items of one request", () => {
  const { file, store } = freshStore();
  store.enqueue({ id: "i1", toKey: "cli:x", awaiting: "r1" });
  store.enqueue({ id: "i2", toKey: "cli:x", awaiting: "r2" });
  store.enqueue({ id: "i3", toKey: "cli:x" });
  assert.deepEqual(store.dropAwaiting("r1").map((i) => i.id), ["i1"]);
  assert.equal(store.awaitingFor("r2").length, 1);
  assert.equal(store.pending("cli:x").length, 1);
  assert.deepEqual(store.dropAwaiting("r1"), []);
  const again = new DelegationStore(file);
  assert.equal(again.awaitingFor("r1").length, 0);
  assert.equal(again.awaitingFor("r2").length, 1);
});

test("forget removes link, its outbox and reopens, and orphans its children", () => {
  const { store } = freshStore();
  store.link("cli:k", "cli:p", "k");
  store.link("cli:child", "cli:k", "child");
  store.enqueue({ id: "o1", toKey: "cli:k" });
  store.enqueue({ id: "o2", toKey: "cli:other" });
  store.addReopen({ requestId: "r1", fromKey: "cli:k", targetKey: "cli:t" });
  store.addReopen({ requestId: "r2", fromKey: "cli:s", targetKey: "cli:k" });
  store.addReopen({ requestId: "r3", fromKey: "cli:s", targetKey: "cli:t" });
  store.forget("cli:k");
  assert.equal(store.linkOf("cli:k"), null);
  assert.equal(store.pending("cli:k").length, 0);
  assert.equal(store.pending("cli:other").length, 1);
  assert.deepEqual(store.reopensFrom("cli:k"), []);
  assert.equal(store.reopenFor("cli:s", "cli:k"), null);
  assert.equal(store.reopenFor("cli:s", "cli:t").requestId, "r3");
  assert.equal(store.linkOf("cli:child").parentDeleted, true);
  assert.equal(store.linkOf("cli:child").parent, "cli:k");
  assert.equal(store.linkOf("cli:k"), null);
});

test("reopens survive a new store instance", () => {
  const { file, store } = freshStore();
  store.addReopen({ requestId: "r1", fromKey: "cli:a", targetKey: "cli:b" });
  const again = new DelegationStore(file);
  assert.equal(again.reopensFrom("cli:a").length, 1);
  assert.equal(again.reopenFor("cli:a", "cli:b").requestId, "r1");
  again.removeReopen("r1");
  assert.equal(new DelegationStore(file).reopenFor("cli:a", "cli:b"), null);
});

test("a child can request its own child", () => {
  const { d, childControl } = setup();
  assert.match(d.requestCreate("cli:child", req), /Do not wait/);
  assert.equal(childControl[0][0], "session_request");
});

test("died sends the ended notice once, only for an unreported child", () => {
  const { d, store, parentPush } = setup();
  d.died("cli:child");
  d.died("cli:child");
  assert.equal(store.pending("cli:parent").length, 1);
  assert.equal(parentPush.length, 1);
  assert.equal(parentPush[0].wake, true);
  assert.match(parentPush[0].text, new RegExp(String.raw`Session "${KID}" ended without reporting a result\. You can ask the user to reopen it\.`));
  const rep = setup();
  rep.d.report("cli:child", "done");
  rep.d.died("cli:child");
  assert.equal(rep.parentPush.length, 1);
  assert.doesNotMatch(rep.parentPush[0].text, /ended without/);
});

test("removing a peer from the registry produces no notice", () => {
  const { registry, parentPush, store } = setup();
  registry.remove("cli:child");
  assert.equal(parentPush.length, 0);
  assert.equal(store.pending("cli:parent").length, 0);
});

function family() {
  const s = setup();
  s.registry.upsert({ key: "cli:kid2", name: "docs", kind: "cli", push: () => true });
  s.registry.upsert({ key: "cli:grand", name: "wnuk", kind: "cli", push: () => true });
  s.d.link("cli:kid2", "cli:parent");
  s.d.link("cli:grand", "cli:child");
  s.d.setTask("cli:child", "Write e2e tests for /orders\nsecond line");
  s.d.setBusy("cli:child", true);
  s.d.report("cli:kid2", "ok");
  s.registry.disconnect("cli:kid2");
  clearTimeout(s.registry.get("cli:kid2").offlineTimer);
  return s;
}
const nm = (r, k) => r.get(k).name;

test("familyBlock lists direct children with state, task and grandchild badge", () => {
  const { d, registry } = family();
  assert.equal(
    d.familyBlock("cli:parent"),
    [
      "Your children (2) — names are current; a closed child can still be messaged (the user is asked to reopen it):",
      `- "${nm(registry, "cli:child")}" — open, working — task: Write e2e tests for /orders [has 1 children]`,
      `- "${nm(registry, "cli:kid2")}" — closed, reported — task: (task not recorded)`,
    ].join("\n"),
  );
  assert.equal(d.familyBlock("cli:grand"), `Your parent: "${nm(registry, "cli:child")}" — open`);
  d.setBusy("cli:child", false);
  assert.match(d.familyBlock("cli:parent"), /— open, idle —/);
  d.setTask("cli:grand", "x".repeat(130));
  assert.match(d.familyBlock("cli:child"), new RegExp(`task: ${"x".repeat(120)}…$`, "m"));
});

test("familyBlock parent line shows closed and deleted", () => {
  const { d, store, registry } = setup();
  registry.disconnect("cli:parent");
  clearTimeout(registry.get("cli:parent").offlineTimer);
  assert.match(d.familyBlock("cli:child"), /— closed$/);
  store.forget("cli:parent");
  assert.match(d.familyBlock("cli:child"), /— deleted$/);
});

test("familyBlock is empty for a session without relatives", () => {
  const { d, registry } = setup();
  registry.upsert({ key: "cli:solo", name: "solo", kind: "cli" });
  assert.equal(d.familyBlock("cli:solo"), "");
  assert.equal(d.decorate("cli:solo", "hi"), "hi");
});

test("isRelative is true for parent and child only", () => {
  const { d } = family();
  assert.ok(d.isRelative("cli:parent", "cli:child") && d.isRelative("cli:child", "cli:parent"));
  assert.ok(!d.isRelative("cli:parent", "cli:grand"));
});

test("a report delivered to a parent carries the children block; the stored prompt stays raw", () => {
  const { d, parentPush, store } = setup();
  d.setTask("cli:child", "do it");
  d.report("cli:child", "wynik");
  assert.match(parentPush[0].prompt, /wynik[\s\S]*Your children \(1\)[\s\S]*task: do it/);
  assert.doesNotMatch(store.pending("cli:parent")[0].prompt, /Your children/);
});

test("list_sessions shows the family block even when nobody else is online", () => {
  const { d, registry } = setup();
  registry.remove("cli:child");
  const out = formatList(registry, "cli:parent", d);
  assert.match(out, /\(no other sessions online\)/);
  assert.match(out, /Your children \(1\)/);
  const lone = new Registry();
  lone.upsert({ key: "cli:x", name: "x", kind: "cli" });
  assert.equal(formatList(lone, "cli:x", null), "(no other sessions online)");
});

test("snapshot reports online and busy from the registry", () => {
  const { d, registry } = family();
  const snap = Object.fromEntries(d.snapshot().map((e) => [e.key, e]));
  assert.equal(snap["cli:child"].busy, true);
  assert.equal(snap["cli:child"].online, true);
  assert.equal(snap["cli:child"].parent, "cli:parent");
  assert.equal(snap["cli:child"].name, nm(registry, "cli:child"));
  assert.equal(snap["cli:kid2"].online, false);
  assert.equal(snap["cli:kid2"].reported, true);
  assert.equal(typeof snap["cli:child"].createdAt, "number");
  d.setBusy("nope", true); // unknown key: no-op
});

test("onChange fires on link, setTask, report, setBusy and online/offline", () => {
  const { d, registry } = setup();
  let n = 0;
  d.onChange(() => n++);
  d.onChange(() => {
    throw new Error("boom");
  });
  const bumped = (fn) => {
    const before = n;
    fn();
    assert.ok(n > before);
  };
  bumped(() => d.link("cli:child", "cli:parent"));
  bumped(() => d.setTask("cli:child", "t"));
  bumped(() => d.setBusy("cli:child", true));
  bumped(() => d.report("cli:child", "r"));
  bumped(() => registry.disconnect("cli:child"));
  clearTimeout(registry.get("cli:child").offlineTimer);
});
