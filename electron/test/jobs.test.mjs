// Tests for the pure scheduled-job helpers (result parsing, masking, notify rules).
import assert from "node:assert/strict";
import { test } from "node:test";
import { RESULT_CAP, capTail, finishRun, maskSecrets, parseResult, shouldNotify } from "../jobs.mjs";

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
