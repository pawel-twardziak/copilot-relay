// Tests for pruning in src/name-store.mjs.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { NameStore } from "../../src/name-store.mjs";

test("pruning drops the oldest unprotected entries and never a kept one", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "names-"));
  try {
    const s = new NameStore(path.join(dir, "names.json"), { keep: (k) => k === "cli:old" });
    s.set("cli:old", "protected", "");
    s.set("cli:gone", "unprotected", "");
    s.data["cli:old"].seen = 1; // oldest of all
    s.data["cli:gone"].seen = 2;
    for (let i = 0; i < 1000; i++) {
      s.set(`cli:k${i}`, `n${i}`, "");
      s.data[`cli:k${i}`].seen = 100 + i;
    }
    assert.equal(Object.keys(s.data).length, 1000);
    assert.ok(s.get("cli:old"), "protected old entry survives");
    assert.equal(s.get("cli:gone"), undefined, "oldest unprotected entry is pruned");
    assert.ok(s.get("cli:k999"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
