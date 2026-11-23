// End to end against a real broker: adopt_session and release_session, the app's card answer and the streams.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startBroker, until } from "./broker-helper.mjs";

const post = (b, route, body) => fetch(`${b.url}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const links = async (b) => (await (await fetch(`${b.url}/api/links`)).json()).links;

test("adopt and release through the tools, the card answer and the streams", async (t) => {
  const b = await startBroker(t);
  const p = await b.connect("cli:p1", { name: "szef", alias: "app:p1", caps: ["links"] });
  const c = await b.connect("cli:c1", { name: "pomocnik", alias: "app:c1", caps: ["links"] });
  assert.match(await b.tool("app:p1", "adopt_session", { name: c.client.name }), /^The user was asked/);
  await until(() => p.linkRequests.length === 1, "the link card");
  assert.deepEqual(await links(b), []);
  const answer = await post(b, "/api/peer/link-answer", { key: p.key, requestId: p.linkRequests[0].requestId, approved: true });
  assert.equal((await answer.json()).result, "linked");
  await until(() => c.parentChanges.length === 1, "parent_changed");
  assert.deepEqual(c.parentChanges[0], { parentKey: "cli:p1", adopted: true });
  assert.deepEqual((await links(b)).map((l) => [l.key, l.parent, l.adopted]), [["cli:c1", "cli:p1", true]]);
  await until(() => p.got.some((m) => /will send you its result/.test(m.text)), "the parent's notice");
  await until(() => c.got.some((m) => /waits for your report/.test(m.text)), "the child's note");
  // the child's next registration carries the link
  await b.disconnect(c);
  const c2 = await b.connect("cli:c1", { alias: "app:c1", caps: ["links"] });
  assert.equal(c2.registered.parentKey, "cli:p1");
  assert.equal(c2.registered.adopted, true);
  // release
  assert.match(await b.tool("app:p1", "release_session", { name: c2.client.name }), /^The user was asked/);
  await until(() => p.linkRequests.length === 2, "the unlink card");
  const out = await post(b, "/api/peer/link-answer", { key: p.key, requestId: p.linkRequests[1].requestId, approved: true });
  assert.equal((await out.json()).result, "released");
  assert.deepEqual(await links(b), []);
  await until(() => c2.parentChanges.some((x) => x.parentKey === null), "parent_changed to none");
});

test("an app that does not announce link cards is refused, and a terminal session has no such tools", async (t) => {
  const b = await startBroker(t);
  await b.connect("cli:p2", { name: "stary", alias: "app:p2" }); // no caps
  const c = await b.connect("cli:c2", { name: "cel", alias: "app:c2", caps: ["links"] });
  assert.match(await b.tool("app:p2", "adopt_session", { name: c.client.name }), /older than the relay broker/);
  await b.connect("cli:t1", { name: "terminal", alias: "term-1" });
  const terminal = await b.tools("term-1");
  assert.equal(terminal.includes("adopt_session") || terminal.includes("release_session"), false);
  const app = await b.tools("app:p2");
  assert.equal(app.includes("adopt_session") && app.includes("release_session"), true);
  for (const x of (await b.toolList("app:p2")).filter((y) => ["adopt_session", "release_session"].includes(y.name))) {
    assert.match(x.description, /only when the user has explicitly asked/, x.name);
    assert.match(x.description, /Never on your own initiative\./, x.name);
  }
});
