// Pure helpers for scheduled scripts: result parsing, secret masking, notify rules. No Electron imports.

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
