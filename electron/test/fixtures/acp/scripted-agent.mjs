#!/usr/bin/env node
// A scripted ACP agent for the UI checks (scripts/ui-check). SCRIPTED_SCENARIO is the path of a module whose default
// export is { prompts: Step[][] }: the n-th session/prompt of a session plays prompts[n]. Steps:
//   { u: update }        a session/update
//   { perm: toolCall }   a session/request_permission; the next step waits for its answer
//   { wait: ms }         a pause
//   { end: stopReason }  the prompt's answer; the steps after it are played after the answer
// Every prompt (as a user_message_chunk, as Copilot replays it) and every update sent is recorded in
// <cwd>/.scripted-agent.json; session/load sends them again, in order, before its answer. Unknown arguments
// (--acp --stdio, the context tier…) are ignored.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const { prompts = [] } = process.env.SCRIPTED_SCENARIO ? (await import(pathToFileURL(process.env.SCRIPTED_SCENARIO).href)).default : {};

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sessionIdOf = (cwd) => `scripted-${path.basename(cwd)}`;

let session = null; // { id, file, updates }
let nextId = 0;
const answers = new Map(); // id of a request we sent -> resolve

function open(cwd, fresh) {
  const file = path.join(cwd, ".scripted-agent.json");
  const updates = fresh ? [] : JSON.parse(readFileSync(file, "utf8")).updates;
  session = { id: sessionIdOf(cwd), file, updates };
  if (fresh) save();
}
const save = () => writeFileSync(session.file, JSON.stringify({ sessionId: session.id, updates: session.updates }, null, 2));

function update(u, record = true) {
  if (record) {
    session.updates.push(u);
    save();
  }
  send({ method: "session/update", params: { sessionId: session.id, update: u } });
}

function ask(method, params) {
  const id = `scripted-${++nextId}`;
  send({ id, method, params });
  return new Promise((resolve) => answers.set(id, resolve));
}

async function play(rpcId, steps) {
  let answered = false;
  const answer = (stopReason) => {
    if (!answered) send({ id: rpcId, result: { stopReason } });
    answered = true;
  };
  for (const step of steps) {
    if ("u" in step) update(step.u);
    else if ("perm" in step) {
      await ask("session/request_permission", {
        sessionId: session.id,
        toolCall: step.perm,
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
    } else if ("wait" in step) await sleep(step.wait);
    else if ("end" in step) answer(step.end);
  }
  answer("end_turn"); // a script without an end step
}

const handlers = {
  initialize: () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } }),
  "session/list": () => ({ sessions: [] }),
  "session/new": ({ cwd = process.cwd() } = {}) => {
    open(cwd, true);
    return { sessionId: session.id, configOptions: [] };
  },
  "session/load": ({ cwd = process.cwd() } = {}) => {
    open(cwd, false);
    for (const u of session.updates) update(u, false);
    return { configOptions: [] };
  },
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (!msg.method) {
    answers.get(msg.id)?.(msg.result);
    answers.delete(msg.id);
  } else if (msg.method === "session/prompt") {
    const text = (msg.params.prompt ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const n = session.updates.filter((u) => u.sessionUpdate === "user_message_chunk").length;
    session.updates.push({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
    save();
    play(msg.id, prompts[n] ?? []);
  } else if (msg.id != null) {
    try {
      send({ id: msg.id, result: handlers[msg.method]?.(msg.params) ?? null });
    } catch (e) {
      send({ id: msg.id, error: { code: -32603, message: String(e?.message ?? e) } });
    }
  }
});
