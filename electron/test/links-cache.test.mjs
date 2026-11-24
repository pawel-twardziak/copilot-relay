// Tests for the app's read cache of the broker's link tree.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readLinksCache, writeLinksCache } from "../links-cache.mjs";

const tempDir = (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "links-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("a missing or corrupt cache reads as empty", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "links-cache.json");
  const empty = { links: [], held: {}, heldByKind: {} };
  assert.deepEqual(readLinksCache(file), empty);
  writeFileSync(file, "{not json");
  assert.deepEqual(readLinksCache(file), empty);
  writeFileSync(file, JSON.stringify({ links: "x", held: [] })); // valid JSON of the wrong shape
  assert.deepEqual(readLinksCache(file), empty);
});

test("write then read round-trips", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "sub", "links-cache.json"); // the folder is created on the first write
  const links = [
    { key: "cli:a", parent: null, name: "main-1a2b3c", task: null, createdAt: 1, reported: false, parentDeleted: false, online: true, busy: false },
    { key: "cli:b", parent: "cli:a", name: "kid-4d5e6f", task: "Check X", createdAt: 2, reported: true, parentDeleted: false, online: false, busy: false },
  ];
  writeLinksCache(file, { links, held: {}, heldByKind: {} });
  assert.deepEqual(readLinksCache(file), { links, held: {}, heldByKind: {} });
  writeLinksCache(file, { links: [], held: {}, heldByKind: {} });
  assert.deepEqual(readLinksCache(file), { links: [], held: {}, heldByKind: {} });
  assert.deepEqual(readdirSync(path.dirname(file)), ["links-cache.json"]); // no temp file left behind
});

test("readLinksCache accepts an old array file", (t) => {
  const file = path.join(tempDir(t), "links-cache.json");
  writeFileSync(file, '[{"key":"cli:a"}]');
  assert.deepEqual(readLinksCache(file), { links: [{ key: "cli:a" }], held: {}, heldByKind: {} });
});

test("writeLinksCache and readLinksCache keep held", (t) => {
  const file = path.join(tempDir(t), "links-cache.json");
  const heldByKind = { "cli:p": { child: 1, parent: 0, other: 1 } };
  writeLinksCache(file, { links: [], held: { "cli:p": 2 }, heldByKind });
  assert.deepEqual(readLinksCache(file), { links: [], held: { "cli:p": 2 }, heldByKind });
});

test("a file without heldByKind reads it as {}", (t) => {
  const file = path.join(tempDir(t), "links-cache.json");
  writeFileSync(file, JSON.stringify({ links: [], held: { "cli:p": 2 } }));
  assert.deepEqual(readLinksCache(file), { links: [], held: { "cli:p": 2 }, heldByKind: {} });
});
