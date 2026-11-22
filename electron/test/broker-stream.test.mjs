// Tests for the broker's push stream (server.mjs, GET /api/peer/stream) against a real broker process and real HTTP:
// a message is delivered once whatever its size, and what waits for a session that is briefly offline still arrives.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { RelayClient } from "../../extension/copilot-relay/relay-client.mjs";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "server.mjs");
// One event over the stream's write buffer on every platform (16 KiB on Windows, 64 KiB elsewhere): the broker
// writes the text twice (text + prompt). INCIDENT ("medium") is over the Windows limit only.
const LARGE = 40_000;
const INCIDENT = 8_000;
const SMALL = 200;

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function until(pred, what, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A broker of its own (port, state files) for the test t, which stops it and every client when it ends. */
async function broker(t) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "broker-stream-"));
  const port = await freePort();
  const proc = spawn(process.execPath, [SERVER, path.join(tmp, "no-config.json")], {
    env: {
      ...process.env,
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
  const connect = (key, { name, parentKey, alias } = {}) =>
    new Promise((resolve) => {
      const got = [];
      const client = new RelayClient({ url, key, cwd: tmp, name, parentKey, alias, onMessage: (m) => got.push(m), onRegistered: () => resolve({ client, got, key }) });
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
  const tool = async (alias, name, args) => {
    const mcp = new Client({ name: "test", version: "1" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp?peer=${encodeURIComponent(alias)}`)));
    try {
      return (await mcp.callTool({ name, arguments: args })).content[0].text;
    } finally {
      await mcp.close();
    }
  };
  return { connect, disconnect, tool };
}

const newKey = () => `cli:${randomUUID()}`;
/** What a stream got, short enough for a failure message: "x*40000" for a run of one character. */
const brief = (text) => (text.length > 20 && new Set(text).size === 1 ? `${text[0]}*${text.length}` : text);
const texts = (got) => got.map((m) => brief(m.text));

/** Sends "end" and waits for it: the stream keeps the order, so everything the broker had for the session came before. */
async function drained(sender, receiver) {
  await sender.client.send(receiver.client.name, "end");
  await until(() => receiver.got.some((m) => m.text === "end"), "the end marker");
}

for (const [label, size] of [["small", SMALL], ["medium", INCIDENT], ["large", LARGE]]) {
  test(`a ${label} message is delivered once, and not again when the recipient reconnects`, async (t) => {
    const b = await broker(t);
    const sender = await b.connect(newKey(), { name: "sender" });
    const first = await b.connect(newKey(), { name: "receiver" });
    const text = "x".repeat(size);

    const answer = await sender.client.send(first.client.name, text);
    assert.match(answer, / delivered\./);
    await drained(sender, first);
    assert.deepEqual(texts(first.got), [brief(text), "end"]);

    await b.disconnect(first);
    const again = await b.connect(first.key);
    await drained(sender, again);
    assert.deepEqual(texts(again.got), ["end"]);
  });

  test(`a ${label} message sent while the recipient is briefly offline arrives once when it reconnects`, async (t) => {
    const b = await broker(t);
    const sender = await b.connect(newKey(), { name: "sender" });
    const first = await b.connect(newKey(), { name: "receiver" });
    const text = "y".repeat(size);

    await b.disconnect(first);
    const answer = await sender.client.send(first.client.name, text);
    assert.match(answer, /queued \(recipient briefly offline\)/);

    const second = await b.connect(first.key);
    await drained(sender, second);
    assert.deepEqual(texts(second.got), [brief(text), "end"]);

    await b.disconnect(second);
    const third = await b.connect(first.key);
    await drained(sender, third);
    assert.deepEqual(texts(third.got), ["end"]);
  });

  test(`a ${label} report is answered as delivered, comes again until acknowledged, then never`, async (t) => {
    const b = await broker(t);
    const parentKey = newKey();
    const parent = await b.connect(parentKey, { name: "parent" });
    const alias = `app:${randomUUID()}`; // the delegation tools are the desktop app's
    const child = await b.connect(newKey(), { name: "child", parentKey, alias });
    const text = "z".repeat(size);

    assert.equal(await b.tool(alias, "report_result", { text }), "Report delivered to your parent session.");
    await until(() => parent.got.length === 1, "the report");
    assert.deepEqual(texts(parent.got), [brief(text)]);
    const { deliveryId } = parent.got[0];
    assert.equal(typeof deliveryId, "string");

    // not acknowledged: the broker delivers it again on the next registration (at least once)
    await b.disconnect(parent);
    const second = await b.connect(parentKey);
    await until(() => second.got.length === 1, "the redelivered report");
    assert.equal(second.got[0].deliveryId, deliveryId);

    await second.client.ack(deliveryId);
    await b.disconnect(second);
    const third = await b.connect(parentKey);
    await drained(child, third);
    assert.deepEqual(texts(third.got), ["end"]);
  });
}
