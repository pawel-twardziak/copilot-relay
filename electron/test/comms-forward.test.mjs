// Tests for the app-wide forwarder of communication events (electron/comms-forward.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCommsForward } from "../comms-forward.mjs";

const collect = (max) => {
  const sent = [];
  return { sent, forward: createCommsForward({ send: (channel, event) => sent.push([channel, event]), max }) };
};

test("each event id is forwarded once, also from several sessions", () => {
  const { sent, forward } = collect();
  forward({ id: "a", kind: "task" });
  forward({ id: "a", kind: "task" }); // the same event pushed through a second session's client
  forward({ id: "b", kind: "report" });
  assert.deepEqual(sent, [["comms:event", { id: "a", kind: "task" }], ["comms:event", { id: "b", kind: "report" }]]);
});

test("old ids fall out after max", () => {
  const { sent, forward } = collect(2);
  for (const id of ["a", "b", "c"]) forward({ id });
  forward({ id: "a" }); // forgotten: forwarded again
  forward({ id: "c" }); // still remembered
  assert.deepEqual(sent.map(([, e]) => e.id), ["a", "b", "c", "a"]);
});

test("an event without an id is ignored", () => {
  const { sent, forward } = collect();
  forward({ kind: "task" });
  forward(null);
  assert.equal(sent.length, 0);
});
