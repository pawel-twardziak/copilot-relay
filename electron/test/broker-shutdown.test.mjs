// Tests for the broker's /health fields and POST /api/shutdown (server.mjs) against a real broker process.
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { SERVER, startBroker } from "./broker-helper.mjs";

const health = async (b) => (await fetch(`${b.url}/health`)).json();
const post = (b, headers = { "content-type": "application/json" }) =>
  fetch(`${b.url}/api/shutdown`, { method: "POST", headers, body: "{}" });

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
