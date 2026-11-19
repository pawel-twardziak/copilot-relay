// Tests for the job scheduler: stores, secrets, history, the tick loop and quitting.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { JobScheduler } from "../scheduler.mjs";

const flush = () => new Promise((r) => setImmediate(r));
const NO_KEYCHAIN = "Secrets can't be saved: the system keychain is not available.";

function fakeRunner() {
  const calls = [];
  const startRun = (opts) => {
    let resolve;
    const done = new Promise((r) => { resolve = r; });
    const call = {
      opts, aborted: false,
      finish: (raw = {}) => resolve({ reason: "exit", exitCode: 0, error: null, stdout: "ok\n", stderr: "",
        stdoutTruncated: false, stderrTruncated: false, resultText: null, resultTruncated: false, durationMs: 5, ...raw }),
    };
    calls.push(call);
    return { abort() { call.aborted = true; call.finish({ reason: "aborted", exitCode: null }); }, done };
  };
  return { calls, startRun };
}

function setup(t, { available = true, decrypt, startRun } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { t: new Date(2026, 10, 19, 10, 5, 0).getTime() };
  const runner = fakeRunner();
  const finished = [];
  let changed = 0;
  const make = () => new JobScheduler({
    dir,
    secrets: { available: () => available, encrypt: (s) => "enc:" + s, decrypt: decrypt ?? ((s) => s.slice(4)) },
    onRunFinished: (run, job, notify) => finished.push({ run, job, notify }),
    onChanged: () => { changed++; },
    now: () => clock.t,
    startRun: startRun ?? runner.startRun,
  });
  return { dir, clock, runner, finished, changed: () => changed, s: make(), make };
}

const jobInput = (dir, extra = {}) => ({
  name: "Report", enabled: true, schedule: { kind: "cron", expr: "* * * * *" },
  command: "echo hi", cwd: dir, env: [], ...extra,
});

test("due job runs once per tick and is recorded", async (t) => {
  const { s, dir, clock, runner, finished } = setup(t);
  const job = s.save(jobInput(dir, { env: [{ name: "FOO", value: "bar" }, { name: "TOKEN", secret: true, value: "abcd1234" }] }));
  clock.t += 61_000;
  s.tick();
  s.tick();
  assert.equal(runner.calls.length, 1);
  assert.deepEqual(runner.calls[0].opts.env, { FOO: "bar", TOKEN: "abcd1234" });
  assert.equal(runner.calls[0].opts.timeoutMs, 10 * 60_000);
  assert.equal(s.list().jobs[0].running, true);
  runner.calls[0].finish();
  await flush();
  const [run] = s.runs(job.id);
  assert.equal(run.status, "success");
  assert.equal(run.trigger, "schedule");
  assert.equal(finished.length, 1);
  assert.equal(finished[0].notify, true);
  assert.equal(finished[0].job.id, job.id);
  assert.equal(s.list().jobs[0].running, false);
  assert.deepEqual(s.run(job.id, run.id), run);
});

test("skipped while running", async (t) => {
  const { s, dir, clock, runner, finished } = setup(t);
  const job = s.save(jobInput(dir));
  clock.t += 61_000;
  s.tick();
  clock.t += 60_000;
  s.tick();
  await flush();
  assert.equal(runner.calls.length, 1);
  const [run] = s.runs(job.id);
  assert.equal(run.status, "skipped");
  assert.equal(run.summary, "Skipped: the previous run is still going");
  assert.equal(run.durationMs, 0);
  assert.equal(finished.length, 0);
});

test("disabled jobs never run", (t) => {
  const { s, dir, clock, runner } = setup(t);
  s.save(jobInput(dir, { enabled: false }));
  clock.t += 61_000;
  s.tick();
  assert.equal(runner.calls.length, 0);
  assert.equal(s.list().jobs[0].nextRunAt, null);
});

test("saving does not fire a passed time", (t) => {
  const { s, dir, clock, runner } = setup(t);
  const view = s.save(jobInput(dir, { schedule: { kind: "cron", expr: "0 10 * * *" } }));
  assert.equal(view.nextRunAt, new Date(2026, 10, 20, 10, 0, 0).toISOString());
  clock.t += 30_000;
  s.tick();
  assert.equal(runner.calls.length, 0);
});

test("missing folder fails the run", async (t) => {
  const { startRun } = await import("../job-runner.mjs");
  const { s, dir, finished } = setup(t, { startRun });
  const cwd = fs.mkdtempSync(path.join(dir, "cwd-"));
  const job = s.save(jobInput(cwd));
  fs.rmSync(cwd, { recursive: true });
  const runId = s.runNow(job.id);
  await flush();
  const [run] = s.runs(job.id);
  assert.equal(run.id, runId);
  assert.equal(run.status, "failed");
  assert.equal(run.trigger, "manual");
  assert.equal(run.summary, `Folder does not exist: ${cwd}`);
  assert.equal(finished[0].notify, true);
});

test("history keeps 20", async (t) => {
  const { s, dir, runner } = setup(t);
  const job = s.save(jobInput(dir));
  const ids = [];
  for (let i = 0; i < 25; i++) {
    ids.push(s.runNow(job.id));
    runner.calls[i].finish();
    await flush();
  }
  const runs = s.runs(job.id);
  assert.equal(runs.length, 20);
  assert.equal(runs[0].id, ids[24]);
  assert.equal(runs[19].id, ids[5]);
});

test("secrets: stored encrypted, kept on save without value, never listed", async (t) => {
  const { s, dir, runner } = setup(t);
  const job = s.save(jobInput(dir, { env: [{ name: "TOKEN", secret: true, value: "abcd1234" }] }));
  const secretsFile = () => fs.readFileSync(path.join(dir, "job-secrets.json"), "utf8");
  assert.match(secretsFile(), /enc:abcd1234/);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, "jobs.json"), "utf8"), /abcd1234/);

  s.save({ ...jobInput(dir), id: job.id, env: [{ name: "TOKEN", secret: true }] });
  assert.match(secretsFile(), /enc:abcd1234/);
  assert.deepEqual(s.list().jobs[0].env, [{ name: "TOKEN", secret: true, set: true }]);
  assert.doesNotMatch(JSON.stringify(s.list()), /abcd1234/);

  s.runNow(job.id);
  assert.deepEqual(runner.calls[0].opts.env, { TOKEN: "abcd1234" });
  runner.calls[0].finish({ stdout: "token abcd1234\n" });
  await flush();
  assert.equal(s.runs(job.id)[0].stdout, "token ••••\n");

  s.save({ ...jobInput(dir), id: job.id, env: [] });
  assert.doesNotMatch(secretsFile(), /abcd1234/);
});

test("no keychain", (t) => {
  const { s, dir } = setup(t, { available: false });
  assert.throws(() => s.save(jobInput(dir, { env: [{ name: "TOKEN", secret: true, value: "abcd1234" }] })),
    { message: NO_KEYCHAIN });
  assert.equal(s.list().secretsAvailable, false);
  assert.equal(s.list().jobs.length, 0);
});

test("save requires an existing folder and a known id", (t) => {
  const { s, dir } = setup(t);
  assert.throws(() => s.save(jobInput(path.join(dir, "nope"))), { message: `Folder does not exist: ${path.join(dir, "nope")}` });
  assert.throws(() => s.save({ ...jobInput(dir), id: "missing" }), { message: "Job not found" });
  assert.throws(() => s.remove("missing"), { message: "Job not found" });
  assert.throws(() => s.setEnabled("missing", true), { message: "Job not found" });
  assert.throws(() => s.runNow("missing"), { message: "Job not found" });
});

test("runNow refuses a second run", (t) => {
  const { s, dir, changed } = setup(t);
  const job = s.save(jobInput(dir));
  const before = changed();
  s.runNow(job.id);
  assert.ok(changed() > before);
  assert.throws(() => s.runNow(job.id), { message: "Already running" });
});

test("setEnabled toggles and persists", (t) => {
  const { s, dir, make } = setup(t);
  const job = s.save(jobInput(dir));
  s.setEnabled(job.id, false);
  assert.equal(make().list().jobs[0].enabled, false);
});

test("remove aborts the run and deletes everything", async (t) => {
  const { s, dir, runner, finished } = setup(t);
  const job = s.save(jobInput(dir, { env: [{ name: "TOKEN", secret: true, value: "abcd1234" }] }));
  s.runNow(job.id);
  runner.calls[0].finish();
  await flush();
  s.runNow(job.id);
  s.remove(job.id);
  assert.equal(runner.calls[1].aborted, true);
  await flush();
  assert.equal(finished.length, 1);
  assert.deepEqual(s.list().jobs, []);
  assert.deepEqual(s.runs(job.id), []);
  for (const f of ["jobs.json", "job-secrets.json", "job-runs.json"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(dir, f), "utf8"), new RegExp(job.id));
  }
});

test("abortAllSync records aborted runs", async (t) => {
  const { s, dir, clock, runner, finished, make } = setup(t);
  const job = s.save(jobInput(dir));
  s.runNow(job.id);
  clock.t += 2_000;
  s.abortAllSync();
  assert.equal(runner.calls[0].aborted, true);
  const [run] = make().runs(job.id);
  assert.equal(run.status, "aborted");
  assert.equal(run.summary, "Stopped because the app quit");
  assert.equal(run.durationMs, 2_000);
  await flush();
  assert.equal(finished.length, 0);
  assert.equal(s.runs(job.id).length, 1);
});

test("corrupt jobs.json is kept aside", (t) => {
  const { s, dir } = setup(t);
  fs.writeFileSync(path.join(dir, "jobs.json"), "{");
  const warn = t.mock.method(console, "warn", () => {});
  s.start();
  s.stop();
  assert.match(s.list().loadError, /jobs\.json\.corrupt-/);
  assert.equal(warn.mock.callCount(), 1);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("jobs.json.corrupt-")));
  assert.equal(fs.existsSync(path.join(dir, "jobs.json")), false);
  s.save(jobInput(dir));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "jobs.json"), "utf8")).jobs.length, 1);
});

test("corrupt job-runs.json is kept aside without a load error", (t) => {
  const { s, dir } = setup(t);
  fs.writeFileSync(path.join(dir, "job-runs.json"), "nope");
  t.mock.method(console, "warn", () => {});
  s.start();
  s.stop();
  assert.equal(s.list().loadError, null);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("job-runs.json.corrupt-")));
});

test("a corrupt expression doesn't stop another due job", (t) => {
  const { s, dir, clock, runner } = setup(t);
  const base = { enabled: true, command: "echo", cwd: dir, env: [], timeoutMinutes: 10, notify: "always" };
  fs.writeFileSync(path.join(dir, "jobs.json"), JSON.stringify({ version: 1, jobs: [
    { ...base, id: "bad", name: "Bad", schedule: { kind: "cron", expr: "nope" } },
    { ...base, id: "good", name: "Good", schedule: { kind: "cron", expr: "* * * * *" } },
  ] }));
  const errors = t.mock.method(console, "error", () => {});
  s.start();
  s.stop();
  clock.t += 61_000;
  s.tick();
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].opts.jobName, "Good");
  assert.ok(errors.mock.callCount() >= 1);
  assert.equal(s.list().jobs.find((j) => j.id === "bad").nextRunAt, null);
});

test("a decrypt failure records a failed run", async (t) => {
  const { s, dir, runner, finished } = setup(t, { decrypt: () => { throw new Error("cannot decrypt"); } });
  const job = s.save(jobInput(dir, { env: [{ name: "TOKEN", secret: true, value: "abcd1234" }] }));
  s.runNow(job.id);
  await flush();
  assert.equal(runner.calls.length, 0);
  const [run] = s.runs(job.id);
  assert.equal(run.status, "failed");
  assert.equal(run.summary, "cannot decrypt");
  assert.equal(finished.length, 1);
});
