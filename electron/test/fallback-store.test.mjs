// The reply-fallback approval switch: per session, null follows the Settings default.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createFallbackStore } from "../fallback-store.mjs";

const storeFile = (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fallback-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "fallback-approval.json");
};
const stored = (file) => JSON.parse(readFileSync(file, "utf8"));

test("a session without an entry follows Settings (null)", (t) => {
  assert.equal(createFallbackStore(storeFile(t)).get("a"), null);
});

test("set stores true or false and reads back, also from a new store", (t) => {
  const file = storeFile(t);
  const s = createFallbackStore(file);
  s.set("a", false);
  s.set("b", true);
  assert.equal(s.get("a"), false);
  assert.equal(s.get("b"), true);
  assert.deepEqual(stored(file), { a: false, b: true });
  assert.equal(createFallbackStore(file).get("a"), false);
});

test("set(id, null) removes the entry", (t) => {
  const file = storeFile(t);
  const s = createFallbackStore(file);
  s.set("a", false);
  s.set("a", null);
  assert.equal(s.get("a"), null);
  assert.deepEqual(stored(file), {});
});

test("copy and delete", (t) => {
  const s = createFallbackStore(storeFile(t));
  s.set("a", false);
  s.copy("a", "b");
  assert.equal(s.get("b"), false);
  s.copy("c", "d"); // no entry copies as nothing
  assert.equal(s.get("d"), null);
  s.delete("a");
  assert.equal(s.get("a"), null);
  assert.equal(s.get("b"), false);
});

test("an unwritable file throws on set; copy and delete only log", (t) => {
  const file = storeFile(t);
  mkdirSync(file); // a directory where the file should be
  const s = createFallbackStore(file);
  assert.throws(() => s.set("a", false));
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = warn; });
  s.copy("a", "b");
  s.delete("a");
});
