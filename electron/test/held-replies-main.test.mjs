// The hold switch (per session, default on, only "off" stored) and the cache of held child replies.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createHeldCache, createHoldStore, HELD_KINDS, heldKind } from "../held-replies.mjs";

const storeFile = (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "held-replies-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "held-replies.json");
};
const stored = (file) => JSON.parse(readFileSync(file, "utf8"));

test("every switch is on by default and only off is stored", (t) => {
  const file = storeFile(t);
  const s = createHoldStore(file);
  assert.deepEqual(s.get("a"), { child: true, parent: true, other: true, user: true });
  s.set("a", "parent", false);
  assert.deepEqual(s.get("a"), { child: true, parent: false, other: true, user: true });
  assert.deepEqual(stored(file), { a: { parent: false } });
  assert.deepEqual(createHoldStore(file).get("a"), { child: true, parent: false, other: true, user: true });
  s.set("a", "parent", true);
  assert.deepEqual(stored(file), {});
  assert.throws(() => s.set("a", "nope", false));
});

test("a file of v0.22 reads as child off, and child-only off is still written that way", (t) => {
  const file = storeFile(t);
  writeFileSync(file, JSON.stringify({ a: false }));
  const s = createHoldStore(file);
  assert.deepEqual(s.get("a"), { child: false, parent: true, other: true, user: true });
  s.set("b", "child", false);
  assert.deepEqual(stored(file), { a: false, b: false });
  s.set("b", "user", false);
  assert.deepEqual(stored(file).b, { child: false, user: false });
});

test("the switches are copied on a fork and deleted with the session", (t) => {
  const s = createHoldStore(storeFile(t));
  s.set("a", "child", false);
  s.set("a", "other", false);
  s.copy("a", "b");
  assert.deepEqual(s.get("b"), { child: false, parent: true, other: false, user: true });
  s.copy("c", "d"); // all on copies as nothing
  assert.deepEqual(s.get("d"), { child: true, parent: true, other: true, user: true });
  s.delete("a");
  assert.deepEqual(s.get("a"), { child: true, parent: true, other: true, user: true });
});

test("heldKind reads fromChild and heldAs", () => {
  assert.equal(heldKind({ fromChild: true }), "child");
  assert.equal(heldKind({ heldAs: "parent" }), "parent");
  assert.equal(heldKind({ heldAs: "user" }), "user");
  assert.equal(heldKind({ heldAs: "bogus" }), null);
  assert.equal(heldKind({}), null);
  assert.deepEqual(HELD_KINDS, ["child", "parent", "other", "user"]);
});

test("the held cache keeps marked messages per session in arrival order until acked", () => {
  const c = createHeldCache();
  assert.equal(c.add("s", { deliveryId: "1" }), true);
  assert.equal(c.add("s", { deliveryId: "2" }), true);
  assert.equal(c.add("s", { deliveryId: "1" }), false);
  assert.equal(c.add("t", { deliveryId: "1" }), true);
  assert.deepEqual(c.list("s").map((m) => m.deliveryId), ["1", "2"]);
  c.ack("s", "1");
  assert.deepEqual(c.list("s").map((m) => m.deliveryId), ["2"]);
  assert.deepEqual(c.list("t").map((m) => m.deliveryId), ["1"]);
  c.drop("s");
  assert.deepEqual(c.list("s"), []);
});
