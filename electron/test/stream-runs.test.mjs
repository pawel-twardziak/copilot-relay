// Tests for routing streamed chunks to their message's block (electron/renderer/stream-runs.js).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const SR = createRequire(import.meta.url)("../renderer/stream-runs.js");

const open = (runs, type, messageId) => {
  const run = { type, messageId };
  runs.add(run);
  return run;
};

test("chunks of two messages streaming at once each go to their own block", () => {
  // two background subagents answering in parallel: their chunks alternate
  const runs = SR.create();
  const a = open(runs, "agent", "m-a");
  assert.equal(runs.find("agent", "m-b"), null); // a new block for the other message
  const b = open(runs, "agent", "m-b");
  assert.equal(runs.find("agent", "m-a"), a);
  assert.equal(runs.find("agent", "m-b"), b);
  assert.equal(runs.find("agent", "m-a"), a);
});

test("a message keeps its block after something else was appended (a tool call, a card)", () => {
  const runs = SR.create();
  const a = open(runs, "agent", "m-a");
  runs.close();
  assert.equal(runs.find("agent", "m-a"), a);
});

test("thinking and the answer of one message are separate blocks", () => {
  const runs = SR.create();
  const t = open(runs, "thought", "m-a");
  assert.equal(runs.find("agent", "m-a"), null);
  const a = open(runs, "agent", "m-a");
  assert.equal(runs.find("thought", "m-a"), t);
  assert.equal(runs.find("agent", "m-a"), a);
});

test("chunks without a messageId continue the current block of their type until it is closed", () => {
  const runs = SR.create();
  const u = open(runs, "user");
  assert.equal(runs.find("user"), u);
  assert.equal(runs.find("agent"), null); // another type: a new block
  runs.close();
  assert.equal(runs.find("user"), null);
});

test("a chunk without a messageId never joins a block that has one, and vice versa", () => {
  const runs = SR.create();
  open(runs, "agent", "m-a");
  assert.equal(runs.find("agent"), null);
  const runs2 = SR.create();
  open(runs2, "agent");
  assert.equal(runs2.find("agent", "m-a"), null);
});
