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

/** Relay tools the agent can call, from events.jsonl. The default agent ("" or undefined) and unknown ones have both. */
export function agentRelayTools(agent, events) {
  if (!agent) return both();
  const list = events ?? [];
  const sel = list.findLast((e) => e?.type === "subagent.selected" && e.data?.agentName === agent);
  if (sel) return flags(Array.isArray(sel.data.tools) ? sel.data.tools : []);
  const base = list.findLast(
    (e) => e?.type === "session.tool_baseline" && String(e.data?.surface ?? "").endsWith(`agent=${agent}`),
  );
  if (base) return flags((base.data.tools ?? []).map((t) => t?.name));
  return both();
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

/** Removes a trailing note block added by fallbackNote. */
export function stripNote(text) {
  const i = String(text).lastIndexOf(`\n\n${NOTE_MARK}`);
  return i < 0 ? text : text.slice(0, i);
}
