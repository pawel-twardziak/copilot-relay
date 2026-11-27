// Tests for the broker's push stream (server.mjs, GET /api/peer/stream) against a real broker process and real HTTP:
// a message is delivered once whatever its size, and what waits for a session that is briefly offline still arrives.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { RelayClient } from "../../extension/copilot-relay/relay-client.mjs";
import { startBroker, until } from "./broker-helper.mjs";

// One event over the stream's write buffer on every platform (16 KiB on Windows, 64 KiB elsewhere): the broker
// writes the text twice (text + prompt). INCIDENT ("medium") is over the Windows limit only.
const LARGE = 40_000;
const INCIDENT = 8_000;
const SMALL = 200;

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
    const b = await startBroker(t);
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
    const b = await startBroker(t);
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
    const b = await startBroker(t);
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

test("an older stream of a session that closes after a newer one registered does not take the session offline", async (t) => {
  const b = await startBroker(t);
  const sender = await b.connect(newKey(), { name: "sender" });
  const older = await b.connect(newKey(), { name: "receiver" });
  const newer = await b.connect(older.key); // e.g. a reconnect whose old request the broker sees closing only now
  older.client.stop();
  await new Promise((r) => setTimeout(r, 300)); // the broker handles the older stream's close
  const answer = await sender.client.send(older.client.name, "after the old close");
  assert.match(answer, / delivered\./);
  await until(() => newer.got.some((m) => m.text === "after the old close"), "the message on the newer stream");
  assert.deepEqual(texts(older.got), []);
});

test("the broker's log traces streams and events by id, never a message's text; the client traces what it got", async (t) => {
  const b = await startBroker(t);
  const sender = await b.connect(newKey(), { name: "sender" });
  const key = newKey();
  const lines = [];
  const client = new RelayClient({ url: b.url, key, cwd: b.tmp, name: "traced", onMessage: () => {}, trace: (l) => lines.push(l) });
  t.after(() => client.stop());
  client.start();
  await until(() => lines.some((l) => l.startsWith("← registered as traced")), "the client's registration");
  assert.match(await sender.client.send(client.name, "secret words"), / delivered\./);
  await until(() => lines.some((l) => l.startsWith("← message")), "the message on the client");
  client.stop();
  const log = () => readFileSync(path.join(b.tmp, "broker.log"), "utf8");
  await until(() => log().includes(`closed ${key}`), "the stream's close in the log");
  const text = log();
  assert.match(text, /\[broker\] .* \(pid \d+, Node v/);
  assert.match(text, new RegExp(`\\[stream s\\d+\\] open ${key}`));
  assert.match(text, new RegExp(`\\[stream s\\d+\\] → message (\\S+ )?${key}`));
  assert.match(text, /\[api\] send from cli:\S+ to traced\S*: Message to traced\S* delivered\./);
  assert.ok(!text.includes("secret words"), "no message text in the log");
  assert.ok(lines[0].startsWith(`connecting to ${b.url} as ${key}`));
  assert.ok(lines.includes("stream open"));
  assert.match(lines.find((l) => l.startsWith("← registered")), /on stream s\d+ \(broker (\S+|of an unknown build), its log: \S+\)$/);
});

test("the broker's log traces create_session from the tool call to the stream event", async (t) => {
  const b = await startBroker(t);
  const alias = `app:${randomUUID()}`;
  const parent = await b.connect(newKey(), { name: "parent", alias });
  const answer = await b.tool(alias, "create_session", { name: "child", task: "secret task" });
  const requestId = answer.match(/^Request (\S+) sent/)?.[1];
  assert.ok(requestId, answer);
  const text = readFileSync(path.join(b.tmp, "broker.log"), "utf8");
  assert.match(text, new RegExp(`\\[mcp\\] create_session from ${parent.key}: Request ${requestId} sent`));
  assert.match(text, new RegExp(`\\[stream s\\d+\\] → session_request ${requestId} ${parent.key}`));
  assert.match(text, new RegExp(`\\[stream s\\d+\\] open ${parent.key} alias=${alias}`));
  assert.ok(!text.includes("secret task"));
});
