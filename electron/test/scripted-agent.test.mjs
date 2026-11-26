// Tests for the scripted ACP agent the UI checks run the app against (electron/test/fixtures/acp/scripted-agent.mjs).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
// the children are killed and gone by then (start: t.after); the retries cover a handle Windows releases late
after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
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

/** The agent as the app starts it (with flags it must ignore), and a client that keeps every message it sent. The
 *  test t kills it when it ends, and waits for its exit, also after a failed assertion or a timeout (a child left
 *  running would keep node --test from exiting). */
function start(t, cwd, scenarioFile = scenario, env = {}) {
  const proc = spawn(process.execPath, [AGENT, "--acp", "--stdio", "--context", "long_context"], {
    cwd,
    env: { ...process.env, SCRIPTED_SCENARIO: scenarioFile, ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const exited = new Promise((resolve) => proc.once("exit", resolve));
  t.after(() => {
    proc.kill();
    return exited;
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

async function newSession(t, cwd) {
  const a = start(t, cwd);
  await a.request("initialize", { protocolVersion: 1 });
  const sessionId = a.seen[await a.request("session/new", { cwd, mcpServers: [] })].result.sessionId;
  return { ...a, sessionId };
}

const prompt = (a, t) => a.request("session/prompt", { sessionId: a.sessionId, prompt: [{ type: "text", text: t }] });

test("session/new answers with scripted- and the folder's name", async (t) => {
  const cwd = freshCwd();
  const a = await newSession(t, cwd);
  a.stop();
  assert.equal(a.sessionId, `scripted-${path.basename(cwd)}`);
});

test("a prompt's updates arrive in order before its answer; steps after end follow the answer", async (t) => {
  const a = await newSession(t, freshCwd());
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

test("a perm step holds the next update until the request is answered", async (t) => {
  const a = await newSession(t, freshCwd());
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

test("session/cancel ends the running prompt at once: it answers cancelled and plays none of its remaining steps", async (t) => {
  const a = await newSession(t, freshCwd());
  await prompt(a, "first");
  await a.waitFor((m) => m.params?.update?.messageId === "m2");
  const answered = prompt(a, "second");
  await a.waitFor((m) => m.method === "session/request_permission"); // waiting for its answer
  const started = Date.now();
  a.write({ method: "session/cancel", params: { sessionId: a.sessionId } });
  const answer = await answered;
  await new Promise((r) => setTimeout(r, 200));
  a.stop();
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(a.seen[answer].result, { stopReason: "cancelled" });
  assert.ok(!a.seen.some((m) => m.params?.update?.sessionUpdate === "tool_call_update"), "a step after the cancel was played");
});

test("session/cancel during a wait step ends the prompt without waiting", async (t) => {
  const cwd = freshCwd();
  const waiting = path.join(tmp, "waiting.mjs");
  writeFileSync(waiting, `export default { prompts: ${JSON.stringify([[{ u: text("m1", "before") }, { wait: 5000 }, { u: text("m1", "after") }, { end: "end_turn" }]])} };\n`);
  const a = start(t, cwd, waiting);
  await a.request("initialize", { protocolVersion: 1 });
  const sessionId = a.seen[await a.request("session/new", { cwd, mcpServers: [] })].result.sessionId;
  const answered = a.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
  await a.waitFor((m) => m.params?.update?.content?.text === "before");
  const started = Date.now();
  a.write({ method: "session/cancel", params: { sessionId } });
  const answer = await answered;
  a.stop();
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(a.seen[answer].result, { stopReason: "cancelled" });
  assert.ok(!a.seen.some((m) => m.params?.update?.content?.text === "after"));
});

test("session/load in a new process replays the prompts and updates in order before its answer", async (t) => {
  const cwd = freshCwd();
  const a = await newSession(t, cwd);
  await prompt(a, "first");
  await a.waitFor((m) => m.params?.update?.messageId === "m2");
  const answered = prompt(a, "second");
  const ask = a.seen[await a.waitFor((m) => m.method === "session/request_permission")];
  a.write({ id: ask.id, result: { outcome: { outcome: "selected", optionId: "allow" } } });
  await answered;
  a.stop();

  const b = start(t, cwd);
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

test("a scenario's load option holds the load's answer back and makes it an error, after the replay", async (t) => {
  const cwd = freshCwd();
  const a = await newSession(t, cwd);
  await prompt(a, "first");
  await a.waitFor((m) => m.params?.update?.messageId === "m2");
  a.stop();

  const b = start(t, cwd, failingLoad);
  await b.request("initialize", { protocolVersion: 1 });
  const from = b.seen.length;
  const started = Date.now();
  const loaded = await b.request("session/load", { sessionId: a.sessionId, cwd, mcpServers: [] });
  b.stop();
  assert.ok(Date.now() - started >= 140); // the delay is 150 ms; a margin for the two processes' clocks
  assert.equal(b.seen[loaded].error?.message, "no luck");
  assert.equal(b.updates(from, loaded).length, 4); // the prompt and its three updates
});

test("the agent records the instructions it was started with", async (t) => {
  const cwd = freshCwd();
  const folder = path.join(tmp, "instructions-1");
  mkdirSync(path.join(folder, ".github", "instructions"), { recursive: true });
  writeFileSync(path.join(folder, ".github", "instructions", "a.instructions.md"), "R1");
  writeFileSync(path.join(folder, ".github", "instructions", "notes.md"), "not an instructions file");
  const missing = path.join(tmp, "no-such-folder");
  const env = { COPILOT_CUSTOM_INSTRUCTIONS_DIRS: `${missing},${folder}` };
  const starts = () => JSON.parse(readFileSync(path.join(cwd, ".scripted-agent.json"), "utf8")).starts;

  const a = start(t, cwd, scenario, env);
  await a.request("initialize", { protocolVersion: 1 });
  const sessionId = a.seen[await a.request("session/new", { cwd, mcpServers: [] })].result.sessionId;
  await a.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "first" }] }); // a save keeps the starts
  a.stop();
  assert.deepEqual(starts(), [{ instructions: ["R1"] }]);

  const b = start(t, cwd, scenario, { COPILOT_CUSTOM_INSTRUCTIONS_DIRS: "" });
  await b.request("initialize", { protocolVersion: 1 });
  const loaded = await b.request("session/load", { sessionId, cwd, mcpServers: [] });
  b.stop();
  assert.ok(!b.seen[loaded].error);
  assert.deepEqual(starts(), [{ instructions: ["R1"] }, { instructions: [] }]);
});

test("session/load takes the session id it is asked for", async (t) => {
  const cwd = freshCwd();
  const a = await newSession(t, cwd);
  await prompt(a, "first");
  a.stop();
  const b = start(t, cwd);
  await b.request("initialize", { protocolVersion: 1 });
  const from = b.seen.length;
  const loaded = await b.request("session/load", { sessionId: "forked-id", cwd, mcpServers: [] });
  b.stop();
  assert.ok(!b.seen[loaded].error);
  const ids = new Set(b.updates(from, loaded).map((p) => p.sessionId));
  assert.deepEqual([...ids], ["forked-id"]);
});

test("a checkpoint step writes a usage checkpoint", async (t) => {
  const cwd = freshCwd();
  const home = path.join(tmp, `copilot-home-${dirs}`);
  const steps = path.join(tmp, "checkpoint.mjs");
  const play = [{ checkpoint: { ttlMs: 9000, model: "claude-opus-5.5" } }, { end: "end_turn" }];
  writeFileSync(steps, `export default { prompts: ${JSON.stringify([play, play])} };\n`);
  const a = start(t, cwd, steps, { COPILOT_HOME: home });
  await a.request("initialize", { protocolVersion: 1 });
  const sessionId = a.seen[await a.request("session/new", { cwd, mcpServers: [] })].result.sessionId;
  const ask = (t) => a.request("session/prompt", { sessionId, prompt: [{ type: "text", text: t }] });
  const before = Date.now();
  await ask("first");
  const after = Date.now();
  await ask("second");
  a.stop();
  const lines = readFileSync(path.join(home, "session-state", sessionId, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((e) => e.type), ["session.start", "user.message", "session.usage_checkpoint", "user.message", "session.usage_checkpoint"]);
  assert.deepEqual(lines.filter((e) => e.type === "user.message").map((e) => e.data.content), ["first", "second"]);
  const [first, last] = lines.filter((e) => e.type === "session.usage_checkpoint");
  assert.equal(lines.at(-1), last);
  assert.notEqual(first.id, last.id, "every checkpoint has a fresh id");
  const [state] = first.data.modelCacheState;
  assert.equal(first.data.modelCacheState.length, 1);
  assert.equal(state.modelId, "claude-opus-5.5");
  assert.equal(state.cacheTtlSeconds, 9);
  const expires = Date.parse(state.cacheExpiresAt);
  assert.ok(expires >= before + 9000 && expires <= after + 9000, `expires ${expires - before} ms after the prompt`);
  assert.ok(Math.abs(Date.parse(first.timestamp) + 9000 - expires) < 5, "about 9 s after the step ran");
});

test("prompts as a function plays the steps it returns for each prompt's text and index", async (t) => {
  const cwd = freshCwd();
  const byText = path.join(tmp, "by-text.mjs");
  writeFileSync(
    byText,
    `export default { prompts: (text, n) => [{ u: { sessionUpdate: "agent_message_chunk", messageId: "f" + n, content: { type: "text", text: n + ":" + text } } }, { end: "end_turn" }] };\n`,
  );
  const a = start(t, cwd, byText);
  await a.request("initialize", { protocolVersion: 1 });
  const sessionId = a.seen[await a.request("session/new", { cwd, mcpServers: [] })].result.sessionId;
  const from = a.seen.length;
  await a.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "first" }] });
  await a.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "second" }] });
  a.stop();
  assert.deepEqual(a.updates(from).map((p) => p.update), [text("f0", "0:first"), text("f1", "1:second")]);
});
