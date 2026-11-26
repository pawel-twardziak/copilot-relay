#!/usr/bin/env node
// A scripted ACP agent for the UI checks (scripts/ui-check). SCRIPTED_SCENARIO is the path of a module whose default
// export is { prompts: Step[][] }: the n-th session/prompt of a session plays prompts[n]. prompts may instead be a
// function (text, n) => Step[]: each prompt plays what it returns for the prompt's text and its index n (from 0). Steps:
//   { u: update }        a session/update
//   { perm: toolCall }   a session/request_permission; the next step waits for its answer
//   { wait: ms }         a pause
//   { end: stopReason }  the prompt's answer; the steps after it are played after the answer
//   { checkpoint: { ttlMs, model } }  appends to Copilot's history file of the session
//                        ($COPILOT_HOME/session-state/<session id>/events.jsonl) a session.start line if the file has
//                        none, a user.message with the prompt's text, and a session.usage_checkpoint with a fresh id
//                        whose cache entry for model expires ttlMs from now (for the cache keeper's checks)
//   { relay: "prompt" }  a prompt "adopt_session <name>" or "release_session <name>" calls that tool of the MCP server
//                        named relay (from session/new|load's mcpServers) with { name }; "send_message <to> <text…>"
//                        calls send_message with { to, text } and "report_result <text…>" report_result with { text }.
//                        The prompt is one line, or the last paragraph after a waiting relay notice. The tool's text
//                        reply is sent as an agent message chunk; any other prompt (a relay notice "[from relay]…")
//                        does nothing
//                        "create_session <name> <task…>" calls create_session with { name, task }, and
//                        "create_session_json <json>" calls it with the parsed object
// session/cancel (Stop) ends the running prompt as Copilot does: it answers "cancelled" (if not answered yet) and
// plays none of its remaining steps; a pause or an unanswered permission request it waits on ends at once.
// Every prompt (as a user_message_chunk, as Copilot replays it) and every update sent is recorded in
// <cwd>/.scripted-agent.json; session/load sends them again, in order, before its answer. The scenario's optional
// load: { delay: ms, error: message } holds that answer back for delay ms, and makes it that error (after the replay).
// The session id is scripted-<folder name> (the folder name itself when that is a UUID), or $SCRIPTED_SESSION_ID (a UUID, for checks that need a session Copilot's
// history files can belong to); session/load takes the id it is asked for (a fork's).
// The custom instructions the process was started with (the text, trimmed, of every *.instructions.md in
// <dir>/.github/instructions/ of each dir in $COPILOT_CUSTOM_INSTRUCTIONS_DIRS, as Copilot reads them) are appended
// as { instructions: string[] } to the file's `starts` when the process opens its session (session/new or load; a
// process that opens none, like the app's lister, writes nothing). session/new keeps the starts of the folder's file.
// The scenario's optional uniqueIds: true gives every session/new after the first one in a folder its own id
// (scripted-<folder>-2, …), for a delegated child, which starts in its parent's folder.
// The scenario's optional configOptions: the session's config options (an array, or (cwd) => array for options per
// folder), returned by session/new and session/load; session/set_config_option({ configId, value }) sets that
// option's currentValue and answers { configOptions }. Without it the session has none.
// Unknown arguments (--acp --stdio, the context tier…) are ignored.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const { prompts = [], load = {}, uniqueIds = false, configOptions = [] } = process.env.SCRIPTED_SCENARIO ? (await import(pathToFileURL(process.env.SCRIPTED_SCENARIO).href)).default : {};

// $SCRIPTED_ARGV_FILE: the arguments this process was started with, one JSON line per start (a check reads what
// reached the agent through the command line, the app's --acp --stdio included)
if (process.env.SCRIPTED_ARGV_FILE) appendFileSync(process.env.SCRIPTED_ARGV_FILE, JSON.stringify(process.argv.slice(2)) + "\n");

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sessionIdOf = (cwd) => process.env.SCRIPTED_SESSION_ID || (UUID.test(path.basename(cwd)) ? path.basename(cwd) : `scripted-${path.basename(cwd)}`);

/** The instructions files Copilot would read at this start, in the order of the variable's dirs and by file name. */
function startInstructions() {
  const out = [];
  for (const dir of (process.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS ?? "").split(",").filter(Boolean)) {
    const folder = path.join(dir, ".github", "instructions");
    let names = [];
    try {
      names = readdirSync(folder).filter((n) => n.endsWith(".instructions.md")).sort();
    } catch {} // a dir without instructions
    for (const n of names) out.push(readFileSync(path.join(folder, n), "utf8").trim());
  }
  return out;
}
const started = { instructions: startInstructions() }; // read at start: the folder may be gone at exit

let session = null; // { id, cwd, file, updates, starts, mcpServers, configOptions }
let nextId = 0;
const answers = new Map(); // id of a request we sent -> resolve
let cancelPlaying = () => {}; // session/cancel: ends the prompt being played (play)

function open(cwd, fresh, mcpServers, id = sessionIdOf(cwd)) {
  const file = path.join(cwd, ".scripted-agent.json");
  const kept = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  if (!fresh && !kept) throw new Error(`no session in ${cwd}`);
  const updates = fresh ? [] : kept.updates;
  const starts = Array.isArray(kept?.starts) ? kept.starts : [];
  if (!session) starts.push(started); // once per process: its first session
  const options = typeof configOptions === "function" ? configOptions(cwd) : configOptions;
  session = { id, cwd, file, updates, starts, mcpServers: mcpServers ?? [], configOptions: structuredClone(options ?? []) };
  save();
}
const save = () => writeFileSync(session.file, JSON.stringify({ sessionId: session.id, updates: session.updates, starts: session.starts }, null, 2));

function update(u, record = true) {
  if (record) {
    session.updates.push(u);
    save();
  }
  send({ method: "session/update", params: { sessionId: session.id, update: u } });
}

/** { checkpoint }: what Copilot writes to the session's history file in a turn (see the header). */
function checkpoint({ ttlMs, model }, text) {
  if (!process.env.COPILOT_HOME) throw new Error("scripted agent: a checkpoint step needs $COPILOT_HOME");
  const dir = path.join(process.env.COPILOT_HOME, "session-state", session.id);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "events.jsonl");
  const now = Date.now();
  const event = (type, data) => JSON.stringify({ type, id: randomUUID(), timestamp: new Date(now).toISOString(), data });
  const lines = [];
  if (!existsSync(file) || !readFileSync(file, "utf8").includes('"type":"session.start"')) {
    lines.push(event("session.start", { sessionId: session.id, context: { cwd: session.cwd } }));
  }
  lines.push(event("user.message", { content: text }));
  const cache = { modelId: model, cacheExpiresAt: new Date(now + ttlMs).toISOString(), cacheTtlSeconds: ttlMs / 1000 };
  lines.push(event("session.usage_checkpoint", { modelCacheState: [cache] }));
  appendFileSync(file, lines.join("\n") + "\n");
}

function ask(method, params) {
  const id = `scripted-${++nextId}`;
  send({ id, method, params });
  return new Promise((resolve) => answers.set(id, resolve));
}

/** { relay: "prompt" }: the tool's text reply for a prompt that names a relay tool (see the header), else null. */
async function relayTool(text) {
  // a relay notice that was waiting is put in front of the next prompt ("[from relay]…\n\n<prompt>"): the last paragraph counts
  const m = /(?:^|\n\n)(adopt_session|release_session|send_message|report_result|create_session_json|create_session) ([^\n]*)$/.exec(text);
  if (!m) return null;
  let tool = m[1];
  let args = { name: m[2] };
  if (m[1] === "report_result") args = { text: m[2] };
  if (m[1] === "create_session") {
    const [name, ...rest] = m[2].split(" ");
    args = { name, task: rest.join(" ") };
  }
  if (m[1] === "create_session_json") {
    tool = "create_session";
    try {
      args = JSON.parse(m[2]);
    } catch (e) {
      return `scripted agent: create_session_json: ${e.message}`;
    }
  }
  if (m[1] === "send_message") {
    const [to, ...rest] = m[2].split(" ");
    args = { to, text: rest.join(" ") };
  }
  const server = session.mcpServers.find((s) => s.name === "relay");
  if (!server) return "scripted agent: no MCP server named relay was given";
  // loaded here, so only the scenarios that call a relay tool pay for it
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const mcp = new Client({ name: "scripted-agent", version: "1" });
  try {
    const headers = Object.fromEntries((server.headers ?? []).map((h) => [h.name, h.value]));
    await mcp.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }));
    const r = await mcp.callTool({ name: tool, arguments: args });
    return r.content.filter((c) => c.type === "text").map((c) => c.text).join("");
  } catch (e) {
    return `scripted agent: ${tool} failed: ${e.message}`; // in the chat, so the check that waits for the reply shows it
  } finally {
    await mcp.close().catch(() => {});
  }
}

async function play(rpcId, steps, text) {
  let answered = false;
  const answer = (stopReason) => {
    if (!answered) send({ id: rpcId, result: { stopReason } });
    answered = true;
  };
  let stopped = false;
  const cancelled = new Promise((resolve) => {
    cancelPlaying = () => {
      stopped = true;
      answer("cancelled");
      resolve();
    };
  });
  for (const step of steps) {
    if (stopped) return;
    if ("u" in step) update(step.u);
    else if ("perm" in step) {
      const asked = ask("session/request_permission", {
        sessionId: session.id,
        toolCall: step.perm,
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
      await Promise.race([asked, cancelled]);
    } else if ("relay" in step) {
      const reply = await Promise.race([relayTool(text), cancelled]);
      if (reply && !stopped) update({ sessionUpdate: "agent_message_chunk", messageId: `relay-${session.updates.length}`, content: { type: "text", text: reply } });
    } else if ("wait" in step) await Promise.race([sleep(step.wait), cancelled]);
    else if ("checkpoint" in step) checkpoint(step.checkpoint, text);
    else if ("end" in step) answer(step.end);
  }
  answer("end_turn"); // a script without an end step
}

const handlers = {
  initialize: () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } }),
  "session/list": () => ({ sessions: [] }),
  "session/new": ({ cwd = process.cwd(), mcpServers } = {}) => {
    let id = sessionIdOf(cwd);
    if (uniqueIds && !process.env.SCRIPTED_SESSION_ID) {
      const file = path.join(cwd, ".scripted-agent.json");
      const used = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).starts?.length ?? 0) : 0;
      if (used > 0) id = `${id}-${used + 1}`;
    }
    open(cwd, true, mcpServers, id);
    return { sessionId: session.id, configOptions: session.configOptions };
  },
  "session/load": async ({ sessionId, cwd = process.cwd(), mcpServers } = {}) => {
    open(cwd, false, mcpServers, sessionId || sessionIdOf(cwd));
    for (const u of session.updates) update(u, false);
    if (load.delay) await sleep(load.delay);
    if (load.error) throw new Error(load.error);
    return { configOptions: session.configOptions };
  },
  "session/set_config_option": ({ configId, value } = {}) => {
    const option = session.configOptions.find((o) => o.id === configId);
    if (!option) throw new Error(`no config option ${configId}`);
    option.currentValue = value;
    return { configOptions: session.configOptions };
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
    play(msg.id, (typeof prompts === "function" ? prompts(text, n) : prompts[n]) ?? [], text);
  } else if (msg.method === "session/cancel") cancelPlaying();
  else if (msg.id != null) {
    Promise.resolve()
      .then(() => handlers[msg.method]?.(msg.params))
      .then(
        (result) => send({ id: msg.id, result: result ?? null }),
        (e) => send({ id: msg.id, error: { code: -32603, message: String(e?.message ?? e) } }),
      );
  }
});
