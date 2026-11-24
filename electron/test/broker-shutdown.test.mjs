// Tests for the broker's /health fields and POST /api/shutdown (server.mjs) against a real broker process.
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";
import { SERVER, startBroker } from "./broker-helper.mjs";

const health = async (b) => (await fetch(`${b.url}/health`)).json();
// fetch only says "fetch failed": the cause (ECONNRESET, UND_ERR_SOCKET…) is what tells a lost answer apart
const post = (b, headers = { "content-type": "application/json" }) =>
  fetch(`${b.url}/api/shutdown`, { method: "POST", headers, body: "{}" }).catch((e) => {
    throw new Error(`${e.message}: ${e.cause?.code ?? e.cause?.message ?? "no cause"}`, { cause: e });
  });

test("health reports the pid, start time, folder and web sessions", async (t) => {
  const b = await startBroker(t);
  const h = await health(b);
  assert.equal(h.ok, true);
  assert.equal(h.app, "copilot-relay");
  assert.equal(h.pid, b.proc.pid);
  assert.equal(realpathSync(h.root), realpathSync(path.dirname(SERVER)));
  assert.ok(Math.abs(Date.now() - h.startedAt) < 60_000);
  assert.equal(h.acpSessions, 0);
});

test("POST /api/shutdown answers with the pid and the broker exits", async (t) => {
  const b = await startBroker(t);
  const r = await post(b);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, pid: b.proc.pid });
  assert.equal(await b.exited, 0);
  await assert.rejects(fetch(`${b.url}/health`));
});

/** A raw connection to the broker with the head of a shutdown request sent: `length` is its Content-Length. */
function shutdownHead(t, b, length) {
  const sock = net.connect(b.port, "127.0.0.1");
  t.after(() => sock.destroy());
  const state = { sock, got: "" };
  sock.setEncoding("utf8").on("data", (d) => (state.got += d));
  sock.on("error", () => {}); // a reset is seen as the close below, not as an uncaught error
  state.closed = new Promise((resolve) => sock.once("close", resolve));
  sock.write(`POST /api/shutdown HTTP/1.1\r\nHost: 127.0.0.1:${b.port}\r\nContent-Type: application/json\r\nContent-Length: ${length}\r\n\r\n`);
  return state;
}
const within = (promise, ms, what) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms).unref())]);

test("the broker answers a shutdown only after the whole request, closes the connection itself and exits at once", async (t) => {
  const b = await startBroker(t);
  // the head of the request without its body: an answer now would leave the body unread when the process exits
  const c = shutdownHead(t, b, 2);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(c.got, "", "no answer before the body arrived");
  assert.equal(b.proc.exitCode, null, "the broker still runs");
  const sent = Date.now();
  c.sock.write("{}");
  await within(c.closed, 5000, "the broker to close the connection"); // Connection: close, not the caller
  assert.match(c.got, /^HTTP\/1\.1 200 /);
  assert.match(c.got, /\r\nconnection: close\r\n/i);
  assert.ok(c.got.includes(JSON.stringify({ ok: true, pid: b.proc.pid })), "the answer's body arrived");
  assert.equal(await within(b.exited, 5000, "the broker to exit"), 0);
  assert.ok(Date.now() - sent < 1500, "the exit follows the close, not the 2 s fallback timer");
});

test("a shutdown request that is cut off leaves the broker running", async (t) => {
  const b = await startBroker(t);
  const c = shutdownHead(t, b, 10);
  c.sock.write("{}"); // 2 of the 10 bytes announced
  await new Promise((resolve) => setTimeout(resolve, 100));
  c.sock.destroy();
  await c.closed;
  await new Promise((resolve) => setTimeout(resolve, 300)); // time for a crash to show
  assert.equal(b.proc.exitCode, null, "the broker still runs");
  assert.equal((await health(b)).pid, b.proc.pid);
  // and it can still be stopped
  assert.equal((await post(b)).status, 200);
  assert.equal(await within(b.exited, 5000, "the broker to exit"), 0);
});

test("a shutdown request with a body that is not JSON still stops the broker", async (t) => {
  const b = await startBroker(t);
  const r = await fetch(`${b.url}/api/shutdown`, { method: "POST", headers: { "content-type": "application/json" }, body: "{x}" });
  assert.equal(r.status, 200);
  assert.equal(await within(b.exited, 5000, "the broker to exit"), 0);
});

test("a foreign shutdown request is refused and the broker keeps running", async (t) => {
  const b = await startBroker(t);
  const stillThere = async () => assert.equal((await health(b)).pid, b.proc.pid);
  // fetch cannot set Host, so this one goes through http.request.
  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: b.port, path: "/api/shutdown", method: "POST", headers: { host: "evil.example", "content-type": "application/json" } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
  assert.equal(status, 403);
  await stillThere();
  assert.equal((await post(b, { "content-type": "application/json", origin: "http://evil.example" })).status, 403);
  await stillThere();
  assert.equal((await post(b, { "content-type": "text/plain" })).status, 403);
  await stillThere();
});

test("GET /api/shutdown is not a route", async (t) => {
  const b = await startBroker(t);
  assert.equal((await fetch(`${b.url}/api/shutdown`)).status, 404);
  assert.equal((await health(b)).pid, b.proc.pid);
});
