// Tests for the durable communication log (src/comms-log.mjs).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { CommsLog } from "../../src/comms-log.mjs";

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(opts = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "comms-"));
  dirs.push(dir);
  const file = path.join(dir, "sub", "communications.jsonl");
  let n = 0;
  const make = (o = {}) => new CommsLog({ file, newId: () => `id${++n}`, now: () => 1000 + n, ...opts, ...o });
  return { dir, file, make, log: make() };
}

const msg = (o = {}) => ({ kind: "message", fromKey: "a", toKey: "b", from: "A", to: "B", text: "hi", status: "queued", ...o });
const line = (o) => JSON.stringify({ kind: "message", fromKey: "a", toKey: "b", from: "A", to: "B", size: 1, text: "x", status: "queued", ...o }) + "\n";

test("append returns the public form with preview and size, and the line holds the cut text", () => {
  const { log, file } = setup();
  const ev = log.append(msg({ text: "x".repeat(70000) }));
  assert.equal(ev.size, 70000);
  assert.equal(ev.preview.length, 301);
  assert.ok(ev.preview.endsWith("…"));
  assert.equal("text" in ev, false);
  const t = log.text(ev.id);
  assert.equal(t.length, 65537);
  assert.ok(t.endsWith("…"));
  const stored = JSON.parse(readFileSync(file, "utf8").trim());
  assert.equal("preview" in stored, false);
  assert.equal(stored.text, t);
});

test("a short text has no ellipsis in preview or text", () => {
  const { log } = setup();
  const ev = log.append(msg({ text: "zażółć" }));
  assert.equal(ev.preview, "zażółć");
  assert.equal(ev.size, 6);
  assert.equal(log.text(ev.id), "zażółć");
});

test("text reads the right line back by byte offset with multibyte content", () => {
  const { log, make } = setup();
  const a = log.append(msg({ text: "ąęść🙂".repeat(20) }));
  const b = log.append(msg({ text: "second" }));
  assert.equal(log.text(b.id), "second");
  assert.equal(make().text(a.id), "ąęść🙂".repeat(20));
  assert.equal(log.text("nope"), null);
});

test("a reloaded log has the same events in order", () => {
  const { log, make } = setup();
  const a = log.append(msg({ text: "one" }));
  const b = log.append(msg({ text: "two", toKey: "c" }));
  const s = log.status(a.id, "delivered");
  const again = make();
  assert.deepEqual(again.eventsOf(["a"]), [a, b, s]);
  assert.equal(again.lastStatus(a.id), "delivered");
  assert.equal(again.lastStatus(b.id), "queued");
  assert.equal(again.text(b.id), "two");
});

test("a corrupt middle line and a half-written last line are skipped", () => {
  const { file, make } = setup();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, line({ id: "1", ts: 1, text: "a" }) + line({ id: "2", ts: 2, text: "b" }) + "{broken\n" + line({ id: "3", ts: 3, text: "c" }) + '{"id":"x","ts"');
  const log = make();
  assert.deepEqual(log.eventsOf(["a"]).map((e) => e.id), ["1", "2", "3"]);
  assert.ok(readFileSync(file, "utf8").endsWith("\n"), "the partial tail was cut off");
  const ev = log.append(msg({ text: "d" }));
  assert.equal(make().eventsOf(["a"]).length, 4);
  assert.equal(log.text(ev.id), "d");
  assert.equal(log.text("3"), "c");
});

test("status: unknown ref -> null; delivered only after queued or awaiting-reopen; once", () => {
  const { log } = setup();
  assert.equal(log.status("nope", "taken"), null);
  const q = log.append(msg({ status: "queued" }));
  const d = log.status(q.id, "delivered");
  assert.equal(d.kind, "status");
  assert.equal(d.ref, q.id);
  assert.equal(d.status, "delivered");
  assert.equal(log.status(q.id, "delivered"), null);
  assert.equal(log.status(q.id, "taken").status, "taken");
  assert.equal(log.lastStatus(q.id), "taken");
  const w = log.append(msg({ status: "awaiting-reopen" }));
  assert.ok(log.status(w.id, "delivered"));
  const bl = log.append(msg({ status: "blocked" }));
  assert.equal(log.status(bl.id, "delivered"), null);
  assert.equal(log.lastStatus("nope"), undefined);
});

test("eventsOf: by fromKey or toKey, status events follow their message", () => {
  const { log } = setup();
  const ab = log.append(msg({ fromKey: "a", toKey: "b" }));
  const cd = log.append(msg({ fromKey: "c", toKey: "d" }));
  const bc = log.append(msg({ fromKey: "b", toKey: "c" }));
  const s1 = log.status(ab.id, "delivered");
  const s2 = log.status(cd.id, "delivered");
  assert.deepEqual(log.eventsOf(["a"]), [ab, s1]);
  assert.deepEqual(log.eventsOf(new Set(["d"])), [cd, s2]);
  assert.deepEqual(log.eventsOf(["b"]), [ab, bc, s1]);
  assert.deepEqual(log.eventsOf([]), []);
});

test("purge drops the key's events and their statuses, also from the file after flush", () => {
  const { log, file, make } = setup();
  const ab = log.append(msg({ fromKey: "a", toKey: "b", text: "ab" }));
  const cd = log.append(msg({ fromKey: "c", toKey: "d", text: "cd" }));
  log.status(ab.id, "delivered");
  log.status(cd.id, "delivered");
  assert.equal(log.purge("a"), 2);
  assert.equal(log.purge("zzz"), 0);
  assert.equal(log.lastStatus(ab.id), undefined);
  assert.deepEqual(log.eventsOf(["a", "b"]), []);
  log.flush();
  const again = make();
  assert.deepEqual(again.eventsOf(["c"]).map((e) => e.id), [cd.id, log.eventsOf(["c"])[1].id]);
  assert.equal(again.text(cd.id), "cd");
  assert.equal(log.text(cd.id), "cd");
  assert.equal(readFileSync(file, "utf8").split("\n").filter(Boolean).length, 2);
  // appends after the rewrite still read back
  const e = log.append(msg({ text: "after" }));
  assert.equal(make().text(e.id), "after");
});

test("a purge is flushed by the debounce timer", async () => {
  const { log, file } = setup();
  log.append(msg());
  log.purge("a");
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(readFileSync(file, "utf8"), "");
});

test("the cap keeps the newest events at load", () => {
  const { file, make } = setup();
  const lines = [1, 2, 3, 4, 5].map((i) => line({ id: String(i), ts: i, text: `t${i}` })).join("");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, lines);
  const log = make({ cap: 3 });
  assert.deepEqual(log.eventsOf(["a"]).map((e) => e.id), ["3", "4", "5"]);
  assert.equal(log.text("5"), "t5");
  assert.equal(readFileSync(file, "utf8").split("\n").filter(Boolean).length, 3);
});

test("onAppend listeners get every appended event; a throwing listener does not break append", () => {
  const { log } = setup();
  const seen = [];
  log.onAppend(() => {
    throw new Error("boom");
  });
  log.onAppend((e) => seen.push(e));
  const a = log.append(msg());
  const s = log.status(a.id, "delivered");
  assert.deepEqual(seen, [a, s]);
});
