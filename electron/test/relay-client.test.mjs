// RelayClient's reconnect timing against a stub broker: the wait after a failure restarts from its base once the
// client has registered, and reconnectNow() ends a wait or a live stream.
import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { RelayClient } from "../../extension/copilot-relay/relay-client.mjs";
import { until } from "./broker-helper.mjs";

/** GET /api/peer/stream answers 503 while `fail`, otherwise a `registered` event on a stream kept open. */
async function stubBroker(t) {
  const s = { attempts: [], fail: false, open: [], closed: 0, drop: () => s.open.splice(0).forEach((r) => r.destroy()) };
  const server = http.createServer((req, res) => {
    s.attempts.push(Date.now());
    if (s.fail) return res.writeHead(503).end();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('event: registered\ndata: {"name":"stub"}\n\n');
    s.open.push(res);
    res.on("close", () => s.closed++);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  s.url = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    s.drop();
    server.close();
  });
  return s;
}

/** A started client against the stub; the test's end stops it. */
function client(t, s, opts = {}) {
  const c = new RelayClient({ url: s.url, key: "k", cwd: ".", onMessage: () => {}, ...opts });
  c.start();
  t.after(() => c.stop());
  return c;
}

test("after a registration the next wait is the base delay again", async (t) => {
  const s = await stubBroker(t);
  s.fail = true;
  const c = client(t, s, { retryMs: 40, retryMaxMs: 5000 });
  await until(() => s.attempts.length >= 6, "six refused attempts"); // waits grew to 1280 ms
  s.fail = false;
  await until(() => c.connected && c.name === "stub", "the registration");
  const before = s.attempts.length;
  const dropped = Date.now();
  s.drop();
  await until(() => s.attempts.length > before, "the next attempt");
  assert.ok(s.attempts.at(-1) - dropped < 500, `waited ${s.attempts.at(-1) - dropped} ms`);
});

test("reconnectNow ends a wait and answers true once registered", async (t) => {
  const s = await stubBroker(t);
  s.fail = true;
  const c = client(t, s, { retryMs: 60_000 });
  await until(() => s.attempts.length === 1, "the first attempt");
  s.fail = false;
  assert.equal(await c.reconnectNow(), true);
  assert.equal(s.attempts.length, 2);
});

test("reconnectNow ends a live stream and registers again", async (t) => {
  const s = await stubBroker(t);
  let registered = 0;
  const c = client(t, s, { retryMs: 60_000, onRegistered: () => registered++ });
  await until(() => registered === 1, "the first registration");
  assert.equal(await c.reconnectNow(), true);
  assert.equal(registered, 2);
  await until(() => s.closed === 1, "the first response to close");
});

test("reconnectNow on a stopped client answers false and does not connect", async (t) => {
  const s = await stubBroker(t);
  const c = client(t, s);
  await until(() => c.connected, "the registration");
  c.stop();
  await until(() => s.closed === 1, "the stream to close");
  const attempts = s.attempts.length;
  assert.equal(await c.reconnectNow(), false);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(s.attempts.length, attempts);
});

test("stop() ends a pending reconnectNow with false", async (t) => {
  const s = await stubBroker(t);
  s.fail = true;
  const c = client(t, s, { retryMs: 60_000 });
  await until(() => s.attempts.length === 1, "the first attempt");
  const p = c.reconnectNow();
  c.stop();
  assert.equal(await p, false);
});

test("default delays", async (t) => {
  const s = await stubBroker(t);
  const c = client(t, s);
  assert.equal(c.retryMs, 1000);
  assert.equal(c.retryMaxMs, 15_000);
});

test("fetchLinkState returns the links and the held counts ({} when the broker sent none)", async (t) => {
  let body = { links: [], held: { "cli:p": 1 } };
  const server = http.createServer((req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body)));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const c = new RelayClient({ url: `http://127.0.0.1:${server.address().port}`, key: "k", cwd: ".", onMessage: () => {} });
  assert.deepEqual(await c.fetchLinkState(), { links: [], held: { "cli:p": 1 } });
  body = { links: [] };
  assert.deepEqual(await c.fetchLinkState(), { links: [], held: {} });
});
