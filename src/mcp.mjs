// MCP endpoint of the broker (Streamable HTTP).
//
//  /mcp?peer=<key>  – stateless, identity given by the URL (broker-spawned ACP sessions; the desktop app
//                     passes an alias that /api/peer/stream?alias= maps to the session's key)
//  /mcp             – stateful: every MCP session becomes its own "mcp" peer with a mailbox.
//                     Use this from any MCP client (VS Code, other agents…).
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { childCommandArgs } from "./child-command.mjs";

const text = (t) => ({ content: [{ type: "text", text: t }] });
/** A relay tool's answer, also as a line in the broker's log: who called it and what it answered (never what was sent). */
const traced = (tool, key, answer, logged = answer) => {
  const first = String(logged).split("\n")[0];
  console.info(`[mcp] ${tool} from ${key ?? "(unregistered)"}: ${first.length > 200 ? `${first.slice(0, 200)}…` : first}`);
  return text(answer);
};
const IDLE_MS = 30 * 60_000;
const FOLDER_MAX = 4096;
const PROMPT_MAX = 20000;
const NAME_MAX = 200; // an agent or a model name

/** Builds the session request from create_session's input, or refuses it (the model sees the reason). */
export function createSessionInput({ name, task, agent, model, folder, prompt, context, command }) {
  const limits = [["agent", agent, NAME_MAX], ["model", model, NAME_MAX], ["folder", folder, FOLDER_MAX], ["prompt", prompt, PROMPT_MAX]];
  for (const [field, value, max] of limits)
    if (typeof value === "string" && value.length > max) return { refused: `Not sent: "${field}" is longer than ${max} characters.` };
  let cmd = "";
  if (typeof command === "string" && command.trim()) {
    const parsed = childCommandArgs(command);
    if (parsed.refused) return { refused: `Not sent: ${parsed.refused}` };
    cmd = command.trim();
  }
  return {
    request: { name, task, agent: agent ?? "", model: model ?? "", folder: folder ?? "", prompt: prompt ?? "", context: context ?? "", command: cmd },
  };
}

/** Delegation tools are for desktop-app sessions only (identity `app:<uuid>` given by the MCP URL). */
export function delegationToolsAllowed(peerParam) {
  return typeof peerParam === "string" && peerParam.startsWith("app:");
}

export function formatList(registry, selfKey, delegation = null) {
  const family = delegation?.familyBlock(selfKey) ?? "";
  const online = formatOnline(registry, selfKey);
  return family ? `${online}\n\n${family}` : online;
}

function formatOnline(registry, selfKey) {
  const all = registry.list();
  const selfParent = all.find((p) => p.key === selfKey)?.parentKey;
  const others = all.filter((p) => p.key !== selfKey);
  if (!others.length) return "(no other sessions online)";
  return others
    .map((p) => {
      const rel = selfParent && p.key === selfParent ? " — your parent" : p.parentKey && p.parentKey === selfKey ? " — your child" : "";
      return `- ${p.name} [${p.kind}${p.online ? "" : ", offline"}]${p.role ? `: ${p.role}` : ""} (cwd: ${p.cwd || "?"})${rel}`;
    })
    .join("\n");
}

function formatMessages(msgs) {
  if (!msgs.length) return "(no new messages)";
  return msgs.map((m) => m.prompt).join("\n\n---\n\n");
}

function buildServer(registry, getKey, { mailbox, delegation = null, fixedKey = null }) {
  const server = new McpServer(
    { name: "copilot-relay", version: "0.2.0" },
    {
      instructions:
        "copilot-relay lets Copilot sessions message each other. list_sessions shows who is online; " +
        "send_message delivers asynchronously — never wait for a reply in the same turn unless using wait_for_message." +
        (delegation && delegationToolsAllowed(fixedKey)
          ? " create_session asks the user to approve a new delegated session (you cannot approve it yourself); " +
            "a delegated or adopted session ends its work with report_result. list_sessions also shows your children and your parent. " +
            "adopt_session and release_session ask the user to link or unlink an existing session as your child; use them only when the user explicitly asks."
          : ""),
    },
  );

  server.registerTool(
    "list_sessions",
    { description: "List the other Copilot sessions connected to the relay (name, kind, role, cwd).", inputSchema: {} },
    async () => text(formatList(registry, getKey(), delegation)),
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
    async ({ to, text: t }) => traced("send_message", getKey(), registry.send(getKey(), to, t)),
  );

  if (delegation && delegationToolsAllowed(fixedKey)) {
    server.registerTool(
      "create_session",
      {
        description:
          "Ask the user to approve a new delegated Copilot session that works on a task and reports back to you. " +
          "The user must approve; the outcome arrives later as a message from relay. Do not wait for it. " +
          "Delegated sessions may delegate further.",
        inputSchema: {
          name: z.string().describe("Name for the new session"),
          task: z.string().describe("The task the new session should work on"),
          agent: z.string().optional().describe("Optional agent to use. The user can change it before approving."),
          model: z.string().optional().describe("Optional model to use. The user can change it before approving."),
          folder: z
            .string()
            .optional()
            .describe("Absolute path of the folder the new session works in. Default: your own folder. The user can change it before approving."),
          prompt: z
            .string()
            .optional()
            .describe("The new session's own prompt part (instructions added to its system prompt). Default: none. The user can change it before approving."),
          context: z
            .enum(["default", "long_context"])
            .optional()
            .describe('Context window tier: "default" (200k) or "long_context" (1M). Default: yours. The user can change it before approving.'),
          command: z
            .string()
            .optional()
            .describe(
              'Only the copilot command with arguments, e.g. "copilot --foo bar". The arguments are added to the command your own session runs. Any other program, a path or shell syntax is refused. Default: your own command. The user can change it before approving.',
            ),
        },
      },
      async (input) => {
        const key = getKey();
        if (!key) return traced("create_session", key, "You are not registered with the relay broker.");
        const { request, refused } = createSessionInput(input);
        // a refusal can quote the model's words (a part of its command): the log says only that it was refused
        if (refused) return traced("create_session", key, refused, "Not sent: the request was refused (its text is not logged)");
        return traced("create_session", key, delegation.requestCreate(key, request));
      },
    );
    server.registerTool(
      "adopt_session",
      {
        description:
          "Ask the user to make an existing open session your child; it then sends you its result with report_result. " +
          "Use it only when the user has explicitly asked, in this conversation, to link these sessions. Never on your own initiative. " +
          "The user must approve a card in the app; the outcome arrives later as a message from relay. Do not wait for it.",
        inputSchema: { name: z.string().describe("Name of the open session to adopt (see list_sessions)") },
      },
      async ({ name }) => {
        const key = getKey();
        if (!key) return traced("adopt_session", key, "You are not registered with the relay broker.");
        return traced("adopt_session", key, delegation.requestLink(key, "adopt", name));
      },
    );
    server.registerTool(
      "release_session",
      {
        description:
          "Ask the user to end the link to one of your children; the session stays open and keeps its history. " +
          "Use it only when the user has explicitly asked, in this conversation, to unlink these sessions. Never on your own initiative. " +
          "The user must approve a card in the app; the outcome arrives later as a message from relay. Do not wait for it.",
        inputSchema: { name: z.string().describe("Name of your child session to release (see list_sessions)") },
      },
      async ({ name }) => {
        const key = getKey();
        if (!key) return traced("release_session", key, "You are not registered with the relay broker.");
        return traced("release_session", key, delegation.requestLink(key, "release", name));
      },
    );
    server.registerTool(
      "report_result",
      {
        description:
          "Child sessions only: send your final result to your parent session (the one that created or adopted you). Use it once, when your work is done.",
        inputSchema: { text: z.string().min(1).describe("The result to report") },
      },
      async ({ text: t }) => {
        const key = getKey();
        if (!key) return traced("report_result", key, "You are not registered with the relay broker.");
        return traced("report_result", key, delegation.report(key, t));
      },
    );
  }

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

export function createMcpHandler(registry, delegation = null) {
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
      const server = buildServer(registry, () => registry.resolve(fixedKey), { mailbox: false, delegation, fixedKey });
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
