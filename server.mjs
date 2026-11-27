// copilot-relay broker: registry + router for Copilot sessions, GUI, MCP endpoint and extension API.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpAgent } from "./src/acp-agent.mjs";
import { isReservedName, Registry, sanitizeName } from "./src/registry.mjs";
import { createMcpHandler } from "./src/mcp.mjs";
import { Delegation } from "./src/delegation.mjs";
import { DelegationStore } from "./src/delegation-store.mjs";
import { CommsLog } from "./src/comms-log.mjs";
import { linksRoutes } from "./src/links-api.mjs";
import { NameStore, randomName, stateFile } from "./src/name-store.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// The broker's log file (COPILOT_RELAY_LOG_FILE, "" for none; default broker.log in the state folder): a broker that
// the app or the extension starts has no console (its output is ignored). The module is the app's (electron/); a copy
// of the broker without that folder runs without the file.
const LOG_FILE = process.env.COPILOT_RELAY_LOG_FILE ?? stateFile("broker.log");
const fileLog = LOG_FILE
  ? await import("./electron/main-log.mjs").then(
      ({ createFileLog, teeConsole }) => {
        const log = createFileLog(LOG_FILE);
        teeConsole(log);
        return log;
      },
      () => null,
    )
  : null;
if (fileLog) process.on("uncaughtExceptionMonitor", (err, origin) => fileLog.write("error", [`[broker] ${origin}:`, err]));

/** Which broker this is, for the log and the app's log (registered): `git describe` of its own folder (never of a
 *  repository above it; no index lock taken; a checkout owned by another user is read all the same), else the commit
 *  .git/HEAD names, else null. */
const BUILD = (() => {
  try {
    const out = execFileSync("git", ["--no-optional-locks", "-c", `safe.directory=${ROOT}`, "describe", "--tags", "--always", "--dirty"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(ROOT) },
    }).trim();
    if (out) return out;
  } catch {
    /* no git, or not a checkout: read HEAD */
  }
  try {
    const head = readFileSync(path.join(ROOT, ".git", "HEAD"), "utf8").trim();
    const ref = head.match(/^ref: (.+)$/)?.[1];
    if (!ref) return head.slice(0, 12) || null;
    try {
      return `${ref.replace(/^refs\/heads\//, "")}@${readFileSync(path.join(ROOT, ".git", ref), "utf8").trim().slice(0, 12)}`;
    } catch {
      return ref.replace(/^refs\/heads\//, ""); // a packed ref: the branch at least
    }
  } catch {
    return null;
  }
})();
// events every app stream gets for any change (live panel updates): not traced per stream, they would repeat N times
const UNTRACED = new Set(["comms", "links_changed"]);
/** The ids an event carries, for a trace line (never its text). */
const idsOf = (data) => {
  const id = data?.deliveryId ?? data?.requestId ?? data?.event?.id ?? data?.id;
  return id ? ` ${id}` : "";
};
let streamSeq = 0;
const configPath = process.argv[2] ?? path.join(ROOT, "relay.config.json");
const config = JSON.parse(await readFile(configPath, "utf8").catch(() => "{}"));

const HOST = "127.0.0.1";
const PORT = Number(process.env.COPILOT_RELAY_PORT ?? config.port ?? 7777);
const SHUTDOWN_GRACE_MS = 2000; // POST /api/shutdown: the longest wait for the answer's connection to close
// Tool titles approved without asking (relay tools only by default).
const AUTO_APPROVE = config.autoApproveTools ?? ["send_message", "list_sessions"];
const DEFAULT_CWD = path.resolve(path.dirname(configPath), config.cwd ?? ".");

const registry = new Registry({
  maxAgentMessages: config.maxAgentMessagesPerUserTurn ?? 12,
  maxPairMessages: config.maxAgentMessagesPerPair ?? 12,
});
// An unreadable delegation store throws here and stops the broker: never run on (and later overwrite) data we could not read.
const delegationStore = new DelegationStore();
const names = new NameStore(process.env.COPILOT_RELAY_NAMES_FILE || undefined, {
  keep: (k) => delegationStore.parentOf(k) != null || delegationStore.childrenOf(k).length > 0,
});
// The communication log is diagnostics only: one that cannot be read (or capped) must not stop relaying, so the broker
// runs without it (no events written, /api/comms answers an empty log).
let comms = null;
try {
  comms = new CommsLog();
} catch (e) {
  console.warn(`comms: the communication log cannot be used, running without it: ${e.message}`);
}
registry.comms = comms;
const delegation = new Delegation({ registry, store: delegationStore, comms, nameOf: (k) => names.get(k)?.name });
registry.offlineRelative = (f, n, t) => delegation.messageClosed(f, n, t);
registry.decorate = (k, p) => delegation.decorate(k, p);
registry.appMessage = (f, t, x) => delegation.appMessage(f, t, x);
registry.userMessage = (t, x) => delegation.userMessage(t, x);
const handleMcp = createMcpHandler(registry, delegation);
const linkRoutes = linksRoutes({ delegation, comms, registry });

// Tell every app connection the tree changed; peer_updated also fires on inbox enqueue, so bursts collapse to one event.
let linksTimer = null;
delegation.onChange(() => {
  if (linksTimer) return;
  linksTimer = setTimeout(() => {
    linksTimer = null;
    for (const p of registry.list()) {
      try {
        registry.get(p.key)?.control?.("links_changed", {});
      } catch {
        /* a dead stream must not stop the others */
      }
    }
  }, 200);
  linksTimer.unref();
});

// Push every new communication event (preview only) to the app connections, no debounce.
comms?.onAppend((event) => {
  for (const p of registry.list()) {
    try {
      const peer = registry.get(p.key);
      if (peer?.app && peer.control) peer.control("comms", { event });
    } catch {
      /* a dead stream must not stop the others */
    }
  }
});

// Persist names/roles of terminal sessions (key = Copilot sessionId, stable across --resume).
const persist = (p) => p.key?.startsWith("cli:") && names.set(p.key, p.name, p.role);
registry.on("peer_renamed", persist);
registry.on("peer_updated", persist);

function pickName(key, explicit) {
  // the returned name is only the wanted base: Registry#upsert makes it permanent and unique (-<suffix>)
  if (explicit) return explicit;
  const stored = names.get(key)?.name;
  if (stored) return stored;
  // upsert appends the key-hash suffix, so a random name needs no collision check
  return randomName();
}

// ---------- SSE to GUI ----------
const guiClients = new Set();
const history = []; // replay for late-joining browser tabs
function broadcast(type, data) {
  const ev = { type, ts: Date.now(), ...data };
  history.push(ev);
  if (history.length > 20000) history.shift();
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of guiClients) res.write(line);
}
for (const t of ["peer_added", "peer_removed", "peer_renamed", "peer_updated", "message", "system"])
  registry.on(t, (d) => broadcast(t, d));

// ---------- Broker-owned ACP sessions ----------
/** @type {Map<string, AcpAgent>} key -> agent */
const acpAgents = new Map();
const STARTED_AT = Date.now();

function introPrompt(meta) {
  return (
    `You are session "${meta.name}" in copilot-relay, where Copilot sessions can message each other.` +
    (meta.role ? `\nYour role: ${meta.role}` : "") +
    `\nRelay tools: list_sessions() shows who is online (sessions come and go), ` +
    `send_message(to, text) sends a message to another session. Messages from other sessions ` +
    `arrive prefixed with [from <name>]; messages without a prefix come from the human user. ` +
    `Your normal chat output is visible ONLY to the human — other sessions see nothing unless you use send_message. ` +
    `Delivery is asynchronous — never wait for replies, and don't send pure acknowledgements.`
  );
}

/** `stableKey`: the key comes from the name alone (startupSessions), so the session keeps its name across broker restarts. */
async function createAcpSession({ name, role = "", cwd, model }, { stableKey = false } = {}) {
  if (!name) throw new HttpError(400, "A name is required.");
  const wanted = sanitizeName(name);
  if (isReservedName(wanted)) throw new HttpError(409, `Name "${wanted}" is reserved.`);
  const dir = cwd ? path.resolve(DEFAULT_CWD, cwd) : DEFAULT_CWD;
  if (!(await stat(dir).catch(() => null))?.isDirectory()) throw new HttpError(400, `Not a directory: ${dir}`);

  // POST /api/sessions may start several sessions with one name: each gets its own key (and so its own name suffix)
  const key = stableKey ? `acp:${wanted}` : `acp:${wanted}:${Date.now().toString(36)}`;
  if (registry.get(key)) throw new HttpError(409, `Session "${registry.get(key).name}" is already running.`);
  let agent = null;
  registry.upsert({
    key,
    name: wanted,
    kind: "acp",
    cwd: dir,
    role,
    model: model ?? "",
    push: (m) => (agent ? agent.enqueue(m.prompt) : false),
  });
  const own = registry.get(key).name; // upsert made it unique: <wanted>-<suffix>
  agent = new AcpAgent({
    name: own,
    role: introPrompt({ name: own, role }),
    cwd: dir,
    args: model ? ["--model", model] : [],
    // the copilot-relay extension (if installed) sees this and stays passive → no duplicate peer/tools
    env: { ...process.env, COPILOT_RELAY_MANAGED: "1" },
    mcpServers: [
      { type: "http", name: "relay", url: `http://${HOST}:${PORT}/mcp?peer=${encodeURIComponent(key)}`, headers: [] },
    ],
  });
  acpAgents.set(key, agent);
  wireAcp(key, agent);
  try {
    await agent.start();
  } catch (e) {
    closeAcpSession(key);
    throw new HttpError(502, `Failed to start ${own}: ${e.message}`);
  }
  return registry.describe(registry.get(key));
}

function closeAcpSession(key) {
  const agent = acpAgents.get(key);
  acpAgents.delete(key);
  agent?.stop();
  return registry.remove(key, "user");
}

function wireAcp(key, agent) {
  const name = () => registry.get(key)?.name ?? agent.name;
  agent.on("update", (u) => {
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content?.type === "text") broadcast("chunk", { key, agent: name(), kind: "text", text: u.content.text });
        break;
      case "agent_thought_chunk":
        if (u.content?.type === "text") broadcast("chunk", { key, agent: name(), kind: "thought", text: u.content.text });
        break;
      case "tool_call":
        broadcast("tool", { key, agent: name(), id: u.toolCallId, title: u.title, status: u.status ?? "pending" });
        break;
      case "tool_call_update":
        broadcast("tool", { key, agent: name(), id: u.toolCallId, title: u.title, status: u.status });
        break;
    }
  });
  agent.on("status", (st) => {
    broadcast("status", { key, agent: name(), ...st });
    if (st.state === "exited" && acpAgents.get(key) === agent) closeAcpSession(key);
  });
  agent.on("queue", (n) => broadcast("queue", { key, agent: name(), n }));
  agent.on("turn_end", (r) => broadcast("turn_end", { key, agent: name(), stopReason: r }));
  agent.on("permission", (p) => {
    const title = p.toolCall?.title ?? "";
    if (AUTO_APPROVE.some((t) => title === t || title === `relay-${t}`)) {
      const opt = p.options?.find((o) => o.kind === "allow_once") ?? p.options?.[0];
      if (opt) return agent.answerPermission(p.reqId, opt.optionId);
    }
    broadcast("permission", { key, agent: name(), ...p });
  });
  agent.on("error", (e) => broadcast("system", { key, agent: name(), text: `${name()}: ${e.message}` }));
  agent.on("log", (l) => process.env.RELAY_DEBUG && process.stderr.write(`[${name()}] ${l}`));
}

const acpByName = (n) => {
  const p = registry.getByName(n);
  return p && acpAgents.get(p.key);
};

// ---------- HTTP ----------
class HttpError extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
  }
}
async function readBody(req) {
  let body = "";
  for await (const c of req) body += c;
  return body ? JSON.parse(body) : undefined;
}
const json = (res, code, obj) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(obj));
const sse = (res) =>
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });

// The broker has no login, so it must not be usable from web pages in the user's browser:
// - Host must be the loopback address (blocks DNS rebinding),
// - a browser Origin, if sent, must be the broker itself (cross-site fetch/XHR/form posts, "null" origins),
// - Sec-Fetch-Site must be same-origin or none: browsers send it on every request, also on GETs without an
//   Origin header such as <img src="http://127.0.0.1:7777/api/peer/stream?...">. Opening the GUI page itself
//   (GET / from a link or bookmark) stays allowed,
// - POST bodies must be JSON (a cross-site form or no-cors fetch cannot send application/json without a preflight).
// Node clients (extension, desktop app, MCP clients) send none of these browser headers, so they are unaffected.
const SELF_HOSTS = new Set(
  ["127.0.0.1", "localhost", "[::1]"].flatMap((h) => (PORT === 80 ? [h, `${h}:80`] : [`${h}:${PORT}`])),
);
function rejectForeign(req, pathname) {
  if (!SELF_HOSTS.has(String(req.headers.host ?? "").toLowerCase())) return "bad Host";
  const origin = req.headers.origin;
  if (origin && !SELF_HOSTS.has(origin.replace(/^https?:\/\//i, "").toLowerCase())) return "cross-origin request";
  const site = req.headers["sec-fetch-site"];
  const page = req.method === "GET" && (pathname === "/" || pathname === "/health");
  if (site && site !== "same-origin" && site !== "none" && !page) return `${site} request`;
  if (req.method === "POST" && !/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return "POST body must be application/json";
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  const q = url.searchParams;
  const foreign = rejectForeign(req, url.pathname);
  if (foreign) return json(res, 403, { error: `Forbidden: ${foreign}` });
  try {
    if (url.pathname === "/mcp") {
      const body = req.method === "POST" ? await readBody(req) : undefined;
      return await handleMcp(req, res, body);
    }

    const route = linkRoutes[`${req.method} ${url.pathname}`];
    if (route) {
      const out = route(req.method === "POST" ? ((await readBody(req)) ?? {}) : Object.fromEntries(q));
      if (out.json === undefined) return res.writeHead(out.status).end();
      return json(res, out.status, out.json);
    }

    switch (`${req.method} ${url.pathname}`) {
      case "GET /":
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(await readFile(path.join(ROOT, "public/index.html")));

      case "GET /health":
        return json(res, 200, {
          ok: true,
          app: "copilot-relay",
          peers: registry.list().length,
          pid: process.pid,
          startedAt: STARTED_AT,
          root: ROOT,
          acpSessions: acpAgents.size,
        });

      // The desktop app's "Update and restart broker". The process must not exit under the answer: the request is
      // read to its end first (a socket closed with unread bytes is reset; whether that was the answer lost now and
      // then on Windows CI is not confirmed), the broker closes the connection with the answer, and the exit
      // follows that close. The body is not parsed: whatever it holds, the caller asked to stop. The timer is for
      // a close that never comes (a socket that was gone before the listener was added).
      case "POST /api/shutdown": {
        for await (const _ of req); // drain
        res.socket?.once("close", shutdown);
        setTimeout(shutdown, SHUTDOWN_GRACE_MS).unref();
        res.writeHead(200, { "content-type": "application/json", connection: "close" });
        return res.end(JSON.stringify({ ok: true, pid: process.pid }));
      }

      // ----- GUI -----
      case "GET /events":
        sse(res);
        res.write(`data: ${JSON.stringify({ type: "hello", defaultCwd: DEFAULT_CWD, peers: registry.list(), history })}\n\n`);
        guiClients.add(res);
        req.on("close", () => guiClients.delete(res));
        return;

      case "GET /api/sessions":
        return json(res, 200, registry.list());

      case "POST /api/sessions":
        return json(res, 201, await createAcpSession((await readBody(req)) ?? {}));

      case "DELETE /api/sessions": {
        const p = registry.getByName(q.get("name"));
        if (!p) return res.writeHead(404).end();
        if (acpAgents.has(p.key)) closeAcpSession(p.key);
        else registry.remove(p.key, "user"); // terminal/MCP peers: just forget them (they re-register on reconnect)
        return res.writeHead(204).end();
      }

      case "POST /api/send": {
        const { to, text } = (await readBody(req)) ?? {};
        const targets = to === "*" ? registry.list().map((p) => p.name) : [to];
        for (const t of targets) registry.sendFromUser(t, text);
        return res.writeHead(204).end();
      }

      case "POST /api/rename": {
        const { name, newName, role } = (await readBody(req)) ?? {};
        const p = registry.getByName(name);
        if (!p) return json(res, 404, { error: `No session "${name}"` });
        const n = newName ? registry.rename(p.key, newName) : p.name;
        if (role != null) registry.setRole(p.key, role);
        return json(res, 200, { name: n });
      }

      case "POST /api/permission": {
        const { agent, reqId, optionId } = (await readBody(req)) ?? {};
        const ok = acpByName(agent)?.answerPermission(reqId, optionId);
        broadcast("permission_done", { agent, reqId, optionId });
        return res.writeHead(ok ? 204 : 404).end();
      }

      case "POST /api/cancel": {
        const { agent } = (await readBody(req)) ?? {};
        acpByName(agent)?.cancel();
        return res.writeHead(204).end();
      }

      // ----- copilot-relay extension (terminal / app sessions) -----
      case "GET /api/peer/stream": {
        const key = q.get("key");
        if (!key) return json(res, 400, { error: "key required" });
        if (q.get("alias")) registry.setAlias(q.get("alias"), key);
        // only the desktop app registers with an app:<uuid> alias; it alone can show reopen cards
        const app = /^app:/.test(q.get("alias") ?? "");
        sse(res);
        // every stream has a number in the log: a session's reconnects show as separate streams
        const sid = `s${++streamSeq}`;
        const trace = (text) => console.info(`[stream ${sid}] ${text}`);
        trace(`open ${key}${q.get("alias") ? ` alias=${q.get("alias")}` : ""}${q.get("caps") ? ` caps=${q.get("caps")}` : ""}${q.get("parent") ? ` parent=${q.get("parent")}` : ""}`);
        // true once the event is handed to the stream. res.write() answers false when its buffer is over the limit
        // (16 KiB on Windows): the event is sent all the same, so that is not "not delivered" (Registry would keep a
        // second copy in the inbox and send it again on the session's next registration)
        // "→" says the event was handed to the stream; "buffered" counts bytes the client has not taken yet, which
        // keeps growing on a stream that is dead but not closed
        const sent = (event, data, flushed) => {
          if (!UNTRACED.has(event)) trace(`→ ${event}${idsOf(data)} ${key}${flushed ? "" : ` (buffered ${res.writableLength} bytes)`}`);
        };
        const write = (event, data) => {
          if (res.destroyed) {
            trace(`${event}${idsOf(data)} for ${key} not sent: the stream is closed`);
            return false;
          }
          sent(event, data, res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          return true;
        };
        // unlike `write`, `control` must throw on a dead stream: Delegation treats only a throw as "not delivered"
        const control = (event, data) => {
          if (res.destroyed) {
            trace(`${event}${idsOf(data)} for ${key} not sent: the stream is closed`);
            throw new Error("stream closed");
          }
          sent(event, data, res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        const linkCards = (q.get("caps") ?? "").split(",").includes("links");
        const parent = q.get("parent");
        if (parent) delegation.link(key, parent); // before upsert: the first message may already depend on the link
        const onRenamed = (ev) => ev.key === key && write("renamed", { name: ev.name });
        registry.on("peer_renamed", onRenamed);
        const peer = registry.upsert({
          key,
          name: pickName(key, q.get("name")),
          kind: "cli",
          cwd: q.get("cwd") ?? "",
          role: names.get(key)?.role ?? "",
          push: (m) => write("message", m),
          parentKey: parent || delegationStore.parentOf(key) || null,
          control,
          app,
          linkCards,
        });
        // explicit name (COPILOT_RELAY_NAME) on a fresh start wins even if the peer is still known; compared in its
        // final <base>-<suffix> form, so a peer already carrying it is not renamed on every registration
        const explicit = q.get("name");
        if (explicit && peer.name !== registry.freeName(explicit, key)) {
          try {
            registry.rename(key, explicit);
          } catch {
            /* a reserved name → keep the current name */
          }
        }
        persist(peer);
        write("registered", { name: peer.name, parentKey: peer.parentKey ?? null, reported: delegationStore.isReported(key), adopted: delegationStore.isAdopted(key), broker: BUILD, stream: sid, brokerLog: fileLog ? LOG_FILE : null });
        delegation.attached(key);
        const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
        req.on("close", () => {
          clearInterval(ping);
          registry.off("peer_renamed", onRenamed);
          // only this stream's own session: a newer stream of the same key (a reconnect whose old request closes
          // only now) keeps the session online
          const current = registry.get(key)?.control === control;
          trace(`closed ${key}${current ? "" : " (an older stream: the session's newer one stays)"}`);
          if (current) registry.disconnect(key);
        });
        return;
      }

      case "POST /api/peer/send": {
        const { key, to, text } = (await readBody(req)) ?? {};
        const result = registry.send(key, to, text);
        console.info(`[api] send from ${key} to ${String(to).split("\n")[0].slice(0, 80)}: ${String(result).split("\n")[0].slice(0, 200)}`);
        return json(res, 200, { result });
      }

      case "POST /api/peer/rename": {
        const { key, name, role } = (await readBody(req)) ?? {};
        const n = registry.rename(key, name);
        if (role != null) registry.setRole(key, role);
        return json(res, 200, { name: n });
      }

      case "POST /api/peer/human": {
        const { key } = (await readBody(req)) ?? {};
        registry.humanPrompt(key);
        return res.writeHead(204).end();
      }

      case "POST /api/peer/ack": {
        const { key, id, outcome } = (await readBody(req)) ?? {};
        const ok = delegation.ack(key, id, outcome === "discarded" ? "discarded" : "taken");
        console.info(`[api] ack ${id} from ${key}: ${outcome === "discarded" ? "discarded" : "taken"}${ok ? "" : " (not pending)"}`);
        return json(res, 200, { ok });
      }

      // The app reports what happened to a session request. Deliberately no endpoint approves a request.
      case "POST /api/peer/delegation-outcome": {
        const { key, requestId, kind, name, text } = (await readBody(req)) ?? {};
        if (!key || !text) return json(res, 400, { error: "key and text required" });
        delegation.outcome(key, { requestId, kind, name, text });
        return res.writeHead(204).end();
      }

      case "GET /api/peer/list": {
        const key = q.get("key");
        return json(res, 200, registry.list().filter((p) => p.key !== key));
      }
    }
    res.writeHead(404).end();
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    // e.code is an HTTP status only for an HttpError; a request cut off mid-body rejects with code "ECONNRESET"
    if (!res.headersSent) json(res, Number.isInteger(e.code) ? e.code : 400, { error: e.message });
  }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`copilot-relay: port ${PORT} already in use (another broker running?)`);
    process.exit(3);
  }
  throw e;
});

server.listen(PORT, HOST, () => {
  console.log(`copilot-relay broker: http://${HOST}:${PORT}  (MCP: /mcp, default cwd: ${DEFAULT_CWD})`);
  console.info(`[broker] ${BUILD ?? "unknown build"} (pid ${process.pid}, Node ${process.version}, ${process.platform}); log: ${fileLog ? LOG_FILE : "none"}`);
  for (const s of config.startupSessions ?? []) {
    createAcpSession(s, { stableKey: true }).then(
      () => console.log(`  ✓ ${s.name}`),
      (e) => console.error(`  ✗ ${s.name}: ${e.message}`),
    );
  }
});

const shutdown = () => {
  for (const a of acpAgents.values()) a.stop();
  comms?.flush(); // a purge waiting in the rewrite debounce must not be lost
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
