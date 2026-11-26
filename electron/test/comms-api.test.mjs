// Tests for GET /api/comms and /api/comms/text (src/links-api.mjs) and the relay client's comms calls.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { CommsLog } from "../../src/comms-log.mjs";
import { Delegation } from "../../src/delegation.mjs";
import { DelegationStore } from "../../src/delegation-store.mjs";
import { linksRoutes } from "../../src/links-api.mjs";
import { Registry } from "../../src/registry.mjs";
import { RelayClient } from "../../extension/copilot-relay/relay-client.mjs";

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// root -> mid -> leaf, plus "cli:outside" (not in the tree, online) and a stored-name-only "cli:gone"
function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "comms-api-"));
  dirs.push(dir);
  const registry = new Registry();
  const comms = new CommsLog({ file: path.join(dir, "c.jsonl") });
  registry.comms = comms;
  const store = new DelegationStore(path.join(dir, "d.json"));
  const delegation = new Delegation({ registry, store, comms, nameOf: (k) => (k === "cli:old" ? "stary" : undefined) });
  for (const [key, name] of [["cli:root", "mama"], ["cli:mid", "srodek"], ["cli:leaf", "lisc"], ["cli:outside", "obcy"]])
    registry.upsert({ key, name, kind: "cli", app: true, push: () => true, control: () => {} });
  delegation.link("cli:mid", "cli:root");
  delegation.link("cli:leaf", "cli:mid");
  return { registry, store, delegation, comms, routes: linksRoutes({ delegation, comms, registry }) };
}

test("GET /api/comms from a grandchild returns the root, all keys and their events", () => {
  const { routes, comms, registry } = setup();
  const e1 = comms.append({ kind: "message", fromKey: "cli:mid", toKey: "cli:leaf", from: "srodek", to: "lisc", text: "x".repeat(400), status: "queued" });
  comms.append({ kind: "message", fromKey: "cli:zzz", toKey: "cli:zzz2", text: "unrelated", status: "queued" });
  const r = routes["GET /api/comms"]({ key: "cli:leaf" });
  assert.equal(r.status, 200);
  assert.equal(r.json.root, "cli:root");
  assert.deepEqual([...r.json.keys].sort(), ["cli:leaf", "cli:mid", "cli:root"]);
  assert.deepEqual(r.json.events.map((e) => e.id), [e1.id]);
  assert.equal(r.json.events[0].text, undefined, "preview only");
  assert.ok(r.json.events[0].preview);
  assert.equal(r.json.peers["cli:root"].name, registry.get("cli:root").name);
  assert.equal(r.json.peers["cli:root"].online, true);
});

test("GET /api/comms lists outside counterparts in peers with their online state", () => {
  const { routes, comms, registry } = setup();
  comms.append({ kind: "message", fromKey: "cli:outside", toKey: "cli:mid", text: "hi", status: "delivered" });
  comms.append({ kind: "message", fromKey: "cli:old", toKey: "cli:mid", text: "hi", status: "delivered" });
  registry.get("cli:outside").busy = true;
  const { peers } = routes["GET /api/comms"]({ key: "cli:root" }).json;
  assert.deepEqual(peers["cli:outside"], { name: registry.get("cli:outside").name, online: true, busy: true, kind: "cli" });
  assert.equal(peers["cli:old"].name, "stary");
  assert.equal(peers["cli:old"].online, false);
  assert.equal(peers["cli:mid"].busy, false);
});

test("GET /api/comms for an unknown key: itself only, no events; no key is 400", () => {
  const { routes } = setup();
  assert.deepEqual(routes["GET /api/comms"]({ key: "cli:nobody" }).json, { root: "cli:nobody", keys: ["cli:nobody"], events: [], peers: {} });
  assert.equal(routes["GET /api/comms"]({}).status, 400);
});

test("an orphan (parent deleted) is its own root", () => {
  const { routes, store } = setup();
  store.linkOf("cli:mid").parentDeleted = true;
  assert.equal(routes["GET /api/comms"]({ key: "cli:leaf" }).json.root, "cli:mid");
});

test("GET /api/comms/text returns the stored text; unknown id 404", () => {
  const { routes, comms } = setup();
  const e = comms.append({ kind: "message", fromKey: "cli:mid", toKey: "cli:leaf", text: "full text", status: "queued" });
  assert.deepEqual(routes["GET /api/comms/text"]({ id: e.id }), { status: 200, json: { text: "full text" } });
  assert.equal(routes["GET /api/comms/text"]({ id: "nope" }).status, 404);
  assert.equal(routes["GET /api/comms/text"]({}).status, 404);
});

test("the relay client gets comms control events and acks with an outcome", async () => {
  const { routes, comms } = setup();
  const e = comms.append({ kind: "message", fromKey: "cli:mid", toKey: "cli:leaf", text: "full text", status: "queued" });
  const acks = [];
  let stream;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/peer/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: registered\ndata: ${JSON.stringify({ name: "me" })}\n\n`);
      res.write(`event: comms\ndata: ${JSON.stringify({ event: { id: "e9", kind: "message" } })}\n\n`);
      stream = res;
      return;
    }
    if (req.method === "POST") {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => (acks.push(JSON.parse(b)), res.writeHead(200, { "content-type": "application/json" }).end("{}")));
      return;
    }
    const route = routes[`${req.method} ${url.pathname}`];
    const out = route(Object.fromEntries(url.searchParams));
    res.writeHead(out.status, { "content-type": "application/json" }).end(JSON.stringify(out.json));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const got = [];
  const client = new RelayClient({ url: `http://127.0.0.1:${server.address().port}`, key: "cli:leaf", cwd: "/", onMessage() {}, onComms: (ev) => got.push(ev) });
  client.start();
  try {
    const until = Date.now() + 3000;
    while (!got.length && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(got, [{ id: "e9", kind: "message" }]);
    const tree = await client.fetchComms();
    assert.equal(tree.root, "cli:root");
    assert.equal(await client.fetchCommsText(e.id), "full text");
    assert.equal(await client.fetchCommsText("nope"), null);
    await client.ack("m1", "discarded");
    await client.ack("m2");
    assert.deepEqual(acks, [{ key: "cli:leaf", id: "m1", outcome: "discarded" }, { key: "cli:leaf", id: "m2" }]);
  } finally {
    client.stop?.();
    stream?.destroy();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
