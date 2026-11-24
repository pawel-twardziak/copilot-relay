// Pure decisions for delegated child sessions. No Electron imports.
import path from "node:path";
import { childCommandArgs } from "./child-command.mjs";
import { normalizeTier } from "./context-tier.mjs";

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

const optionList = (option) => {
  const seen = new Set();
  const out = [];
  for (const o of option?.options ?? []) {
    if (seen.has(o.value)) continue;
    seen.add(o.value);
    out.push({ value: o.value, name: o.name });
  }
  return out;
};

/** The approval card's start values from the parent's request. `parent`: { cwd, tier, storedCommand, command,
 *  configOptions, name }; `isDir(path)` is the caller's file system check. A value the parent asked for that cannot
 *  be taken gets a note and the default; `from` says which values are the parent's. */
export function cardStart(request, parent, { isDir }) {
  const notes = {};
  const from = { cwd: false, tier: false, agent: false, model: false, own: false, command: false };
  const str = (v) => (typeof v === "string" ? v : "");

  let cwd = parent.cwd;
  const folder = str(request.folder);
  if (folder) {
    if (path.isAbsolute(folder) && isDir(folder)) {
      cwd = path.resolve(folder);
      from.cwd = true;
    } else {
      notes.cwd = `Asked for the folder "${folder}", which is not an existing absolute path.`;
    }
  }

  let tier = parent.tier;
  const context = str(request.context);
  if (context) {
    const asked = normalizeTier(context);
    if (asked) {
      tier = asked;
      from.tier = true;
    } else {
      notes.tier = `Asked for the context "${context}", which is not 200k or 1M.`;
    }
  }

  const own = str(request.prompt);
  from.own = own !== "";

  let command = parent.storedCommand;
  const asked = str(request.command);
  if (asked) {
    const parsed = childCommandArgs(asked);
    if (parsed.refused) {
      notes.command = `Asked for a command that was not taken: ${parsed.refused}`;
    } else if (parsed.args.length) {
      command = `${parent.command} ${parsed.args.join(" ")}`;
      from.command = true;
    }
  }

  const modelOption = findModelOption(parent.configOptions);
  const agentOption = findAgentOption(parent.configOptions);
  const agents = optionList(agentOption);
  const models = optionList(modelOption);

  let agent = "";
  const askedAgent = str(request.agent);
  if (askedAgent) {
    if (agents.some((a) => a.value === askedAgent)) {
      agent = askedAgent;
      from.agent = true;
    } else if (!agentOption) {
      notes.agent = `Asked for the agent "${askedAgent}", but there are no custom agents available.`;
    } else {
      notes.agent = `Asked for the agent "${askedAgent}", which is not offered here. Valid agents: ${list(valuesOf(agentOption))}.`;
    }
  }

  let model = "";
  const askedModel = str(request.model);
  if (askedModel) {
    if (models.some((m) => m.value === askedModel)) {
      model = askedModel;
      from.model = true;
    } else {
      notes.model = `Asked for the model "${askedModel}", which is not offered here. Valid models: ${list(valuesOf(modelOption))}.`;
    }
  }

  return {
    cwd,
    tier,
    agent,
    model,
    own,
    command,
    agents,
    models,
    currentModel: modelOption?.currentValue ?? null,
    parentName: parent.name || "the session",
    from,
    notes,
  };
}

/** The card's answer as main uses it: an absolute folder, a valid tier, agent and model as text. */
export function answerFields(fields, { parentCwd, parentTier }) {
  const f = fields && typeof fields === "object" ? fields : {};
  return {
    cwd: typeof f.cwd === "string" && path.isAbsolute(f.cwd) ? path.resolve(f.cwd) : parentCwd,
    tier: normalizeTier(f.tier) ?? parentTier,
    agent: typeof f.agent === "string" ? f.agent : "",
    model: typeof f.model === "string" ? f.model : "",
  };
}

/** What the parent is told when the child is up. */
export function createdText({ name, childCwd, parentCwd }) {
  const tail = "and has started on its task. It will send you its result with report_result.";
  return path.resolve(childCwd) !== path.resolve(parentCwd)
    ? `Session "${name}" was created in the folder "${childCwd}" ${tail}`
    : `Session "${name}" was created ${tail}`;
}

/** The last line of the intro of a child's first message, also said in the child part of its prompt. */
export const REMINDER = "When you are done, always send the result (or a short summary) with report_result.";

export function childPrompt({ parentName, task, folder }) {
  return (
    `[from ${parentName}]\n` +
    (folder ? `[folder ${JSON.stringify(folder)}]\n` : "") +
    `You were started by the session "${parentName}" to do the task below. ` +
    `${REMINDER}\n\n` +
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

/** Children that still owe their parent a report (delegated or adopted). */
export function unreportedChildren(entries) {
  return [...entries].filter((e) => isChild(e) && !e.reported);
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
