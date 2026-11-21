#!/usr/bin/env node
// Spike (throwaway): what does `copilot --acp` send over ACP while subagents run?
// Records every raw JSON-RPC line both ways, then writes a structural summary (field names, counts, id links; no
// content) for designing the chat's sub-process UI.
//
//   node scripts/probe-subagents.mjs [--cmd copilot] [--model <id>] [--only 1,2,3,4]
//
// Runs in a fresh temp folder with dummy files only (no project data is read). Output goes to a new folder under
// the home directory, printed at the end; nothing is written to the repo. Share summary.txt; keep raw.jsonl local.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, appendFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const CMD = opt("cmd", process.env.COPILOT_CMD || "copilot");
const MODEL = opt("model", null);
const ONLY = opt("only", null)?.split(",").map(Number);
const PROMPT_TIMEOUT = 8 * 60_000;
const LATE_WAIT = 30_000; // after end of turn: background subagents may still report
const isWin = process.platform === "win32";

const PROMPTS = [
  {
    n: 1,
    name: "sync subagent",
    text:
      "Use your task tool to start ONE subagent (agent type: explore) and wait for its result. Pass model \"auto\" to the task tool if it has a model parameter. Its job: list the files " +
      "in the current folder and read notes.txt. Do not read the files yourself. When it is done, tell me in one " +
      "sentence what it found.",
  },
  {
    n: 2,
    name: "background subagent",
    text:
      "Start ONE subagent (agent type: explore, model \"auto\") in BACKGROUND mode: it should read a.txt and b.txt and summarize them. " +
      "Do not wait for it. Right after starting it, reply with the single word STARTED and end your turn.",
  },
  {
    n: 3,
    name: "follow-up after background",
    text: "Has the background subagent finished? If yes, tell me its result in one sentence; if not, say NOT YET.",
  },
  {
    n: 4,
    name: "two parallel subagents",
    text:
      "Start THREE subagents (agent type: explore, model \"auto\") in BACKGROUND mode at once: they read a.txt, b.txt and notes.txt, " +
      "one file each. Tell each to answer with a numbered list of 15 points (about 300 words) about its file. Then wait " +
      "for all three (sleep about 40 seconds in the shell if needed) and reply with one sentence per subagent.",
  },
];

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(homedir(), `copilot-probe-subagents-${stamp}`);
await mkdir(outDir, { recursive: true });
const RAW = join(outDir, "raw.jsonl");
const SUMMARY = join(outDir, "summary.txt");

const work = await mkdtemp(join(tmpdir(), "probe-subagents-"));
await writeFile(join(work, "notes.txt"), "The quick brown fox. Probe file, nothing important.\n");
await writeFile(join(work, "a.txt"), "Apples are red or green.\n");
await writeFile(join(work, "b.txt"), "Bananas are yellow.\n");

let phase = "init";
const t0 = Date.now();
const raw = (dir, msg) => appendFile(RAW, JSON.stringify({ t: Date.now() - t0, phase, dir, msg }) + "\n");

// --- minimal JSON-RPC over NDJSON (self-contained so every line is logged as is)
function connect() {
  const cmd = isWin && /\s/.test(CMD) && !CMD.startsWith('"') ? `"${CMD}"` : CMD;
  const args = ["--acp", "--stdio", ...(MODEL ? ["--model", MODEL] : [])];
  const proc = spawn(cmd, args, { cwd: work, stdio: ["pipe", "pipe", "pipe"], shell: isWin, windowsHide: true });
  const pending = new Map();
  const listeners = [];
  let nextId = 0;
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
  proc.on("exit", (code) => {
    for (const p of pending.values()) p.reject(new Error(`copilot exited (${code}): ${stderr.slice(-500)}`));
  });
  const send = (obj) => {
    raw("out", obj);
    proc.stdin.write(JSON.stringify(obj) + "\n");
  };
  let buf = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        raw("in-unparsed", line);
        continue;
      }
      raw("in", msg);
      if (msg.id != null && !msg.method) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else p?.resolve(msg.result);
      } else if (msg.method === "session/request_permission") {
        // allow everything (dummy folder); prefer a one-time allow
        const opts = msg.params?.options ?? [];
        const o = opts.find((x) => x.kind === "allow_once") ?? opts.find((x) => x.kind?.startsWith("allow")) ?? opts[0];
        send({ jsonrpc: "2.0", id: msg.id, result: { outcome: o ? { outcome: "selected", optionId: o.optionId } : { outcome: "cancelled" } } });
      } else if (msg.method && msg.id != null) {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not supported: ${msg.method}` } });
      } else if (msg.method) for (const l of listeners) l(msg);
    }
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      send({ jsonrpc: "2.0", id, method, params });
    });
  const init = () =>
    request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "probe-subagents", version: "0.0.1" },
    });
  return { proc, request, init, onNotify: (f) => listeners.push(f), kill: () => proc.kill() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) =>
  Promise.race([p, sleep(ms).then(() => Promise.reject(new Error(`timeout: ${what}`)))]);

const notes = [];
const log = (s) => {
  notes.push(s);
  console.log(s);
};

const c = connect();
let sessionId;
try {
  const init = await c.init();
  log(`initialize ok: agentCapabilities keys = ${Object.keys(init?.agentCapabilities ?? {}).join(", ")}`);
  phase = "session/new";
  const s = await c.request("session/new", { cwd: work, mcpServers: [] });
  sessionId = s.sessionId;
  log(`session/new ok; result keys = ${Object.keys(s).join(", ")}`);

  for (const p of PROMPTS) {
    if (ONLY && !ONLY.includes(p.n)) continue;
    phase = `prompt${p.n}`;
    log(`\n--- prompt ${p.n} (${p.name})`);
    try {
      const r = await withTimeout(
        c.request("session/prompt", { sessionId, prompt: [{ type: "text", text: p.text }] }),
        PROMPT_TIMEOUT,
        `prompt ${p.n}`,
      );
      log(`  stopReason = ${r?.stopReason}`);
    } catch (e) {
      log(`  prompt failed: ${e.message}`);
    }
    phase = `prompt${p.n}-late`;
    await sleep(LATE_WAIT); // updates arriving here came after the turn ended
  }

  // replay: does session/load bring back the subagents' tool calls?
  c.kill();
  await sleep(1500);
  phase = "load";
  const c2 = connect();
  await c2.init();
  try {
    await withTimeout(c2.request("session/load", { sessionId, cwd: work, mcpServers: [] }), 120_000, "session/load");
    log("\nsession/load ok");
  } catch (e) {
    log(`\nsession/load failed: ${e.message}`);
  }
  await sleep(3000);
  c2.kill();
} catch (e) {
  log(`FATAL: ${e.message}`);
  c.kill();
}

// --- structural summary (no message content)
const { readFile } = await import("node:fs/promises");
const lines = (await readFile(RAW, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
const ups = lines.filter((l) => l.dir === "in" && l.msg.method === "session/update").map((l) => ({ ...l, u: l.msg.params?.update ?? {} }));
const out = [...notes, "", "=== session/update per phase and type"];
const byPhase = new Map();
for (const x of ups) {
  const k = `${x.phase} ${x.u.sessionUpdate}`;
  byPhase.set(k, (byPhase.get(k) ?? 0) + 1);
}
for (const [k, n] of byPhase) out.push(`  ${n}\t${k}`);

out.push("", "=== fields seen per update type (top level of update, params, and _meta)");
const fields = new Map();
const add = (k, v) => fields.set(k, new Set([...(fields.get(k) ?? []), ...v]));
for (const x of ups) {
  const t = x.u.sessionUpdate;
  add(`${t} update`, Object.keys(x.u));
  add(`${t} params`, Object.keys(x.msg.params ?? {}));
  if (x.u._meta) add(`${t} update._meta`, Object.keys(x.u._meta));
  if (x.msg.params?._meta) add(`${t} params._meta`, Object.keys(x.msg.params._meta));
  if (x.u.content?._meta) add(`${t} content._meta`, Object.keys(x.u.content._meta));
  if (x.u.rawInput && typeof x.u.rawInput === "object") add(`${t} rawInput`, Object.keys(x.u.rawInput));
}
for (const [k, v] of fields) out.push(`  ${k}: ${[...v].sort().join(", ")}`);

out.push("", "=== tool calls (order of first sight; title truncated)");
const tools = new Map();
for (const x of ups) {
  const u = x.u;
  if (u.sessionUpdate !== "tool_call" && u.sessionUpdate !== "tool_call_update") continue;
  let t = tools.get(u.toolCallId);
  if (!t) tools.set(u.toolCallId, (t = { first: `${x.phase}@${x.t}ms via ${u.sessionUpdate}`, statuses: [], kind: null, title: null, meta: null, last: null }));
  if (u.status) t.statuses.push(u.status);
  t.kind ??= u.kind;
  t.title ??= u.title;
  if (u._meta) t.meta = JSON.stringify(u._meta).slice(0, 300);
  t.last = `${x.phase}@${x.t}ms`;
}
for (const [id, t] of tools)
  out.push(`  ${id}  kind=${t.kind} title=${JSON.stringify((t.title ?? "").slice(0, 60))}\n      first=${t.first} last=${t.last} statuses=${t.statuses.join(">")}${t.meta ? `\n      _meta=${t.meta}` : ""}`);

out.push("", "=== message runs (sequence of update types, consecutive repeats collapsed, with messageId changes)");
for (const ph of [...new Set(ups.map((x) => x.phase))]) {
  const seq = [];
  let prev = null;
  for (const x of ups.filter((y) => y.phase === ph)) {
    const u = x.u;
    const tag = u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update" ? `${u.sessionUpdate}[${String(u.toolCallId).slice(-6)}${u.status ? ":" + u.status : ""}]` : `${u.sessionUpdate}${u.messageId ? `(${String(u.messageId).slice(-6)})` : ""}`;
    if (tag !== prev) seq.push(tag);
    prev = tag;
  }
  out.push(`  [${ph}] ${seq.join(" → ")}`);
}

out.push("", "=== agent_message_chunk / agent_thought_chunk per messageId (chunks, time span, interleaving)");
for (const type of ["agent_message_chunk", "agent_thought_chunk"]) {
  const msgs = new Map();
  let prev = null;
  for (const x of ups.filter((y) => y.u.sessionUpdate === type)) {
    const id = String(x.u.messageId ?? "(none)");
    const m = msgs.get(id) ?? { n: 0, chars: 0, from: x.t, to: x.t, phase: x.phase, switches: 0 };
    m.n++;
    m.chars += x.u.content?.text?.length ?? 0;
    m.to = x.t;
    if (prev !== null && prev !== id) m.switches++;
    prev = id;
    msgs.set(id, m);
  }
  for (const [id, m] of msgs)
    out.push(`  ${type} ${id.slice(-10)} [${m.phase}] chunks=${m.n} chars=${m.chars} t=${m.from}..${m.to}ms entered-from-other-id=${m.switches}`);
}

out.push("", "=== other inbound methods / requests");
const other = new Map();
for (const l of lines.filter((l) => l.dir === "in" && l.msg.method && l.msg.method !== "session/update")) other.set(l.msg.method, (other.get(l.msg.method) ?? 0) + 1);
for (const [k, n] of other) out.push(`  ${n}\t${k}`);

await writeFile(SUMMARY, out.join("\n") + "\n");
console.log(`\nDone.\n  summary (share this): ${SUMMARY}\n  raw (keep local):     ${RAW}\n  dummy cwd:            ${work}`);
process.exit(0);
