// The comms wiring in server.mjs against a real broker process: the control push, the query passthrough, the ack outcome
// and the isolated log file.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { startBroker, until } from "./broker-helper.mjs";

test("a message is pushed as a comms event to the app, served by /api/comms, acked as taken, logged in the test's own file", async (t) => {
  const b = await startBroker(t);
  const seen = [];
  // only a session registered with an app: alias counts as the app and gets the control event
  const parent = await b.connect("cli:parent", { name: "mama", alias: "app:p1", onComms: (e) => seen.push(e) });
  const child = await b.connect("cli:child", { name: "badacz", alias: "app:c1", parentKey: "cli:parent" });

  await child.client.send(parent.client.name, "report text");
  await until(() => seen.some((e) => e.kind === "message" && e.fromKey === "cli:child"), "the comms push");
  const pushed = seen.find((e) => e.kind === "message");
  assert.equal(pushed.text, undefined, "the push carries a preview, not the text");

  const tree = await parent.client.fetchComms("cli:child"); // through the real dispatcher: the key arrives as a query
  assert.equal(tree.root, "cli:parent");
  assert.ok(tree.events.some((e) => e.id === pushed.id));
  assert.equal(await parent.client.fetchCommsText(pushed.id), "report text");

  const delivery = parent.got.find((m) => m.text === "report text")?.deliveryId;
  assert.ok(delivery, "the app parent gets a durable delivery id");
  await parent.client.ack(delivery, "bogus");
  await until(async () => (await parent.client.fetchComms("cli:child")).events.some((e) => e.kind === "status" && e.status === "taken"), "the taken status");

  assert.ok(existsSync(path.join(b.tmp, "communications.jsonl")), "the broker logs into the test's own file");
});
