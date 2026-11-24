// Shared state and helpers of the SDK probe: runtime clients, sessions, event recording, turns.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanText, errorInfo, rmrf, sanitize, shape, sleep, withTimeout } from "./lib.mjs";

/** Everything the scenarios share. Filled by probe.mjs before the first scenario runs. */
export const G = {
  opt: {},
  sdk: null,
  cli: null, // resolveCli() result
  variant: null, // runtime variant the scenarios use: "cli" | "script" | "bundled"
  cwd: process.cwd(), // the repository under test (--cwd)
  tmpRoot: null,
  copilotHome: process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot"),
  clients: new Map(), // mode -> started CopilotClient
  extraClients: new Set(),
  sessions: new Set(), // session IDs the probe created (deleted by the cleanup scenario)
  acp: null, // ACP baseline: { agents, models, sessionId, … }
  discovery: {}, // "mode/discovery" -> what a session sees
  best: { enableConfigDiscovery: undefined }, // session options that showed the most custom agents
  customAgents: [],
};

export class Skip extends Error {}

// ---------------------------------------------------------------------------------------------------------------
// Runtime connections and clients

/** A RuntimeConnection for a variant. `extra` goes to the factory (e.g. `{ env }`). */
export function runtimeFor(variant, extra = {}) {
  const { RuntimeConnection } = G.sdk;
  const env = extra.env ?? process.env;
  switch (variant) {
    case "cli":
      if (!G.cli.executable) throw new Skip("no directly startable Copilot executable found");
      return RuntimeConnection.forSpawnedStdio({ path: G.cli.executable, ...extra });
    case "script":
      if (!G.cli.script) throw new Skip("no JavaScript entry of the Copilot CLI found");
      return RuntimeConnection.forSpawnedStdio({ path: G.cli.script, ...extra });
    case "bundled": {
      // without `path` the SDK would still pick up COPILOT_CLI_PATH: hide it to really test the bundled runtime
      const clean = { ...env };
      delete clean.COPILOT_CLI_PATH;
      return RuntimeConnection.forSpawnedStdio({ ...extra, env: clean });
    }
    case "tcp": {
      const p = G.cli.executable ?? G.cli.script;
      return RuntimeConnection.forSpawnedTcp({ ...(p ? { path: p } : {}), ...extra });
    }
    case "inprocess":
      return RuntimeConnection.forInProcess({});
    default:
      throw new Error(`unknown runtime variant: ${variant}`);
  }
}

/** A started client. Clients are shared per mode unless `fresh` (own runtime process) is asked for. */
export async function getClient(mode = "coding-agent", { fresh = false, env } = {}) {
  if (!fresh && G.clients.has(mode)) return G.clients.get(mode);
  if (!G.variant) throw new Error("no working runtime variant (see the runtime-variants scenario)");
  // "empty" mode refuses to start without an explicit place for session data: give it the usual Copilot home
  const extra = { ...(env ? { env } : {}), ...(mode === "empty" ? { baseDirectory: G.copilotHome } : {}) };
  const client = new G.sdk.CopilotClient({ mode, runtime: runtimeFor(G.variant, extra) });
  await withTimeout(client.start(), 90_000, "client.start()");
  if (fresh) G.extraClients.add(client);
  else G.clients.set(mode, client);
  return client;
}

export async function stopClient(client, { force = false } = {}) {
  G.extraClients.delete(client);
  for (const [k, c] of G.clients) if (c === client) G.clients.delete(k);
  try {
    if (force) await withTimeout(client.forceStop(), 15_000, "client.forceStop()");
    else await withTimeout(client.stop(), 25_000, "client.stop()");
  } catch {
    await client.forceStop().catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Event recording

/** Event types whose payload is big or private (system prompt, whole conversation): only counted. */
const HEAVY = new Set(["system.message", "model.messages_snapshot", "model.telemetry", "model.captured_assignment_context", "model.message", "model.response", "instruction.update", "session.skills_loaded", "session.tools_updated"]);

export function watcher() {
  const events = [];
  const permissions = [];
  const waiters = new Set();
  const onEvent = (e) => {
    events.push({ at: Date.now(), type: e?.type, id: e?.id, data: e?.data, raw: e });
    for (const w of [...waiters]) w();
  };
  /** Resolves with the first event at index >= `from` that satisfies `pred` (a type name or a function). */
  const waitFor = (pred, ms, from = 0) => {
    const test = typeof pred === "string" ? (e) => e.type === pred : pred;
    return new Promise((resolve, reject) => {
      let idx = from;
      const check = () => {
        for (; idx < events.length; idx++) {
          if (test(events[idx])) {
            clearTimeout(timer);
            waiters.delete(check);
            resolve(events[idx]);
            return;
          }
        }
      };
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`timeout after ${ms} ms waiting for ${typeof pred === "string" ? pred : "an event"}`));
      }, ms);
      waiters.add(check);
      check();
    });
  };
  const histogram = (from = 0) => {
    const h = {};
    for (const e of events.slice(from)) h[e.type] = (h[e.type] ?? 0) + 1;
    return h;
  };
  return {
    events,
    permissions,
    onEvent,
    waitFor,
    histogram,
    mark: () => events.length,
    of: (type, from = 0) => events.slice(from).filter((e) => (type instanceof RegExp ? type.test(e.type) : e.type === type)),
    text: (from = 0) => events.slice(from).filter((e) => e.type === "assistant.message").map((e) => e.data?.content ?? "").join("\n"),
  };
}

/** Events as JSON lines for the report: heavy payloads dropped, streaming deltas thinned out. */
export function eventLines(w) {
  const deltas = {};
  const out = [];
  for (const e of w.events) {
    if (/_delta$/.test(e.type ?? "")) {
      deltas[e.type] = (deltas[e.type] ?? 0) + 1;
      if (deltas[e.type] > 3) continue;
    }
    const line = { at: e.at, type: e.type, id: e.id };
    if (HEAVY.has(e.type)) line.data = `[dropped: ${shape(e.data)}]`;
    else line.data = sanitize(e.data, { max: 240, depth: 5, items: 12 });
    if (e.raw?.parentId) line.parentId = e.raw.parentId;
    if (e.raw?.agentId) line.agentId = e.raw.agentId;
    out.push(JSON.stringify(line));
  }
  for (const [type, n] of Object.entries(deltas)) if (n > 3) out.push(JSON.stringify({ type, note: `${n} events in total, the first 3 kept` }));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Sessions

/**
 * Permission handler for a policy:
 *   "approve"   – approve everything once (temporary workspaces only)
 *   "read-only" – approve reads, reject everything else (the repository under test is never changed)
 *   function    – custom: (request) => result
 * Every request is recorded in `w.permissions`.
 */
export function permissionHandler(w, policy = "approve") {
  return async (request, invocation) => {
    const rec = { at: Date.now(), kind: request?.kind, keys: Object.keys(request ?? {}), managedApprovalRequired: request?.managedApprovalRequired ?? null, request: sanitize(request, { max: 200, depth: 4 }), invocation: sanitize(invocation, { max: 120, depth: 2 }) };
    w.permissions.push(rec);
    let result;
    if (typeof policy === "function") result = await policy(request, invocation);
    else if (policy === "read-only") result = request?.kind === "read" ? { kind: "approve-once" } : { kind: "reject", feedback: "The probe allows read access only." };
    else result = { kind: "approve-once" };
    rec.result = sanitize(result, { depth: 3 });
    return result;
  };
}

function merge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra ?? {})) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" ? { ...base[k], ...v } : v;
  }
  return out;
}

/** Options for createSession. `policy` as in permissionHandler; `null` leaves requests pending (no handler). */
export function sessionOptions(w, { cwd, policy = "approve", extra } = {}) {
  const base = {
    workingDirectory: cwd,
    filesystem: { trustWorkingDirectory: "session" },
    events: { streaming: true, onEvent: w.onEvent },
    permissions: policy === null ? {} : { onRequest: permissionHandler(w, policy) },
  };
  if (G.opt.model) base.model = G.opt.model;
  return merge(base, extra);
}

/** Options for resumeSession: the same without the create-only ones. */
export function resumeOptions(w, { cwd, policy = "approve", extra } = {}) {
  const o = sessionOptions(w, { cwd, policy, extra });
  delete o.filesystem;
  delete o.model;
  return o;
}

/** Creates a session and remembers it for the cleanup. Returns `{ session, w }`. */
export async function open(client, { cwd, policy, extra } = {}) {
  const w = watcher();
  const session = await withTimeout(client.createSession(sessionOptions(w, { cwd, policy, extra })), 90_000, "createSession");
  G.sessions.add(session.sessionId);
  return { session, w };
}

export async function close(session) {
  if (!session) return;
  try {
    await withTimeout(session.disconnect(), 15_000, "session.disconnect()");
  } catch {}
}

/** One prompt, waits for the session to go idle. Returns `{ text, ms, from, firstDeltaMs, deltas }`. */
export async function turn(session, w, prompt, { timeout } = {}) {
  const from = w.mark();
  const t0 = Date.now();
  const ms = timeout ?? G.opt.turnTimeout;
  const msg = await withTimeout(session.sendAndWait(typeof prompt === "string" ? { prompt } : prompt, ms), ms + 15_000, "sendAndWait");
  const deltas = w.of("assistant.message_delta", from);
  return {
    text: msg?.data?.content ?? w.text(from),
    ms: Date.now() - t0,
    from,
    deltas: deltas.length,
    firstDeltaMs: deltas.length ? deltas[0].at - t0 : null,
  };
}

/** Waits until the session reports idle after index `from`; false on timeout. */
export async function idle(w, from, ms = 30_000) {
  try {
    await w.waitFor("session.idle", ms, from);
    return true;
  } catch {
    return false;
  }
}

/** A fresh empty directory under the probe's temporary root. */
export function workspace(name) {
  const dir = fs.mkdtempSync(path.join(G.tmpRoot, `${name}-`));
  return dir;
}

/** Files of a session as Copilot stores them on disk (the app reads events.jsonl and workspace.yaml directly). */
export function sessionFiles(sessionId) {
  const dir = path.join(G.copilotHome, "session-state", sessionId);
  const out = { exists: fs.existsSync(dir), files: [], eventsLines: null, eventTypes: null, firstEventKeys: null };
  if (!out.exists) return out;
  try {
    out.files = fs.readdirSync(dir).slice(0, 30);
    const file = path.join(dir, "events.jsonl");
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
      out.eventsLines = lines.length;
      const types = {};
      for (const l of lines) {
        try {
          const e = JSON.parse(l);
          types[e.type] = (types[e.type] ?? 0) + 1;
          out.firstEventKeys ??= Object.keys(e);
        } catch {
          types["(unparsable)"] = (types["(unparsable)"] ?? 0) + 1;
        }
      }
      out.eventTypes = types;
    }
  } catch (e) {
    out.error = errorInfo(e);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Generic read-only RPC inventory

const SKIP_NAMESPACE = /^(secrets|gitHubAuth|accounts|debug|telemetry|shell|fetch|llmInference|network|sessionFs|azureMl|runtime|host|suspend|shutdown|send|sendMessages|abort|canvas|workflow|completions|eventLog|decisions|registerExtensionLaunchProvider|interruptMainTurn|cancelAllBackgroundAgents|log|ui|localModels|providers|provider|sandbox|environments|agentRegistry|connectors|lsp|taskAnalytics|catalog|diagnostics|dynamicContext|autopilotObjective|limitPrediction|remote|schedule|fleet)$/;
const READ_METHOD = /^(list|get|getCurrent|getMode|getCapabilities|getRequired|getAllowAll|getMetrics|getQuota|getSources|getStatus|getWorkspace|pendingRequests|pendingItems|listRewindPoints|status)$/;
const SKIP_METHOD = /^(getCurrentAuth|getToken|getSecret)$/;

/** Results that list the user's own sessions, tasks or settings: only their shape is kept, never their content. */
const PRIVATE_RESULT = /^(sessions|management|tasks|user|name|workspaces|quota|account)\./;

/** A short, privacy-friendly summary of an RPC result: counts and item names instead of whole payloads. */
function brief(method, res) {
  if (res === null || typeof res !== "object") return sanitize(res, { max: 110 });
  if (PRIVATE_RESULT.test(method)) return "[content not kept]";
  const label = (x) => (x && typeof x === "object" ? (x.name ?? x.id ?? x.serverName ?? x.modelId ?? null) : typeof x === "string" ? x : null);
  const one = (v) => {
    if (Array.isArray(v)) return { count: v.length, names: v.map(label).filter((n) => typeof n === "string").slice(0, 60).map((n) => cleanText(n, 80)) };
    if (v && typeof v === "object") return `{${Object.keys(v).slice(0, 12).join(",")}}`;
    return sanitize(v, { max: 110 });
  };
  if (Array.isArray(res)) return one(res);
  return Object.fromEntries(Object.entries(res).map(([k, v]) => [k, /login$/i.test(k) ? "[redacted]" : one(v)]));
}

/** Calls the read-only methods of an `rpc` object (client.rpc or session.rpc) and records what they return. */
export async function rpcInventory(rpc, { depth = 3 } = {}) {
  const out = {};
  const walk = async (obj, prefix, level) => {
    for (const [name, value] of Object.entries(obj ?? {})) {
      const full = prefix ? `${prefix}.${name}` : name;
      if (typeof value === "function") {
        if (!READ_METHOD.test(name) || SKIP_METHOD.test(name)) continue;
        try {
          const res = await withTimeout(value({}), 12_000, full);
          out[full] = { ok: true, shape: shape(res), value: brief(full, res) };
        } catch (e) {
          out[full] = { ok: false, error: sanitize(e?.message ?? String(e), { max: 220 }) };
        }
      } else if (value && typeof value === "object" && level < depth) {
        if (!prefix && SKIP_NAMESPACE.test(name)) continue;
        await walk(value, full, level + 1);
      }
    }
  };
  await walk(rpc, "", 0);
  return out;
}

export function cleanupTmp() {
  return G.tmpRoot ? rmrf(G.tmpRoot) : true;
}

export { sleep };
