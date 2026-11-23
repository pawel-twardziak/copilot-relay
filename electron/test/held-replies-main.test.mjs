// The hold switch (per session, default on, only "off" stored) and the cache of held child replies.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createHeldCache, createHoldStore } from "../held-replies.mjs";

const storeFile = (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "held-replies-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "held-replies.json");
};
const stored = (file) => JSON.parse(readFileSync(file, "utf8"));

test("the hold switch is on by default and only off is stored", (t) => {
  const file = storeFile(t);
  const s = createHoldStore(file);
  assert.equal(s.get("a"), true);
  s.set("a", false);
  assert.equal(s.get("a"), false);
  assert.deepEqual(stored(file), { a: false });
  assert.equal(createHoldStore(file).get("a"), false);
  s.set("a", true);
  assert.equal(s.get("a"), true);
  assert.deepEqual(stored(file), {});
  assert.equal(createHoldStore(file).get("a"), true);
});

test("the hold switch is copied on a fork and deleted with the session", (t) => {
  const s = createHoldStore(storeFile(t));
  s.set("a", false);
  s.copy("a", "b");
  assert.equal(s.get("b"), false);
  s.copy("c", "d"); // an on switch copies as nothing
  assert.equal(s.get("d"), true);
  s.delete("a");
  assert.equal(s.get("a"), true);
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
