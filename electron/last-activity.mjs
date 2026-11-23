// When a session was last used: the time of its last message or tool call, for the sidebar's "x min ago" and order.
// Copilot's own updatedAt (session/list) is the modification time of events.jsonl, which also moves when a session
// is only opened (session.resume) or its process ends (session.shutdown). Pure Node built-ins, no Electron.
import fs from "node:fs/promises";
import path from "node:path";
import { copilotHome as copilotHomeDefault, isSessionId, yamlGet } from "./history.mjs";
import { readLines } from "./usage.mjs";

const ACTIVITY = /"type"\s*:\s*"(?:user|assistant|tool)\./; // cheap test of the raw line before it is parsed
const isActivity = (type) => typeof type === "string" && /^(?:user|assistant|tool)\./.test(type);
const TAILS = [64 * 1024, 2 * 1024 * 1024]; // most sessions end within the first; then the whole file (bounded)

/** Time (ms) of the last activity event in these lines, or null. */
function lastEventTime(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!ACTIVITY.test(lines[i])) continue;
    try {
      const e = JSON.parse(lines[i]);
      const t = isActivity(e?.type) ? Date.parse(e.timestamp) : NaN;
      if (Number.isFinite(t)) return t;
    } catch {
      // half-written or foreign line
    }
  }
  return null;
}

/** False only when there is certainly no such file: a file that cannot be looked at counts as there. */
const exists = (file) => fs.stat(file).then(() => true, (e) => e?.code !== "ENOENT");

/** { time } of the file's last activity event (null: it has none, or there is no file); { unknown: true } when the
 *  file is there but could not be read to the end of the search (it is too big, or a read failed). */
async function lastEventTimeOf(file) {
  for (const bytes of [...TAILS, null]) {
    const read = await readLines(file, bytes === null, bytes ?? undefined);
    if (!read) return (await exists(file)) ? { unknown: true } : { time: null };
    const time = lastEventTime(read.lines);
    if (time !== null || !read.truncated) return { time };
  }
  return { unknown: true };
}

async function createdTimeOf(file) {
  try {
    const value = yamlGet(await fs.readFile(file, "utf8"), "created_at");
    const t = value ? new Date(value).getTime() : NaN;
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * ISO time of the last message or tool call of session `sessionId`, or of its creation when that is later (a fork
 * copies older messages) or there are none. null when neither can be read, and when the search of a very big
 * history had to stop (the creation time alone would make a used session look old). Never throws.
 */
export async function readLastActivity(sessionId, { copilotHome } = {}) {
  if (!isSessionId(sessionId)) return null;
  const dir = path.join(copilotHome ?? copilotHomeDefault(), "session-state", sessionId);
  const [event, created] = await Promise.all([lastEventTimeOf(path.join(dir, "events.jsonl")), createdTimeOf(path.join(dir, "workspace.yaml"))]);
  if (event.unknown) return null;
  const times = [event.time, created].filter((t) => t !== null);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

/** A value that changes whenever the session's events.jsonl does (its size and modification time); null without one. */
export async function activityStamp(sessionId, { copilotHome } = {}) {
  if (!isSessionId(sessionId)) return null;
  try {
    const st = await fs.stat(path.join(copilotHome ?? copilotHomeDefault(), "session-state", sessionId, "events.jsonl"));
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

/**
 * Returns `add(sessions)`: the sessions of session/list, each with `lastActivityAt` (ISO or null). A session is read
 * again only when its events.jsonl changed (`stamp`), at most `limit` sessions at a time. An unknown time (null) and
 * a session without a stamp are not remembered: they are read again with the next list.
 */
export function createLastActivity({ read = readLastActivity, stamp = activityStamp, limit = 8 } = {}) {
  let cache = new Map(); // sessionId -> { key, value }
  return async function add(sessions) {
    const next = new Map();
    const out = new Array(sessions.length);
    let at = 0;
    const worker = async () => {
      while (at < sessions.length) {
        const i = at++;
        const s = sessions[i];
        let value = null;
        try {
          const key = await stamp(s.sessionId);
          const hit = cache.get(s.sessionId);
          if (key && hit?.key === key) value = hit.value;
          else value = (await read(s.sessionId)) ?? null;
          if (key && value !== null) next.set(s.sessionId, { key, value });
        } catch {
          // the list must never fail over a time
        }
        out[i] = { ...s, lastActivityAt: value };
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, sessions.length) }, worker));
    cache = next;
    return out;
  };
}
