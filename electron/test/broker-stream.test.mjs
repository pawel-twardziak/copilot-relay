// Tests for the broker's push stream (server.mjs, GET /api/peer/stream) against a real broker process and real HTTP:
// a message is delivered once whatever its size, and what waits for a session that is briefly offline still arrives.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
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
