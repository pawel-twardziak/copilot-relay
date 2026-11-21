// Tests for the scripted ACP agent the UI checks run the app against (electron/test/fixtures/acp/scripted-agent.mjs).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "acp", "scripted-agent.mjs");

const text = (messageId, t) => ({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: t } });
const call = { sessionUpdate: "tool_call", toolCallId: "t1", title: "rm x", kind: "execute", status: "pending" };
const done = { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" };
const PROMPTS = [
  [{ u: text("m1", "one") }, { u: text("m1", " two") }, { end: "end_turn" }, { wait: 20 }, { u: text("m2", "after the answer") }],
  [{ u: call }, { perm: { toolCallId: "t1", title: "rm x", kind: "execute", status: "pending" } }, { u: done }, { end: "end_turn" }],
];

const tmp = mkdtempSync(path.join(os.tmpdir(), "scripted-agent-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const scenario = path.join(tmp, "scenario.mjs");
writeFileSync(scenario, `export default { prompts: ${JSON.stringify(PROMPTS)} };\n`);
const failingLoad = path.join(tmp, "failing-load.mjs");
writeFileSync(failingLoad, `export default { prompts: ${JSON.stringify(PROMPTS)}, load: { delay: 150, error: "no luck" } };\n`);
let dirs = 0;
const freshCwd = () => {
  const dir = path.join(tmp, `work-${++dirs}`);
  mkdirSync(dir);
  return dir;
};

/** The agent as the app starts it (with flags it must ignore), and a client that keeps every message it sent. */
function start(cwd, scenarioFile = scenario) {
  const proc = spawn(process.execPath, [AGENT, "--acp", "--stdio", "--context", "long_context"], {
    cwd,
    env: { ...process.env, SCRIPTED_SCENARIO: scenarioFile },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const seen = [];
  const waiters = new Set();
  createInterface({ input: proc.stdout }).on("line", (line) => {
    seen.push(JSON.parse(line));
    for (const w of waiters) w();
  });
  /** Resolves with the index in `seen` of the first message matching pred. */
  const waitFor = (pred, ms = 3000) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const i = seen.findIndex(pred);
        if (i < 0) return false;
        waiters.delete(check);
        clearTimeout(timer);
        resolve(i);
        return true;
      };
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error("timed out waiting for a message"));
      }, ms);
      waiters.add(check);
      check();
    });
  let id = 0;
  const write = (msg) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  /** Sends a request; resolves with the index of its answer. */
  const request = (method, params) => {
    const rid = ++id;
    write({ id: rid, method, params });
    return waitFor((m) => m.id === rid && !m.method);
  };
  const updates = (from, to) => seen.slice(from, to).filter((m) => m.method === "session/update").map((m) => m.params);
  return { proc, seen, waitFor, request, write, updates, stop: () => proc.kill() };
}

async function newSession(cwd) {
  const a = start(cwd);
  await a.request("initialize", { protocolVersion: 1 });
  const sessionId = a.seen[await a.request("session/new", { cwd, mcpServers: [] })].result.sessionId;
  return { ...a, sessionId };
}

const prompt = (a, t) => a.request("session/prompt", { sessionId: a.sessionId, prompt: [{ type: "text", text: t }] });

test("session/new answers with scripted- and the folder's name", async () => {
  const cwd = freshCwd();
  const a = await newSession(cwd);
  a.stop();
  assert.equal(a.sessionId, `scripted-${path.basename(cwd)}`);
});

test("a prompt's updates arrive in order before its answer; steps after end follow the answer", async () => {
  const a = await newSession(freshCwd());
  const from = a.seen.length;
  const answer = await prompt(a, "first");
  assert.deepEqual(a.seen[answer].result, { stopReason: "end_turn" });
  assert.deepEqual(a.updates(from, answer), [
    { sessionId: a.sessionId, update: text("m1", "one") },
    { sessionId: a.sessionId, update: text("m1", " two") },
  ]);
  const late = await a.waitFor((m) => m.params?.update?.messageId === "m2");
  a.stop();
  assert.ok(late > answer);
});

test("a perm step holds the next update until the request is answered", async () => {
  const a = await newSession(freshCwd());
  await prompt(a, "first");
  await a.waitFor((m) => m.params?.update?.messageId === "m2");
  const answered = prompt(a, "second");
  const ask = a.seen[await a.waitFor((m) => m.method === "session/request_permission")];
  assert.equal(ask.params.sessionId, a.sessionId);
  assert.equal(ask.params.toolCall.toolCallId, "t1");
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!a.seen.some((m) => m.params?.update?.sessionUpdate === "tool_call_update"), "the update after perm came before the answer");
  a.write({ id: ask.id, result: { outcome: { outcome: "selected", optionId: "allow" } } });
  const answer = await answered;
  const update = a.seen.findIndex((m) => m.params?.update?.sessionUpdate === "tool_call_update");
  a.stop();
  assert.ok(update > 0 && update < answer);
  assert.deepEqual(a.seen[answer].result, { stopReason: "end_turn" });
});

test("session/load in a new process replays the prompts and updates in order before its answer", async () => {
  const cwd = freshCwd();
  const a = await newSession(cwd);
  await prompt(a, "first");
  await a.waitFor((m) => m.params?.update?.messageId === "m2");
  const answered = prompt(a, "second");
  const ask = a.seen[await a.waitFor((m) => m.method === "session/request_permission")];
  a.write({ id: ask.id, result: { outcome: { outcome: "selected", optionId: "allow" } } });
  await answered;
  a.stop();

  const b = start(cwd);
  await b.request("initialize", { protocolVersion: 1 });
  const from = b.seen.length;
  const loaded = await b.request("session/load", { sessionId: a.sessionId, cwd, mcpServers: [] });
  b.stop();
  assert.ok(!b.seen[loaded].error);
  const user = (t) => ({ sessionUpdate: "user_message_chunk", content: { type: "text", text: t } });
  assert.deepEqual(
    b.updates(from, loaded),
    [user("first"), text("m1", "one"), text("m1", " two"), text("m2", "after the answer"), user("second"), call, done].map((update) => ({ sessionId: a.sessionId, update })),
  );
});

test("a scenario's load option holds the load's answer back and makes it an error, after the replay", async () => {
  const cwd = freshCwd();
  const a = await newSession(cwd);
  await prompt(a, "first");
  await a.waitFor((m) => m.params?.update?.messageId === "m2");
  a.stop();

  const b = start(cwd, failingLoad);
  await b.request("initialize", { protocolVersion: 1 });
  const from = b.seen.length;
  const started = Date.now();
  const loaded = await b.request("session/load", { sessionId: a.sessionId, cwd, mcpServers: [] });
  b.stop();
  assert.ok(Date.now() - started >= 150);
  assert.equal(b.seen[loaded].error?.message, "no luck");
  assert.equal(b.updates(from, loaded).length, 4); // the prompt and its three updates
});
