#!/usr/bin/env node
// A scripted ACP agent for the UI checks (scripts/ui-check). SCRIPTED_SCENARIO is the path of a module whose default
// export is { prompts: Step[][] }: the n-th session/prompt of a session plays prompts[n]. Steps:
//   { u: update }        a session/update
//   { perm: toolCall }   a session/request_permission; the next step waits for its answer
//   { wait: ms }         a pause
//   { end: stopReason }  the prompt's answer; the steps after it are played after the answer
//   { relay: "prompt" }  a prompt "adopt_session <name>" or "release_session <name>" calls that tool of the MCP server
//                        named relay (from session/new|load's mcpServers) with { name }; "send_message <to> <text…>"
//                        calls send_message with { to, text } and "report_result <text…>" report_result with { text }.
//                        The prompt is one line, or the last paragraph after a waiting relay notice. The tool's text
//                        reply is sent as an agent message chunk; any other prompt (a relay notice "[from relay]…")
//                        does nothing
// session/cancel (Stop) ends the running prompt as Copilot does: it answers "cancelled" (if not answered yet) and
// plays none of its remaining steps; a pause or an unanswered permission request it waits on ends at once.
// Every prompt (as a user_message_chunk, as Copilot replays it) and every update sent is recorded in
// <cwd>/.scripted-agent.json; session/load sends them again, in order, before its answer. The scenario's optional
// load: { delay: ms, error: message } holds that answer back for delay ms, and makes it that error (after the replay).
// The session id is scripted-<folder name>, or $SCRIPTED_SESSION_ID (a UUID, for checks that need a session Copilot's
// history files can belong to); session/load takes the id it is asked for (a fork's).
// The custom instructions the process was started with (the text, trimmed, of every *.instructions.md in
// <dir>/.github/instructions/ of each dir in $COPILOT_CUSTOM_INSTRUCTIONS_DIRS, as Copilot reads them) are appended
// as { instructions: string[] } to the file's `starts` when the process opens its session (session/new or load; a
// process that opens none, like the app's lister, writes nothing). session/new keeps the starts of the folder's file.
// Unknown arguments (--acp --stdio, the context tier…) are ignored.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const { prompts = [], load = {} } = process.env.SCRIPTED_SCENARIO ? (await import(pathToFileURL(process.env.SCRIPTED_SCENARIO).href)).default : {};

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sessionIdOf = (cwd) => process.env.SCRIPTED_SESSION_ID || `scripted-${path.basename(cwd)}`;

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

let session = null; // { id, file, updates, starts, mcpServers }
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
  session = { id, file, updates, starts, mcpServers: mcpServers ?? [] };
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

function ask(method, params) {
  const id = `scripted-${++nextId}`;
  send({ id, method, params });
  return new Promise((resolve) => answers.set(id, resolve));
}

/** { relay: "prompt" }: the tool's text reply for a prompt that names a relay tool (see the header), else null. */
async function relayTool(text) {
  // a relay notice that was waiting is put in front of the next prompt ("[from relay]…\n\n<prompt>"): the last paragraph counts
  const m = /(?:^|\n\n)(adopt_session|release_session|send_message|report_result) ([^\n]*)$/.exec(text);
  if (!m) return null;
  let args = { name: m[2] };
  if (m[1] === "report_result") args = { text: m[2] };
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
    const r = await mcp.callTool({ name: m[1], arguments: args });
    return r.content.filter((c) => c.type === "text").map((c) => c.text).join("");
  } catch (e) {
    return `scripted agent: ${m[1]} failed: ${e.message}`; // in the chat, so the check that waits for the reply shows it
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
    else if ("end" in step) answer(step.end);
  }
  answer("end_turn"); // a script without an end step
}

const handlers = {
  initialize: () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } }),
  "session/list": () => ({ sessions: [] }),
  "session/new": ({ cwd = process.cwd(), mcpServers } = {}) => {
    open(cwd, true, mcpServers);
    return { sessionId: session.id, configOptions: [] };
  },
  "session/load": async ({ sessionId, cwd = process.cwd(), mcpServers } = {}) => {
    open(cwd, false, mcpServers, sessionId || sessionIdOf(cwd));
    for (const u of session.updates) update(u, false);
    if (load.delay) await sleep(load.delay);
    if (load.error) throw new Error(load.error);
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
    play(msg.id, prompts[n] ?? [], text);
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
