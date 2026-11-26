#!/usr/bin/env node
// Context meter on load: the figure the app shows when it reopens a session, against what the first turn after
// the reopen really sent.
//
//   node context-on-load.mjs                  free: scans the newest 100 sessions in COPILOT_HOME, sends nothing
//   node context-on-load.mjs <id> [<id>...]   free: only these sessions, every run in detail
//
// Options: --sessions <n> (newest sessions scanned, default 100), --threshold <pct> (difference counted as a
// mismatch, default 20), --all (details of every scanned session, not only the mismatches).
//
// The app figure comes from readLastContext (electron/usage.mjs), the function the app itself calls, run on the
// events.jsonl as it stood just before each reopen. The live figure is the inputTokens of the first model call of
// the reopened run. The report goes to results/context-on-load-<time>.md (ignored by git). It holds event types,
// model names, times and token counts only: no prompts, no answers, no summaries, no file names.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLastContext } from "../../electron/usage.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const copilotHome = process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
const stateDir = path.join(copilotHome, "session-state");
const threshold = Number(value("threshold", "20")) / 100;
const out = [];
const say = (line = "") => {
  console.log(line);
  out.push(line);
};
const k = (n) => (typeof n === "number" ? (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)) : "—");
const time = (t) => (t ? String(t).replace("T", " ").slice(0, 19) : "—");

// ---------------------------------------------------------------------------------------------------------------
// Reading events.jsonl: only the fields named here leave this function.

const TYPES = new Set([
  "session.start",
  "session.resume",
  "session.shutdown",
  "session.usage_record",
  "session.model_change",
  "session.compaction_start",
  "session.compaction_summarized",
  "session.compaction_complete",
  "session.truncation",
  "session.context_cleared",
  "session.error",
  "user.message",
]);

function pick(e, sessionId) {
  const d = e.data ?? {};
  const base = { type: e.type, ts: e.timestamp };
  switch (e.type) {
    case "session.start":
    case "session.resume":
      return { ...base, model: d.selectedModel, tier: d.contextTier ?? undefined, wasActive: d.sessionWasActive };
    case "session.shutdown":
      return {
        ...base,
        cur: d.currentTokens,
        sys: d.systemTokens,
        conv: d.conversationTokens,
        tools: d.toolDefinitionsTokens,
        kind: d.shutdownType,
        model: d.currentModel,
      };
    case "session.usage_record": {
      const u = d.usage ?? {};
      const src = u.accounting?.sourceSessionId;
      return {
        ...base,
        in: u.inputTokens,
        max: u.maxPromptTokens,
        model: u.model,
        what: u.interactionType,
        initiator: u.initiator,
        tools: u.toolTokenCount,
        sub: src && src !== sessionId ? true : undefined,
      };
    }
    case "session.model_change":
      return { ...base, from: d.previousModel, to: d.newModel ?? d.model };
    case "session.compaction_start":
      return { ...base, trigger: d.trigger, cur: d.currentTokens, limit: d.tokenLimit };
    case "session.compaction_summarized":
      return { ...base, ok: d.success, applyPending: d.applyPending, outcome: d.outcome };
    case "session.compaction_complete":
      return {
        ...base,
        ok: d.success,
        trigger: d.trigger,
        pre: d.preCompactionTokens,
        post: d.postCompactionTokens,
        outcome: d.outcome,
      };
    case "session.truncation":
      return {
        ...base,
        pre: d.preTruncationTokensInMessages,
        post: d.postTruncationTokensInMessages,
        removed: d.messagesRemovedDuringTruncation,
        by: d.performedBy,
      };
    case "session.context_cleared":
      return { ...base, cleared: d.messagesCleared };
    case "session.error":
      return { ...base, kind: d.errorType };
    case "user.message":
      return base;
  }
  return null;
}

/** Lines of the file, and the events of interest with the index of their line. */
function readSession(sessionId) {
  const file = path.join(stateDir, sessionId, "events.jsonl");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  const events = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('"type":"session.') && !line.includes('"type":"user.message"')) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!TYPES.has(e?.type)) continue;
    const p = pick(e, sessionId);
    if (p) events.push({ ...p, line: i });
  }
  return { file, lines, events };
}

/** Runs: each starts at session.start or session.resume. Events before the first one form run 0 ("before"). */
function splitRuns(events) {
  const runs = [];
  let cur = { kind: "before", events: [], line: 0 };
  for (const e of events) {
    if (e.type === "session.start" || e.type === "session.resume") {
      if (cur.events.length || cur.kind !== "before") runs.push(cur);
      cur = { kind: e.type.slice(8), ts: e.ts, model: e.model, tier: e.tier, line: e.line, events: [] };
      continue;
    }
    cur.events.push(e);
  }
  runs.push(cur);
  return runs;
}

// ---------------------------------------------------------------------------------------------------------------
// The app figure at a reopen: readLastContext on the file as it stood before the reopen's first line.

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "context-on-load-"));

async function appFigureBefore(sessionId, lines, lineIndex) {
  const dir = path.join(tmpHome, "session-state", sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "events.jsonl"), lines.slice(0, lineIndex).join("\n") + "\n");
  return readLastContext(sessionId, { copilotHome: tmpHome });
}

function firstMainCall(run) {
  return run.events.find((e) => e.type === "session.usage_record" && !e.sub && !/compact|summar/i.test(e.what ?? ""));
}

/** Events of the run before its first main model call: what could have changed the context since the shutdown. */
function before(run, call) {
  const stop = call ? call.line : Infinity;
  const skip = new Set(["user.message", "session.usage_record", "session.shutdown"]);
  return run.events.filter((e) => e.line < stop && !skip.has(e.type));
}

/** Events of a run after its last main model call: compaction or truncation left pending at the shutdown. */
function tail(run) {
  const calls = run.events.filter((e) => e.type === "session.usage_record" && !e.sub);
  const last = calls.at(-1);
  if (!last) return [];
  return run.events.filter(
    (e) => e.line > last.line && e.type !== "user.message" && e.type !== "session.usage_record" && e.type !== "session.shutdown",
  );
}

function describe(e) {
  switch (e.type) {
    case "session.shutdown":
      return `shutdown ${e.kind ?? "?"} cur=${k(e.cur)} (sys ${k(e.sys)} + conv ${k(e.conv)} + tools ${k(e.tools)}) model=${e.model ?? "—"}`;
    case "session.usage_record":
      return `call ${e.what ?? "?"}${e.sub ? " (sub-agent)" : ""} in=${k(e.in)} max=${k(e.max)} tools=${k(e.tools)} model=${e.model ?? "—"}`;
    case "session.model_change":
      return `model_change ${e.from ?? "?"} → ${e.to ?? "?"}`;
    case "session.compaction_start":
      return `compaction_start trigger=${e.trigger ?? "?"} cur=${k(e.cur)} limit=${k(e.limit)}`;
    case "session.compaction_summarized":
      return `compaction_summarized ok=${e.ok} applyPending=${e.applyPending} outcome=${e.outcome ?? "—"}`;
    case "session.compaction_complete":
      return `compaction_complete ok=${e.ok} trigger=${e.trigger ?? "?"} pre=${k(e.pre)} post=${k(e.post)} outcome=${e.outcome ?? "—"}`;
    case "session.truncation":
      return `truncation ${e.by ?? "?"} messages ${k(e.pre)} → ${k(e.post)} (removed ${e.removed ?? "?"})`;
    case "session.context_cleared":
      return `context_cleared messages=${e.cleared ?? "?"}`;
    case "session.error":
      return `error ${e.kind ?? "?"}`;
    case "user.message":
      return "user.message";
  }
  return e.type;
}

// ---------------------------------------------------------------------------------------------------------------

async function analyse(sessionId) {
  const s = readSession(sessionId);
  if (!s) return null;
  const runs = splitRuns(s.events);
  const reopens = [];
  for (let i = 1; i < runs.length; i++) {
    const run = runs[i];
    if (run.kind !== "resume") continue;
    const shown = await appFigureBefore(sessionId, s.lines, run.line);
    const call = firstMainCall(run);
    const live = call ? { used: call.in, size: call.max } : null;
    const diff = shown && live?.used ? (shown.used - live.used) / live.used : null;
    reopens.push({
      run: i,
      ts: run.ts,
      shown,
      live,
      diff,
      mismatch: diff !== null && Math.abs(diff) > threshold,
      sizeDiffers: shown && live?.size && shown.size !== live.size,
      between: [...tail(runs[i - 1]), ...before(run, call)],
    });
  }
  const now = await readLastContext(sessionId, { copilotHome });
  const counts = {};
  for (const e of s.events) if (/compaction|truncation|context_cleared/.test(e.type)) counts[e.type] = (counts[e.type] ?? 0) + 1;
  return { sessionId, runs, reopens, now, counts, size: fs.statSync(s.file).size };
}

function printDetail(a) {
  say(`### ${a.sessionId}`);
  say("");
  say(`events.jsonl ${k(a.size)} B, runs ${a.runs.length}, app would show now: ${a.now ? `${k(a.now.used)} / ${k(a.now.size)}` : "—"}`);
  say("");
  for (const r of a.reopens) {
    const shown = r.shown ? `${k(r.shown.used)} / ${k(r.shown.size)}` : "—";
    const live = r.live ? `${k(r.live.used)} / ${k(r.live.size)}` : "no turn";
    const d = r.diff === null ? "" : ` (${r.diff > 0 ? "+" : ""}${Math.round(r.diff * 100)}%)`;
    say(`- reopen run ${r.run} at ${time(r.ts)}: app showed ${shown}, first turn sent ${live}${d}${r.mismatch ? " **MISMATCH**" : ""}${r.sizeDiffers ? " **SIZE DIFFERS**" : ""}`);
    for (const e of r.between) say(`  - between: ${time(e.ts)} ${describe(e)}`);
  }
  say("");
  say("Runs:");
  say("");
  say("```");
  a.runs.forEach((run, i) => {
    say(`run ${i} ${run.kind} ${time(run.ts)} model=${run.model ?? "—"}${run.tier ? ` tier=${JSON.stringify(run.tier)}` : ""}`);
    let turns = 0;
    for (const e of run.events) {
      if (e.type === "user.message") {
        turns++;
        continue;
      }
      say(`  ${time(e.ts)} ${describe(e)}`);
    }
    say(`  (${turns} user messages)`);
  });
  say("```");
  say("");
}

async function main() {
  const ids = argv.filter((a) => ID.test(a));
  let targets = ids;
  if (!ids.length) {
    const limit = Number(value("sessions", "100"));
    let names = [];
    try {
      names = fs.readdirSync(stateDir).filter((n) => ID.test(n));
    } catch {
      say(`No session-state folder at ${stateDir}`);
      return;
    }
    targets = names
      .map((n) => {
        try {
          return { n, t: fs.statSync(path.join(stateDir, n, "events.jsonl")).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.t - a.t)
      .slice(0, limit)
      .map((x) => x.n);
  }

  say(`# Context meter on load`);
  say("");
  say(`${new Date().toISOString()} · ${os.platform()} · COPILOT_HOME=${copilotHome} · ${targets.length} sessions · mismatch above ±${Math.round(threshold * 100)}%`);
  say("");

  const all = [];
  for (const id of targets) {
    const a = await analyse(id);
    if (a) all.push(a);
    else if (ids.length) say(`- ${id}: no events.jsonl`);
  }

  say("## Summary");
  say("");
  say("| session | runs | reopens with a turn | mismatches | worst | size differs | compactions / truncations | app shows now |");
  say("|---|---|---|---|---|---|---|---|");
  for (const a of all) {
    const checked = a.reopens.filter((r) => r.shown && r.live);
    if (!checked.length && !ids.length && !flag("all") && !Object.keys(a.counts).length) continue;
    const worst = checked.reduce((w, r) => (Math.abs(r.diff) > Math.abs(w ?? 0) ? r.diff : w), null);
    const c = Object.entries(a.counts).map(([t, n]) => `${t.slice(8)}×${n}`).join(", ") || "—";
    say(
      `| ${a.sessionId.slice(0, 8)} | ${a.runs.length} | ${checked.length} | ${checked.filter((r) => r.mismatch).length} | ${worst === null ? "—" : `${worst > 0 ? "+" : ""}${Math.round(worst * 100)}%`} | ${checked.filter((r) => r.sizeDiffers).length} | ${c} | ${a.now ? `${k(a.now.used)} / ${k(a.now.size)}` : "—"} |`,
    );
  }
  say("");

  const detail = all.filter(
    (a) => ids.length || flag("all") || a.reopens.some((r) => r.mismatch || r.sizeDiffers) || Object.keys(a.counts).length,
  );
  say("## Details");
  say("");
  if (!detail.length) say("No mismatches and no compactions in the scanned sessions.");
  for (const a of detail) printDetail(a);

  const dir = path.join(here, "results");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `context-on-load-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  fs.writeFileSync(file, out.join("\n") + "\n");
  console.log(`\nDone: ${file}`);
}

try {
  await main();
} finally {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}
