// Pure helpers for scheduled scripts: result parsing, secret masking, notify rules, schedule math, validation.
// No Electron imports.
import { randomUUID } from "node:crypto";
import { Cron } from "croner";

export const RESULT_CAP = 65536;
export const MASK = "••••";
export const NOTIFY_MODES = ["always", "result", "failure", "never"];

// Keeps the last `max` UTF-8 bytes of `text`, never starting in the middle of a character.
export function capTail(text, max = RESULT_CAP) {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return { text, truncated: false };
  let start = buf.length - max;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return { text: buf.subarray(start).toString("utf8"), truncated: true };
}

export function maskSecrets(text, secrets) {
  const ordered = [...new Set((secrets ?? []).filter((s) => typeof s === "string" && s !== ""))].sort(
    (a, b) => b.length - a.length,
  );
  let out = text;
  for (const s of ordered) out = out.split(s).join(MASK);
  return out;
}

const firstLine = (text) => text.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "") ?? null;

export function parseResult(text) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (trimmed === "") return { hasResult: false, summary: null, details: null, notify: null, invalidJson: null };
  let invalidJson = null;
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        return {
          hasResult: true,
          summary: typeof obj.summary === "string" ? firstLine(obj.summary) : null,
          details: typeof obj.details === "string" ? obj.details : null,
          notify: typeof obj.notify === "boolean" ? obj.notify : null,
          invalidJson: null,
        };
      }
    } catch (e) {
      invalidJson = e instanceof Error ? e.message : String(e);
    }
  }
  return { hasResult: true, summary: firstLine(text), details: text, notify: null, invalidJson };
}

export function shouldNotify(mode, status, hasResult, override) {
  if (status === "skipped") return false;
  if (status === "success") {
    if (typeof override === "boolean") return override;
    if (mode === "always") return true;
    if (mode === "result") return hasResult;
    return false;
  }
  return mode !== "never";
}

export function finishRun(raw, ctx) {
  const prep = (text, truncated) => {
    const capped = capTail(maskSecrets(text ?? "", ctx.secrets), RESULT_CAP);
    return { text: capped.text, truncated: capped.truncated || Boolean(truncated) };
  };
  const out = prep(raw.stdout, raw.stdoutTruncated);
  const err = prep(raw.stderr, raw.stderrTruncated);
  const resultText = raw.resultText == null ? null : prep(raw.resultText, raw.resultTruncated).text;
  const parsed = parseResult(resultText);

  let summary = parsed.hasResult ? parsed.summary : null;
  if (summary == null) {
    summary = raw.error ?? lastLine(out.text) ?? `exit code ${raw.exitCode ?? "?"}`;
  }
  const status =
    raw.reason === "timeout" ? "timeout"
    : raw.reason === "aborted" ? "aborted"
    : raw.exitCode === 0 && !raw.error ? "success"
    : "failed";

  return {
    id: ctx.runId,
    jobId: ctx.jobId,
    trigger: ctx.trigger,
    startedAt: ctx.startedAt,
    durationMs: raw.durationMs,
    status,
    exitCode: raw.exitCode,
    summary: maskSecrets(summary, ctx.secrets),
    details: parsed.details == null ? null : maskSecrets(parsed.details, ctx.secrets),
    hasResult: parsed.hasResult,
    notifyOverride: parsed.notify,
    invalidJson: parsed.invalidJson == null ? null : maskSecrets(parsed.invalidJson, ctx.secrets),
    stdout: out.text,
    stderr: err.text,
    stdoutTruncated: out.truncated,
    stderrTruncated: err.truncated,
  };
}

function lastLine(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  return lines.length ? lines[lines.length - 1] : null;
}

// ---- Schedule math ----

export const RESERVED_ENV = ["JOB_RESULT", "JOB_NAME", "JOB_RUN_ID"];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseCron(expr) {
  if (typeof expr !== "string" || expr.trim() === "") throw new Error("Invalid schedule: the expression is empty");
  if (expr.trim().split(/\s+/).length !== 5) throw new Error("Invalid schedule: use exactly 5 fields (minute hour day month weekday)");
  try {
    return new Cron(expr.trim(), { paused: true });
  } catch (e) {
    throw new Error(`Invalid schedule: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function scheduleInfo(expr, from, n = 3) {
  try {
    const next = parseCron(expr).nextRuns(n, from).map((d) => d.toISOString());
    return { ok: true, next };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// True iff the first scheduled time after `lastCheckedAt` is at or before `now`.
export function isDue(expr, lastCheckedAt, now) {
  const next = parseCron(expr).nextRun(new Date(lastCheckedAt));
  return next != null && next.getTime() <= now;
}

// ---- Validation ----

function validateEnv(env) {
  if (env == null) return [];
  if (!Array.isArray(env)) throw new Error("Environment variables must be a list");
  const seen = new Set();
  return env.map((e) => {
    const name = typeof e?.name === "string" ? e.name.trim() : "";
    if (!ENV_NAME.test(name)) throw new Error(`Invalid variable name "${name}": use letters, digits and _, not starting with a digit`);
    if (RESERVED_ENV.includes(name)) throw new Error(`Variable name ${name} is reserved`);
    if (seen.has(name)) throw new Error(`Variable ${name} is listed twice`);
    seen.add(name);
    if (e.secret === true) {
      if (e.value === undefined || e.value === null) return { name, secret: true };
      if (typeof e.value !== "string" || e.value.length < 4) throw new Error(`Secret ${name} must be at least 4 characters`);
      return { name, secret: true, value: e.value };
    }
    if (typeof e.value !== "string") throw new Error(`Variable ${name} needs a value`);
    return { name, secret: false, value: e.value };
  });
}

export function validateJob(input) {
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  if (name === "") throw new Error("Name is required");
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (command === "") throw new Error("Command is required");
  const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
  if (cwd === "") throw new Error("Working folder is required");
  if (input.schedule?.kind !== "cron") throw new Error("Invalid schedule: only cron schedules are supported");
  const expr = typeof input.schedule.expr === "string" ? input.schedule.expr.trim() : "";
  const info = scheduleInfo(expr, new Date(), 1);
  if (!info.ok) throw new Error(info.error);
  const timeoutMinutes = input.timeoutMinutes ?? 10;
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 1440) {
    throw new Error("Timeout must be a whole number of minutes from 1 to 1440");
  }
  const notify = input.notify ?? "always";
  if (!NOTIFY_MODES.includes(notify)) throw new Error(`Unknown notify mode "${notify}"`);
  return {
    id: typeof input.id === "string" && input.id !== "" ? input.id : randomUUID(),
    name,
    enabled: Boolean(input.enabled),
    schedule: { kind: "cron", expr },
    command,
    cwd,
    env: validateEnv(input.env),
    timeoutMinutes,
    notify,
  };
}
