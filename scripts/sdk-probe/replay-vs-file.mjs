#!/usr/bin/env node
// Replay versus file: which messages of events.jsonl does `session/load` replay as user_message_chunk /
// agent_message_chunk text? Settles two questions of the content search: are `assistant.message` events with
// `phase: "commentary"` replayed as main-thread agent text, and are messages from before a compaction replayed.
//
//   node replay-vs-file.mjs                 free: the newest 20 sessions in COPILOT_HOME, session/load only
//   node replay-vs-file.mjs <id> [<id>...]  only these sessions (the newest-20 default is then not added)
//
// Options: --sessions <n> (newest sessions, default 20), --fallback-cwd <dir> (cwd for session/load when the
// session's own folder no longer exists; without it such a session is skipped), --make-compacted (first creates a
// session in a temp folder, sends two short prompts and /compact, and includes it: this SENDS PROMPTS, costs AIU).
//
// No prompt is sent unless --make-compacted is given. The report goes to results/replay-vs-file-<time>.md (ignored
// by git) and holds counts and event types only: no message text.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpConnection } from "../../electron/acp.mjs";
import { resolveCommand } from "../../electron/copilot-command.mjs";
import { isKeepAlive } from "../../electron/cache-keeper.mjs";
import { yamlGet } from "../../electron/history.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ids = argv.filter((a, i) => ID.test(a) && !(argv[i - 1] ?? "").startsWith("--"));
const copilotHome = process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
const stateDir = path.join(copilotHome, "session-state");
const { command } = resolveCommand({ envPath: process.env.COPILOT_PATH });
const fallbackCwd = value("fallback-cwd", "");
const out = [];
const say = (line = "") => {
  console.log(line);
  out.push(line);
};
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The messages of events.jsonl a user sees in the main thread: no sub-agent events, no keep-alive prompts.
function readFile(id) {
  const lines = fs.readFileSync(path.join(stateDir, id, "events.jsonl"), "utf8").split("\n");
  const msgs = [];
  let lastCompaction = -1;
  for (const line of lines) {
    if (!line.includes('"user.message"') && !line.includes('"assistant.message"') && !line.includes('"session.compaction_complete"')) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "session.compaction_complete") lastCompaction = msgs.length;
    else if (e.agentId) continue;
    else if (e.type === "user.message" && !isKeepAlive(e.data?.content)) msgs.push({ kind: "user", phase: "-", text: norm(e.data?.content) });
    else if (e.type === "assistant.message") msgs.push({ kind: "agent", phase: e.data?.phase ?? "-", text: norm(e.data?.content) });
  }
  msgs.forEach((m, i) => (m.when = lastCompaction >= 0 && i < lastCompaction ? "before" : "after"));
  return { msgs: msgs.filter((m) => m.text), compacted: lastCompaction >= 0 };
}

// Replayed text, one string per kind (chunks of the same message are concatenated, so containment is tested on the
// whole replayed text of that kind).
async function replay(id, cwd) {
  const conn = new AcpConnection({ command, cwd });
  const text = { user: "", agent: "" };
  conn.on("notification", (_m, p) => {
    const u = p?.update;
    if (u?.content?.type !== "text") return;
    if (u.sessionUpdate === "user_message_chunk") text.user += u.content.text + "\n";
    if (u.sessionUpdate === "agent_message_chunk") text.agent += u.content.text + "\n";
  });
  try {
    await conn.start();
    await conn.request("session/load", { sessionId: id, cwd, mcpServers: [] });
    await wait(500);
  } finally {
    conn.kill();
  }
  return { user: norm(text.user), agent: norm(text.agent) };
}

// --make-compacted: a session in a temp folder, two prompts, /compact, until compaction_complete is in the file.
async function makeCompacted() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "replay-vs-file-"));
  const conn = new AcpConnection({ command, cwd });
  await conn.start();
  const { sessionId } = await conn.request("session/new", { cwd, mcpServers: [] });
  for (const text of ["Say only: ONE", "Say only: TWO", "/compact"]) {
    await conn.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  }
  const file = path.join(stateDir, sessionId, "events.jsonl");
  for (let i = 0; i < 60 && !fs.readFileSync(file, "utf8").includes('"session.compaction_complete"'); i++) await wait(1000);
  conn.kill();
  return sessionId;
}

const list = ids.length
  ? ids
  : fs
      .readdirSync(stateDir)
      .filter((d) => ID.test(d) && fs.existsSync(path.join(stateDir, d, "events.jsonl")))
      .map((d) => ({ d, t: fs.statSync(path.join(stateDir, d, "events.jsonl")).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, Number(value("sessions", "20")))
      .map((x) => x.d);
if (flag("make-compacted")) list.push(await makeCompacted());

say(`# Replay versus events.jsonl (${new Date().toISOString().slice(0, 19)}Z)`);
say(`command: ${command}, COPILOT_HOME: ${copilotHome}, sessions: ${list.length}`);
say();

const total = new Map(); // "kind/phase/when" -> { found, missing }
const skipped = [];
for (const id of list) {
  let ws;
  try {
    ws = fs.readFileSync(path.join(stateDir, id, "workspace.yaml"), "utf8");
  } catch {
    skipped.push(`${id}: no workspace.yaml`);
    continue;
  }
  let cwd = yamlGet(ws, "cwd");
  const own = cwd && fs.existsSync(cwd);
  if (!own) {
    if (!fallbackCwd) {
      skipped.push(`${id}: cwd no longer exists`);
      continue;
    }
    cwd = fallbackCwd;
  }
  const { msgs, compacted } = readFile(id);
  let replayed;
  try {
    replayed = await replay(id, cwd);
  } catch (e) {
    skipped.push(`${id}: session/load failed (${String(e?.message ?? e).slice(0, 80)})`);
    continue;
  }
  const rows = new Map();
  for (const m of msgs) {
    const key = `${m.kind}/${m.phase}/${m.when}`;
    const hit = replayed[m.kind].includes(m.text);
    for (const t of [rows, total]) {
      const r = t.get(key) ?? { found: 0, missing: 0 };
      r[hit ? "found" : "missing"]++;
      t.set(key, r);
    }
  }
  say(`## ${id}${own ? "" : " (fallback cwd)"}${compacted ? " (compacted)" : ""}: ${msgs.length} messages in file`);
  for (const [key, r] of [...rows].sort()) say(`- ${key}: found ${r.found}, not found ${r.missing}`);
  say();
}
say("## Total (kind/phase/before-or-after-compaction)");
for (const [key, r] of [...total].sort()) say(`- ${key}: found ${r.found}, not found ${r.missing}`);
if (skipped.length) {
  say();
  say("## Skipped");
  for (const s of skipped) say(`- ${s}`);
}
const dir = path.join(here, "results");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `replay-vs-file-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.md`);
fs.writeFileSync(file, out.join("\n") + "\n");
console.log(`\nDone: ${file}`);
