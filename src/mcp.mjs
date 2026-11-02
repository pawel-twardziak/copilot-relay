// MCP endpoint of the broker (Streamable HTTP).
//
//  /mcp?peer=<key>  – stateless, identity given by the broker (used by broker-spawned ACP sessions)
//  /mcp             – stateful: every MCP session becomes its own "mcp" peer with a mailbox.
//                     Use this from any MCP client (VS Code, other agents…).
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const text = (t) => ({ content: [{ type: "text", text: t }] });
const IDLE_MS = 30 * 60_000;

function formatList(registry, selfKey) {
  const others = registry.list().filter((p) => p.key !== selfKey);
  if (!others.length) return "(no other sessions online)";
  return others
    .map((p) => `- ${p.name} [${p.kind}${p.online ? "" : ", offline"}]${p.role ? `: ${p.role}` : ""} (cwd: ${p.cwd || "?"})`)
    .join("\n");
}

function formatMessages(msgs) {
  if (!msgs.length) return "(no new messages)";
  return msgs.map((m) => m.prompt).join("\n\n---\n\n");
}

function buildServer(registry, getKey, { mailbox }) {
  const server = new McpServer(
    { name: "copilot-relay", version: "0.2.0" },
    {
      instructions:
        "copilot-relay lets Copilot sessions message each other. list_sessions shows who is online; " +
        "send_message delivers asynchronously — never wait for a reply in the same turn unless using wait_for_message.",
    },
  );

  server.registerTool(
    "list_sessions",
    { description: "List the other Copilot sessions connected to the relay (name, kind, role, cwd).", inputSchema: {} },
    async () => text(formatList(registry, getKey())),
  );

  server.registerTool(
    "send_message",
    {
      description:
        "Send a message to another Copilot session in the relay. Asynchronous: the reply arrives later " +
        "as a new message prefixed with [from <name>]. Do not send pure acknowledgements.",
      inputSchema: {
        to: z.string().describe("Target session name (see list_sessions)"),
        text: z.string().describe("Message content"),
      },
    },
    async ({ to, text: t }) => text(registry.send(getKey(), to, t)),
  );

  if (mailbox) {
    server.registerTool(
      "set_name",
      {
        description: "Set this session's relay name (and optional role) so others can address it.",
        inputSchema: { name: z.string(), role: z.string().optional() },
      },
      async ({ name, role }) => {
        try {
          const n = registry.rename(getKey(), name);
          if (role != null) registry.setRole(getKey(), role);
          return text(`You are now "${n}".`);
        } catch (e) {
          return text(e.message);
        }
      },
    );
    server.registerTool(
      "read_inbox",
      { description: "Return (and clear) messages other sessions sent to you.", inputSchema: {} },
      async () => text(formatMessages(registry.drain(getKey()))),
    );
    server.registerTool(
      "wait_for_message",
      {
        description: "Block until a message arrives in your inbox (or timeout), then return it.",
        inputSchema: { timeout_seconds: z.number().int().min(1).max(600).default(120) },
      },
      async ({ timeout_seconds }) => text(formatMessages(await registry.waitForMessages(getKey(), timeout_seconds * 1000))),
    );
  }
  return server;
}

export function createMcpHandler(registry) {
  /** @type {Map<string, {transport: StreamableHTTPServerTransport, last: number}>} */
  const sessions = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) if (now - s.last > IDLE_MS) s.transport.close();
  }, 60_000).unref();

  return async function handleMcp(req, res, body) {
    const url = new URL(req.url, "http://x");
    const fixedKey = url.searchParams.get("peer");

    // Broker-owned sessions: stateless, identity from the URL.
    if (fixedKey) {
      if (req.method !== "POST") return res.writeHead(405, { Allow: "POST" }).end();
      const server = buildServer(registry, () => fixedKey, { mailbox: false });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      return transport.handleRequest(req, res, body);
    }

    // Generic MCP clients: one peer per MCP session.
    const sid = req.headers["mcp-session-id"];
    let entry = sid && sessions.get(sid);
    if (!entry) {
      if (req.method !== "POST" || !isInitializeRequest(body)) {
        return res.writeHead(400, { "content-type": "application/json" }).end(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Unknown or missing MCP session" }, id: null }),
        );
      }
      let key;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          key = `mcp:${id}`;
          const client = body?.params?.clientInfo?.name ?? "mcp";
          registry.upsert({ key, name: `${client}-${id.slice(0, 4)}`, kind: "mcp" });
          sessions.set(id, entry);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
        if (key) registry.remove(key);
      };
      entry = { transport, last: Date.now() };
      const server = buildServer(registry, () => key, { mailbox: true });
      await server.connect(transport);
    }
    entry.last = Date.now();
    return entry.transport.handleRequest(req, res, body);
  };
}
