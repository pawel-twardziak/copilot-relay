// Copilot session history files (session-state/<id>/events.jsonl + workspace.yaml): fork and truncate.
// The only place that knows the on-disk format; pure Node built-ins, no Electron.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMAT_ERROR = "Unrecognized session history format";
const NOT_FOUND = "Could not find this message in the session history";

/** $COPILOT_HOME/session-state, resolved at call time (same default as relayConfig in main.mjs). */
export function sessionStateDir() {
  const home = process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
  return path.join(home, "session-state");
}

/** Real path of a session's dir; throws unless `id` is a UUID naming a real directory directly in session-state. */
export function sessionDir(id) {
  if (typeof id !== "string" || !UUID.test(id)) throw new Error(`Invalid session id: ${id}`);
  let root;
  let st;
  try {
    root = fs.realpathSync(sessionStateDir());
    st = fs.lstatSync(path.join(root, id));
  } catch {
    throw new Error(`Session not found: ${id}`);
  }
  if (!st.isDirectory()) throw new Error(`Session ${id} is not a directory`);
  const dir = fs.realpathSync(path.join(root, id));
  if (path.dirname(dir) !== root) throw new Error(`Session ${id} is outside ${root}`);
  return dir;
}

/** Parsed events plus their raw lines (kept so writing back preserves the original bytes). */
export function readEvents(dir) {
  const lines = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").split("\n").filter((l) => l.trim());
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

/** Copy session `id` under a new id with history cut at `target`; the original is not modified. */
export function forkSession(id, target, now = new Date()) {
  const src = sessionDir(id);
  const { events, lines } = readEvents(src);
  const idx = cutIndex(events, target);
  const sessionId = randomUUID();
  const dst = path.join(path.dirname(src), sessionId);
  try {
    fs.cpSync(src, dst, { recursive: true, errorOnExist: true, force: false });
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
    const name = `Fork of ${yamlGet(ws, "name") || "session"}`;
    const stamp = now.toISOString();
    fs.writeFileSync(
      wsFile,
      yamlSet(ws, { id: sessionId, name: yamlQuote(name), user_named: "true", created_at: stamp, updated_at: stamp }),
      { mode: 0o600 },
    );
    const cwd = yamlGet(ws, "cwd") || events[0].data?.context?.cwd || null;
    const prefill = target.where === "beforeUser" ? String(events[idx].data?.content ?? "") : "";
    return { sessionId, cwd, name, prefill };
  } catch (err) {
    fs.rmSync(dst, { recursive: true, force: true });
    throw err;
  }
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
