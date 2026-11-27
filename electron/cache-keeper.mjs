// Rules of the cache keeper: when to send keep-alive pings, when to count down and when to compact so the prompt
// cache of a paused session does not expire unused. Pure: no timers, no files, no Electron. The runner feeds it
// events and facts and asks `next` what to do and when.

export const PING_LEAD_MS = 60_000; // a ping goes out this long before the cache expires
export const COUNTDOWN_LEAD_MS = 120_000; // the "compacting soon" countdown starts this long before expiry
export const COMPACT_LEAD_MS = 60_000; // compaction starts this long before expiry
export const LATE_MS = 30_000; // closer to expiry than this, nothing is started (timers fire late, so this sits before the action times)
// A countdown or a compaction is still started this long after its time (a timer a little late); later than that,
// e.g. once a block (held text, a card, the switch, settings) is released, it is missed: no compaction without the
// countdown the user could see. Pings have no such limit.
export const CATCHUP_MS = 2_000;
export const MAX_PINGS = 20;
export const KEEPALIVE_MARKER = "[keep-alive]";

const DEFAULTS = { enabled: false, pings: 6, minContext: 50_000 };
// pings are real messages in the model's context: the last exchange to keep is the last one that is not a ping
const COMPACT_BASE =
  `/compact Ignore the messages that start with ${KEEPALIVE_MARKER} and their one-dot replies. Quote verbatim the last other user message and your answer to it.`;
const COMPACT_PARENT =
  " For each delegated child session, keep verbatim what you asked it to do and how you planned to check its result.";

export function keepAliveText() {
  return `${KEEPALIVE_MARKER} The user is away. Reply with a single dot. Do not use any tool and do not continue any task.`;
}

export function compactText({ parent }) {
  return parent ? COMPACT_BASE + COMPACT_PARENT : COMPACT_BASE;
}

/** True for our own ping prompt, also when the CLI put a datetime block in front of it. */
export function isKeepAlive(text) {
  const t = String(text ?? "").trim().replace(/^<current_datetime>[\s\S]*?<\/current_datetime>\s*/, "");
  return t.startsWith(KEEPALIVE_MARKER);
}

// A field that was sent but is empty, NaN or negative means 0; a field that was not sent means the default.
function wholeNumber(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

export function normalizeKeeperSettings(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const mc = Math.floor(Number(r.minContext));
  const minContext = r.minContext === "" || r.minContext == null || !Number.isFinite(mc) ? DEFAULTS.minContext : Math.max(0, mc);
  return { enabled: r.enabled === true, pings: Math.min(MAX_PINGS, wholeNumber(r.pings, DEFAULTS.pings)), minContext };
}

export function initialState() {
  return { expiresAt: null, pingsSent: 0, skipped: false, phase: "idle" };
}

export function reduce(state, event) {
  switch (event.type) {
    case "turnEnded": // a turn starts a new pause
      return { ...initialState(), expiresAt: event.expiresAt };
    case "pingEnded":
      return { ...state, expiresAt: event.expiresAt, pingsSent: state.pingsSent + 1, phase: "idle" };
    case "compactEnded": // the cache is fresh and small now; nothing more to do until the next turn
      return { ...state, phase: "done" };
    case "activity": // the user or the session did something: forget the pause until a turn ends
      return initialState();
    case "notNow":
      return { ...state, skipped: true };
    default:
      return state;
  }
}

/** What to do next and when (`at`, epoch ms; at <= now means due now). `missed: true` with `none`: the countdown or
 *  the compaction is later than CATCHUP_MS, so the rest of the pause is skipped (the runner marks it `notNow`). */
export function next({ state, now, settings, facts, leads }) {
  const none = { action: "none", at: null };
  const missed = { ...none, missed: true };
  const lead = { ping: PING_LEAD_MS, countdown: COUNTDOWN_LEAD_MS, compact: COMPACT_LEAD_MS, late: LATE_MS, catchup: CATCHUP_MS, ...leads };
  if (!facts.enabled || !settings.enabled) return none;
  if (facts.busy || facts.held || facts.replaying) return none;
  if (state.skipped || state.phase === "done" || state.phase === "off") return none;
  if (state.expiresAt == null || !(facts.contextUsed >= settings.minContext)) return none;

  // Too late: the cache may already be cold.
  if (state.expiresAt - now < lead.late) return none;

  // An action whose time has passed is due now (at <= now), as long as it is not too late; a countdown or a
  // compaction only within the catch-up.
  if (state.phase === "countdown") {
    const compactAt = state.expiresAt - lead.compact;
    return now > compactAt + lead.catchup ? missed : { action: "compact", at: compactAt };
  }
  if (state.pingsSent < settings.pings) return { action: "ping", at: state.expiresAt - lead.ping };
  const countdownAt = state.expiresAt - lead.countdown;
  return now > countdownAt + lead.catchup ? missed : { action: "countdown", at: Math.max(now, countdownAt) };
}

const COMPACT_REPLY = "Compacted conversation history";
/** An agent message that is the reply to `/compact`. */
export const isCompactReply = (text) => String(text ?? "").startsWith(COMPACT_REPLY);
// what a turn produces; session state (command list, usage, config, title) is not turn content and always passes
export const TURN_CONTENT = new Set(["user_message_chunk", "agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"]);

/** Filter for the updates `session/load` replays: keep-alive prompts, the turn content the session produced in answer to them, and
 *  the `/compact` reply are not part of the chat the user sees. One filter per replay. */
export function createReplayFilter() {
  let swallowing = false;
  return {
    pass(update) {
      const text = update?.content?.text;
      if (update?.sessionUpdate === "user_message_chunk") {
        swallowing = isKeepAlive(text);
        return !swallowing;
      }
      if (swallowing && TURN_CONTENT.has(update?.sessionUpdate)) return false;
      return !(update?.sessionUpdate === "agent_message_chunk" && isCompactReply(text));
    },
  };
}
