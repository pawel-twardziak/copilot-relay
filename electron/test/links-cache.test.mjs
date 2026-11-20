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

test("a missing or corrupt cache reads as []", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "links-cache.json");
  assert.deepEqual(readLinksCache(file), []);
  writeFileSync(file, "{not json");
  assert.deepEqual(readLinksCache(file), []);
  writeFileSync(file, JSON.stringify({ links: [] })); // valid JSON, but not an array
  assert.deepEqual(readLinksCache(file), []);
});

test("write then read round-trips", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "sub", "links-cache.json"); // the folder is created on the first write
  const links = [
    { key: "cli:a", parent: null, name: "main-1a2b3c", task: null, createdAt: 1, reported: false, parentDeleted: false, online: true, busy: false },
    { key: "cli:b", parent: "cli:a", name: "kid-4d5e6f", task: "Check X", createdAt: 2, reported: true, parentDeleted: false, online: false, busy: false },
  ];
  writeLinksCache(file, links);
  assert.deepEqual(readLinksCache(file), links);
  writeLinksCache(file, []);
  assert.deepEqual(readLinksCache(file), []);
  assert.deepEqual(readdirSync(path.dirname(file)), ["links-cache.json"]); // no temp file left behind
});
