// Tests for electron/asides.mjs (saved side-question cards) in a temp folder.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { cleanEntry, dropAsides, listAsides, pruneAsides, removeAside, saveAside } from "../asides.mjs";

const SID = "9101a108-adc1-4b85-bb25-a5a99f632c58";
let dir;
beforeEach(() => (dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "asides-test-")), "side-questions")));
afterEach(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));

const entry = (id, turn, extra = {}) => ({ id, turn, at: "2026-11-05T18:30:00.000Z", question: `q${id}`, answer: `a${id}`, state: "done", ...extra });

describe("asides store", () => {
  test("nothing saved: empty list, no folder", () => {
    assert.deepEqual(listAsides(dir, SID), []);
    assert.ok(!fs.existsSync(dir));
  });

  test("save, replace by id, remove", () => {
    saveAside(dir, SID, entry("a", 1));
    saveAside(dir, SID, entry("b", 2));
    saveAside(dir, SID, entry("a", 1, { sentAt: "2026-11-05T18:31:00.000Z", collapsed: true }));
    const list = listAsides(dir, SID);
    assert.deepEqual(list.map((e) => e.id), ["a", "b"]);
    assert.equal(list[0].sentAt, "2026-11-05T18:31:00.000Z");
    assert.equal(list[0].collapsed, true);
    removeAside(dir, SID, "a");
    assert.deepEqual(listAsides(dir, SID).map((e) => e.id), ["b"]);
    removeAside(dir, SID, "b");
    assert.equal(fs.readdirSync(dir).length, 0); // the last one removes the file
  });

  test("prune drops questions of removed turns; drop removes everything", () => {
    for (const [id, turn] of [["a", 1], ["b", 2], ["c", 3]]) saveAside(dir, SID, entry(id, turn));
    pruneAsides(dir, SID, 2);
    assert.deepEqual(listAsides(dir, SID).map((e) => e.id), ["a", "b"]);
    dropAsides(dir, SID);
    assert.deepEqual(listAsides(dir, SID), []);
  });

  test("rejects bad ids and entries; unknown fields and states are cleaned", () => {
    assert.throws(() => listAsides(dir, "../x"), /Invalid session id/);
    assert.throws(() => saveAside(dir, SID, { id: "../../x", turn: 1 }), /Invalid side question/);
    assert.throws(() => saveAside(dir, SID, { id: "a", turn: -1 }), /Invalid side question/);
    const e = cleanEntry({ ...entry("a", 0), state: "running", evil: 1, question: 5 });
    assert.equal(e.state, "done");
    assert.equal(e.question, "");
    assert.ok(!("evil" in e));
  });

  test("a corrupt file reads as empty", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${SID}.json`), "{nope");
    assert.deepEqual(listAsides(dir, SID), []);
  });
});
