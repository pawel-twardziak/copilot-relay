// Shared by the tests that run a real broker (server.mjs) as a child process on a free port with its own state files.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { RelayClient } from "../../extension/copilot-relay/relay-client.mjs";

export const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "server.mjs");

export const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

export async function until(pred, what, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * A broker of its own (port, state files) for the test t, which stops it and every client when it ends.
 * `script` is the server file to run, `port` fixes the port (default: a free one), `env` adds environment variables.
 */
export async function startBroker(t, { script = SERVER, port: wanted, env } = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "broker-test-"));
  const port = wanted ?? (await freePort());
  const proc = spawn(process.execPath, [script, path.join(tmp, "no-config.json")], {
    env: {
      ...process.env,
      ...env,
      COPILOT_RELAY_PORT: String(port),
      COPILOT_RELAY_NAMES_FILE: path.join(tmp, "names.json"),
      COPILOT_RELAY_DELEGATIONS_FILE: path.join(tmp, "delegations.json"),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise((resolve) => proc.once("exit", resolve));
  const clients = [];
  t.after(async () => {
    for (const c of clients) c.stop();
    proc.kill();
    await exited;
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await new Promise((resolve, reject) => {
    createInterface({ input: proc.stdout }).on("line", (line) => line.includes("copilot-relay broker:") && resolve());
    proc.once("exit", (code) => reject(new Error(`the broker exited with ${code}`)));
  });
  const url = `http://127.0.0.1:${port}`;

  /** A session's stream: resolves once registered; got holds every message it was pushed, in order. */
  const connect = (key, { name, parentKey, alias, caps } = {}) =>
    new Promise((resolve) => {
      const got = [];
      const linkRequests = [];
      const parentChanges = [];
      const peer = { client: null, got, key, linkRequests, parentChanges, registered: null };
      const client = new RelayClient({
        url, key, cwd: tmp, name, parentKey, alias, caps,
        onMessage: (m) => got.push(m),
        onLinkRequest: (p) => linkRequests.push(p),
        onParentChanged: (p) => parentChanges.push(p),
        onRegistered: (_name, payload) => {
          peer.registered = payload;
          resolve(peer);
        },
      });
      peer.client = client;
      clients.push(client);
      client.start();
    });
  const online = async (key) => (await (await fetch(`${url}/api/peer/list?key=none`)).json()).find((p) => p.key === key)?.online;
  /** The session's stream is closed and the broker has noticed (it is offline, inside the grace period). */
  const disconnect = async (peer) => {
    peer.client.stop();
    await until(async () => (await online(peer.key)) === false, "the broker to see the stream close");
  };
  /** Call a relay tool as the session registered with `alias` (the MCP endpoint the app gives Copilot). */
  const withMcp = async (alias, fn) => {
    const mcp = new Client({ name: "test", version: "1" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp?peer=${encodeURIComponent(alias)}`)));
    try {
      return await fn(mcp);
    } finally {
      await mcp.close();
    }
  };
  const tool = (alias, name, args) => withMcp(alias, async (mcp) => (await mcp.callTool({ name, arguments: args })).content[0].text);
  /** The names of the tools the MCP endpoint offers the session registered with `alias`. */
  const tools = (alias) => withMcp(alias, async (mcp) => (await mcp.listTools()).tools.map((x) => x.name));
  return { url, port, proc, exited, tmp, connect, disconnect, tool, tools };
}
