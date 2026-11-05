// Saved side questions: the cards a session's chat shows for questions asked while its agent was busy. They are
// not in Copilot's history (the agent never saw them), so the app keeps them itself: one JSON file per session in
// `dir` (the app's data folder). Pure Node built-ins, no Electron.
import fs from "node:fs";
import path from "node:path";
import { isSessionId } from "./history.mjs";

const STATES = ["done", "stopped", "failed"];
const MAX_TEXT = 100_000;
const MAX_ENTRIES = 500;

function fileFor(dir, sessionId) {
  if (!isSessionId(sessionId)) throw new Error(`Invalid session id: ${sessionId}`);
  return path.join(dir, `${sessionId.toLowerCase()}.json`);
}

const str = (v, max = MAX_TEXT) => (typeof v === "string" ? v.slice(0, max) : "");

/** A stored entry with only known, well-typed fields; null if it isn't one. */
export function cleanEntry(e) {
  if (!e || typeof e !== "object" || typeof e.id !== "string" || !/^[\w-]{1,64}$/.test(e.id)) return null;
  if (!Number.isInteger(e.turn) || e.turn < 0) return null;
  return {
    id: e.id,
    turn: e.turn, // the user message (turn ordinal) during which it was asked; the card follows that turn's reply
    at: str(e.at, 40),
    question: str(e.question),
    answer: str(e.answer),
    state: STATES.includes(e.state) ? e.state : "done",
    detail: str(e.detail, 2000),
    sentAt: str(e.sentAt, 40),
    collapsed: e.collapsed === true,
  };
}

/** Side questions saved for `sessionId`, oldest first; [] when there are none or the file is unreadable. */
export function listAsides(dir, sessionId) {
  const file = fileFor(dir, sessionId);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  return Array.isArray(raw) ? raw.map(cleanEntry).filter(Boolean) : [];
}

function write(dir, sessionId, list) {
  const file = fileFor(dir, sessionId);
  if (!list.length) return fs.rmSync(file, { force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list.slice(-MAX_ENTRIES)), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Add or replace (by id) one side question. */
export function saveAside(dir, sessionId, entry) {
  const e = cleanEntry(entry);
  if (!e) throw new Error("Invalid side question.");
  const list = listAsides(dir, sessionId);
  const i = list.findIndex((x) => x.id === e.id);
  if (i === -1) list.push(e);
  else list[i] = e;
  write(dir, sessionId, list);
  return e;
}

export function removeAside(dir, sessionId, id) {
  write(dir, sessionId, listAsides(dir, sessionId).filter((x) => x.id !== id));
}

/** After history was cut to `turns` user messages: drop the side questions asked during the removed turns. */
export function pruneAsides(dir, sessionId, turns) {
  const list = listAsides(dir, sessionId);
  const kept = list.filter((x) => x.turn <= turns);
  if (kept.length !== list.length) write(dir, sessionId, kept);
}

/** All side questions of a deleted session. */
export function dropAsides(dir, sessionId) {
  fs.rmSync(fileFor(dir, sessionId), { force: true });
}
