#!/usr/bin/env node
// SDK probe: can the Copilot SDK (@microsoft/copilot-sdk) replace `copilot --acp --stdio` in copilot-relay?
//
// Run it on the machine and in the repository the app is used with (see README.md):
//   npm install && node probe.mjs --cwd C:\path\to\company\repo
//
// It writes results/<time>/report.md (summary), report.json (everything) and events/*.jsonl (event samples).
// Scenarios marked [llm] send prompts and cost model requests; --no-llm runs only the free ones.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { cleanText, errorInfo, resolveCli, sanitize, withTimeout } from "./lib.mjs";
import { G, Skip, eventLines, runtimeFor } from "./core.mjs";
import { freeScenarios } from "./scenarios-free.mjs";
import { llmScenarios } from "./scenarios-llm.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// discovery runs before the inventory, so the inventory session already uses the best discovery options
const ORDER = ["env", "acp-baseline", "runtime-variants", "discovery", "inventory", "sessions", "models", "modes", "turn", "agents", "prompts", "permissions", "mcp", "abort", "queue", "resume", "history", "attachments", "subagents", "ask-user", "crash", "cleanup"];
const ALL = [...freeScenarios, ...llmScenarios].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));

const HELP = `SDK probe for copilot-relay

  node probe.mjs [options]

  --cwd <dir>           repository to open sessions in (default: current directory). Use the company repository:
                        company agents, instructions and MCP servers are discovered from it. It is never changed.
  --cli <path>          Copilot CLI to test (default: COPILOT_CLI_PATH, COPILOT_PATH, then "copilot" on PATH)
  --runtime <variant>   runtime the scenarios use: auto (default), cli, script, bundled
  --agent <name>        company agent to select in the "agents" scenario (default: the first one found)
  --model <id>          model for all turns (default: the session's default model)
  --no-llm              skip the scenarios that send prompts
  --only <ids>          run only these scenarios (comma separated)
  --skip <ids>          skip these scenarios
  --keep                keep the probe's sessions and temporary folders
  --out <dir>           where to write the results (default: ./results/<time>)
  --turn-timeout <s>    seconds to wait for one turn (default: 180)
  --list                list the scenarios and exit

Scenarios:
${ALL.map((x) => `  ${x.id.padEnd(17)}${x.llm ? "[llm] " : "      "}${x.title}`).join("\n")}
`;

const { values: opt } = parseArgs({
  options: {
    cwd: { type: "string" },
    cli: { type: "string" },
    runtime: { type: "string", default: "auto" },
    agent: { type: "string" },
    model: { type: "string" },
    "no-llm": { type: "boolean", default: false },
    only: { type: "string" },
    skip: { type: "string" },
    keep: { type: "boolean", default: false },
    out: { type: "string" },
    "turn-timeout": { type: "string", default: "180" },
    list: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
    "variant-check": { type: "string" },
  },
});

if (!["auto", "cli", "script", "bundled"].includes(opt.runtime)) {
  console.error(`--runtime must be one of: auto, cli, script, bundled (got "${opt.runtime}")`);
  process.exit(2);
}
if (opt.help || opt.list) {
  console.log(HELP);
  process.exit(0);
}

let sdk;
try {
  sdk = await import("@microsoft/copilot-sdk");
} catch (e) {
  console.error(`Cannot load @microsoft/copilot-sdk: ${e.message}\nRun "npm install" in ${here} first.`);
  process.exit(2);
}
G.sdk = sdk;
G.sdkProtocolVersion = null;
try {
  const mod = await import(new URL("./node_modules/@microsoft/copilot-sdk/dist/sdkProtocolVersion.js", import.meta.url));
  G.sdkProtocolVersion = mod.getSdkProtocolVersion?.() ?? mod.SDK_PROTOCOL_VERSION ?? null;
} catch {}
G.cli = resolveCli(opt.cli);
G.opt = { ...opt, turnTimeout: Math.max(30, Number(opt["turn-timeout"]) || 180) * 1000 };

// ---------------------------------------------------------------------------------------------------------------
// Child mode: start one runtime variant, report, exit. Runs in its own process so a crash stays contained.

if (opt["variant-check"]) {
  const name = opt["variant-check"];
  const out = { ok: false, variant: name };
  let client;
  try {
    client = new sdk.CopilotClient({ mode: "coding-agent", runtime: runtimeFor(name) });
    const t0 = Date.now();
    await withTimeout(client.start(), 80_000, "client.start()");
    out.startMs = Date.now() - t0;
    out.ping = sanitize(await withTimeout(client.ping("probe"), 20_000, "ping"), { depth: 2 });
    out.status = sanitize(await withTimeout(client.getStatus(), 20_000, "getStatus"), { depth: 3 });
    const auth = await withTimeout(client.getAuthStatus(), 30_000, "getAuthStatus");
    out.auth = { isAuthenticated: auth?.isAuthenticated, authType: auth?.authType, host: auth?.host, hasLogin: Boolean(auth?.login), statusMessage: cleanText(auth?.statusMessage ?? "", 160) };
    const models = await withTimeout(client.listModels(), 40_000, "listModels").catch((e) => ({ error: cleanText(e.message, 200) }));
    out.models = Array.isArray(models) ? models.map((m) => m.id) : models;
    out.ok = true;
  } catch (e) {
    out.error = errorInfo(e);
  }
  try {
    if (client) await withTimeout(client.stop(), 20_000, "client.stop()");
  } catch {
    await client?.forceStop().catch(() => {});
  }
  console.log(`@@VARIANT@@${JSON.stringify(out)}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------------------------
// Runner

G.cwd = path.resolve(opt.cwd ?? process.cwd());
if (!fs.existsSync(G.cwd) || !fs.statSync(G.cwd).isDirectory()) {
  console.error(`--cwd is not a directory: ${G.cwd}`);
  process.exit(2);
}
G.cwd = fs.realpathSync(G.cwd);
G.tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-sdk-probe-"));
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
const outDir = path.resolve(opt.out ?? path.join(here, "results", stamp));
fs.mkdirSync(path.join(outDir, "events"), { recursive: true });

const only = opt.only ? new Set(opt.only.split(",").map((x) => x.trim())) : null;
const skipIds = new Set((opt.skip ?? "").split(",").map((x) => x.trim()).filter(Boolean));
const unknown = [...(only ?? []), ...skipIds].filter((id) => !ALL.some((x) => x.id === id));
if (unknown.length) {
  console.error(`Unknown scenario: ${unknown.join(", ")}. Use --list.`);
  process.exit(2);
}

const report = {
  meta: { startedAt: new Date().toISOString(), finishedAt: null, cwd: cleanText(G.cwd), options: sanitize({ ...opt, cwd: undefined }), node: process.version, platform: `${process.platform} ${process.arch}` },
  scenarios: [],
};

const MARK = { true: "PASS", false: "FAIL", null: "INFO" };

function markdown() {
  const lines = [];
  lines.push("# Copilot SDK probe", "");
  lines.push(`- Started: ${report.meta.startedAt}`, `- Finished: ${report.meta.finishedAt ?? "(still running or interrupted)"}`, `- Machine: ${report.meta.platform}, Node ${report.meta.node}`, `- Repository under test: \`${report.meta.cwd}\``);
  const env = report.scenarios.find((x) => x.id === "env")?.data;
  if (env) lines.push(`- SDK: ${env.sdk?.name} ${env.sdk?.version} (bundled runtime ${env.sdk?.bundledCliVersion}), installed CLI: ${env.cliVersion?.text ?? env.cliVersion?.error ?? "?"}`);
  const variants = report.scenarios.find((x) => x.id === "runtime-variants")?.data;
  if (variants) lines.push(`- Runtime used by the scenarios: ${variants.chosen ?? "none"}`);
  lines.push("", "## Scenarios", "", "| Scenario | Result | Time | What it covers |", "|---|---|---|---|");
  for (const x of report.scenarios) lines.push(`| ${x.id} | ${x.status}${x.status === "failed" ? `: ${String(x.error?.message ?? "").replace(/\|/g, "/").slice(0, 140)}` : x.status === "skipped" ? `: ${x.reason}` : ""} | ${(x.ms / 1000).toFixed(1)} s | ${x.title} |`);
  lines.push("", "## Checks", "", "PASS and FAIL are verdicts; INFO is a fact to read, not a verdict.", "", "| Scenario | Check | Result | Details |", "|---|---|---|---|");
  for (const x of report.scenarios) for (const c of x.checks) lines.push(`| ${x.id} | ${c.name.replace(/\|/g, "/")} | ${MARK[String(c.pass)]} | ${String(c.note ?? "").replace(/\|/g, "/").replace(/\n/g, " ")} |`);
  const notes = report.scenarios.flatMap((x) => x.notes.map((n) => `- **${x.id}**: ${n}`));
  if (notes.length) lines.push("", "## Notes", "", ...notes);
  const failed = report.scenarios.filter((x) => x.status === "failed");
  if (failed.length) {
    lines.push("", "## Failed scenarios", "");
    for (const x of failed) lines.push(`- **${x.id}**: ${x.error?.message ?? "?"}${x.error?.stack ? `\n  \`${x.error.stack}\`` : ""}`);
  }
  lines.push("", "Full data: `report.json`. Event samples per scenario: `events/*.jsonl`.", "");
  return lines.join("\n");
}

/** Written after every scenario, so an interrupted run still leaves its results. */
function save() {
  fs.writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "report.md"), markdown());
}

process.on("unhandledRejection", (e) => console.error(`      (unhandled rejection: ${cleanText(e?.message ?? String(e), 200)})`));
process.on("uncaughtException", (e) => console.error(`      (uncaught exception: ${cleanText(e?.message ?? String(e), 200)})`));
let interrupted = false;
process.on("SIGINT", () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  console.error("\nInterrupted: finishing the current scenario, then cleaning up. Press Ctrl+C again to stop at once.");
});

const selected = ALL.filter((x) => (only ? only.has(x.id) : true));
console.log(`Copilot SDK probe\n  repository: ${G.cwd}\n  results:    ${outDir}\n`);

let index = 0;
for (const sc of selected) {
  index++;
  const entry = { id: sc.id, title: sc.title, llm: Boolean(sc.llm), status: "ok", ms: 0, checks: [], notes: [], data: {}, error: null };
  report.scenarios.push(entry);
  const s = {
    data: entry.data,
    check: (name, pass, note = "") => entry.checks.push({ name, pass: pass === null || pass === undefined ? null : Boolean(pass), note: cleanText(note ?? "", 400) }),
    note: (text) => entry.notes.push(cleanText(text, 600)),
    saveEvents: (label, w) => {
      try {
        fs.writeFileSync(path.join(outDir, "events", `${sc.id}-${label}.jsonl`), `${eventLines(w).join("\n")}\n`);
      } catch {}
    },
  };
  let reason = null;
  if (skipIds.has(sc.id)) reason = "--skip";
  else if (sc.llm && opt["no-llm"]) reason = "--no-llm";
  else if (interrupted && sc.id !== "cleanup") reason = "interrupted";
  process.stdout.write(`[${String(index).padStart(2)}/${selected.length}] ${sc.id.padEnd(17)}`);
  const t0 = Date.now();
  if (reason) {
    entry.status = "skipped";
    entry.reason = reason;
  } else {
    process.stdout.write("…\n");
    try {
      await sc.run(s);
    } catch (e) {
      if (e instanceof Skip) {
        entry.status = "skipped";
        entry.reason = e.message;
      } else {
        entry.status = "failed";
        entry.error = errorInfo(e);
      }
    }
  }
  entry.ms = Date.now() - t0;
  entry.data = sanitize(entry.data, { max: 400, depth: 9, items: 80 });
  const fails = entry.checks.filter((c) => c.pass === false).length;
  console.log(`${reason ? "" : "      "}${entry.status}${entry.status === "skipped" ? ` (${entry.reason})` : ""}${entry.status === "failed" ? `: ${entry.error.message}` : ""}${entry.checks.length ? `, checks: ${entry.checks.length - fails} ok, ${fails} failed` : ""} (${(entry.ms / 1000).toFixed(1)} s)`);
  for (const c of entry.checks) console.log(`        ${MARK[String(c.pass)]}  ${c.name}${c.note ? `: ${c.note.slice(0, 150)}` : ""}`);
  save();
}

report.meta.finishedAt = new Date().toISOString();
save();
for (const c of [...G.clients.values(), ...G.extraClients]) await c.forceStop().catch(() => {});
const failedChecks = report.scenarios.flatMap((x) => x.checks).filter((c) => c.pass === false).length;
const failedScenarios = report.scenarios.filter((x) => x.status === "failed").length;
console.log(`\nDone: ${report.scenarios.length} scenarios, ${failedScenarios} failed, ${failedChecks} failed checks.\nReport: ${path.join(outDir, "report.md")}`);
process.exit(0);
