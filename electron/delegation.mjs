// Pure decisions for delegated child sessions. No Electron imports.

const isChild = (e) => Boolean(e?.parentSessionId);

export function findModelOption(options) {
  return (options ?? []).find((o) => o?.id === "model");
}

const findAgentOption = (options) => (options ?? []).find((o) => o?.id === "agent");

const valuesOf = (option) => [...new Set((option?.options ?? []).map((o) => o.value))];
const list = (values) => values.map((v) => (v === "" ? '"" (default)' : v)).join(", ");

export function resolveConfig(options, { agent, model, inheritedModel } = {}) {
  const sets = [];
  const push = (option, value) => {
    if (value !== option.currentValue) sets.push({ configId: option.id, value });
  };

  const modelOption = findModelOption(options);
  if (model) {
    if (!modelOption) return { error: "This session does not expose a model option, so a model cannot be chosen." };
    const values = valuesOf(modelOption);
    if (!values.includes(model)) return { error: `Unknown model "${model}". Valid models: ${list(values)}.` };
    push(modelOption, model);
  } else if (inheritedModel && modelOption && valuesOf(modelOption).includes(inheritedModel)) {
    push(modelOption, inheritedModel);
  }

  if (agent) {
    const agentOption = findAgentOption(options);
    if (!agentOption) return { error: `Cannot use agent "${agent}": there are no custom agents available.` };
    const values = valuesOf(agentOption);
    if (!values.includes(agent)) return { error: `Unknown agent "${agent}". Valid agents: ${list(values)}.` };
    push(agentOption, agent);
  }

  return { sets };
}

export function childPrompt({ parentName, task, folder }) {
  return (
    `[from ${parentName}]\n` +
    (folder ? `[folder ${JSON.stringify(folder)}]\n` : "") +
    `You were started by the session "${parentName}" to do the task below. ` +
    `${parentName} cannot see this session's chat, so when you are done, send the result with the report_result tool, exactly once.\n\n` +
    task
  );
}

/** Rejects with `message` if `promise` is not settled by `deadline` (ms since the epoch). */
export function withDeadline(promise, deadline, message) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), Math.max(0, deadline - Date.now()));
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/** The question asked before a reload: { message, detail } (see the View menu in main.mjs). `reopens`: open reopen
 *  cards of the sessions it stops (the broker asks again when they register anew). */
export function reloadWarning(children, requests, reopens = 0) {
  const stopped = children ? `stops ${children} delegated ${children === 1 ? "session" : "sessions"}` : "";
  const dropped = requests ? `discards ${requests} waiting ${requests === 1 ? "request" : "requests"} for a new session` : "";
  const asked = reopens
    ? ` ${reopens} open reopen ${reopens === 1 ? "request of theirs is" : "requests of theirs are"} asked again when they are resumed.`
    : "";
  return {
    message: `Reloading ${[stopped, dropped].filter(Boolean).join(" and ")}.`,
    detail: `A reloaded window cannot show their cards. Stopped sessions stay in the list and can be resumed.${asked}`,
  };
}

/** Children that still owe their parent a report. An adopted child was given no task, so it owes none. */
export function unreportedChildren(entries) {
  return [...entries].filter((e) => isChild(e) && !e.reported && !e.adopted);
}

/** The relay's own tools, by the server-prefixed title of their tool call: they run without Copilot's prompt
 *  (adopt_session and release_session are approved on the app's link card instead). */
export function isRelayTool(title) {
  return /^relay-(send_message|list_sessions|create_session|report_result|adopt_session|release_session)$/.test(title ?? "");
}

/** The window's link card for the broker's link_request, shown in the view of `sessionId` (the parent that asked). */
export function linkCardOf(sessionId, { requestId, kind, childKey, childName, childCwd, parentName, task }) {
  return { sessionId, requestId, kind, childSessionId: String(childKey ?? "").replace(/^cli:/, ""), childName, childCwd, parentName, task };
}

export class PendingRequests {
  #byId = new Map();

  add(req) {
    this.#byId.set(req.requestId, req);
  }

  take(id) {
    const req = this.#byId.get(id);
    this.#byId.delete(id);
    return req;
  }

  get size() {
    return this.#byId.size;
  }

  clear() {
    this.#byId.clear();
  }

  dropForParent(parentId) {
    for (const [id, req] of this.#byId) if (req.parentSessionId === parentId) this.#byId.delete(id);
  }
}
