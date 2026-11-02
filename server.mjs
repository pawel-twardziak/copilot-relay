// copilot-relay broker: registry + router for Copilot sessions, GUI, MCP endpoint and extension API.
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpAgent } from "./src/acp-agent.mjs";
import { Registry, sanitizeName } from "./src/registry.mjs";
import { createMcpHandler } from "./src/mcp.mjs";
import { NameStore, randomName } from "./src/name-store.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const configPath = process.argv[2] ?? path.join(ROOT, "relay.config.json");
const config = JSON.parse(await readFile(configPath, "utf8").catch(() => "{}"));

const HOST = "127.0.0.1";
const PORT = Number(process.env.COPILOT_RELAY_PORT ?? config.port ?? 7777);
// Tool titles approved without asking (relay tools only by default).
const AUTO_APPROVE = config.autoApproveTools ?? ["send_message", "list_sessions"];
const DEFAULT_CWD = path.resolve(path.dirname(configPath), config.cwd ?? ".");

const registry = new Registry({ maxAgentMessages: config.maxAgentMessagesPerUserTurn ?? 12 });
const handleMcp = createMcpHandler(registry);
const names = new NameStore(process.env.COPILOT_RELAY_NAMES_FILE || undefined);

// Persist names/roles of terminal sessions (key = Copilot sessionId, stable across --resume).
const persist = (p) => p.key?.startsWith("cli:") && names.set(p.key, p.name, p.role);
registry.on("peer_renamed", persist);
registry.on("peer_updated", persist);

function pickName(key, explicit) {
  if (explicit) return explicit;
  const stored = names.get(key)?.name;
  if (stored) return stored;
  for (let i = 0; i < 50; i++) {
    const n = randomName();
    if (!registry.getByName(n) && !names.isTakenByOther(n, key)) return n;
  }
  return `${randomName()}-${Math.random().toString(36).slice(2, 5)}`;
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

async function createAcpSession({ name, role = "", cwd, model }) {
  const wanted = sanitizeName(name);
  if (!name || registry.getByName(wanted)) throw new HttpError(409, `Name "${wanted}" is missing or taken.`);
  const dir = cwd ? path.resolve(DEFAULT_CWD, cwd) : DEFAULT_CWD;
  if (!(await stat(dir).catch(() => null))?.isDirectory()) throw new HttpError(400, `Not a directory: ${dir}`);

  const key = `acp:${wanted}:${Date.now().toString(36)}`;
  const agent = new AcpAgent({
    name: wanted,
    role: introPrompt({ name: wanted, role }),
    cwd: dir,
    args: model ? ["--model", model] : [],
    // the copilot-relay extension (if installed) sees this and stays passive → no duplicate peer/tools
    env: { ...process.env, COPILOT_RELAY_MANAGED: "1" },
    mcpServers: [
      { type: "http", name: "relay", url: `http://${HOST}:${PORT}/mcp?peer=${encodeURIComponent(key)}`, headers: [] },
    ],
  });
  registry.upsert({
    key,
    name: wanted,
    kind: "acp",
    cwd: dir,
    role,
    model: model ?? "",
    push: (m) => agent.enqueue(m.prompt),
  });
  acpAgents.set(key, agent);
  wireAcp(key, agent);
  try {
    await agent.start();
  } catch (e) {
    closeAcpSession(key);
    throw new HttpError(502, `Failed to start ${wanted}: ${e.message}`);
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  const q = url.searchParams;
  try {
    if (url.pathname === "/mcp") {
      const body = req.method === "POST" ? await readBody(req) : undefined;
      return await handleMcp(req, res, body);
    }

    switch (`${req.method} ${url.pathname}`) {
      case "GET /":
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(await readFile(path.join(ROOT, "public/index.html")));

      case "GET /health":
        return json(res, 200, { ok: true, app: "copilot-relay", peers: registry.list().length });

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
        sse(res);
        const write = (event, data) => !res.destroyed && res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        const onRenamed = (ev) => ev.key === key && write("renamed", { name: ev.name });
        registry.on("peer_renamed", onRenamed);
        const peer = registry.upsert({
          key,
          name: pickName(key, q.get("name")),
          kind: "cli",
          cwd: q.get("cwd") ?? "",
          role: names.get(key)?.role ?? "",
          push: (m) => write("message", m),
        });
        // explicit name (COPILOT_RELAY_NAME) on a fresh start wins even if the peer is still known
        const explicit = q.get("name");
        if (explicit && peer.name !== sanitizeName(explicit)) {
          try {
            registry.rename(key, explicit);
          } catch {
            /* taken by an online session → keep the current name */
          }
        }
        persist(peer);
        write("registered", { name: peer.name });
        const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
        req.on("close", () => {
          clearInterval(ping);
          registry.off("peer_renamed", onRenamed);
          if (registry.get(key)?.push) registry.disconnect(key);
        });
        return;
      }

      case "POST /api/peer/send": {
        const { key, to, text } = (await readBody(req)) ?? {};
        return json(res, 200, { result: registry.send(key, to, text) });
      }

      case "POST /api/peer/rename": {
        const { key, name, role } = (await readBody(req)) ?? {};
        const n = registry.rename(key, name);
        if (role != null) registry.setRole(key, role);
        return json(res, 200, { name: n });
      }

      case "POST /api/peer/human": {
        registry.humanPrompt();
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
    if (!res.headersSent) json(res, e.code ?? 400, { error: e.message });
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
  for (const s of config.startupSessions ?? []) {
    createAcpSession(s).then(
      () => console.log(`  ✓ ${s.name}`),
      (e) => console.error(`  ✗ ${s.name}: ${e.message}`),
    );
  }
});

const shutdown = () => {
  for (const a of acpAgents.values()) a.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
