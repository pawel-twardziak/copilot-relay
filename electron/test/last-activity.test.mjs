// Tests for electron/last-activity.mjs on session dirs in a temp COPILOT_HOME.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { activityStamp, createLastActivity, readLastActivity } from "../last-activity.mjs";
import { keepAliveText } from "../cache-keeper.mjs";

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

  test("found by reading the whole file when even the big tail has none", async () => {
    const filler = Array.from({ length: 12 }, (_, i) => ev("model.messages_snapshot", "2026-11-23T14:00:00.000Z", { n: i, blob: "x".repeat(256 * 1024) }));
    const id = put([START, ev("assistant.message", "2026-11-23T13:26:30.000Z"), ...filler], { createdAt: "2026-11-23T10:00:00.000Z" });
    assert.equal(await read(id), "2026-11-23T13:26:30.000Z");
  });

  test("a history too big to search to the end: unknown, not the creation time", async () => {
    const id = put([START, ev("assistant.message", "2026-11-23T13:26:30.000Z")], { createdAt: "2026-11-01T10:00:00.000Z" });
    const file = path.join(home, "session-state", id, "events.jsonl");
    fs.truncateSync(file, 65 * 1024 * 1024); // zero bytes, no line break: one endless "line" after the message
    fs.appendFileSync(file, "\n" + ev("session.shutdown", "2026-11-23T22:36:00.000Z") + "\n");
    assert.equal(await read(id), null);
  });

  // a folder stands in for a file that cannot be read; Windows opens a folder as an empty file, so not there
  test("an events file that is there but cannot be read: unknown, not the creation time", { skip: process.platform === "win32" }, async () => {
    const id = put(null, { createdAt: "2026-11-01T10:00:00.000Z" });
    fs.mkdirSync(path.join(home, "session-state", id, "events.jsonl"));
    assert.equal(await read(id), null);
  });

  test("a half-written last line and an event without a readable time are skipped", async () => {
    const id = put([START, ev("user.message", "2026-11-23T13:00:00.000Z"), ev("assistant.message", "not a date"), '{"type":"assistant.message","timest']);
    assert.equal(await read(id), "2026-11-23T13:00:00.000Z");
  });

  test("a keep-alive ping and the turn it started are not activity", async () => {
    const id = put([
      START,
      ev("user.message", "2026-11-23T13:00:00.000Z", { content: "real" }),
      ev("assistant.message", "2026-11-23T13:01:00.000Z"),
      ev("user.message", "2026-11-23T13:30:00.000Z", { content: keepAliveText() }),
      ev("assistant.turn_start", "2026-11-23T13:30:01.000Z"),
      ev("tool.execution_start", "2026-11-23T13:30:02.000Z"),
      ev("assistant.message", "2026-11-23T13:30:03.000Z"),
      ev("session.usage_checkpoint", "2026-11-23T13:30:04.000Z"),
    ]);
    assert.equal(await read(id), "2026-11-23T13:01:00.000Z");
  });

  test("a message after a ping is activity", async () => {
    const id = put([
      START,
      ev("user.message", "2026-11-23T13:30:00.000Z", { content: keepAliveText() }),
      ev("assistant.message", "2026-11-23T13:30:03.000Z"),
      ev("user.message", "2026-11-23T14:00:00.000Z", { content: "back" }),
    ]);
    assert.equal(await read(id), "2026-11-23T14:00:00.000Z");
  });

  test("only pings since the creation: the creation time", async () => {
    const id = put([START, ev("user.message", "2026-11-23T13:30:00.000Z", { content: keepAliveText() }), ev("assistant.message", "2026-11-23T13:30:03.000Z")], { createdAt: "2026-11-23T10:00:00.000Z" });
    assert.equal(await read(id), "2026-11-23T10:00:00.000Z");
  });

  test("a ping whose prompt lies before the first tail is still recognised", async () => {
    const id = put([
      START,
      ev("user.message", "2026-11-23T13:00:00.000Z", { content: "real" }),
      ev("assistant.message", "2026-11-23T13:01:00.000Z"),
      ev("user.message", "2026-11-23T13:30:00.000Z", { content: keepAliveText(), transformedContent: "x".repeat(100 * 1024) }),
      ev("assistant.message", "2026-11-23T13:30:03.000Z"),
    ]);
    assert.equal(await read(id), "2026-11-23T13:01:00.000Z");
  });

  test("nothing to read: null", async () => {
    assert.equal(await read(put(null)), null);
    assert.equal(await read(put([START])), null);
    assert.equal(await read(randomUUID()), null);
    assert.equal(await read("../escape"), null);
  });
});

describe("createLastActivity", () => {
  const S = (sessionId) => ({ sessionId, updatedAt: "2026-11-23T22:37:00.000Z", cwd: "/a", title: sessionId });
  /** A reader that records its calls, and stamps that the test changes by hand. */
  function fake(value = (id, n) => `time ${n}`) {
    const calls = [];
    const stamps = {};
    const add = createLastActivity({
      read: async (id) => (calls.push(id), value(id, calls.length)),
      stamp: async (id) => stamps[id] ?? null,
    });
    return { add, calls, stamps };
  }

  test("adds lastActivityAt to every session and keeps the other fields", async () => {
    const { add } = fake((id) => (id === "a" ? "2026-11-23T13:00:00.000Z" : null));
    assert.deepEqual(await add([S("a"), S("b")]), [
      { ...S("a"), lastActivityAt: "2026-11-23T13:00:00.000Z" },
      { ...S("b"), lastActivityAt: null },
    ]);
  });

  test("reads a session again only when its events file changed", async () => {
    const { add, calls, stamps } = fake();
    Object.assign(stamps, { a: "1:10", b: "1:10" });
    await add([S("a"), S("b")]);
    stamps.b = "2:20";
    const second = await add([S("a"), S("b")]);
    assert.deepEqual(calls, ["a", "b", "b"]);
    assert.deepEqual(
      second.map((s) => s.lastActivityAt),
      ["time 1", "time 3"],
    );
  });

  test("forgets sessions that left the list", async () => {
    const { add, calls, stamps } = fake();
    stamps.a = "1:10";
    await add([S("a")]);
    await add([]);
    await add([S("a")]);
    assert.deepEqual(calls, ["a", "a"]);
  });

  test("an unknown time and a session without an events file are read again next time", async () => {
    const { add, calls, stamps } = fake((id) => (id === "unknown" ? null : "t"));
    stamps.unknown = "1:10";
    await add([S("unknown"), S("nofile")]);
    await add([S("unknown"), S("nofile")]);
    assert.deepEqual(calls, ["unknown", "nofile", "unknown", "nofile"]);
  });

  test("a failing read or stamp gives null, keeps the session and is tried again", async () => {
    let fail = true;
    const boom = async () => {
      if (fail) throw new Error("boom");
      return "t";
    };
    for (const add of [createLastActivity({ read: boom, stamp: async () => "1:10" }), createLastActivity({ read: async () => "t", stamp: boom })]) {
      fail = true;
      assert.deepEqual(await add([S("a")]), [{ ...S("a"), lastActivityAt: null }]);
      fail = false;
      assert.equal((await add([S("a")]))[0].lastActivityAt, "t");
    }
  });

  test("the real stamp: changes when events.jsonl grows, null without the file", async () => {
    const id = put([START, ev("user.message", "2026-11-23T13:00:00.000Z")]);
    const first = await activityStamp(id, { copilotHome: home });
    fs.appendFileSync(path.join(home, "session-state", id, "events.jsonl"), ev("session.shutdown", "2026-11-23T22:36:00.000Z") + "\n");
    assert.notEqual(await activityStamp(id, { copilotHome: home }), first);
    assert.equal(await activityStamp(put(null), { copilotHome: home }), null);
    assert.equal(await activityStamp("../escape", { copilotHome: home }), null);
  });

  test("many sessions: all read, a few at a time", async () => {
    let running = 0;
    let most = 0;
    const add = createLastActivity({
      limit: 4,
      stamp: async () => null,
      read: async (id) => {
        most = Math.max(most, ++running);
        await new Promise((r) => setTimeout(r, 1));
        running--;
        return id;
      },
    });
    const list = Array.from({ length: 30 }, (_, i) => S(`s${i}`));
    const out = await add(list);
    assert.deepEqual(
      out.map((s) => s.lastActivityAt),
      list.map((s) => s.sessionId),
    );
    assert.ok(most <= 4, `ran ${most} at once`);
  });
});
