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

async function lastEventTimeOf(file) {
  for (const bytes of [...TAILS, null]) {
    const read = await readLines(file, bytes === null, bytes ?? undefined);
    if (!read) return null;
    const t = lastEventTime(read.lines);
    if (t !== null || !read.truncated) return t;
  }
  return null;
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
 * copies older messages) or there are none. null when neither can be read. Never throws.
 */
export async function readLastActivity(sessionId, { copilotHome } = {}) {
  if (!isSessionId(sessionId)) return null;
  const dir = path.join(copilotHome ?? copilotHomeDefault(), "session-state", sessionId);
  const times = (await Promise.all([lastEventTimeOf(path.join(dir, "events.jsonl")), createdTimeOf(path.join(dir, "workspace.yaml"))])).filter((t) => t !== null);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

/**
 * Returns `add(sessions)`: the sessions of session/list, each with `lastActivityAt` (ISO or null). A session is read
 * again only when its updatedAt changed (that is the file's modification time), at most `limit` files at a time.
 */
export function createLastActivity({ read = readLastActivity, limit = 8 } = {}) {
  let cache = new Map(); // sessionId -> { updatedAt, value }
  return async function add(sessions) {
    const next = new Map();
    const out = new Array(sessions.length);
    let at = 0;
    const worker = async () => {
      while (at < sessions.length) {
        const i = at++;
        const s = sessions[i];
        const hit = cache.get(s.sessionId);
        let value = null;
        if (hit && s.updatedAt && hit.updatedAt === s.updatedAt) {
          value = hit.value;
          next.set(s.sessionId, hit);
        } else {
          try {
            value = (await read(s.sessionId)) ?? null;
            next.set(s.sessionId, { updatedAt: s.updatedAt, value });
          } catch {
            // not remembered: tried again with the next list
          }
        }
        out[i] = { ...s, lastActivityAt: value };
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, sessions.length) }, worker));
    cache = next;
    return out;
  };
}
