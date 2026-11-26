// Reads Copilot CLI usage figures (session credits/tokens, premium quota) from session-state/<id>/events.jsonl
// and formats them for display. Pure Node built-ins, no Electron.
import fs from "node:fs/promises";
import path from "node:path";
import { copilotHome as copilotHomeDefault, isSessionId } from "./history.mjs";

const TAIL_BYTES = 2 * 1024 * 1024;
const MAX_FULL_READ = 64 * 1024 * 1024;
const QUOTA_FILES = 5;

/** Lines of the file's last `tailBytes` (2 MiB), or of the whole file when `whole`; null if unreadable. Never includes a partial first line. */
export async function readLines(file, whole, tailBytes = TAIL_BYTES) {
  let fh;
  try {
    fh = await fs.open(file, "r");
    const { size } = await fh.stat();
    if (whole && size > MAX_FULL_READ) return null;
    const len = whole ? size : Math.min(size, tailBytes);
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

// Per-file memo keyed by size+mtime, so an unchanged events.jsonl (e.g. > 2 MiB with no checkpoint in the
// tail, which forces a whole-file scan) is not re-read on every push.
const usageMemo = new Map(); // file -> { size, mtimeMs, usage }
const USAGE_MEMO_MAX = 50;

/** Usage from the session's last complete session.usage_checkpoint; null if the id is invalid or none exists. */
export async function readSessionUsage(sessionId, { copilotHome } = {}) {
  if (!isSessionId(sessionId)) return null;
  const file = path.join(copilotHome ?? copilotHomeDefault(), "session-state", sessionId, "events.jsonl");
  const st = await fs.stat(file).catch(() => null);
  if (!st) {
    usageMemo.delete(file);
    return null;
  }
  const memo = usageMemo.get(file);
  if (memo && memo.size === st.size && memo.mtimeMs === st.mtimeMs) return memo.usage;
  const found = await scan(file, '"session.usage_checkpoint"', (e) =>
    e?.type === "session.usage_checkpoint" && e.data && typeof e.data === "object" ? e.data : null,
  );
  const usage = found ? toSessionUsage(found.hit) : null;
  usageMemo.delete(file);
  usageMemo.set(file, { size: st.size, mtimeMs: st.mtimeMs, usage });
  if (usageMemo.size > USAGE_MEMO_MAX) usageMemo.delete(usageMemo.keys().next().value);
  return usage;
}

/**
 * Prompt-cache expiry from the session's last usage checkpoint that has a non-empty modelCacheState.
 * With a modelId only that model's entry counts; with none (or "auto") the entry that expires last wins.
 * Null for an invalid id, a missing file, no such checkpoint, no matching entry or an unparsable date.
 */
export async function readCacheExpiry(sessionId, { copilotHome, modelId } = {}) {
  if (!isSessionId(sessionId)) return null;
  const file = path.join(copilotHome ?? copilotHomeDefault(), "session-state", sessionId, "events.jsonl");
  const found = await scan(file, '"session.usage_checkpoint"', (e) =>
    e?.type === "session.usage_checkpoint" &&
    Array.isArray(e.data?.modelCacheState) &&
    e.data.modelCacheState.length > 0
      ? e
      : null,
  );
  if (!found) return null;
  const any = modelId === undefined || modelId === null || modelId === "auto";
  let best = null;
  for (const entry of found.hit.data.modelCacheState) {
    if (!entry || typeof entry !== "object") continue;
    if (!any && entry.modelId !== modelId) continue;
    const expiresAt = typeof entry.cacheExpiresAt === "string" ? Date.parse(entry.cacheExpiresAt) : NaN;
    if (!Number.isFinite(expiresAt)) continue;
    if (!best || expiresAt > best.expiresAt) {
      best = {
        expiresAt,
        ttlSeconds: num(entry.cacheTtlSeconds) ?? 0,
        modelId: String(entry.modelId ?? ""),
        checkpointId: typeof found.hit.id === "string" ? found.hit.id : null,
      };
    }
  }
  return best;
}

const POOLS = [["premium_interactions", "premium"], ["chat", "chat"]]; // completions is never shown

/** A snapshot is usable if unlimited, or if every number is present (never invent values; resetDate may be absent). */
function validQuota(q) {
  if (!q || typeof q !== "object") return false;
  if (q.isUnlimitedEntitlement === true) return true;
  return num(q.usedRequests) !== null && num(q.entitlementRequests) !== null && num(q.remainingPercentage) !== null;
}

/** The first pool (premium_interactions, then chat) that is valid and unlimited or has an entitlement; null if none. */
export function pickPool(snapshots) {
  if (!snapshots || typeof snapshots !== "object") return null;
  for (const [key, pool] of POOLS) {
    const q = snapshots[key];
    if (!validQuota(q)) continue;
    const unlimited = q.isUnlimitedEntitlement === true;
    if (!unlimited && !(q.entitlementRequests > 0)) continue;
    return {
      pool,
      used: num(q.usedRequests) ?? 0,
      total: num(q.entitlementRequests) ?? 0,
      remainingPct: num(q.remainingPercentage) ?? 0,
      resetDate: typeof q.resetDate === "string" ? q.resetDate : "",
      unlimited,
      tokenBased: q.tokenBasedBilling === true,
    };
  }
  return null;
}

/** Newest quota pick ({ quota, at }, at = event time in ms) from the 5 most recently modified sessions; null if none. */
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
    const found = await scan(file, '"quotaSnapshots"', (e) => pickPool(e?.data?.quotaSnapshots), { tailOnly: true });
    if (!found) continue;
    const parsed = Date.parse(found.e.timestamp);
    const ts = Number.isNaN(parsed) ? null : parsed; // unknown time: loses to any dated snapshot
    if (!best || (ts ?? -Infinity) > (best.ts ?? -Infinity)) best = { ts, q: found.hit };
  }
  return best ? { quota: best.q, at: best.ts } : null;
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

const round1 = (n) => Math.round(n * 10) / 10;

/** "Premium: 533 / 1500 used · 64.5% left · resets Dec 1 · as of 18:05"; the reset only for request-billed pools, "as of" only with `at`. */
export function quotaLine(pick, { at = null, timeZone } = {}) {
  if (!pick) return null;
  const label = pick.pool === "chat" ? "Chat" : "Premium";
  const asOf =
    at === null
      ? ""
      : ` · as of ${new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone })}`;
  if (pick.unlimited) return `${label}: unlimited${asOf}`;
  const d = new Date(pick.resetDate);
  const reset =
    pick.tokenBased || Number.isNaN(d.getTime())
      ? ""
      : ` · resets ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`;
  return `${label}: ${round1(pick.used)} / ${round1(pick.total)} used · ${round1(pick.remainingPct)}% left${reset}${asOf}`;
}

/** Live quota from the Copilot SDK (account.getQuota), picked with pickPool; throws on a start/query error or after `deadlineMs`. */
export async function readLiveQuota({ runtime, command, deadlineMs = 10_000 }) {
  // The runtime owns the deadline: past it the call rejects and the stuck CLI is replaced.
  return runtime.withClient({ command, deadlineMs }, async (client) => {
    const answer = await client.rpc.account.getQuota({});
    return pickPool(answer?.quotaSnapshots);
  });
}

/**
 * Quota with fallbacks, cached `ttlMs` (failures too): live; else the last live figure (<= maxAgeMs old); else a
 * session-file figure (<= maxAgeMs old); else none. A live answer without a pool is a final "none".
 * State: { quota, source: "live"|"earlier"|"file"|null, at, reason }. `onChange(state)` fires when the state differs.
 */
export function createQuotaService({
  readLive,
  readFile = readQuota,
  now = Date.now,
  ttlMs = 60_000,
  maxAgeMs = 3_600_000,
  onChange = () => {},
}) {
  let lastLive = null; // { quota, at }
  let cache = null; // { at, state }
  let inFlight = null;
  let emitted;

  async function compute() {
    let reason;
    try {
      const quota = await readLive();
      if (!quota) {
        lastLive = null;
        return { quota: null, source: "live", at: null, reason: null };
      }
      lastLive = { quota, at: now() };
      return { quota, source: "live", at: null, reason: null };
    } catch (e) {
      reason = e?.message ?? String(e);
    }
    if (lastLive && now() - lastLive.at <= maxAgeMs) {
      return { quota: lastLive.quota, source: "earlier", at: lastLive.at, reason };
    }
    const file = await Promise.resolve().then(() => readFile()).catch(() => null);
    if (file?.quota && typeof file.at === "number" && now() - file.at <= maxAgeMs) {
      return { quota: file.quota, source: "file", at: file.at, reason };
    }
    return { quota: null, source: null, at: null, reason };
  }

  async function run() {
    const state = await compute();
    cache = { at: now(), state };
    const json = JSON.stringify(state);
    if (json !== emitted) {
      emitted = json;
      onChange(state);
    }
    return state;
  }

  return {
    async get({ force = false } = {}) {
      if (!force && cache && now() - cache.at < ttlMs) return cache.state;
      if (!inFlight) inFlight = run().finally(() => (inFlight = null));
      return inFlight;
    },
  };
}

/** { line, tooltip } for the sidebar, or null when there is no quota. */
export function quotaView(state, { timeZone } = {}) {
  if (!state?.quota) return null;
  const live = state.source === "live";
  const line = quotaLine(state.quota, { at: live ? null : state.at, timeZone });
  const tooltip = live
    ? "Live from Copilot"
    : state.source === "earlier"
      ? `Last live figure; live query failed: ${state.reason}`
      : `From a session file; live query failed: ${state.reason}`;
  return { line, tooltip };
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
  return { context: contextView(context), credits, tooltip: parts.join(" · "), quota: quotaView(quota)?.line ?? null };
}

/**
 * Debounced per-session pusher: remembers the latest context numbers, reads the session's usage and the
 * (cached) quota, and calls send(sessionId, UsageView). Reader failures degrade to a view without those parts.
 */
export function createUsagePusher({ send, readSession = readSessionUsage, quota: readQuotaState = async () => null, debounceMs = 300 }) {
  const states = new Map(); // sessionId -> { context, timer }

  const quota = () => Promise.resolve().then(() => readQuotaState()).catch(() => null);

  async function push(sessionId, state) {
    const [session, q] = await Promise.all([
      Promise.resolve().then(() => readSession(sessionId)).catch(() => null),
      quota(),
    ]);
    if (states.get(sessionId) !== state) return; // forgotten while reading
    send(sessionId, summarize({ context: state.context, session, quota: q }));
  }

  function schedule(sessionId) {
    let state = states.get(sessionId);
    if (!state) states.set(sessionId, (state = { context: null, timer: null }));
    clearTimeout(state.timer);
    const s = state;
    s.timer = setTimeout(() => {
      s.timer = null;
      push(sessionId, s).catch(() => {});
    }, debounceMs);
    return s;
  }

  return {
    context(sessionId, { used, size }) {
      schedule(sessionId).context = { used, size };
    },
    refresh(sessionId) {
      schedule(sessionId);
    },
    forget(sessionId) {
      clearTimeout(states.get(sessionId)?.timer);
      states.delete(sessionId);
    },
  };
}
