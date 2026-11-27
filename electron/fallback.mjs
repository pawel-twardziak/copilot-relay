// The reply fallback in main: what a chain of prompts said, whether its last reply is forwarded, and the forwards
// that wait for the owner's approval. No Electron imports (see docs/superpowers/specs/2026-11-27-relay-fallback-design.md).
import { isRelayCall, neededTool } from "./relay-tools.mjs";

const ABORT_TEXT = "Info: Operation cancelled by user"; // the chunk Copilot writes for a cancelled turn
const topLevel = (u) => !u?._meta?.["github.com/copilot"]?.agentId; // a subagent's updates carry its agentId

/** The chain origin as the window sent it, kept only in a known shape: a relay sender with a key, or the owner. */
export function originOf(o) {
  if (o?.kind === "owner") return { kind: "owner" };
  if (o?.kind === "relay" && typeof o.fromKey === "string" && o.fromKey) {
    return { kind: "relay", fromKey: o.fromKey, fromName: typeof o.fromName === "string" ? o.fromName : "" };
  }
  return null;
}

/**
 * One chain: the prompt a relay message (or an owner turn of an unreported child) starts, any prompts delivered into
 * it mid-turn, and the continue prompt. `reported` is the session's state when the chain started: it decides which
 * tool the reply stands in for, also when the session reports during the chain.
 */
export function createChainState() {
  let seq = null;
  let origin = null;
  let reported = false;
  let text = "";
  let titles = [];
  let lastStop = null;
  let prompts = 0;
  return {
    start(s = {}) {
      seq = s.seq ?? null;
      origin = s.origin ?? null;
      reported = s.reported === true;
      text = "";
      titles = [];
      lastStop = null;
    },
    /** A prompt of the chain starts: the reply shown after it is a new message. Returns the prompt's number. */
    prompt() {
      text = "";
      lastStop = null;
      return ++prompts;
    },
    update(u) {
      if (!topLevel(u)) return;
      if (u?.sessionUpdate === "tool_call") {
        text = "";
        if (u.title) titles.push(u.title);
      } else if (u?.sessionUpdate === "agent_message_chunk" && typeof u.content?.text === "string" && u.content.text !== ABORT_TEXT) {
        text += u.content.text;
      }
    },
    /** A prompt returned. Only the most recently started one counts: an interrupted one returns after its successor. */
    stopped(reason, n = prompts) {
      if (n === prompts) lastStop = reason;
    },
    snapshot: () => ({ seq, origin, text, titles: [...titles], lastStop, reported }),
  };
}

/** The forward a chain's end prepares, or null (see "Turn end" in the spec). The caller reads `tools` at the end. */
export function decideForward({ snapshot, tools, parentKey, reported } = {}) {
  if (snapshot?.lastStop !== "end_turn") return null;
  const tool = neededTool({ origin: snapshot.origin, parentKey, reported });
  if (!tool || tools?.[tool] !== false) return null;
  if (snapshot.titles.some((t) => isRelayCall(t, tool))) return null;
  if (!String(snapshot.text ?? "").trim()) return null;
  return { toKey: snapshot.origin.kind === "owner" ? parentKey : snapshot.origin.fromKey, kind: tool === "report_result" ? "report" : "message" };
}

/** Forwards waiting for approval, per session, in main memory. A taken forward added again keeps its id. */
export function createPending() {
  const bySession = new Map(); // sessionId -> Map<id, forward>
  let n = 0;
  return {
    add(sessionId, f) {
      const id = f.id ?? `fb${++n}`;
      if (!bySession.has(sessionId)) bySession.set(sessionId, new Map());
      bySession.get(sessionId).set(id, { ...f, id });
      return id;
    },
    take(sessionId, id) {
      const m = bySession.get(sessionId);
      const f = m?.get(id) ?? null;
      if (f) m.delete(id);
      return f;
    },
    list: (sessionId) => [...(bySession.get(sessionId)?.values() ?? [])],
    drop: (sessionId) => void bySession.delete(sessionId),
  };
}
