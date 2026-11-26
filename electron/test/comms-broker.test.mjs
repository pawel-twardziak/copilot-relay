// The broker writes one communication-log event per message path (src/delegation.mjs, src/registry.mjs).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { CommsLog } from "../../src/comms-log.mjs";
import { Delegation } from "../../src/delegation.mjs";
import { DelegationStore } from "../../src/delegation-store.mjs";
import { Registry } from "../../src/registry.mjs";

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** parent "mama" and child "badacz" (linked), both app sessions; hooks wired as in server.mjs. `comms: false` = no log. */
function setup({ comms: withComms = true } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "comms-broker-"));
  dirs.push(dir);
  const registry = new Registry();
  const store = new DelegationStore(path.join(dir, "delegations.json"));
  let n = 0;
  const comms = withComms ? new CommsLog({ file: path.join(dir, "communications.jsonl"), newId: () => `e${++n}` }) : undefined;
  let m = 0;
  const d = new Delegation({ registry, store, comms, newId: () => `id${++m}` });
  registry.comms = comms;
  registry.offlineRelative = (f, nm, t) => d.messageClosed(f, nm, t);
  registry.appMessage = (f, t, x) => d.appMessage(f, t, x);
  registry.userMessage = (t, x) => d.userMessage(t, x);
  const pushes = {};
  const controls = {};
  const add = (key, name, extra = {}) => {
    pushes[key] = [];
    controls[key] = [];
    registry.upsert({ key, name, kind: "cli", app: true, push: (msg) => (pushes[key].push(msg), true), control: (...a) => controls[key].push(a), ...extra });
  };
  add("cli:parent", "mama");
  add("cli:child", "badacz");
  d.link("cli:child", "cli:parent");
  const events = () => comms?.items.map((i) => i.event) ?? [];
  const msgs = () => events().filter((e) => e.kind !== "status");
  const statuses = (id) => events().filter((e) => e.kind === "status" && e.ref === id).map((e) => e.status);
  const nm = (key) => registry.get(key).name; // a registry name carries a suffix
  return { nm, dir, registry, store, comms, d, pushes, controls, add, events, msgs, statuses };
}

const close = (s, key) => {
  s.registry.disconnect(key);
  clearTimeout(s.registry.get(key).offlineTimer);
};

test("setTask logs one task event; a second setTask does not", () => {
  const s = setup();
  assert.equal(s.d.setTask("cli:child", "do it"), true);
  assert.deepEqual(s.msgs().map((e) => [e.kind, e.fromKey, e.toKey, e.from, e.to, e.status, e.preview]), [
    ["task", "cli:parent", "cli:child", s.nm("cli:parent"), s.nm("cli:child"), "delivered", "do it"],
  ]);
  s.d.setTask("cli:child", "again");
  assert.equal(s.msgs().length, 1);
});

test("send_message between app sessions logs one message event with the outbox id", () => {
  const s = setup();
  s.registry.send("cli:child", s.nm("cli:parent"), "hello");
  const [e, ...rest] = s.msgs();
  assert.equal(rest.length, 0);
  assert.deepEqual([e.id, e.kind, e.fromKey, e.toKey, e.from, e.to, e.status], ["id1", "message", "cli:child", "cli:parent", s.nm("cli:child"), s.nm("cli:parent"), "delivered"]);
  assert.equal(s.pushes["cli:parent"][0].fromKey, "cli:child");
});

test("send_message to a non-app peer logs delivered, to an offline one queued", () => {
  const s = setup();
  s.add("cli:x", "plain", { app: false });
  s.registry.send("cli:parent", s.nm("cli:x"), "one");
  assert.equal(s.msgs()[0].status, "delivered");
  assert.equal(s.msgs()[0].fromKey, "cli:parent");
  s.add("cli:y", "gone", { app: false, push: () => false });
  s.registry.send("cli:parent", s.nm("cli:y"), "two");
  assert.equal(s.msgs()[1].status, "queued");
  assert.equal(s.msgs().length, 2);
});

test("a budget block logs blocked (Registry.send and messageClosed)", () => {
  const s = setup();
  s.registry.budget = 0;
  s.add("cli:x", "plain", { app: false });
  s.registry.send("cli:parent", s.nm("cli:x"), "nope");
  assert.deepEqual([s.msgs()[0].kind, s.msgs()[0].status, s.msgs()[0].to], ["message", "blocked", s.nm("cli:x")]);
  // a linked pair with no budget left, the child closed
  s.registry.pairBudgets.set("cli:parent|cli:child", 0);
  close(s, "cli:child");
  s.d.messageClosed("cli:parent", s.nm("cli:child"), "late");
  const blocked = s.msgs().filter((e) => e.status === "blocked");
  assert.equal(blocked.length, 2);
  assert.deepEqual([blocked[1].fromKey, blocked[1].toKey, blocked[1].from, blocked[1].to], ["cli:parent", "cli:child", s.nm("cli:parent"), s.nm("cli:child")]);
});

test("report logs report delivered; to an offline parent queued, then attached logs delivered once", () => {
  const s = setup();
  s.d.report("cli:child", "done");
  assert.deepEqual([s.msgs()[0].kind, s.msgs()[0].status, s.msgs()[0].id], ["report", "delivered", "id1"]);
  const t = setup();
  close(t, "cli:parent");
  t.d.report("cli:child", "done");
  const [r] = t.msgs();
  assert.deepEqual([r.kind, r.status], ["report", "queued"]);
  t.add("cli:parent", "mama");
  t.d.attached("cli:parent");
  t.d.attached("cli:parent");
  assert.deepEqual(t.statuses(r.id), ["delivered"]);
  assert.equal(t.msgs().length, 1);
});

test("messageClosed logs awaiting-reopen; approve with the target still closed logs no status; attached does", () => {
  const s = setup();
  close(s, "cli:child");
  s.d.messageClosed("cli:parent", s.nm("cli:child"), "wake up");
  const [e] = s.msgs();
  assert.deepEqual([e.kind, e.status, e.fromKey, e.toKey], ["message", "awaiting-reopen", "cli:parent", "cli:child"]);
  const reqId = s.controls["cli:parent"].find((c) => c[0] === "reopen_request")[1].requestId;
  assert.equal(s.d.answerReopen("cli:parent", reqId, true), true);
  assert.deepEqual(s.statuses(e.id), []);
  s.add("cli:child", "badacz");
  s.d.attached("cli:child");
  assert.deepEqual(s.statuses(e.id), ["delivered"]);
});

test("approve with the target already open logs delivered", () => {
  const s = setup();
  close(s, "cli:child");
  s.d.messageClosed("cli:parent", s.nm("cli:child"), "wake up");
  s.add("cli:child", "badacz");
  const reqId = s.controls["cli:parent"].find((c) => c[0] === "reopen_request")[1].requestId;
  s.d.answerReopen("cli:parent", reqId, true);
  assert.deepEqual(s.statuses(s.msgs()[0].id), ["delivered"]);
});

test("rejected reopen, release and forget log dropped; forget purges the key", () => {
  const s = setup();
  close(s, "cli:child");
  s.d.messageClosed("cli:parent", s.nm("cli:child"), "one");
  const first = s.msgs()[0].id;
  const reqId = s.controls["cli:parent"].find((c) => c[0] === "reopen_request")[1].requestId;
  s.d.answerReopen("cli:parent", reqId, false);
  assert.deepEqual(s.statuses(first), ["dropped"]);
  // the notice to the sender ("not delivered") is logged as from relay
  assert.ok(s.msgs().some((e) => e.kind === "notice" && e.toKey === "cli:parent"));

  // release drops the awaiting item of the pair
  s.d.messageClosed("cli:parent", s.nm("cli:child"), "two");
  const second = s.msgs().find((e) => e.preview === "two").id;
  s.registry.get("cli:parent").linkCards = true;
  s.d.requestLink("cli:parent", "release", s.nm("cli:child"));
  const link = s.controls["cli:parent"].filter((c) => c[0] === "link_request").pop()[1];
  s.d.answerLink("cli:parent", link.requestId, true);
  assert.deepEqual(s.statuses(second), ["dropped"]);

  // forget drops queued items of the key and purges its events
  const f = setup();
  close(f, "cli:child");
  f.d.report("cli:child", "r"); // delivered to the parent: stays
  f.d.messageClosed("cli:parent", f.nm("cli:child"), "held");
  const heldId = f.msgs().find((e) => e.preview === "held").id;
  const spy = [];
  const real = f.comms.status.bind(f.comms);
  f.comms.status = (ref, st) => (spy.push([ref, st]), real(ref, st));
  f.d.forget("cli:child");
  assert.ok(spy.some(([ref, st]) => ref === heldId && st === "dropped"));
  assert.deepEqual(f.comms.eventsOf(["cli:child"]), []);
});

test("notices and informs log notice from relay; userMessage logs user", () => {
  const s = setup();
  s.registry.get("cli:parent").linkCards = true;
  s.d.outcome("cli:parent", { kind: "other", text: "a notice" });
  const [n] = s.msgs();
  assert.deepEqual([n.kind, n.fromKey, n.from, n.toKey, n.to, n.status, n.id], ["notice", null, "relay", "cli:parent", s.nm("cli:parent"), "delivered", "id1"]);
  s.d.outcome("cli:parent", { kind: "created", text: "created!" });
  const inf = s.msgs()[1];
  assert.deepEqual([inf.kind, inf.from, inf.status], ["notice", "relay", "delivered"]);
  s.d.userMessage("cli:child", "hi there");
  const u = s.msgs()[2];
  assert.deepEqual([u.kind, u.fromKey, u.from, u.to, u.status], ["user", null, "user", s.nm("cli:child"), "delivered"]);
  s.add("cli:x", "plain", { app: false });
  s.registry.sendFromUser(s.nm("cli:x"), "yo");
  const u2 = s.msgs()[3];
  assert.deepEqual([u2.kind, u2.from, u2.to, u2.status], ["user", "user", s.nm("cli:x"), "delivered"]);
  s.registry.sendFromUser(s.nm("cli:child"), "app one");
  assert.equal(s.msgs().length, 5); // an app recipient: exactly one event
});

test("ack logs taken by default and discarded with the outcome", () => {
  const s = setup();
  s.registry.send("cli:parent", s.nm("cli:child"), "a");
  s.registry.send("cli:parent", s.nm("cli:child"), "b");
  const [a, b] = s.msgs();
  assert.equal(s.d.ack("cli:child", a.id), true);
  assert.equal(s.d.ack("cli:child", b.id, "discarded"), true);
  assert.equal(s.d.ack("cli:child", a.id), false);
  assert.deepEqual(s.statuses(a.id), ["taken"]);
  assert.deepEqual(s.statuses(b.id), ["discarded"]);
});

test("snapshot has endedNotice; the push carries fromKey", () => {
  const s = setup();
  assert.equal(s.d.snapshot().find((l) => l.key === "cli:child").endedNotice, false);
  s.d.died("cli:child");
  assert.equal(s.d.snapshot().find((l) => l.key === "cli:child").endedNotice, true);
  assert.equal(s.store.isEndedNotice("cli:child"), true);
  s.d.report("cli:parent", "x"); // not a child: nothing
  s.registry.send("cli:parent", s.nm("cli:child"), "hi");
  assert.equal(s.pushes["cli:child"].at(-1).fromKey, "cli:parent");
});

test("without comms nothing changes (no throw)", () => {
  const s = setup({ comms: false });
  s.d.setTask("cli:child", "t");
  s.registry.send("cli:child", s.nm("cli:parent"), "m");
  s.d.report("cli:child", "r");
  s.d.userMessage("cli:child", "u");
  s.d.outcome("cli:parent", { kind: "created", text: "c" });
  s.d.outcome("cli:parent", { kind: "x", text: "n" });
  s.d.ack("cli:parent", "id1");
  s.d.forget("cli:child");
  assert.ok(s.pushes["cli:parent"].length >= 2);
});
