#!/usr/bin/env node
// Prompt-cache TTL and compaction cost, as the Copilot CLI records them.
//
//   node cache-ttl.mjs                      free: scans the session history in COPILOT_HOME, sends nothing
//   node cache-ttl.mjs --live               lists the models the live test can use, sends nothing
//   node cache-ttl.mjs --live --model <id>  two prompts + /compact over ACP in a temporary folder (2 premium requests × the model multiplier)
//
// Options: --sessions <n> (newest sessions scanned, default 300), --cli <path> (Copilot CLI), --keep (keep the test
// session). The report goes to results/cache-ttl-<time>.md (ignored by git). It holds model names, numbers and
// endpoints only: no prompts, no answers, no file names.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Acp, cliVersion, resolveCli, sleep, summarizeConfigOptions, withTimeout } from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const copilotHome = process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
const stateDir = path.join(copilotHome, "session-state");
const out = [];
const say = (line = "") => {
  console.log(line);
  out.push(line);
};

// ---------------------------------------------------------------------------------------------------------------
// Reading events.jsonl

const WANTED = /"type":"(session\.usage_checkpoint|session\.compaction_start|session\.compaction_complete|user\.message|assistant\.turn_start|session\.shutdown)"/;

function readEvents(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const events = [];
  for (const line of text.split("\n")) {
    if (!WANTED.test(line)) continue; // skip the big lines (system prompt, messages) without parsing them
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  return events;
}

/** Facts from one session's events: TTL per model, endpoints, and the cost of each compaction. */
function analyse(events) {
  const ttl = []; // { model, ttl, observed }
  const endpoints = []; // { model, vendor, api_endpoint, marks }
  const compactions = []; // { trigger, model, premiumDelta, aiuDelta, ownAiu, clean }
  let last = null; // last checkpoint
  let open = null; // compaction in progress
  for (const e of events) {
    const d = e.data ?? {};
    if (e.type === "session.usage_checkpoint") {
      for (const m of d.modelCacheState ?? []) {
        const observed = m.cacheExpiresAt && e.timestamp ? Math.round((Date.parse(m.cacheExpiresAt) - Date.parse(e.timestamp)) / 1000) : null;
        ttl.push({ model: m.modelId, ttl: m.cacheTtlSeconds, observed });
      }
      for (const p of d.promptCacheBreakState ?? []) {
        for (const [model, v] of Object.entries(p.models ?? {})) {
          const c = v?.cache_config ?? {};
          endpoints.push({ model, vendor: v?.vendor, api_endpoint: v?.api_endpoint, marks: `system=${c.marks_system_prompt} conversation=${c.marks_conversation}` });
        }
      }
      if (open?.complete) {
        const before = open.before;
        compactions.push({
          ...open.complete,
          premiumDelta: before ? (d.totalPremiumRequests ?? 0) - (before.totalPremiumRequests ?? 0) : null,
          aiuDelta: before ? (d.totalNanoAiu ?? 0) - (before.totalNanoAiu ?? 0) : null,
          clean: open.clean,
        });
        open = null;
      }
      last = d;
    } else if (e.type === "session.compaction_start") {
      open = { before: last, clean: true, complete: null };
    } else if (e.type === "session.compaction_complete") {
      const used = d.compactionTokensUsed ?? {};
      const entry = { trigger: d.trigger ?? "?", model: used.model ?? d.behaviorModelId ?? "?", ownAiu: used.copilotUsage?.totalNanoAiu ?? null, success: d.success };
      if (open) open.complete = entry;
      else compactions.push({ ...entry, premiumDelta: null, aiuDelta: null, clean: false });
    } else if ((e.type === "user.message" || e.type === "assistant.turn_start") && open) {
      open.clean = false; // a turn between the checkpoints: the deltas are not the compaction's alone
    } else if (e.type === "session.shutdown" && open?.complete) {
      const s = d.accountingSnapshot ?? {};
      const before = open.before;
      compactions.push({
        ...open.complete,
        premiumDelta: before ? (s.totalPremiumRequestCost ?? 0) - (before.totalPremiumRequests ?? 0) : null,
        aiuDelta: before ? (s.totalNanoAiu ?? 0) - (before.totalNanoAiu ?? 0) : null,
        clean: open.clean,
      });
      open = null;
    }
  }
  if (open?.complete) compactions.push({ ...open.complete, premiumDelta: null, aiuDelta: null, clean: false });
  return { ttl, endpoints, compactions };
}

const count = (items, key) => {
  const m = new Map();
  for (const i of items) {
    const k = key(i);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

function report(results, title) {
  const ttl = results.flatMap((r) => r.ttl);
  const endpoints = results.flatMap((r) => r.endpoints);
  const compactions = results.flatMap((r) => r.compactions);

  say(`## ${title}`);
  say();
  say("### Cache TTL per model (session.usage_checkpoint → modelCacheState)");
  say();
  if (!ttl.length) say("No checkpoint with modelCacheState found (the CLI version may not record it).");
  else {
    say("| model | cacheTtlSeconds | expiresAt − checkpoint time (s) | checkpoints |");
    say("|---|---|---|---|");
    for (const [k, n] of count(ttl, (t) => `${t.model}|${t.ttl}`)) {
      const [model, t] = k.split("|");
      const obs = ttl.filter((x) => x.model === model && String(x.ttl) === t && x.observed != null).map((x) => x.observed);
      const range = obs.length ? `${Math.min(...obs)}–${Math.max(...obs)}` : "–";
      say(`| ${model} | ${t} | ${range} | ${n} |`);
    }
  }
  say();
  say("### Where the requests go (promptCacheBreakState)");
  say();
  if (!endpoints.length) say("None recorded.");
  else {
    say("| model | vendor | api_endpoint | cache marks | checkpoints |");
    say("|---|---|---|---|---|");
    for (const [k, n] of count(endpoints, (e) => `${e.model}|${e.vendor}|${e.api_endpoint}|${e.marks}`)) say(`| ${k.split("|").join(" | ")} | ${n} |`);
  }
  say();
  say("### Compactions (premium requests and AI units around each one)");
  say();
  if (!compactions.length) say("No compaction found.");
  else {
    say("| trigger | model | success | premium Δ | nano-AIU Δ | nano-AIU of the call | no turn in between |");
    say("|---|---|---|---|---|---|---|");
    for (const c of compactions.slice(0, 40)) {
      say(`| ${c.trigger} | ${c.model} | ${c.success} | ${c.premiumDelta ?? "?"} | ${c.aiuDelta ?? "?"} | ${c.ownAiu ?? "?"} | ${c.clean ? "yes" : "no"} |`);
    }
    if (compactions.length > 40) say(`… and ${compactions.length - 40} more`);
    const clean = compactions.filter((c) => c.clean && c.premiumDelta != null);
    say();
    say(`Compactions with no turn in between: ${clean.length}; with premium Δ > 0: ${clean.filter((c) => c.premiumDelta > 0).length}.`);
  }
  say();
}

// ---------------------------------------------------------------------------------------------------------------
// Free scan

function scan() {
  const limit = Number(value("sessions", "300"));
  let dirs = [];
  try {
    dirs = fs.readdirSync(stateDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(stateDir, d.name, "events.jsonl")).filter((f) => fs.existsSync(f));
  } catch (e) {
    say(`Cannot read ${stateDir}: ${e.message}`);
    return;
  }
  dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const picked = dirs.slice(0, limit);
  const results = picked.map((f) => analyse(readEvents(f)));
  report(results, `Session history: ${picked.length} of ${dirs.length} sessions in ${stateDir}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Live test over ACP

async function live() {
  const cli = resolveCli(value("cli"));
  const model = value("model");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-relay-cache-ttl-"));
  const acp = new Acp({ command: cli.command, cwd: ws });
  let sessionId = null;
  try {
    await withTimeout(acp.start(), 60_000, "ACP initialize");
    const res = await withTimeout(acp.request("session/new", { cwd: ws, mcpServers: [] }), 90_000, "ACP session/new");
    sessionId = res?.sessionId;
    await sleep(3000); // config_option_update and available_commands_update arrive after the answer
    let options = summarizeConfigOptions(res?.configOptions);
    for (const n of acp.notifications) {
      const u = n.params?.update;
      if (u?.sessionUpdate === "config_option_update" && Array.isArray(u.configOptions)) options = summarizeConfigOptions(u.configOptions);
    }
    const modelOpt = options.find((o) => /model/i.test(`${o.id} ${o.category ?? ""}`)) ?? options.find((o) => /model/i.test(o.name ?? ""));
    const commands = acp.notifications.map((n) => n.params?.update).filter((u) => u?.sessionUpdate === "available_commands_update").at(-1)?.availableCommands ?? [];
    say("## Live test over ACP");
    say();
    say(`CLI: ${cli.command} (${cliVersion(cli.command).text ?? "?"})`);
    say(`/compact offered by ACP: ${commands.some((c) => c.name === "compact") ? "yes" : "no"}`);
    if (!model) {
      say();
      say("Models (pass one with --model <id>; pick a Claude model to see its TTL):");
      const seen = new Set();
      for (const v of (modelOpt?.values ?? []).filter((v) => !seen.has(v.value) && seen.add(v.value))) say(`- ${v.value}${v.name && v.name !== v.value ? ` (${v.name})` : ""}`);
      return;
    }
    if (!modelOpt) throw new Error("ACP offers no model option");
    if (!modelOpt.values.some((v) => v.value === model)) throw new Error(`unknown model ${model}; run with --live alone to list them`);
    await withTimeout(acp.request("session/set_config_option", { sessionId, configId: modelOpt.id, value: model }), 30_000, "set model");
    say(`Model: ${model}`);

    const prompt = async (text) => {
      const from = acp.notifications.length;
      const r = await withTimeout(acp.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }), 300_000, `prompt ${text}`);
      const said = acp.notifications.slice(from).map((n) => n.params?.update).filter((u) => u?.sessionUpdate === "agent_message_chunk").map((u) => u.content?.text ?? "").join("");
      return { stop: r?.stopReason, said };
    };
    // the second turn reads the cache of the first: only then does the CLI reliably record modelCacheState
    for (const word of ["alpha", "beta"]) {
      const t = await prompt(`Reply with the single word: ${word}`);
      say(`Turn ${word}: stop=${t.stop}`);
    }
    const t0 = Date.now();
    const t2 = await prompt("/compact");
    say(`/compact: stop=${t2.stop}, ${Date.now() - t0} ms, answer: ${JSON.stringify(t2.said.slice(0, 200))}`);
  } finally {
    await acp.kill();
    await sleep(2000); // the CLI writes compaction_complete and shutdown on the way out
  }
  if (!sessionId || !model) return cleanup(ws, null);
  const dir = path.join(stateDir, sessionId);
  say();
  report([analyse(readEvents(path.join(dir, "events.jsonl")))], `Test session ${sessionId}`);
  cleanup(ws, flag("keep") ? null : dir);
}

function cleanup(ws, sessionDir) {
  for (const d of [ws, sessionDir].filter(Boolean)) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch (e) {
      say(`Could not remove ${d}: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------

say(`# Cache TTL probe (${new Date().toISOString()}, ${process.platform})`);
say();
try {
  if (flag("live")) await live();
  else scan();
} catch (e) {
  say(`ERROR: ${e?.message ?? e}`);
  process.exitCode = 1;
}
const dir = path.join(here, "results");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `cache-ttl-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
fs.writeFileSync(file, `${out.join("\n")}\n`);
console.log(`\nDone: ${file}`);
