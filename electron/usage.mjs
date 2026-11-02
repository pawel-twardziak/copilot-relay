// Reads Copilot CLI usage figures (session credits/tokens, premium quota) from session-state/<id>/events.jsonl
// and formats them for display. Pure Node built-ins, no Electron.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAIL_BYTES = 2 * 1024 * 1024;
const MAX_FULL_READ = 64 * 1024 * 1024;
const QUOTA_FILES = 5;

/** $COPILOT_HOME or ~/.copilot, resolved at call time (same default as history.mjs). */
export function copilotHomeDefault() {
  return process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
}

/** Lines of the file's last 2 MiB, or of the whole file when `whole`; null if unreadable. Never includes a partial first line. */
async function readLines(file, whole) {
  let fh;
  try {
    fh = await fs.open(file, "r");
    const { size } = await fh.stat();
    if (whole && size > MAX_FULL_READ) return null;
    const len = whole ? size : Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const { bytesRead } = await fh.read(buf, got, len - got, size - len + got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    const lines = buf.subarray(0, got).toString("utf8").split("\n");
    if (len < size) lines.shift();
    return { lines, truncated: len < size };
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

/** Parsed events (in file order) whose raw line contains `marker` and satisfies `pick`, scanning backwards; the last one wins. */
function lastMatch(lines, marker, pick) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes(marker)) continue;
    try {
      const e = JSON.parse(line);
      const hit = pick(e);
      if (hit) return { hit, e };
    } catch {
      // half-written or foreign line
    }
  }
  return null;
}

/** Tail scan first; if nothing is found and the file is bigger than the tail, scan the whole file (bounded). */
async function scan(file, marker, pick, { tailOnly = false } = {}) {
  const tail = await readLines(file, false);
  if (!tail) return null;
  const found = lastMatch(tail.lines, marker, pick);
  if (found || !tail.truncated || tailOnly) return found;
  const all = await readLines(file, true);
  return all ? lastMatch(all.lines, marker, pick) : null;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function toSessionUsage(data) {
  const metrics = data.accountingSnapshot?.modelMetrics;
  let tokens = null;
  if (metrics && typeof metrics === "object") {
    tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
    for (const m of Object.values(metrics)) {
      const u = m?.usage ?? {};
      tokens.input += num(u.inputTokens) ?? 0;
      tokens.output += num(u.outputTokens) ?? 0;
      tokens.cacheRead += num(u.cacheReadTokens) ?? 0;
      tokens.cacheWrite += num(u.cacheWriteTokens) ?? 0;
      tokens.reasoning += num(u.reasoningTokens) ?? 0;
    }
  }
  const changes = data.accountingSnapshot?.codeChanges;
  const nano = num(data.totalNanoAiu);
  return {
    aiCredits: nano === null ? null : nano / 1e9,
    premiumRequests: num(data.totalPremiumRequests),
    tokens,
    linesAdded: num(changes?.linesAdded),
    linesRemoved: num(changes?.linesRemoved),
  };
}

/** Usage from the session's last complete session.usage_checkpoint; null if the id is invalid or none exists. */
export async function readSessionUsage(sessionId, { copilotHome } = {}) {
  if (typeof sessionId !== "string" || !UUID.test(sessionId)) return null;
  const file = path.join(copilotHome ?? copilotHomeDefault(), "session-state", sessionId, "events.jsonl");
  const found = await scan(file, '"session.usage_checkpoint"', (e) =>
    e?.type === "session.usage_checkpoint" && e.data && typeof e.data === "object" ? e.data : null,
  );
  return found ? toSessionUsage(found.hit) : null;
}

/** A snapshot is usable if unlimited, or if every displayed field is present (never invent values). */
function validQuota(q) {
  if (!q || typeof q !== "object") return false;
  if (q.isUnlimitedEntitlement === true) return true;
  return (
    num(q.usedRequests) !== null &&
    num(q.entitlementRequests) !== null &&
    num(q.remainingPercentage) !== null &&
    typeof q.resetDate === "string" &&
    q.resetDate !== ""
  );
}

/** Newest premium_interactions quota snapshot from the 5 most recently modified sessions; null if none. */
export async function readQuota({ copilotHome } = {}) {
  const dir = path.join(copilotHome ?? copilotHomeDefault(), "session-state");
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }
  const files = [];
  for (const name of names) {
    const file = path.join(dir, name, "events.jsonl");
    try {
      files.push({ file, mtimeMs: (await fs.stat(file)).mtimeMs });
    } catch {
      // no events file
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let best = null;
  for (const { file } of files.slice(0, QUOTA_FILES)) {
    const found = await scan(file, '"quotaSnapshots"', (e) => {
      const q = e?.data?.quotaSnapshots?.premium_interactions;
      return validQuota(q) ? q : null;
    }, { tailOnly: true });
    if (!found) continue;
    const ts = Date.parse(found.e.timestamp) || 0;
    if (!best || ts > best.ts) best = { ts, q: found.hit };
  }
  if (!best) return null;
  const q = best.q;
  return {
    used: num(q.usedRequests) ?? 0,
    total: num(q.entitlementRequests) ?? 0,
    remainingPct: num(q.remainingPercentage) ?? 0,
    resetDate: typeof q.resetDate === "string" ? q.resetDate : "",
    unlimited: q.isUnlimitedEntitlement === true,
  };
}

/** 999 -> "999", 22899 -> "22.9k", 200000 -> "200k", 1250000 -> "1.25M". */
export function formatTokens(n) {
  if (n < 1000) return String(Math.round(n));
  const trim = (x, d) => x.toFixed(d).replace(/\.?0+$/, "");
  return n < 1e6 ? `${trim(n / 1e3, 1)}k` : `${trim(n / 1e6, 2)}M`;
}

function contextView(context) {
  if (!context || !(context.size > 0) || !(context.used >= 0)) return null;
  const pct = Math.min(100, Math.round((context.used / context.size) * 100));
  return {
    label: `${formatTokens(context.used)} / ${formatTokens(context.size)} · ${pct}%`,
    pct,
    level: pct >= 95 ? "full" : pct >= 80 ? "warn" : "ok",
  };
}

function quotaLine(quota) {
  if (!quota) return null;
  if (quota.unlimited) return "Premium: unlimited";
  const d = new Date(quota.resetDate);
  const reset = Number.isNaN(d.getTime())
    ? ""
    : ` · resets ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`;
  return `Premium: ${quota.used} / ${quota.total} used · ${quota.remainingPct}% left${reset}`;
}

/** Display strings for the context meter, session credits (+ tooltip) and premium quota. */
export function summarize({ context = null, session = null, quota = null } = {}) {
  const parts = [];
  let credits = null;
  if (session) {
    if (session.aiCredits !== null) credits = `${session.aiCredits.toFixed(2)} AI credits`;
    if (session.premiumRequests !== null) parts.push(`Requests: ${session.premiumRequests} premium`);
    const t = session.tokens;
    if (t) {
      parts.push(`Tokens: input ${formatTokens(t.input)}, output ${formatTokens(t.output)}, cached ${formatTokens(t.cacheRead)}`);
    }
    if (session.linesAdded !== null && session.linesRemoved !== null) {
      parts.push(`Changes: +${session.linesAdded} −${session.linesRemoved}`);
    }
  }
  return { context: contextView(context), credits, tooltip: parts.join(" · "), quota: quotaLine(quota) };
}
