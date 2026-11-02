// copilot-relay – Copilot CLI extension.
// Registers every Copilot CLI session with the local relay broker so sessions can message each other.
// Incoming messages are injected into this session as new prompts (session.send), so the agent
// reacts even when the terminal is idle.
import { joinSession } from "@github/copilot-sdk/extension";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RelayClient } from "./relay-client.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
let cfg = {};
try {
  cfg = JSON.parse(readFileSync(path.join(here, "config.json"), "utf8"));
} catch {
  /* defaults */
}
// session.workspacePath is Copilot's per-session state dir (~/.copilot/session-state/<id>);
// the real working directory is recorded in its workspace.yaml.
function sessionCwd(workspacePath) {
  try {
    const m = readFileSync(path.join(workspacePath, "workspace.yaml"), "utf8").match(/^cwd:\s*(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  } catch {
    /* fall through */
  }
  return process.cwd();
}

const BROKER_URL = process.env.COPILOT_RELAY_URL ?? cfg.url ?? "http://127.0.0.1:7777";

if (process.env.COPILOT_RELAY_MANAGED || process.env.COPILOT_RELAY_DISABLED) {
  // Session spawned by the broker itself (it already has relay tools via MCP) or relay disabled.
  await joinSession({});
} else {
  let client;
  const session = await joinSession({
    tools: [
      {
        name: "relay_list_sessions",
        description: "copilot-relay: list the other Copilot sessions you can message (name, kind, role, cwd).",
        parameters: { type: "object", properties: {} },
        skipPermission: true,
        handler: async () => {
          const peers = await client.list();
          if (!peers.length) return "(no other sessions online)";
          return peers
            .map((p) => `- ${p.name} [${p.kind}${p.online ? "" : ", offline"}]${p.role ? `: ${p.role}` : ""} (cwd: ${p.cwd || "?"})`)
            .join("\n");
        },
      },
      {
        name: "relay_send_message",
        description:
          "copilot-relay: send a message to another Copilot session. Asynchronous — the reply arrives later " +
          "as a new message prefixed with [from <name>]. Do not wait for it and do not send pure acknowledgements.",
        parameters: {
          type: "object",
          properties: {
            to: { type: "string", description: "Target session name (see relay_list_sessions)" },
            text: { type: "string", description: "Message content" },
          },
          required: ["to", "text"],
        },
        skipPermission: true,
        handler: async ({ to, text }) => client.send(to, text),
      },
      {
        name: "relay_set_name",
        description: "copilot-relay: set the name (and optional role) under which other sessions see this session.",
        parameters: {
          type: "object",
          properties: { name: { type: "string" }, role: { type: "string" } },
          required: ["name"],
        },
        skipPermission: true,
        handler: async ({ name, role }) => {
          try {
            return `You are now "${await client.rename(name, role)}" in the relay.`;
          } catch (e) {
            return e.message;
          }
        },
      },
    ],
    commands: [
      {
        name: "relay-name",
        description: "copilot-relay: show or set this session's relay name — /relay-name [new-name] [| role]",
        handler: async ({ args }) => {
          const [rawName, role] = String(args ?? "").split("|").map((s) => s.trim());
          if (!rawName) {
            await session.log(`copilot-relay: this session is "${client.name ?? "(not connected)"}". Change it with /relay-name <new-name>`);
            return;
          }
          try {
            const n = await client.rename(rawName, role || undefined);
            await session.log(`copilot-relay: renamed to "${n}" (kept across --resume)`);
          } catch (e) {
            await session.log(`copilot-relay: ${e.message}`, { level: "error" });
          }
        },
      },
      {
        name: "relay",
        description: "copilot-relay: show connection status and the other sessions",
        handler: async () => {
          try {
            const peers = await client.list();
            const lines = peers.map((p) => `  ${p.name} [${p.kind}${p.online ? "" : ", offline"}]${p.role ? ` — ${p.role}` : ""}`);
            await session.log(
              `copilot-relay: you are "${client.name}" (${client.connected ? "connected" : "disconnected"})\n` +
                (lines.length ? lines.join("\n") : "  (no other sessions)"),
            );
          } catch (e) {
            await session.log(`copilot-relay: broker unreachable (${e.message})`, { level: "error" });
          }
        },
      },
    ],
    hooks: {
      onUserPromptSubmitted: async (input) => {
        // a real human prompt (not one we injected) re-opens the agent-to-agent message budget
        if (!String(input?.prompt ?? "").startsWith("[from ")) client?.human();
      },
    },
  });

  client = new RelayClient({
    url: BROKER_URL,
    key: `cli:${session.sessionId}`,
    cwd: sessionCwd(session.workspacePath),
    name: process.env.COPILOT_RELAY_NAME,
    brokerScript: cfg.brokerScript,
    nodePath: cfg.nodePath,
    log: (m) => session.log(m, { ephemeral: true }).catch(() => {}),
    onRegistered: (name) => session.log(`copilot-relay: connected as "${name}" (change with /relay-name)`, { ephemeral: true }).catch(() => {}),
    onRenamed: (name) => session.log(`copilot-relay: this session was renamed to "${name}"`).catch(() => {}),
    onMessage: (m) => {
      session.send({ prompt: m.prompt, mode: "enqueue" }).catch((e) => session.log(`copilot-relay: delivery failed: ${e.message}`, { level: "error" }));
    },
  });
  client.start();

  const stop = () => client.stop();
  process.on("SIGTERM", stop);
  process.on("disconnect", stop);
}
