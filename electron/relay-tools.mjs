// Which relay tools a session's current agent can call, and the note for the reply fallback. No Electron imports.
export const RELAY_TOOLS = ["report_result", "send_message"];
export const NOTE_MARK = "[relay fallback]";

const both = () => ({ report_result: true, send_message: true });

// Does one tool entry (an agent's `tools:` item or a baseline tool name) grant the relay tool?
const grants = (entry, tool) => {
  const e = String(entry ?? "");
  return e === "*" || e === "relay/*" || e === `relay/${tool}` || e === `relay-${tool}` || e === `relay_${tool}`;
};

const flags = (entries) => Object.fromEntries(RELAY_TOOLS.map((t) => [t, entries.some((e) => grants(e, t))]));

/** The file-style name Copilot puts in a baseline's surface for an agent named `name` ("Poeta wspomnień" →
 *  "poeta-wspomnien"): lower case, no diacritics, runs of other characters as one "-". */
export const agentSlug = (name) =>
  String(name ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ł/g, "l")
    .replace(/Ł/g, "L")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const isSwitch = (e) => e?.type === "subagent.selected" || e?.type === "subagent.deselected";

/** The session's own events: a sub-agent's (task tool) events carry `agentId` on the envelope. */
const ownEvents = (events) => (events ?? []).filter((e) => !e?.agentId);

/** Is the agent's own subagent.selected the last switch in the session (no other agent selected, no default since)? */
export const agentIsLastSelected = (agent, events) => {
  const list = ownEvents(events);
  const at = list.findLastIndex(isSwitch);
  return at >= 0 && list[at].type === "subagent.selected" && list[at].data?.agentName === agent;
};

/** Relay tools the agent can call, from events.jsonl. The default agent ("" or undefined) and unknown ones have both.
 *  Of the agent's last subagent.selected and its last tool baseline, the later one in the list counts: a reload after
 *  the agent file changed writes a new baseline but no new subagent.selected. A baseline is the agent's when it was
 *  written after the agent's own selection with no switch since (its surface carries the file name, which can differ
 *  from the agent's `name:`), or when its surface ends with `agent=<name>` or `agent=<file-style name>`. */
export function agentRelayTools(agent, events) {
  if (!agent) return both();
  const list = ownEvents(events);
  const selAt = list.findLastIndex((e) => e?.type === "subagent.selected" && e.data?.agentName === agent);
  const ownFrom = selAt >= 0 && list.findLastIndex(isSwitch) === selAt ? selAt : Infinity;
  // never a bare "agent=": that is the default agent's surface (a name without Latin letters has an empty slug)
  const slug = agentSlug(agent);
  const names = [`agent=${agent}`, ...(slug ? [`agent=${slug}`] : [])];
  const baseAt = list.findLastIndex((e, i) => {
    if (e?.type !== "session.tool_baseline") return false;
    const surface = String(e.data?.surface ?? "");
    if (i > ownFrom && !surface.endsWith("agent=")) return true; // a default-agent baseline is never this agent's
    return names.some((n) => surface.endsWith(n));
  });
  if (selAt < 0 && baseAt < 0) return both();
  // A missing tools list means all tools (an agent file without a `tools:` key).
  if (selAt > baseAt) {
    const tools = list[selAt].data.tools;
    return Array.isArray(tools) ? flags(tools) : both();
  }
  const tools = list[baseAt].data.tools;
  return Array.isArray(tools) ? flags(tools.map((t) => t?.name)) : both();
}

/** Is this tool-call title a call of the given relay tool? */
export const isRelayCall = (title, tool) => title === `relay-${tool}` || title === `relay_${tool}`;

/** The tool the session's last reply stands in for, or null when nothing is expected. */
export function neededTool({ origin, parentKey, reported } = {}) {
  if (origin?.kind === "owner") return parentKey && !reported ? "report_result" : null;
  if (origin?.kind === "relay" && origin.fromKey) {
    return origin.fromKey === parentKey && !reported ? "report_result" : "send_message";
  }
  return null;
}

export function fallbackNote({ toName, kind }) {
  const as = kind === "report" ? "report" : "reply";
  return (
    `${NOTE_MARK}\nYou cannot use the relay tools in this session. Your last message of this turn is sent to ` +
    `"${toName}" as your ${as}, so end the turn with the result itself, or a short summary. ` +
    `Ignore any instruction to use report_result or send_message, here or in your instructions.`
  );
}

// the note's fixed text around the recipient's name, for each kind (stripNote recognises a whole note by them)
const NAME = "\u0000";
const NOTE_PARTS = ["report", "message"].map((kind) => fallbackNote({ toName: NAME, kind }).split(NAME));
const isNote = (s) => NOTE_PARTS.some(([head, tail]) => s.length >= head.length + tail.length && s.startsWith(head) && s.endsWith(tail));

/** Removes a trailing note block added by fallbackNote ("\n\n" + the whole note, to the end); any other text is
 *  unchanged. The window keeps a copy (electron/renderer/fallback.js). */
export function stripNote(text) {
  const s = String(text);
  const sep = `\n\n${NOTE_MARK}\n`;
  // from the last marker back: the latest one that starts a whole note (a name may contain the marker too)
  for (let i = s.lastIndexOf(sep); i >= 0; i = i > 0 ? s.lastIndexOf(sep, i - 1) : -1) {
    if (isNote(s.slice(i + 2))) return s.slice(0, i);
  }
  return text;
}
