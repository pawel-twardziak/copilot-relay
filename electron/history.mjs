// Copilot session history files (session-state/<id>/events.jsonl + workspace.yaml): fork, truncate and delete.
// The only place that knows the on-disk format; pure Node built-ins, no Electron.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMAT_ERROR = "Unrecognized session history format";
const NOT_FOUND = "Could not find this message in the session history";

/** $COPILOT_HOME or ~/.copilot, resolved at call time (same default as relayConfig in main.mjs). */
export function copilotHome() {
  return process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
}

/** True if `id` looks like a Copilot session id (UUID). */
export function isSessionId(id) {
  return typeof id === "string" && UUID.test(id);
}

/** $COPILOT_HOME/session-state, resolved at call time. */
export function sessionStateDir() {
  return path.join(copilotHome(), "session-state");
}

/** Real path of a session's dir; throws unless `id` is a UUID naming a real directory directly in session-state. */
export function sessionDir(id) {
  if (!isSessionId(id)) throw new Error(`Invalid session id: ${id}`);
  let root;
  let st;
  try {
    root = fs.realpathSync(sessionStateDir());
    st = fs.lstatSync(path.join(root, id));
  } catch {
    throw Object.assign(new Error(`Session not found: ${id}`), { code: "ENOSESSION" });
  }
  if (!st.isDirectory()) throw new Error(`Session ${id} is not a directory`);
  const dir = fs.realpathSync(path.join(root, id));
  if (path.dirname(dir) !== root) throw new Error(`Session ${id} is outside ${root}`);
  return dir;
}

/** Parsed events plus their raw lines (kept so writing back preserves the original bytes). With `liveTail`, a last
 *  line without its newline is left out: the agent of a running session may be in the middle of writing it. */
export function readEvents(dir, { liveTail = false } = {}) {
  let text = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8");
  if (liveTail && !text.endsWith("\n")) text = text.slice(0, text.lastIndexOf("\n") + 1);
  const lines = text.split("\n").filter((l) => l.trim());
  const events = lines.map((line, i) => {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      throw new Error(`${FORMAT_ERROR} (line ${i + 1} is not JSON)`);
    }
    if (typeof e?.type !== "string") throw new Error(`${FORMAT_ERROR} (line ${i + 1} has no type)`);
    return e;
  });
  if (events[0]?.type !== "session.start") throw new Error(`${FORMAT_ERROR} (no session.start)`);
  return { events, lines };
}

const normalize = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const isUser = (e) => e.type === "user.message";

/** Index of the user.message the bubble refers to: the ordinal-th if its text matches, else the only match. */
function userIndex(events, ordinal, text) {
  const users = events.flatMap((e, i) => (isUser(e) ? [i] : []));
  const want = normalize(text);
  const matches = (i) => normalize(events[i].data?.content).includes(want);
  const atOrdinal = users[ordinal - 1];
  if (atOrdinal !== undefined && (!want || matches(atOrdinal))) return atOrdinal;
  const found = want ? users.filter(matches) : [];
  if (found.length !== 1) throw new Error(NOT_FOUND);
  return found[0];
}

/** Index in `events` where history is cut, or throw if the bubble can't be matched. */
export function cutIndex(events, { ordinal, text, where }) {
  if (!["beforeUser", "beforeReply", "afterReply"].includes(where)) throw new Error(`Unknown cut position: ${where}`);
  const u = userIndex(events, ordinal, text);
  if (where === "beforeUser") return u;
  if (where === "beforeReply") return u + 1;
  const next = events.findIndex((e, i) => i > u && isUser(e));
  return next === -1 ? events.length : next;
}

/** Number of user messages at or after `idx` (the ones a cut there removes). */
export function countFrom(events, idx) {
  return events.slice(idx).filter(isUser).length;
}

/** Number of user.message events recorded for session `id`; 0 when it has no events.jsonl yet. */
export function countUserMessages(id) {
  const dir = sessionDir(id);
  try {
    return readEvents(dir).events.filter(isUser).length;
  } catch (err) {
    if (err.code === "ENOENT") return 0;
    throw err;
  }
}

/** What cutting session `id` at `target` would remove, for the confirm dialog. */
export function describeCut(id, target) {
  const { events } = readEvents(sessionDir(id));
  const idx = cutIndex(events, target);
  return { removedUserMessages: countFrom(events, idx), removedEvents: events.length - idx };
}

/** Write `lines` as events.jsonl content (always newline-terminated). */
const jsonl = (lines) => lines.map((l) => l + "\n").join("");

/** YAML single-quoted string. */
const yamlQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** A workspace.yaml scalar value with YAML quotes removed. */
function yamlUnquote(v) {
  v = v.trim();
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, -1);
    }
  }
  return v;
}

/** Value of a top-level `key: value` line in workspace.yaml, or undefined. */
function yamlGet(text, key) {
  const m = text.match(new RegExp(`^${key}:(.*)$`, "m"));
  return m ? yamlUnquote(m[1]) : undefined;
}

/** workspace.yaml text with the given top-level keys replaced (or appended when missing). */
function yamlSet(text, values) {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const [key, value] of Object.entries(values)) {
    const i = lines.findIndex((l) => l.startsWith(`${key}:`));
    if (i === -1) lines.push(`${key}: ${value}`);
    else lines[i] = `${key}: ${value}`;
  }
  return lines.join("\n") + "\n";
}

/** Copy the session dir `src` under a new id with only `lines[0..idx)` of its history, renamed by `rename(oldName)`.
 *  `marker` names an extra empty file to create in the copy. Returns { sessionId, dst, cwd, name }. */
function copySession(src, { events, lines }, idx, rename, now, marker) {
  const sessionId = randomUUID();
  const dst = path.join(path.dirname(src), sessionId);
  try {
    // the original's delete backup, temp files, Copilot's lock file and side-question marker belong to the original only
    const own = (p) =>
      path.dirname(p) !== src || !/^(events\.jsonl\.bak|\.events\.jsonl\..*\.tmp|\.workspace-fork\.lock|\.side-question)$/.test(path.basename(p));
    fs.cpSync(src, dst, { recursive: true, errorOnExist: true, force: false, filter: own });
    if (marker) fs.writeFileSync(path.join(dst, marker), "", { mode: 0o600 });
    const start = structuredClone(events[0]);
    start.data = { ...start.data, sessionId };
    fs.writeFileSync(path.join(dst, "events.jsonl"), jsonl([JSON.stringify(start), ...lines.slice(1, idx)]), { mode: 0o600 });

    const wsFile = path.join(dst, "workspace.yaml");
    let ws = "";
    try {
      ws = fs.readFileSync(wsFile, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    const name = rename(yamlGet(ws, "name") || "session");
    const stamp = now.toISOString();
    fs.writeFileSync(
      wsFile,
      yamlSet(ws, { id: sessionId, name: yamlQuote(name), user_named: "true", created_at: stamp, updated_at: stamp }),
      { mode: 0o600 },
    );
    const cwd = yamlGet(ws, "cwd") || events[0].data?.context?.cwd || null;
    return { sessionId, dst, cwd, name };
  } catch (err) {
    fs.rmSync(dst, { recursive: true, force: true });
    throw err;
  }
}

/** Copy session `id` under a new id with history cut at `target`; the original is not modified. */
export function forkSession(id, target, now = new Date()) {
  const src = sessionDir(id);
  const history = readEvents(src);
  const idx = cutIndex(history.events, target);
  const { sessionId, cwd, name } = copySession(src, history, idx, (old) => `Fork of ${old}`, now);
  const prefill = target.where === "beforeUser" ? String(history.events[idx].data?.content ?? "") : "";
  return { sessionId, cwd, name, prefill };
}

/** Marker file of a temporary side-question copy: such a dir is removed by purgeSideQuestions() if it outlives its use. */
const SIDE_MARKER = ".side-question";

/**
 * Temporary copy of session `id` for a side question, made while its agent may be mid-turn: history up to (not
 * including) user message number `keepUsers + 1`, i.e. the turns finished before the running one. A half-written
 * last line is skipped. The original is not modified.
 */
export function snapshotSession(id, keepUsers, now = new Date()) {
  if (!Number.isInteger(keepUsers) || keepUsers < 0) throw new Error(`Invalid number of turns to keep: ${keepUsers}`);
  const src = sessionDir(id);
  const history = readEvents(src, { liveTail: true });
  let seen = 0;
  let idx = history.events.findIndex((e) => isUser(e) && ++seen > keepUsers);
  if (idx === -1) idx = history.events.length;
  const { sessionId, cwd } = copySession(src, history, idx, () => "Side question (temporary)", now, SIDE_MARKER);
  return { sessionId, cwd };
}

/** True if session `id` is a temporary side-question copy. */
export function isSideQuestion(id) {
  try {
    return fs.existsSync(path.join(sessionDir(id), SIDE_MARKER));
  } catch {
    return false;
  }
}

/** Delete the side-question copies a crash or a stuck process left behind; returns how many were removed. */
export async function purgeSideQuestions() {
  let removed = 0;
  for (const name of await fs.promises.readdir(sessionStateDir()).catch(() => [])) {
    if (!isSessionId(name) || !isSideQuestion(name)) continue;
    const res = await deleteSession(name).catch(() => null);
    if (res) removed++;
  }
  return removed;
}

/** Cut session `id`'s history at `target` in place: events.jsonl.bak first, then an atomic rename. */
export function truncateSession(id, target) {
  const dir = sessionDir(id);
  const { events, lines } = readEvents(dir);
  const idx = cutIndex(events, target);
  if (idx <= 0) throw new Error("Refusing to remove the start of the session");
  const file = path.join(dir, "events.jsonl");
  const tmp = path.join(dir, `.events.jsonl.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, jsonl(lines.slice(0, idx)), { mode: 0o600 });
    fs.copyFileSync(file, file + ".bak");
    fs.chmodSync(file + ".bak", 0o600);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return { removedUserMessages: countFrom(events, idx) };
}

const TRASH = /^\.deleted-[0-9a-f-]{36}-[0-9a-f-]{36}$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** rename that retries while another process (antivirus, a Copilot process still exiting on Windows) holds a file. */
async function renameRetry(from, to, tries = 6) {
  for (let i = 1; ; i++) {
    try {
      return await fs.promises.rename(from, to);
    } catch (err) {
      // EACCES is transient only on Windows (a file held open); elsewhere it is a real permission problem
      const transient = ["EPERM", "EBUSY", ...(process.platform === "win32" ? ["EACCES"] : [])];
      if (i >= tries || !transient.includes(err.code)) throw err;
      await sleep(250 * i);
    }
  }
}

/**
 * Remove session `id` for good: its session-state dir, then its rows in Copilot's session-store.db (an index that
 * only some sessions are in). The dir is first renamed out of the way, so a failed removal never leaves a
 * half-deleted session that still looks resumable; a leftover is retried by purgeDeleted(). The caller must have
 * closed the session's process. With `missingOk`, a session without a dir (never written) only has its rows removed.
 */
export async function deleteSession(id, { missingOk = false } = {}) {
  let dir = null;
  try {
    dir = sessionDir(id);
  } catch (err) {
    if (!missingOk || err.code !== "ENOSESSION") throw err; // an invalid id or a non-dir entry is never "not found"
  }
  let leftover = null;
  if (dir) {
    const trash = path.join(path.dirname(dir), `.deleted-${id}-${randomUUID()}`);
    await renameRetry(dir, trash);
    try {
      // the files that make it a session first: a leftover without them can't be listed or resumed
      for (const f of ["workspace.yaml", "events.jsonl"]) await fs.promises.rm(path.join(trash, f), { force: true, maxRetries: 3 }).catch(() => {});
      await fs.promises.rm(trash, { recursive: true, force: true, maxRetries: 3 });
    } catch (err) {
      leftover = `${trash}: ${err.message}`; // the session is gone already; purgeDeleted() tries again later
    }
  }
  let store;
  try {
    store = { removedRows: await forgetInStore(id) };
  } catch (err) {
    store = { error: err.message };
  }
  return { leftover, store };
}

/** Remove what failed deletions left in session-state (`.deleted-<id>-<uuid>`); returns how many were removed. */
export async function purgeDeleted() {
  const root = sessionStateDir();
  let removed = 0;
  for (const name of await fs.promises.readdir(root).catch(() => [])) {
    if (!TRASH.test(name)) continue;
    try {
      await fs.promises.rm(path.join(root, name), { recursive: true, force: true, maxRetries: 3 }); // a symlink: only the link
      removed++;
    } catch {
      /* still locked: next start */
    }
  }
  return removed;
}

// search_index is a plain FTS5 table (not external-content, no triggers) with an unindexed session_id and no foreign
// key, so it is named here; every other per-session table is found through its foreign key to sessions(id).
const FTS_TABLES = ["search_index"];

/** Delete session `id`'s rows from session-store.db: every table with a foreign key to sessions(id) (by that key's
 *  column, so a column that merely looks like a session id is never used), the FTS index, then `sessions`. */
export async function forgetInStore(id, file = path.join(copilotHome(), "session-store.db"), { timeout = 1500 } = {}) {
  if (!isSessionId(id)) throw new Error(`Invalid session id: ${id}`);
  if (!fs.existsSync(file)) return 0;
  const { DatabaseSync } = await import("node:sqlite");
  // synchronous: keep the wait for a lock short. Foreign keys aren't enforced here: rows of a table that points at a
  // per-session table (not at sessions) are left behind rather than failing the whole cleanup.
  const db = new DatabaseSync(file, { timeout, enableForeignKeyConstraints: false });
  try {
    const tables = db
      .prepare("SELECT name FROM pragma_table_list WHERE schema = 'main' AND type IN ('table', 'virtual')")
      .all()
      .map((r) => r.name);
    const q = (name) => `"${name.replace(/"/g, '""')}"`;
    const targets = []; // [table, column]
    for (const t of tables.filter((t) => t.toLowerCase() !== "sessions")) {
      // a key of sessions on itself (e.g. a parent session) would select other sessions' rows
      const fks = db.prepare(`SELECT "from" AS col FROM pragma_foreign_key_list(?) WHERE lower("table") = 'sessions' AND ("to" IS 'id' OR "to" IS NULL)`).all(t);
      for (const { col } of fks) targets.push([t, col]);
    }
    for (const t of FTS_TABLES) {
      if (tables.includes(t) && db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = 'session_id'`).get(t)) targets.push([t, "session_id"]);
    }
    let removed = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const [t, col] of targets) removed += Number(db.prepare(`DELETE FROM ${q(t)} WHERE ${q(col)} = ?`).run(id).changes);
      if (tables.includes("sessions")) removed += Number(db.prepare("DELETE FROM sessions WHERE id = ?").run(id).changes);
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* SQLite already rolled back (e.g. SQLITE_FULL): report the original error */
      }
      throw err;
    }
    return removed;
  } finally {
    db.close();
  }
}
