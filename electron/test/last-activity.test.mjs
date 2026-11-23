// Tests for electron/last-activity.mjs on session dirs in a temp COPILOT_HOME.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createLastActivity, readLastActivity } from "../last-activity.mjs";

let root;
let home;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "last-activity-test-"));
  home = path.join(root, "home ł");
  fs.mkdirSync(path.join(home, "session-state"), { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const ev = (type, timestamp, data = {}) => JSON.stringify({ type, data, id: randomUUID(), timestamp });
const START = ev("session.start", "2026-11-23T10:00:00.000Z");

/** A session dir with these event lines and, when given, a workspace.yaml with this created_at. */
function put(lines, { createdAt, id = randomUUID() } = {}) {
  const dir = path.join(home, "session-state", id);
  fs.mkdirSync(dir, { recursive: true });
  if (lines) fs.writeFileSync(path.join(dir, "events.jsonl"), lines.join("\n") + "\n");
  if (createdAt) fs.writeFileSync(path.join(dir, "workspace.yaml"), `id: ${id}\ncreated_at: ${createdAt}\nupdated_at: 2026-11-23T22:37:00.000Z\n`);
  return id;
}
const read = (id) => readLastActivity(id, { copilotHome: home });

describe("readLastActivity", () => {
  test("the last message, not the resume, hook and shutdown events written after it", async () => {
    const id = put([
      START,
      ev("user.message", "2026-11-23T13:26:00.000Z"),
      ev("assistant.turn_start", "2026-11-23T13:26:01.000Z"),
      ev("assistant.message", "2026-11-23T13:26:30.000Z"),
      ev("assistant.turn_end", "2026-11-23T13:26:31.000Z"),
      ev("session.usage_checkpoint", "2026-11-23T13:26:32.000Z"),
      ev("session.shutdown", "2026-11-23T22:36:00.000Z"),
      ev("session.resume", "2026-11-23T22:37:00.000Z"),
      ev("hook.start", "2026-11-23T22:37:01.000Z"),
      ev("hook.end", "2026-11-23T22:37:01.500Z"),
      ev("session.model_change", "2026-11-23T22:37:02.000Z"),
    ]);
    assert.equal(await read(id), "2026-11-23T13:26:31.000Z");
  });

  test("a tool call counts as activity", async () => {
    const id = put([START, ev("user.message", "2026-11-23T13:00:00.000Z"), ev("tool.execution_start", "2026-11-23T13:05:00.000Z"), ev("session.shutdown", "2026-11-23T20:00:00.000Z")]);
    assert.equal(await read(id), "2026-11-23T13:05:00.000Z");
  });

  test("an event that only mentions a message type in its data is not activity", async () => {
    const id = put([START, ev("user.message", "2026-11-23T13:00:00.000Z"), ev("session.info", "2026-11-23T20:00:00.000Z", { note: '"type":"user.message"' })]);
    assert.equal(await read(id), "2026-11-23T13:00:00.000Z");
  });

  test("a session without messages: when it was created", async () => {
    const id = put([START, ev("session.resume", "2026-11-23T22:37:00.000Z")], { createdAt: "2026-11-23T10:00:00.000Z" });
    assert.equal(await read(id), "2026-11-23T10:00:00.000Z");
  });

  test("a fork is as new as its creation, though its copied messages are older", async () => {
    const id = put([START, ev("user.message", "2026-11-20T09:00:00.000Z")], { createdAt: "2026-11-23T21:00:00.000Z" });
    assert.equal(await read(id), "2026-11-23T21:00:00.000Z");
  });

  test("a message newer than the creation wins", async () => {
    const id = put([START, ev("user.message", "2026-11-23T12:00:00.000Z")], { createdAt: "2026-11-23T10:00:00.000Z" });
    assert.equal(await read(id), "2026-11-23T12:00:00.000Z");
  });

  test("found behind a long tail of other events", async () => {
    const big = ev("model.messages_snapshot", "2026-11-23T14:00:00.000Z", { blob: "x".repeat(300 * 1024) });
    const id = put([START, ev("assistant.message", "2026-11-23T13:26:30.000Z"), big, ev("session.shutdown", "2026-11-23T22:36:00.000Z")]);
    assert.equal(await read(id), "2026-11-23T13:26:30.000Z");
  });

  test("a half-written last line and an event without a readable time are skipped", async () => {
    const id = put([START, ev("user.message", "2026-11-23T13:00:00.000Z"), ev("assistant.message", "not a date"), '{"type":"assistant.message","timest']);
    assert.equal(await read(id), "2026-11-23T13:00:00.000Z");
  });

  test("nothing to read: null", async () => {
    assert.equal(await read(put(null)), null);
    assert.equal(await read(put([START])), null);
    assert.equal(await read(randomUUID()), null);
    assert.equal(await read("../escape"), null);
  });
});

describe("createLastActivity", () => {
  const S = (sessionId, updatedAt) => ({ sessionId, updatedAt, cwd: "/a", title: sessionId });

  test("adds lastActivityAt to every session and keeps the other fields", async () => {
    const add = createLastActivity({ read: async (id) => (id === "a" ? "2026-11-23T13:00:00.000Z" : null) });
    assert.deepEqual(await add([S("a", "t1"), S("b", "t1")]), [
      { ...S("a", "t1"), lastActivityAt: "2026-11-23T13:00:00.000Z" },
      { ...S("b", "t1"), lastActivityAt: null },
    ]);
  });

  test("reads a session again only when its updatedAt changed", async () => {
    const calls = [];
    const add = createLastActivity({
      read: async (id) => {
        calls.push(id);
        return `time ${calls.length}`;
      },
    });
    await add([S("a", "t1"), S("b", "t1")]);
    const second = await add([S("a", "t1"), S("b", "t2")]);
    assert.deepEqual(calls, ["a", "b", "b"]);
    assert.deepEqual(
      second.map((s) => s.lastActivityAt),
      ["time 1", "time 3"],
    );
  });

  test("forgets sessions that left the list", async () => {
    const calls = [];
    const add = createLastActivity({ read: async (id) => (calls.push(id), "t") });
    await add([S("a", "t1")]);
    await add([]);
    await add([S("a", "t1")]);
    assert.deepEqual(calls, ["a", "a"]);
  });

  test("a failed read gives null and is tried again next time", async () => {
    let fail = true;
    const add = createLastActivity({
      read: async () => {
        if (fail) throw new Error("boom");
        return "t";
      },
    });
    assert.equal((await add([S("a", "t1")]))[0].lastActivityAt, null);
    fail = false;
    assert.equal((await add([S("a", "t1")]))[0].lastActivityAt, "t");
  });

  test("a session without updatedAt is read every time", async () => {
    const calls = [];
    const add = createLastActivity({ read: async (id) => (calls.push(id), "t") });
    await add([S("a", undefined)]);
    await add([S("a", undefined)]);
    assert.deepEqual(calls, ["a", "a"]);
  });

  test("many sessions: all read, a few at a time", async () => {
    let running = 0;
    let most = 0;
    const add = createLastActivity({
      limit: 4,
      read: async (id) => {
        most = Math.max(most, ++running);
        await new Promise((r) => setTimeout(r, 1));
        running--;
        return id;
      },
    });
    const list = Array.from({ length: 30 }, (_, i) => S(`s${i}`, "t1"));
    const out = await add(list);
    assert.deepEqual(
      out.map((s) => s.lastActivityAt),
      list.map((s) => s.sessionId),
    );
    assert.ok(most <= 4, `ran ${most} at once`);
  });
});
