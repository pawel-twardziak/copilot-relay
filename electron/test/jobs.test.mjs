// Tests for the pure scheduled-job helpers (result parsing, masking, notify rules).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RESULT_CAP, capTail, finishRun, isDue, maskSecrets, parseResult, scheduleInfo, shouldNotify, validateJob,
} from "../jobs.mjs";

const rawRun = (over = {}) => ({
  reason: "exit",
  exitCode: 0,
  error: null,
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  resultText: null,
  resultTruncated: false,
  durationMs: 5,
  ...over,
});
const ctx = (over = {}) => ({
  jobId: "j",
  runId: "r",
  trigger: "manual",
  startedAt: "2026-11-19T10:00:00.000Z",
  secrets: [],
  ...over,
});

test("parseResult: JSON object", () => {
  assert.deepEqual(parseResult('{"summary":"3 new PRs\\nmore","details":"- #12","notify":false,"x":1}'),
    { hasResult: true, summary: "3 new PRs", details: "- #12", notify: false, invalidJson: null });
});
test("parseResult: plain text, CRLF", () => {
  assert.deepEqual(parseResult("\r\n  3 new PRs\r\nline 2\r\n"),
    { hasResult: true, summary: "3 new PRs", details: "\r\n  3 new PRs\r\nline 2\r\n", notify: null, invalidJson: null });
});
test("parseResult: invalid JSON falls back to text and reports the error", () => {
  const r = parseResult('{"summary": "x",}');
  assert.equal(r.hasResult, true);
  assert.equal(r.summary, '{"summary": "x",}');
  assert.match(r.invalidJson, /JSON/);
});
test("parseResult: empty, whitespace, null", () => {
  for (const t of [null, "", " \n "]) assert.equal(parseResult(t).hasResult, false);
});
test("parseResult: JSON array or non-string fields are text / ignored", () => {
  assert.equal(parseResult("[1]").summary, "[1]");
  assert.equal(parseResult('{"summary":5,"notify":"yes"}').summary, null); // object without usable summary
  assert.equal(parseResult('{"summary":5,"notify":"yes"}').notify, null);
});
test("shouldNotify: every cell of the table", () => {
  const T = { always: [1, 1, 1], result: [0, 1, 1], failure: [0, 0, 1], never: [0, 0, 0] };
  for (const [mode, [plain, withResult, fail]] of Object.entries(T)) {
    assert.equal(shouldNotify(mode, "success", false, null), !!plain, mode);
    assert.equal(shouldNotify(mode, "success", true, null), !!withResult, mode);
    for (const s of ["failed", "timeout", "aborted"]) assert.equal(shouldNotify(mode, s, false, null), !!fail, mode + s);
  }
  assert.equal(shouldNotify("always", "skipped", true, true), false);
});
test("shouldNotify: override on success only", () => {
  assert.equal(shouldNotify("never", "success", true, true), true);
  assert.equal(shouldNotify("always", "success", true, false), false);
  assert.equal(shouldNotify("never", "failed", true, true), false);
  assert.equal(shouldNotify("result", "failed", true, false), true);
});
test("maskSecrets: all occurrences, longest first", () => {
  assert.equal(maskSecrets("abcd abcdef abcd", ["abcd", "abcdef"]), "•••• •••• ••••");
});
test("capTail keeps the tail without splitting a character", () => {
  const r = capTail("a".repeat(10) + "ż".repeat(10), 7);
  assert.equal(r.truncated, true);
  assert.equal(r.text, "żżż");
});
test("masks before capping", () => {
  const secret = "S3CRET-VALUE";
  const raw = rawRun({ stdout: "x".repeat(RESULT_CAP - 5) + secret + "tail" });
  const run = finishRun(raw, ctx({ secrets: [secret] }));
  assert.ok(!run.stdout.includes("VALUE"));
  assert.ok(!run.stdout.includes("S3C"));
  assert.ok(Buffer.byteLength(run.stdout) <= RESULT_CAP);
});
test("finishRun: status and fallback summary", () => {
  assert.equal(finishRun(rawRun({ exitCode: 0 }), ctx()).status, "success");
  assert.equal(finishRun(rawRun({ exitCode: 2 }), ctx()).status, "failed");
  assert.equal(finishRun(rawRun({ reason: "timeout", exitCode: null }), ctx()).status, "timeout");
  assert.equal(finishRun(rawRun({ reason: "aborted", exitCode: null }), ctx()).status, "aborted");
  assert.equal(finishRun(rawRun({ exitCode: null, error: "Folder does not exist: /x" }), ctx()).summary, "Folder does not exist: /x");
  assert.equal(finishRun(rawRun({ stdout: "a\nlast line\n\n" }), ctx()).summary, "last line");
  assert.equal(finishRun(rawRun({ exitCode: 3 }), ctx()).summary, "exit code 3");
  const r = finishRun(rawRun({ resultText: '{"summary":"tok abcdefg","details":"abcdefg"}' }), ctx({ secrets: ["abcdefg"] }));
  assert.equal(r.summary, "tok ••••");
  assert.equal(r.details, "••••");
});

test("scheduleInfo: weekdays 08:00 from a Saturday", () => {
  const r = scheduleInfo("0 8 * * 1-5", new Date(2026, 10, 21, 9, 0));
  assert.equal(r.ok, true);
  assert.deepEqual(r.next.map((s) => new Date(s).getDate()), [23, 24, 25]);
});
test("scheduleInfo: invalid and non-5-field expressions", () => {
  assert.match(scheduleInfo("61 * * * *", new Date()).error, /minute/);
  assert.match(scheduleInfo("0 0 8 * * 1", new Date()).error, /5 fields/);
  assert.equal(scheduleInfo("", new Date()).ok, false);
});
test("isDue collapses a gap into one due check", () => {
  const t0 = new Date(2026, 10, 19, 10, 0, 10).getTime();
  assert.equal(isDue("*/5 * * * *", t0, t0 + 20_000), false);
  assert.equal(isDue("*/5 * * * *", t0, t0 + 3 * 3600_000), true); // 36 missed times -> just "due"
});
test("validateJob: normalizes and defaults", () => {
  const j = validateJob({ name: " PR ", enabled: true, schedule: { kind: "cron", expr: "0 8 * * *" },
    command: " ./run.sh ", cwd: "/tmp", env: [{ name: "ADO_ORG", value: "c", secret: false }] });
  assert.equal(j.name, "PR"); assert.equal(j.command, "./run.sh");
  assert.equal(j.timeoutMinutes, 10); assert.equal(j.notify, "always"); assert.ok(j.id);
});
test("validateJob: refusals", () => {
  const ok = { name: "a", enabled: true, schedule: { kind: "cron", expr: "* * * * *" }, command: "x", cwd: "/tmp", env: [] };
  const bad = (over, re) => assert.throws(() => validateJob({ ...ok, ...over }), re);
  bad({ name: " " }, /name/i);
  bad({ command: "" }, /command/i);
  bad({ schedule: { kind: "cron", expr: "x" } }, /schedule/i);
  bad({ timeoutMinutes: 0 }, /1.*1440/);
  bad({ timeoutMinutes: 1441 }, /1.*1440/);
  bad({ notify: "loud" }, /notify/i);
  bad({ env: [{ name: "1X", value: "v", secret: false }] }, /name/i);
  bad({ env: [{ name: "A", value: "1", secret: false }, { name: "A", value: "2", secret: false }] }, /twice/i);
  bad({ env: [{ name: "JOB_RESULT", value: "v", secret: false }] }, /reserved/i);
  bad({ env: [{ name: "PAT", value: "abc", secret: true }] }, /4 characters/);
});
test("validateJob: secret env keeps value only when typed; keeps id and enabled boolean", () => {
  const j = validateJob({ id: "abc", name: "a", enabled: 1, schedule: { kind: "cron", expr: "* * * * *" }, command: "x", cwd: "/tmp",
    env: [{ name: "PAT", secret: true }, { name: "TOK", value: "abcd", secret: true }, { name: "E", value: "", secret: false }] });
  assert.equal(j.id, "abc"); assert.equal(j.enabled, true);
  assert.deepEqual(j.env, [{ name: "PAT", secret: true }, { name: "TOK", secret: true, value: "abcd" }, { name: "E", secret: false, value: "" }]);
});
