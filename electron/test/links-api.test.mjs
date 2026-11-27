// Tests for the links HTTP API route logic (src/links-api.mjs) and the relay client's new calls/events.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { Delegation } from "../../src/delegation.mjs";
import { DelegationStore } from "../../src/delegation-store.mjs";
import { linksRoutes } from "../../src/links-api.mjs";
import { Registry } from "../../src/registry.mjs";
import { RelayClient } from "../../extension/copilot-relay/relay-client.mjs";

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "links-"));
  dirs.push(dir);
  const registry = new Registry();
  const store = new DelegationStore(path.join(dir, "d.json"));
  let n = 0;
  const delegation = new Delegation({ registry, store, newId: () => `id${++n}` });
  const controls = [];
  for (const [key, name] of [["cli:parent", "mama"], ["cli:child", "badacz"]])
    registry.upsert({ key, name, kind: "cli", app: true, push: () => true, control: (...a) => controls.push([key, ...a]) });
  delegation.link("cli:child", "cli:parent");
  const logs = [];
  return { registry, store, delegation, routes: linksRoutes({ delegation, log: (m) => logs.push(m) }), controls, logs };
}

test("GET /api/links returns the snapshot", () => {
  const { routes } = setup();
  const r = routes["GET /api/links"]();
  assert.equal(r.status, 200);
  assert.equal(r.json.links.length, 1);
  assert.equal(r.json.links[0].key, "cli:child");
});

test("forget removes cli: links, ignores non-cli keys, fires onChange", () => {
  const { routes, store, delegation } = setup();
  let changes = 0;
  delegation.onChange(() => changes++);
  delegation.link("acp:x", "cli:parent");
  assert.equal(routes["POST /api/links/forget"]({ keys: ["acp:x", "cli:child"] }).status, 204);
  assert.equal(store.linkOf("cli:child") ?? null, null);
  assert.equal(store.parentOf("acp:x"), "cli:parent", "non-cli link survives forget");
  assert.ok(changes >= 1);
  assert.equal(routes["POST /api/links/missing"]({ keys: ["acp:x"] }).status, 204);
  assert.equal(store.parentOf("acp:x"), "cli:parent", "non-cli link survives missing");
});

test("keys must be an array of strings", () => {
  const { routes } = setup();
  assert.equal(routes["POST /api/links/forget"]({ keys: "cli:child" }).status, 400);
  assert.equal(routes["POST /api/links/forget"]({ keys: [1] }).status, 400);
  assert.equal(routes["POST /api/links/missing"]({}).status, 400);
});

test("task stores the task, reports unknown children as ok:false", () => {
  const { routes, store } = setup();
  assert.deepEqual(routes["POST /api/peer/task"]({ key: "cli:child", task: "do it" }), { status: 200, json: { ok: true } });
  assert.equal(store.taskOf("cli:child"), "do it");
  assert.equal(routes["POST /api/peer/task"]({ key: "cli:none", task: "x" }).json.ok, false);
  assert.equal(routes["POST /api/peer/task"]({ key: 5, task: "x" }).status, 400);
});

test("state sets busy; invalid key is 400", () => {
  const { routes, registry } = setup();
  assert.equal(routes["POST /api/peer/state"]({ key: "cli:child", busy: true }).status, 204);
  assert.equal(registry.get("cli:child").busy, true);
  assert.equal(routes["POST /api/peer/state"]({ busy: true }).status, 400);
});

test("died notifies the parent once", () => {
  const { routes, store } = setup();
  assert.equal(routes["POST /api/peer/died"]({ key: "cli:child" }).status, 204);
  assert.ok(store.pending("cli:parent").length >= 1);
  assert.equal(routes["POST /api/peer/died"]({}).status, 400);
});

test("reopen-answer approve releases the queue", () => {
  const { routes, store, registry, delegation, controls } = setup();
  registry.get("cli:child").online = false;
  delegation.messageClosed("cli:parent", registry.get("cli:child").name, "hello");
  const ask = controls.find((c) => c[1] === "reopen_request");
  assert.ok(ask, "a reopen request was emitted");
  const { requestId } = ask[2];
  assert.equal(store.awaitingFor(requestId).length, 1);
  assert.equal(routes["POST /api/peer/reopen-answer"]({ key: "cli:parent", requestId, approved: true }).status, 204);
  assert.equal(store.awaitingFor(requestId).length, 0);
  assert.equal(routes["POST /api/peer/reopen-answer"]({ key: "cli:parent", approved: true }).status, 400);
});

test("reopen-answer for a request that is not pending is 404", () => {
  const { routes, registry, delegation, controls } = setup();
  registry.get("cli:child").online = false;
  delegation.messageClosed("cli:parent", registry.get("cli:child").name, "hello");
  const { requestId } = controls.find((c) => c[1] === "reopen_request")[2];
  assert.equal(routes["POST /api/peer/reopen-answer"]({ key: "cli:parent", requestId, approved: false }).status, 204);
  const again = routes["POST /api/peer/reopen-answer"]({ key: "cli:parent", requestId, approved: false });
  assert.equal(again.status, 404);
  assert.match(again.json.error, /not pending/);
  assert.equal(routes["POST /api/peer/reopen-answer"]({ key: "cli:other", requestId: "nope", approved: true }).status, 404);
});

test("missing logs what it forgot; forget does not", () => {
  const { routes, logs } = setup();
  routes["POST /api/links/forget"]({ keys: [] });
  assert.deepEqual(logs, []);
  routes["POST /api/links/missing"]({ keys: ["cli:child", "acp:x"] });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /cli:child/);
  assert.doesNotMatch(logs[0], /acp:x/);
});

test("the client's answerReopen throws on a refused answer (with its status) and on an unreachable broker", async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => res.writeHead(404, { "content-type": "application/json" }).end('{"error":"This reopen request is not pending."}'));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const client = new RelayClient({ url: `http://127.0.0.1:${port}`, key: "cli:me", cwd: "/", onMessage() {} });
  try {
    await assert.rejects(client.answerReopen("r1", true), (e) => e.status === 404 && /not pending/.test(e.message));
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  await assert.rejects(client.answerReopen("r1", true), (e) => e.status === undefined);
});

test("the client calls onReopenRequest and onLinksChanged for their events, and fetchLinks/posts work", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/api/peer/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: reopen_request\ndata: {"requestId":"r1"}\n\n');
      res.write("event: links_changed\ndata: {}\n\n");
      return res.end();
    }
    if (req.url === "/api/links") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ links: [{ key: "cli:a" }] }));
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push([req.url, body]);
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const events = [];
  const client = new RelayClient({
    url, key: "cli:me", cwd: "/", onMessage() {},
    onReopenRequest: (p) => events.push(["reopen", p.requestId]),
    onLinksChanged: () => events.push(["links"]),
  });
  client.start();
  const until = Date.now() + 3000;
  while (events.length < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  client.stop();
  assert.deepEqual(events, [["reopen", "r1"], ["links"]]);
  assert.deepEqual(await client.fetchLinks(), [{ key: "cli:a" }]);
  assert.equal(await client.setTask("t"), true);
  await client.state(true);
  await client.died();
  await client.answerReopen("r1", true, undefined);
  assert.deepEqual(seen.map((s) => s[0]), ["/api/peer/task", "/api/peer/state", "/api/peer/died", "/api/peer/reopen-answer"]);
  await new Promise((r) => server.close(r));
});

test("the client's answerLink returns the result, and throws with the status when the request is not pending", async () => {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const b = JSON.parse(body);
      bodies.push(b);
      if (b.requestId === "r1") return res.writeHead(200, { "content-type": "application/json" }).end('{"result":"linked","text":"ok"}');
      res.writeHead(404, { "content-type": "application/json" }).end('{"error":"This link request is not pending."}');
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const client = new RelayClient({ url: `http://127.0.0.1:${server.address().port}`, key: "cli:me", cwd: "/", onMessage() {} });
  try {
    assert.deepEqual(await client.answerLink("r1", true), { result: "linked", text: "ok" });
    await assert.rejects(client.answerLink("r2", true), (e) => e.status === 404 && /not pending/.test(e.message));
    assert.deepEqual(bodies[0], { key: "cli:me", requestId: "r1", approved: true });
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test("the client sends caps and calls onLinkRequest and onParentChanged for their events", async () => {
  let seenUrl = "";
  const server = http.createServer((req, res) => {
    seenUrl ||= req.url;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('event: registered\ndata: {"name":"me"}\n\n');
    res.write('event: link_request\ndata: {"requestId":"r1","kind":"adopt"}\n\n');
    res.write('event: parent_changed\ndata: {"parentKey":null,"adopted":false}\n\n');
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const linkRequests = [];
  const parentChanges = [];
  const client = new RelayClient({
    url: `http://127.0.0.1:${server.address().port}`, key: "cli:me", cwd: "/", onMessage() {}, caps: ["links"],
    onLinkRequest: (p) => linkRequests.push(p),
    onParentChanged: (p) => parentChanges.push(p),
  });
  client.start();
  try {
    const until = Date.now() + 3000;
    while ((!linkRequests.length || !parentChanges.length) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  } finally {
    client.stop();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  assert.equal(new URL(seenUrl, "http://x").searchParams.get("caps"), "links");
  assert.deepEqual(linkRequests, [{ requestId: "r1", kind: "adopt" }]);
  assert.deepEqual(parentChanges, [{ parentKey: null, adopted: false }]);
});

test("a runtime rename fires onChange", () => {
  const { registry, delegation } = setup();
  let changes = 0;
  delegation.onChange(() => changes++);
  registry.emit("peer_renamed", registry.get("cli:child"));
  assert.equal(changes, 1);
});

test("link-answer approves a pending request once and is 404 afterwards", () => {
  const { routes, registry, delegation, controls } = setup(); // cli:child is linked to cli:parent
  registry.get("cli:parent").linkCards = true;
  delegation.requestLink("cli:parent", "release", registry.get("cli:child").name);
  const { requestId } = controls.find((c) => c[1] === "link_request")[2];
  assert.equal(routes["POST /api/peer/link-answer"]({ key: "cli:parent", approved: true }).status, 400);
  assert.equal(routes["POST /api/peer/link-answer"]({ requestId, approved: true }).status, 400);
  assert.equal(routes["POST /api/peer/link-answer"]({ key: "cli:child", requestId, approved: true }).status, 404);
  const ok = routes["POST /api/peer/link-answer"]({ key: "cli:parent", requestId, approved: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.result, "released");
  const again = routes["POST /api/peer/link-answer"]({ key: "cli:parent", requestId, approved: true });
  assert.equal(again.status, 404);
  assert.match(again.json.error, /not pending/);
});

test("link-answer treats anything but approved === true as a rejection", () => {
  const { routes, registry, delegation, controls, store } = setup();
  registry.get("cli:parent").linkCards = true;
  delegation.requestLink("cli:parent", "release", registry.get("cli:child").name);
  const { requestId } = controls.find((c) => c[1] === "link_request")[2];
  assert.equal(routes["POST /api/peer/link-answer"]({ key: "cli:parent", requestId, approved: "true" }).json.result, "rejected");
  assert.equal(store.parentOf("cli:child"), "cli:parent");
});

test("GET /api/links answers links, held and heldByKind", () => {
  const byKind = { "cli:p": { child: 2, parent: 1, other: 0 } };
  const routes = linksRoutes({ delegation: { snapshot: () => [], heldCounts: () => ({ "cli:p": 2 }), heldByKind: () => byKind }, log: () => {} });
  const r = routes["GET /api/links"]();
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { links: [], held: { "cli:p": 2 }, heldByKind: byKind });
});

test("fallback forwards the reply and answers its result; missing to or text is 400", () => {
  const { routes, store } = setup();
  const out = routes["POST /api/peer/fallback"]({ key: "cli:child", to: "cli:parent", text: "done" });
  assert.equal(out.status, 200);
  assert.match(out.json.result, /Report delivered/);
  assert.equal(store.isReported("cli:child"), true);
  assert.equal(routes["POST /api/peer/fallback"]({ key: "cli:child", to: "cli:parent" }).status, 400);
  assert.equal(routes["POST /api/peer/fallback"]({ key: "cli:child", text: "x" }).status, 400);
  assert.equal(routes["POST /api/peer/fallback"]({ to: "cli:parent", text: "x" }).status, 400);
});
