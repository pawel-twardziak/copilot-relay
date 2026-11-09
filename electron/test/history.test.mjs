// Tests for electron/history.mjs on fixture session dirs in a temp COPILOT_HOME.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  countFrom,
  countUserMessages,
  cutIndex,
  deleteSession,
  describeCut,
  forgetInStore,
  purgeDeleted,
  forkSession,
  readEvents,
  sessionDir,
  sessionStateDir,
  truncateSession,
} from "../history.mjs";

let home;
let prevHome;

beforeEach(() => {
  prevHome = process.env.COPILOT_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "history-test-"));
  process.env.COPILOT_HOME = home;
  fs.mkdirSync(path.join(home, "session-state"));
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.COPILOT_HOME;
  else process.env.COPILOT_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const ev = (type, data = {}) => ({ type, data, id: randomUUID(), timestamp: "2026-11-02T16:00:00.000Z", parentId: null });

/** Fixture events: index comments match the cut-index expectations below. */
function fixtureEvents(id) {
  return [
    ev("session.start", { sessionId: id, context: { cwd: "/start/cwd" } }), // 0
    ev("user.message", { content: "Hello world, please list files" }), // 1  turn 1
    ev("assistant.turn_start"), // 2
    ev("assistant.message", { content: "Sure." }), // 3
    ev("tool.execution_start", { toolName: "bash" }), // 4
    ev("tool.execution_complete", { success: true }), // 5
    ev("assistant.turn_end"), // 6
    ev("session.shutdown"), // 7
    ev("session.resume"), // 8
    ev("user.message", { content: "[from tester]\nPlease review   the\n  patch" }), // 9  turn 2 (relay)
    ev("assistant.turn_start"), // 10
    ev("assistant.message", { content: "Reviewed." }), // 11
    ev("assistant.turn_end"), // 12
    ev("user.message", { content: "Last question about things" }), // 13 turn 3
    ev("assistant.turn_start"), // 14
    ev("assistant.message", { content: "Answer." }), // 15
    ev("assistant.turn_end"), // 16
  ];
}

const WORKSPACE = (id, name = "'Reply with just: ok'") =>
  [
    `id: ${id}`,
    "cwd: /some/dir",
    "git_root: /some",
    "repository: owner/repo",
    "branch: main",
    `name: ${name}`,
    "user_named: false",
    "summary_count: 0",
    "fork_count: 0",
    "created_at: 2026-11-02T16:01:01.652Z",
    "updated_at: 2026-11-02T18:02:59.487Z",
    "",
  ].join("\n");

/** Write a session dir; one line uses odd spacing so byte-preservation is observable. */
function makeSession({ id = randomUUID(), name, events } = {}) {
  const dir = path.join(home, "session-state", id);
  fs.mkdirSync(dir);
  const list = events ?? fixtureEvents(id);
  const lines = list.map((e, i) => (i === 3 ? `{ "type" : "assistant.message",  "data": {"content":"Sure."} }` : JSON.stringify(e)));
  fs.writeFileSync(path.join(dir, "events.jsonl"), lines.join("\n") + "\n", { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "workspace.yaml"), WORKSPACE(id, name), { mode: 0o600 });
  for (const sub of ["checkpoints", "files", "research", "rewind-file-snapshots"]) {
    fs.mkdirSync(path.join(dir, sub));
    fs.writeFileSync(path.join(dir, sub, "note.txt"), `${sub} content`);
  }
  return { id, dir, lines };
}

/** Map of relative path -> file contents for a directory tree. */
function snapshot(dir) {
  const out = {};
  for (const rel of fs.readdirSync(dir, { recursive: true })) {
    const p = path.join(dir, rel);
    if (fs.statSync(p).isFile()) out[rel] = fs.readFileSync(p).toString("base64");
  }
  return out;
}

const sessionIds = () => fs.readdirSync(path.join(home, "session-state")).sort();
const readLines = (file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean);

describe("paths", () => {
  test("sessionStateDir follows COPILOT_HOME at call time", () => {
    assert.equal(sessionStateDir(), path.join(home, "session-state"));
  });

  test("sessionDir returns the real dir for a valid id", () => {
    const { id, dir } = makeSession();
    assert.equal(sessionDir(id), fs.realpathSync(dir));
  });

  test("sessionDir rejects an invalid id", () => {
    assert.throws(() => sessionDir("../etc"), /Invalid session id/);
    assert.throws(() => sessionDir("not-a-uuid"), /Invalid session id/);
  });

  test("sessionDir rejects a missing dir", () => {
    assert.throws(() => sessionDir(randomUUID()), /Session not found/);
  });

  test("sessionDir rejects a symlinked session dir", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "history-outside-"));
    try {
      const id = randomUUID();
      fs.symlinkSync(outside, path.join(home, "session-state", id));
      assert.throws(() => sessionDir(id), /not a directory/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("sessionDir rejects a plain file", () => {
    const id = randomUUID();
    fs.writeFileSync(path.join(home, "session-state", id), "x");
    assert.throws(() => sessionDir(id), /not a directory/);
  });
});

describe("readEvents", () => {
  test("parses events and keeps raw lines", () => {
    const { dir, lines } = makeSession();
    const r = readEvents(dir);
    assert.equal(r.events.length, 17);
    assert.deepEqual(r.lines, lines);
    assert.equal(r.events[3].type, "assistant.message");
  });

  test("rejects a non-JSON line", () => {
    const { dir } = makeSession();
    fs.appendFileSync(path.join(dir, "events.jsonl"), "not json\n");
    assert.throws(() => readEvents(dir), /Unrecognized session history format/);
  });

  test("rejects a line without a string type", () => {
    const { dir } = makeSession();
    fs.appendFileSync(path.join(dir, "events.jsonl"), '{"data":{}}\n');
    assert.throws(() => readEvents(dir), /Unrecognized session history format/);
  });

  test("rejects a file not starting with session.start", () => {
    const id = randomUUID();
    const { dir } = makeSession({ id, events: fixtureEvents(id).slice(1) });
    assert.throws(() => readEvents(dir), /Unrecognized session history format/);
  });
});

describe("cutIndex", () => {
  const events = fixtureEvents(randomUUID());
  const cut = (ordinal, text, where) => cutIndex(events, { ordinal, text, where });

  test("beforeUser = index of the N-th user.message", () => {
    assert.equal(cut(1, "Hello world", "beforeUser"), 1);
    assert.equal(cut(2, "Please review the patch", "beforeUser"), 9);
    assert.equal(cut(3, "Last question", "beforeUser"), 13);
  });

  test("beforeReply = index after the N-th user.message", () => {
    assert.equal(cut(1, "Hello world", "beforeReply"), 2);
    assert.equal(cut(3, "Last question", "beforeReply"), 14);
  });

  test("afterReply = next user.message, or end for the last turn", () => {
    assert.equal(cut(1, "Hello world", "afterReply"), 9);
    assert.equal(cut(2, "review", "afterReply"), 13);
    assert.equal(cut(3, "Last question", "afterReply"), 17);
  });

  test("relay text matches with whitespace normalized", () => {
    assert.equal(cut(2, "[from tester] Please   review the patch", "beforeUser"), 9);
  });

  test("text mismatch at ordinal falls back to the unique match", () => {
    assert.equal(cut(1, "Last question", "beforeUser"), 13);
    assert.equal(cut(99, "Hello world", "beforeUser"), 1);
  });

  test("ambiguous text throws", () => {
    assert.throws(() => cut(9, "e", "beforeUser"), /Could not find this message in the session history/);
  });

  test("absent text throws", () => {
    assert.throws(() => cut(1, "never said this", "beforeUser"), /Could not find this message in the session history/);
  });

  test("empty text accepts the ordinal", () => {
    assert.equal(cut(2, "", "beforeUser"), 9);
    assert.equal(cut(2, "   ", "afterReply"), 13);
  });

  test("empty text with ordinal out of range throws", () => {
    assert.throws(() => cut(4, "", "beforeUser"), /Could not find this message/);
  });

  test("unknown where throws", () => {
    assert.throws(() => cut(1, "Hello", "sideways"), /Unknown cut position/);
  });

  test("countFrom counts user messages at/after the cut", () => {
    assert.equal(countFrom(events, 1), 3);
    assert.equal(countFrom(events, 9), 2);
    assert.equal(countFrom(events, 14), 0);
    assert.equal(countFrom(events, 17), 0);
  });
});

describe("cutIndex with a folder line", () => {
  test("bubble text still matches a user.message that has one", () => {
    const events = fixtureEvents("x");
    events[9] = ev("user.message", { content: '[from tester]\n[folder "/a b"]\nhello' });
    assert.equal(cutIndex(events, { ordinal: 2, text: "hello", where: "beforeUser" }), 9);
    assert.equal(cutIndex(events, { ordinal: 7, text: "hello", where: "beforeUser" }), 9);
  });
});

describe("describeCut", () => {
  test("reports removed user messages and events", () => {
    const { id } = makeSession();
    assert.deepEqual(describeCut(id, { ordinal: 2, text: "review", where: "beforeUser" }), {
      removedUserMessages: 2,
      removedEvents: 8,
    });
    assert.deepEqual(describeCut(id, { ordinal: 3, text: "Last", where: "beforeReply" }), {
      removedUserMessages: 0,
      removedEvents: 3,
    });
  });
});

describe("forkSession", () => {
  const now = new Date("2026-11-02T20:00:00.000Z");

  test("fork beforeUser copies history up to the message and prefills it", () => {
    const { id, dir, lines } = makeSession();
    const before = snapshot(dir);
    const res = forkSession(id, { ordinal: 2, text: "Please review the patch", where: "beforeUser" }, now);

    assert.notEqual(res.sessionId, id);
    assert.match(res.sessionId, /^[0-9a-f-]{36}$/);
    assert.equal(res.cwd, "/some/dir");
    assert.equal(res.name, "Fork of Reply with just: ok");
    assert.equal(res.prefill, "[from tester]\nPlease review   the\n  patch");

    const newDir = path.join(home, "session-state", res.sessionId);
    const out = readLines(path.join(newDir, "events.jsonl"));
    assert.equal(out.length, 9);
    assert.equal(JSON.parse(out[0]).data.sessionId, res.sessionId);
    assert.deepEqual(JSON.parse(out[0]).data.context, { cwd: "/start/cwd" });
    assert.deepEqual(out.slice(1), lines.slice(1, 9)); // raw bytes kept, odd-spaced line included
    assert.ok(fs.readFileSync(path.join(newDir, "events.jsonl"), "utf8").endsWith("\n"));

    const ws = fs.readFileSync(path.join(newDir, "workspace.yaml"), "utf8");
    assert.match(ws, new RegExp(`^id: ${res.sessionId}$`, "m"));
    assert.match(ws, /^name: 'Fork of Reply with just: ok'$/m);
    assert.match(ws, /^user_named: true$/m);
    assert.match(ws, /^created_at: 2026-11-02T20:00:00.000Z$/m);
    assert.match(ws, /^updated_at: 2026-11-02T20:00:00.000Z$/m);
    assert.match(ws, /^repository: owner\/repo$/m);
    assert.match(ws, /^fork_count: 0$/m);

    for (const sub of ["checkpoints", "files", "research", "rewind-file-snapshots"]) {
      assert.equal(fs.readFileSync(path.join(newDir, sub, "note.txt"), "utf8"), `${sub} content`);
    }
    assert.deepEqual(snapshot(dir), before);
  });

  test("fork prefill drops the folder line and keeps [from x]", () => {
    const events = fixtureEvents("x");
    events[9] = ev("user.message", { content: '[from tester]\n[folder "/a b"]\nPlease review' });
    const { id } = makeSession({ events });
    const res = forkSession(id, { ordinal: 2, text: "Please review", where: "beforeUser" }, now);
    assert.equal(res.prefill, "[from tester]\nPlease review");
  });

  test("fork afterReply keeps the reply and has no prefill", () => {
    const { id, dir } = makeSession();
    const before = snapshot(dir);
    const res = forkSession(id, { ordinal: 1, text: "Hello world", where: "afterReply" }, now);
    const out = readLines(path.join(home, "session-state", res.sessionId, "events.jsonl"));
    assert.equal(out.length, 9);
    assert.equal(res.prefill, "");
    assert.deepEqual(snapshot(dir), before);
  });

  test("fork does not copy the original's delete backup or temp files", () => {
    const { id, dir } = makeSession();
    fs.writeFileSync(path.join(dir, "events.jsonl.bak"), "old");
    fs.writeFileSync(path.join(dir, ".events.jsonl.x.tmp"), "tmp");
    fs.writeFileSync(path.join(dir, ".workspace-fork.lock"), "");
    const res = forkSession(id, { ordinal: 2, text: "", where: "beforeUser" }, now);
    const files = fs.readdirSync(path.join(home, "session-state", res.sessionId));
    for (const f of ["events.jsonl.bak", ".events.jsonl.x.tmp", ".workspace-fork.lock"]) assert.ok(!files.includes(f), f);
    assert.ok(files.includes("checkpoints"));
  });

  test("fork afterReply on the last turn keeps everything", () => {
    const { id, lines } = makeSession();
    const res = forkSession(id, { ordinal: 3, text: "Last question", where: "afterReply" }, now);
    const out = readLines(path.join(home, "session-state", res.sessionId, "events.jsonl"));
    assert.equal(out.length, 17);
    assert.deepEqual(out.slice(1), lines.slice(1));
  });

  test("fork name with an apostrophe is YAML-quoted and parsed back", () => {
    const { id } = makeSession({ name: "'Bob''s idea'" });
    const res = forkSession(id, { ordinal: 1, text: "", where: "beforeUser" }, now);
    assert.equal(res.name, "Fork of Bob's idea");
    const ws = fs.readFileSync(path.join(home, "session-state", res.sessionId, "workspace.yaml"), "utf8");
    assert.match(ws, /^name: 'Fork of Bob''s idea'$/m);
  });

  test("fork of an unquoted name", () => {
    const { id } = makeSession({ name: "plain name" });
    const res = forkSession(id, { ordinal: 1, text: "", where: "beforeUser" }, now);
    assert.equal(res.name, "Fork of plain name");
  });

  test("fork of beforeUser on turn 1 keeps only session.start", () => {
    const { id } = makeSession();
    const res = forkSession(id, { ordinal: 1, text: "Hello", where: "beforeUser" }, now);
    const out = readLines(path.join(home, "session-state", res.sessionId, "events.jsonl"));
    assert.equal(out.length, 1);
    assert.equal(res.prefill, "Hello world, please list files");
  });

  test("unmatched message throws and writes nothing", () => {
    const { id, dir } = makeSession();
    const before = snapshot(dir);
    assert.throws(() => forkSession(id, { ordinal: 1, text: "nope", where: "beforeUser" }, now), /Could not find/);
    assert.deepEqual(sessionIds(), [id]);
    assert.deepEqual(snapshot(dir), before);
  });

  test("failure after the copy removes the new dir", () => {
    const { id, dir } = makeSession();
    fs.rmSync(path.join(dir, "workspace.yaml"));
    fs.mkdirSync(path.join(dir, "workspace.yaml")); // reading it fails after the copy
    assert.throws(() => forkSession(id, { ordinal: 1, text: "", where: "afterReply" }, now));
    assert.deepEqual(sessionIds(), [id]);
  });

  test("malformed events.jsonl throws and writes nothing", () => {
    const { id } = makeSession();
    fs.appendFileSync(path.join(home, "session-state", id, "events.jsonl"), "{broken\n");
    assert.throws(() => forkSession(id, { ordinal: 1, text: "", where: "afterReply" }, now), /Unrecognized/);
    assert.deepEqual(sessionIds(), [id]);
  });
});

describe("truncateSession", () => {
  test("delete beforeUser drops the message and later events, with a .bak", () => {
    const { id, dir, lines } = makeSession();
    const file = path.join(dir, "events.jsonl");
    const original = fs.readFileSync(file);
    const res = truncateSession(id, { ordinal: 2, text: "review", where: "beforeUser" });
    assert.deepEqual(res, { removedUserMessages: 2 });
    assert.deepEqual(fs.readFileSync(file + ".bak"), original);
    const text = fs.readFileSync(file, "utf8");
    assert.ok(text.endsWith("\n"));
    assert.deepEqual(readLines(file), lines.slice(0, 9));
    assert.equal(readEvents(dir).events.length, 9);
    // Windows has no POSIX modes (stat reports 0o666), so only check them elsewhere.
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith("events.jsonl")).sort(), ["events.jsonl", "events.jsonl.bak"]);
  });

  test("delete beforeReply keeps the user message", () => {
    const { id, dir, lines } = makeSession();
    const res = truncateSession(id, { ordinal: 1, text: "Hello world", where: "beforeReply" });
    assert.deepEqual(res, { removedUserMessages: 2 });
    assert.deepEqual(readLines(path.join(dir, "events.jsonl")), lines.slice(0, 2));
  });

  test("delete beforeReply on the last turn", () => {
    const { id, dir, lines } = makeSession();
    const res = truncateSession(id, { ordinal: 3, text: "Last question", where: "beforeReply" });
    assert.deepEqual(res, { removedUserMessages: 0 });
    assert.deepEqual(readLines(path.join(dir, "events.jsonl")), lines.slice(0, 14));
  });

  test("an older .bak is overwritten", () => {
    const { id, dir } = makeSession();
    fs.writeFileSync(path.join(dir, "events.jsonl.bak"), "old");
    const original = fs.readFileSync(path.join(dir, "events.jsonl"));
    truncateSession(id, { ordinal: 3, text: "", where: "beforeUser" });
    assert.deepEqual(fs.readFileSync(path.join(dir, "events.jsonl.bak")), original);
  });

  test("unmatched message throws and writes nothing", () => {
    const { id, dir } = makeSession();
    const before = snapshot(dir);
    assert.throws(() => truncateSession(id, { ordinal: 1, text: "ambiguous? no: absent", where: "beforeUser" }), /Could not find/);
    assert.deepEqual(snapshot(dir), before);
  });

  test("malformed events.jsonl throws and writes nothing", () => {
    const { id, dir } = makeSession();
    fs.appendFileSync(path.join(dir, "events.jsonl"), "garbage\n");
    const before = snapshot(dir);
    assert.throws(() => truncateSession(id, { ordinal: 1, text: "", where: "beforeUser" }), /Unrecognized/);
    assert.deepEqual(snapshot(dir), before);
  });

  test("invalid id and symlinked dir are refused", () => {
    assert.throws(() => truncateSession("x/../y", { ordinal: 1, text: "", where: "beforeUser" }), /Invalid session id/);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "history-outside-"));
    try {
      const id = randomUUID();
      fs.writeFileSync(path.join(outside, "events.jsonl"), JSON.stringify(ev("session.start", { sessionId: id })) + "\n");
      fs.symlinkSync(outside, path.join(home, "session-state", id));
      assert.throws(() => truncateSession(id, { ordinal: 1, text: "", where: "beforeUser" }), /not a directory/);
      assert.deepEqual(fs.readdirSync(outside), ["events.jsonl"]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("countUserMessages", () => {
  test("counts user.message events", () => {
    const id = randomUUID();
    makeSession({
      id,
      events: [
        ev("session.start", { sessionId: id }),
        ev("user.message", { content: "one" }),
        ev("assistant.message", { content: "reply" }),
        ev("assistant.turn_end"), // index 3 is rewritten by makeSession, so it must not be a user message
        ev("user.message", { content: "two" }),
        ev("assistant.message", { content: "reply" }),
      ],
    });
    assert.equal(countUserMessages(id), 2);
  });

  test("is 0 without events.jsonl", () => {
    const id = randomUUID();
    const dir = path.join(home, "session-state", id);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "workspace.yaml"), WORKSPACE(id), { mode: 0o600 });
    assert.equal(countUserMessages(id), 0);
  });
});

describe("deleteSession", () => {
  const storeFile = () => path.join(home, "session-store.db");
  async function makeStore(ids) {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(storeFile());
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, parent_id TEXT REFERENCES sessions(id));
      CREATE TABLE turn_notes (turn_id INTEGER REFERENCES turns(id));
      CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), turn_index INTEGER);
      CREATE TABLE new_child (owner TEXT NOT NULL REFERENCES sessions(id));
      CREATE TABLE dynamic_context_items (name TEXT);
      CREATE TABLE future_links (session_id TEXT, other TEXT);
      CREATE VIRTUAL TABLE search_index USING fts5(content, session_id UNINDEXED);
    `);
    for (const [i, id] of ids.entries()) {
      db.prepare("INSERT INTO sessions VALUES (?, '/x', ?)").run(id, i ? ids[0] : null); // later ones: children of the first
      db.prepare("INSERT INTO turns (session_id, turn_index) VALUES (?, 0), (?, 1)").run(id, id);
      db.prepare("INSERT INTO search_index VALUES ('hello', ?)").run(id);
      db.prepare("INSERT INTO future_links VALUES (?, 'x')").run(id);
      db.prepare("INSERT INTO new_child VALUES (?)").run(id);
      db.prepare("INSERT INTO turn_notes SELECT id FROM turns WHERE session_id = ?").run(id);
    }
    db.prepare("INSERT INTO dynamic_context_items VALUES ('keep')").run();
    db.close();
  }
  async function counts(id) {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(storeFile());
    try {
      const n = (sql) => db.prepare(sql).get(id).n;
      return {
        sessions: n("SELECT count(*) AS n FROM sessions WHERE id = ?"),
        turns: n("SELECT count(*) AS n FROM turns WHERE session_id = ?"),
        search: n("SELECT count(*) AS n FROM search_index WHERE session_id = ?"),
      };
    } finally {
      db.close();
    }
  }

  test("removes the session dir and leaves other sessions alone", async () => {
    const a = makeSession();
    const b = makeSession();
    const res = await deleteSession(a.id);
    assert.equal(res.leftover, null);
    assert.deepEqual(res.store, { removedRows: 0 }); // no session-store.db
    assert.deepEqual(sessionIds(), [b.id]);
    assert.ok(fs.existsSync(path.join(b.dir, "events.jsonl")));
  });

  test("removes the session's rows from session-store.db only", async () => {
    const a = makeSession();
    const b = makeSession();
    await makeStore([a.id, b.id]);
    const res = await deleteSession(a.id);
    assert.deepEqual(res.store, { removedRows: 1 + 2 + 1 + 1 });
    assert.deepEqual(await counts(a.id), { sessions: 0, turns: 0, search: 0 });
    assert.deepEqual(await counts(b.id), { sessions: 1, turns: 2, search: 1 });
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(storeFile());
    assert.equal(db.prepare("SELECT count(*) AS n FROM future_links").get().n, 2, "a session_id without a foreign key is left alone");
    assert.equal(db.prepare("SELECT count(*) AS n FROM new_child").get().n, 1, "any table with a foreign key to sessions is cleaned");
    db.close();
  });

  test("a session missing from the store is still deleted", async () => {
    const a = makeSession();
    await makeStore([randomUUID()]);
    assert.deepEqual((await deleteSession(a.id)).store, { removedRows: 0 });
    assert.deepEqual(sessionIds(), []);
  });

  test("an unreadable store is reported, the dir is deleted anyway", async () => {
    const a = makeSession();
    fs.writeFileSync(storeFile(), "not a database");
    const res = await deleteSession(a.id);
    assert.ok(res.store.error);
    assert.deepEqual(sessionIds(), []);
  });

  test("missingOk: a session without a dir only has its store rows removed", async () => {
    const id = randomUUID();
    await makeStore([id]);
    assert.deepEqual(await deleteSession(id, { missingOk: true }), { leftover: null, store: { removedRows: 1 + 2 + 1 + 1 } });
    await assert.rejects(deleteSession("../etc", { missingOk: true }), /Invalid session id/);
  });

  test("purgeDeleted removes only leftovers of failed deletions", async () => {
    const keep = makeSession();
    const root = path.join(home, "session-state");
    const trash = path.join(root, `.deleted-${randomUUID()}-${randomUUID()}`);
    fs.mkdirSync(path.join(trash, "files"), { recursive: true });
    fs.writeFileSync(path.join(trash, "events.jsonl"), "x");
    fs.mkdirSync(path.join(root, ".deleted-not-ours"));
    assert.equal(await purgeDeleted(), 1);
    assert.deepEqual(fs.readdirSync(root).sort(), [".deleted-not-ours", keep.id].sort());
  });

  test("refuses invalid and missing ids", async () => {
    await assert.rejects(deleteSession("../etc"), /Invalid session id/);
    await assert.rejects(deleteSession(randomUUID()), (err) => err.code === "ENOSESSION" && /Session not found/.test(err.message));
    await assert.rejects(forgetInStore("x' OR 1=1 --"), /Invalid session id/);
  });
});
