// The reply fallback in main: what a chain of prompts said, whether its last reply is forwarded, and the forwards
// that wait for the owner's approval. No Electron imports (see docs/superpowers/specs/2026-11-27-relay-fallback-design.md).
import { agentRelayTools, isRelayCall, neededTool } from "./relay-tools.mjs";
import { randomUUID } from "node:crypto";
import { jsonFileMap } from "./json-file-map.mjs";

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
 * The relay tools of the session's current agent. `readEvents` reads the session's history as history.mjs's
 * readEvents does ({ events, lines }); it is called only for a custom agent, and a read that fails means the tools
 * are unknown, treated as present.
 */
export function relayToolsFor({ agent, readEvents }) {
  if (!agent) return agentRelayTools(agent, null);
  let events = null;
  try {
    events = readEvents().events;
  } catch {
    /* no readable history */
  }
  return agentRelayTools(agent, events);
}

/** How long after the app set the agent its subagent.selected event may still be missing from events.jsonl. */
export const AGENT_EVENT_WAIT_MS = 2000;
const AGENT_EVENT_STEP_MS = 100;

/**
 * relayToolsFor, but right after the app itself set this agent (`agentSetAt` = { value, at }, less than
 * AGENT_EVENT_WAIT_MS ago) it re-reads the history every 100 ms until the agent's subagent.selected is there or the
 * wait is over: Copilot writes that event about 500 ms after set_config_option answers (CLI 1.0.117), and a prompt
 * sent sooner (a delegated child's first one) would otherwise go out as if the agent had the relay tools. Any other
 * case reads once, as relayToolsFor. `now` and `sleep` are injectable for tests.
 */
export async function relayToolsAfterSet({ agent, readEvents, agentSetAt, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!agent) return agentRelayTools(agent, null);
  const read = () => {
    try {
      return readEvents().events;
    } catch {
      return null; // not readable (yet)
    }
  };
  const selected = (events) => (events ?? []).some((e) => e?.type === "subagent.selected" && e.data?.agentName === agent);
  const deadline = agentSetAt?.value === agent && typeof agentSetAt.at === "number" ? agentSetAt.at + AGENT_EVENT_WAIT_MS : -Infinity;
  let events = read();
  while (!selected(events) && now() < deadline) {
    await sleep(Math.min(AGENT_EVENT_STEP_MS, deadline - now()));
    events = read();
  }
  return agentRelayTools(agent, events);
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
      if (seq === null || !topLevel(u)) return; // no chain running: nothing to collect
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

/** Forwards waiting for approval, per session. Kept in main memory; with `file` they are also kept on disk
 *  ({ [sessionId]: Forward[] }, in arrival order) and read once at the start, so they survive a restart. A write that
 *  fails is logged once and never thrown (memory stays the source of truth); an unreadable file reads as empty. A taken
 *  forward added again keeps its id; the ids of a file-backed set are UUIDs, unique across restarts. */
export function createPending({ file } = {}) {
  const bySession = new Map(); // sessionId -> Map<id, forward>
  let n = 0;
  const store = file ? jsonFileMap(file, "fallback") : null;
  let warned = false;
  if (store) {
    for (const [sessionId, list] of Object.entries(store.read())) {
      if (!Array.isArray(list)) continue;
      const m = new Map();
      for (const f of list) if (f && typeof f === "object" && typeof f.id === "string") m.set(f.id, f);
      if (m.size) bySession.set(sessionId, m);
    }
  }
  const save = () => {
    if (!store) return;
    try {
      store.write(Object.fromEntries([...bySession].map(([sessionId, m]) => [sessionId, [...m.values()]])));
    } catch (e) {
      if (!warned) console.warn(`[fallback] could not write ${file}: ${e.message}`);
      warned = true;
    }
  };
  return {
    add(sessionId, f) {
      const id = f.id ?? (store ? randomUUID() : `fb${++n}`);
      if (!bySession.has(sessionId)) bySession.set(sessionId, new Map());
      bySession.get(sessionId).set(id, { ...f, id });
      save();
      return id;
    },
    take(sessionId, id) {
      const m = bySession.get(sessionId);
      const f = m?.get(id) ?? null;
      if (f) {
        m.delete(id);
        if (!m.size) bySession.delete(sessionId);
        save();
      }
      return f;
    },
    list: (sessionId) => [...(bySession.get(sessionId)?.values() ?? [])],
    drop(sessionId) {
      if (bySession.delete(sessionId)) save();
    },
  };
}
