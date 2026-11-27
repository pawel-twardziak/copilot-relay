// Content-search scan, run in a worker thread so main (which relays every open session's stream) never blocks on it.
// Protocol: main posts { seq, query, ids, copilotHome }; the worker answers { seq, result } or { seq, cancelled: true }
// (a message with a higher seq arrived: the scan stops at the next file boundary). Parsed messages are cached per
// session, keyed by the file's size + mtime (Copilot rewrites events.jsonl in place on truncate and fork).
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parentPort } from "node:worker_threads";
import { extractMessages, isSessionId, searchMessages } from "./history.mjs";

const FindText = createRequire(import.meta.url)("./renderer/find-text.js");

export const MAX_SESSIONS = 50;
const cache = new Map(); // sessionId -> { size, mtimeMs, messages }
let latestSeq = 0;

/** The cached messages of a session (with their folded text), re-read when the file changed; null with no file. */
async function messagesOf(home, id) {
  const file = path.join(home, "session-state", id, "events.jsonl");
  let st;
  try {
    st = await fs.promises.stat(file);
  } catch {
    cache.delete(id);
    return null;
  }
  const hit = cache.get(id);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.messages;
  let text;
  try {
    text = await fs.promises.readFile(file, "utf8");
  } catch {
    cache.delete(id);
    return null;
  }
  const messages = extractMessages(text).map((m) => ({ ...m, folded: FindText.foldText(m.text) }));
  cache.set(id, { size: st.size, mtimeMs: st.mtimeMs, messages });
  return messages;
}

async function scan({ seq, query, ids, copilotHome }) {
  const sessions = [];
  for (const id of new Set(ids)) {
    if (seq !== latestSeq) return { seq, cancelled: true };
    if (!isSessionId(id)) continue;
    const messages = await messagesOf(copilotHome, id);
    if (!messages) continue;
    const { count, latest, hits } = searchMessages(messages, query);
    if (count > 0) sessions.push({ sessionId: id, count, latest, hits });
  }
  if (seq !== latestSeq) return { seq, cancelled: true };
  sessions.sort((a, b) => (b.latest ?? -Infinity) - (a.latest ?? -Infinity));
  return { seq, result: { cancelled: false, sessions: sessions.slice(0, MAX_SESSIONS), more: sessions.length > MAX_SESSIONS } };
}

parentPort.on("message", (msg) => {
  latestSeq = msg.seq;
  scan(msg).then((reply) => parentPort.postMessage(reply));
});
