// Tests for the pure helpers in electron/renderer/schedules.js (form state <-> jobsSave input, last-run text) and
// electron/renderer/schedule-run.js (the run summary's duration, status line and notices).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
require("../renderer/schedule-form.js"); // sets globalThis.ScheduleForm, which schedules.js reads at call time
const S = require("../renderer/schedules.js");
const R = require("../renderer/schedule-run.js");

const job = (over = {}) => ({
  id: "j1", name: "PRs", enabled: true, schedule: { kind: "cron", expr: "30 8 * * 1-5" }, command: "echo hi", cwd: "/tmp",
  env: [{ name: "A", value: "1", secret: false }, { name: "TOKEN", secret: true, set: true }],
  timeoutMinutes: 15, notify: "result", running: false, nextRunAt: null, lastRun: null, ...over,
});

test("a new job's form saves as an enabled daily job with the default timeout", () => {
  const f = S.formFromJob(null);
  Object.assign(f, { name: " n ", command: "ls", cwd: " /x " });
  assert.deepEqual(S.buildPayload(f), {
    name: "n", enabled: true, schedule: { kind: "cron", expr: "0 9 * * *" }, command: "ls", cwd: "/x", env: [],
    timeoutMinutes: 10, notify: "always",
  });
});

test("editing keeps the id, the preset and a stored secret (value omitted)", () => {
  const f = S.formFromJob(job());
  assert.equal(f.sched.kind, "weekdays");
  assert.deepEqual(f.sched.days, [1, 2, 3, 4, 5]);
  const p = S.buildPayload(f);
  assert.equal(p.id, "j1");
  assert.equal(p.schedule.expr, "30 8 * * 1,2,3,4,5");
  assert.equal(p.timeoutMinutes, 15);
  assert.deepEqual(p.env, [{ name: "A", secret: false, value: "1" }, { name: "TOKEN", secret: true }]);
  assert.ok(!("value" in p.env[1]));
});

test("a replaced or renamed stored secret sends the typed value", () => {
  const rows = S.envRowsFromJob(job().env);
  rows[1].replace = true;
  rows[1].value = "abcd";
  assert.deepEqual(S.envToInput(rows)[1], { name: "TOKEN", secret: true, value: "abcd" });
  const renamed = S.envRowsFromJob(job().env);
  renamed[1].name = "TOKEN2";
  assert.deepEqual(S.envToInput(renamed)[1], { name: "TOKEN2", secret: true, value: "" });
});

test("a new secret row always sends its value; blank rows are dropped; names are trimmed", () => {
  const rows = [
    { name: " K ", value: "", secret: true, set: false, origName: "", replace: false },
    { name: "", value: "", secret: false, set: false, origName: "", replace: false },
  ];
  assert.deepEqual(S.envToInput(rows), [{ name: "K", secret: true, value: "" }]);
});

test("timeout is sent as a Number", () => {
  const f = S.formFromJob(job());
  f.timeout = "45";
  assert.equal(S.buildPayload(f).timeoutMinutes, 45);
});

test("schedule state round-trips presets and keeps custom text", () => {
  assert.equal(S.schedToCron(S.schedFromExpr("*/5 * * * *")), "*/5 * * * *");
  assert.equal(S.schedToCron(S.schedFromExpr("0 */6 * * *")), "0 */6 * * *");
  assert.equal(S.schedToCron(S.schedFromExpr("15 7 * * *")), "15 7 * * *");
  const c = S.schedFromExpr("0 0 1 * *");
  assert.equal(c.kind, "custom");
  assert.equal(S.schedToCron(c), "0 0 1 * *");
  // switching presets keeps the other presets' fields
  const s = S.schedFromExpr("15 7 * * *");
  s.kind = "minutes";
  assert.equal(S.schedToCron(s), "*/5 * * * *");
  s.kind = "daily";
  assert.equal(S.schedToCron(s), "15 7 * * *");
});

test("weekdays with no day throws the ScheduleForm message", () => {
  const s = S.schedFromExpr("0 9 * * 1");
  s.days = [];
  assert.throws(() => S.schedToCron(s), /Pick at least one day\./);
  const f = S.formFromJob(null);
  f.sched = s;
  assert.throws(() => S.buildPayload(f), /Pick at least one day\./);
});

test("last-run text: running, never, status icons with ago", () => {
  const now = Date.parse("2026-11-19T10:00:00Z");
  assert.equal(S.lastRunText(job({ running: true }), now), "⏳ running");
  assert.equal(S.lastRunText(job(), now), "never run");
  const lr = (status, startedAt = "2026-11-19T09:58:00Z") => job({ lastRun: { id: "r", status, startedAt, summary: "" } });
  assert.equal(S.lastRunText(lr("success"), now), "✓ 2 min ago");
  assert.equal(S.lastRunText(lr("failed"), now), "✗ 2 min ago");
  assert.equal(S.lastRunText(lr("aborted"), now), "✗ 2 min ago");
  assert.equal(S.lastRunText(lr("timeout"), now), "⏱ 2 min ago");
  assert.equal(S.lastRunText(lr("skipped", "2026-11-19T09:59:30Z"), now), "⏭ just now");
});

test("duration: ms under a second, one decimal under a minute, then minutes and seconds", () => {
  assert.equal(R.formatDuration(0), "0 ms");
  assert.equal(R.formatDuration(999), "999 ms");
  assert.equal(R.formatDuration(1000), "1.0 s");
  assert.equal(R.formatDuration(12_345), "12.3 s");
  assert.equal(R.formatDuration(59_999), "59.9 s");
  assert.equal(R.formatDuration(60_000), "1 min 0 s");
  assert.equal(R.formatDuration(125_900), "2 min 5 s");
  assert.equal(R.formatDuration(null), "—");
});

const run = (over = {}) => ({
  id: "r1", jobId: "j1", trigger: "manual", startedAt: "2026-11-19T09:00:00Z", durationMs: 1500, status: "success",
  exitCode: 0, summary: "3 new PRs", details: null, hasResult: true, notifyOverride: null, invalidJson: null,
  stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, ...over,
});

test("status line: icon and status, trigger, start, duration, exit code when there is one", () => {
  const fmt = (iso) => `at ${iso}`;
  assert.deepEqual(R.runMeta(run(), fmt), ["✓ success", "run now", "at 2026-11-19T09:00:00Z", "1.5 s", "exit code 0"]);
  assert.deepEqual(R.runMeta(run({ status: "failed", trigger: "schedule", exitCode: 2 }), fmt).slice(0, 2), ["✗ failed", "scheduled"]);
  assert.equal(R.runMeta(run({ status: "aborted", exitCode: null }), fmt).length, 4);
  assert.equal(R.runMeta(run({ status: "timeout", exitCode: null }), fmt)[0], "⏱ timeout");
  assert.equal(R.runMeta(run({ status: "skipped", exitCode: null, durationMs: 0 }), fmt)[0], "⏭ skipped");
});

test("notices: a result shows no no-result line and keeps stdout collapsed", () => {
  const n = R.runNotices(run({ stdout: "hi\n" }));
  assert.equal(n.noResult, false);
  assert.equal(n.invalidJson, null);
  assert.deepEqual(n.stdout, { show: true, open: false, truncated: false });
  assert.deepEqual(n.stderr, { show: false, open: false, truncated: false });
});

test("notices: no result shows the line and opens the stdout tail; truncation flags pass through", () => {
  const n = R.runNotices(run({ hasResult: false, stdout: "x", stderr: "e", stdoutTruncated: true, stderrTruncated: true }));
  assert.equal(n.noResult, true);
  assert.deepEqual(n.stdout, { show: true, open: true, truncated: true });
  assert.deepEqual(n.stderr, { show: true, open: false, truncated: true });
});

test("notices: skipped and aborted runs never get the no-result line", () => {
  assert.equal(R.runNotices(run({ status: "skipped", hasResult: false })).noResult, false);
  assert.equal(R.runNotices(run({ status: "aborted", hasResult: false })).noResult, false);
  assert.equal(R.runNotices(run({ status: "failed", hasResult: false })).noResult, true);
});

test("notices: an invalid JSON result shows the parse error", () => {
  const n = R.runNotices(run({ invalidJson: "Unexpected token } in JSON at position 15" }));
  assert.equal(n.invalidJson, "The result file is not valid JSON: Unexpected token } in JSON at position 15");
});
