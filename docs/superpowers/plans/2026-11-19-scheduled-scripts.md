# Scheduled Scripts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A **Schedules** page in the desktop app: jobs that run a shell command on a cron schedule while the app
is open, with a run history, a run summary (from `$JOB_RESULT` or stdout) and a desktop notification.

**Architecture:** Main process only runs scripts. Three new ES modules without Electron imports, so `node:test`
covers them: `jobs.mjs` (pure: validation, schedule math, result parsing, masking, notify decision),
`job-runner.mjs` (spawns one run, kills the process tree, caps output) and `scheduler.mjs` (`JobScheduler`:
JSON stores, secrets via injected encrypt/decrypt, the 30 s loop). `main.mjs` wires it to IPC, `safeStorage`,
`Notification` and quit. Renderer: a classic-script pure module `schedule-form.js` (presets ↔ cron, labels) in the
style of `ui-state.js`, and `schedules.js` (the page, form, run summary).

**Tech Stack:** Electron 45, Node `child_process`, `croner@11.0.1` (verified: `new Cron(expr, { paused: true })`,
`.nextRun(from)`, `.nextRuns(n, from)`, throws `CronPattern: Invalid value for …` on bad input; day-of-month and
day-of-week are OR-ed like Vixie cron), vanilla JS renderer, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-19-scheduled-scripts-design.md`

## Global Constraints

- Branch `feat/scheduled-scripts` from `main`. Tests: `npm test` from the repo root (`node --test "electron/test/*.test.mjs"`).
- Files in `app.getPath("userData")`: `jobs.json`, `job-secrets.json`, `job-runs.json`. Written atomically
  (write `<file>.tmp`, then `renameSync`).
- Limits: tick 30 s; `timeoutMinutes` default 10, integer 1–1440; history 20 runs per job; stdout, stderr and
  result file capped at 64 KB (65 536 bytes) each, keeping the tail; secret values at least 4 characters.
- Cron: exactly 5 fields, local time zone, parsed only with `croner`.
- Shell: `spawn(command, { shell: true })` (Node uses `/bin/sh -c` and `cmd.exe /d /s /c`). POSIX `detached: true`
  and kill with `process.kill(-pid, …)`; Windows `taskkill /pid <pid> /T /F`.
- Env given to the script: `process.env` + job variables (decrypted secrets) + `JOB_RESULT`, `JOB_NAME`,
  `JOB_RUN_ID`. Job variables may not use those three names. Variable names match `/^[A-Za-z_][A-Za-z0-9_]*$/`.
- Per-run temp folder: `fs.mkdtempSync(path.join(os.tmpdir(), "copilot-sessions-job-"))`, mode 0700; result file
  `result`, created empty with mode 0600; folder removed after the run.
- Statuses: `success` | `failed` | `timeout` | `aborted` | `skipped`. Triggers: `schedule` | `manual`.
- Notify modes and labels: `always` "Always" (default), `result` "When there is a result or an error",
  `failure` "Failure only", `never` "Never".
- Mask string `••••`. Secrets never go to the renderer, `jobs.json`, history or notifications.
- Jobs change only through the `jobs:*` IPC channels. No relay or MCP tool.
- Exact UI copy:
  - Sidebar button: `⏰` with tooltip `Schedules`; page title `Schedules`
  - Help panel summary: `How a script reports its result`
  - Hint under the `result` mode: `The script must write to $JOB_RESULT, otherwise it only notifies about errors.`
  - No result: `The script wrote no result, showing the last stdout line.` + link `How to report a result`
  - Invalid JSON: `The result file is not valid JSON: <parse error>`
  - Truncated output: `Output was cut to the last 64 KB.`
  - No keychain: `Secrets can't be saved: the system keychain is not available.`
  - Notification title: `✓ <name>` (success), `✗ <name>` (failed, aborted), `⏱ <name>` (timeout); body: the
    run's `summary`.

## Review Focus

1. **A script that floods output (tens of MB fast).** Memory stays bounded and the last 64 KB is kept. Task 3 test
   `caps a flood of output to the tail`.
2. **A secret cut in half by the 64 KB cap.** No partial secret survives at the start of the kept tail. The runner
   keeps `cap + 4096` bytes and `finishRun` masks before cutting to 64 KB. Task 1 test `masks before capping`.
3. **The job's folder was deleted after saving.** The run is `failed` with `Folder does not exist: <cwd>`, it is
   recorded and notifies. Task 4 test `missing folder fails the run`.
4. **Editing a job to a time that already passed today** (save "daily 10:00" at 10:05) must not fire at once.
   Saving resets the job's check time to now. Task 4 test `saving does not fire a passed time`.
5. **An unreadable `jobs.json`** (hand-edited, half-written) is not overwritten with an empty list. It is renamed
   to `jobs.json.corrupt-<timestamp>`, and `list()` reports `loadError`, which the page shows. Task 4 test
   `corrupt jobs.json is kept aside`.

---

### Task 1: Result, masking and notify helpers (`jobs.mjs`, part 1)

**Files:**
- Create: `electron/jobs.mjs`
- Test: `electron/test/jobs.test.mjs`

**Interfaces:**
- Produces:
  - `RESULT_CAP = 65536`, `MASK = "••••"`, `NOTIFY_MODES = ["always", "result", "failure", "never"]`
  - `capTail(text: string, max = RESULT_CAP) -> { text: string, truncated: boolean }` (by UTF-8 bytes; never
    splits a character)
  - `maskSecrets(text: string, secrets: string[]) -> string` (longest first, every occurrence)
  - `parseResult(text: string|null) -> { hasResult: boolean, summary: string|null, details: string|null,
    notify: boolean|null, invalidJson: string|null }`
  - `shouldNotify(mode, status, hasResult, override: boolean|null) -> boolean`
  - `finishRun(raw: RawRun, ctx: { jobId, runId, trigger, startedAt, secrets: string[] }) -> RunRecord`
  - `RawRun` (Task 3 produces it): `{ reason: "exit"|"timeout"|"aborted", exitCode: number|null,
    error: string|null, stdout: string, stderr: string, stdoutTruncated: boolean, stderrTruncated: boolean,
    resultText: string|null, resultTruncated: boolean, durationMs: number }`
  - `RunRecord`: `{ id, jobId, trigger, startedAt (ISO), durationMs, status, exitCode, summary, details,
    hasResult, notifyOverride, invalidJson, stdout, stderr, stdoutTruncated, stderrTruncated }`

- [ ] **Step 0: Branch and commit the spec**

```bash
git switch -c feat/scheduled-scripts
git add docs/superpowers/specs/2026-11-19-scheduled-scripts-design.md docs/superpowers/plans/2026-11-19-scheduled-scripts.md
git commit -m "docs: scheduled scripts spec and plan"
```

- [ ] **Step 1: Write the failing tests**

```js
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
```

`rawRun(over)` returns a `RawRun` with `reason: "exit", exitCode: 0, error: null`, empty strings, `false` flags,
`resultText: null, durationMs: 5`, overridden by `over`. `ctx(over)` returns
`{ jobId: "j", runId: "r", trigger: "manual", startedAt: "2026-11-19T10:00:00.000Z", secrets: [] }` plus `over`.

- [ ] **Step 2: Run and see them fail**

Run: `node --test electron/test/jobs.test.mjs`
Expected: FAIL, `Cannot find module '../jobs.mjs'`.

- [ ] **Step 3: Implement the helpers in `electron/jobs.mjs`**

Rules the tests don't fully pin down:
- `parseResult`: trim the text. Empty means no result. If it starts with `{`, try `JSON.parse`. On a plain object:
  `summary` is the first non-empty line of a string `summary` (else `null`), `details` is a string or `null`, and
  `notify` is a boolean or `null`. On a parse error, treat it as text and set `invalidJson` to the error message.
  Text: `details` is the original text and `summary` its first non-empty trimmed line.
- `finishRun`, in this order:
  1. Mask stdout, stderr and resultText.
  2. `capTail` each to `RESULT_CAP` and OR the `truncated` flags with the raw ones.
  3. `parseResult`.
  4. If there is no result or its `summary` is `null`, `summary` = `error` ?? last non-empty stdout line ?? `exit code N` (`exit code ?` if null).
  5. Mask `summary` and `details` again.
- Status: `timeout`/`aborted` come from `reason`. Otherwise `success` iff `exitCode === 0 && !error`, else `failed`.

- [ ] **Step 4: Run the tests, expect PASS**

Run: `node --test electron/test/jobs.test.mjs`

- [ ] **Step 5: Commit**

```bash
git add electron/jobs.mjs electron/test/jobs.test.mjs
git commit -m "feat(desktop): job result parsing, masking and notify rules"
```

---

### Task 2: Schedule math and job validation (`jobs.mjs`, part 2)

**Files:**
- Modify: `electron/jobs.mjs`, `electron/package.json` (dependency `"croner": "11.0.1"`; add `jobs.mjs`,
  `job-runner.mjs`, `scheduler.mjs` to `build.files`)
- Test: `electron/test/jobs.test.mjs`

**Interfaces:**
- Produces:
  - `scheduleInfo(expr: string, from: Date, n = 3) -> { ok: true, next: string[] /* ISO */ } | { ok: false, error: string }`
  - `isDue(expr: string, lastCheckedAt: number, now: number) -> boolean` (true iff the next run after `lastCheckedAt` is ≤ `now`)
  - `RESERVED_ENV = ["JOB_RESULT", "JOB_NAME", "JOB_RUN_ID"]`
  - `validateJob(input) -> Job`, throws `Error` with a readable message. Input from the renderer: `{ id?, name, enabled,
    schedule: { kind: "cron", expr }, command, cwd, env: [{ name, value?, secret: boolean }], timeoutMinutes, notify }`.
    Returns a normalized `Job`: trimmed strings, `id` kept or `crypto.randomUUID()`, `timeoutMinutes` defaulting to 10,
    `notify` defaulting to `"always"`, and `env` entries `{ name, secret, value? }`. Secret entries keep `value` only when
    a new one was typed; `validateJob` does not touch storage. Checking that `cwd` exists is the scheduler's job, not this
    function's.

- [ ] **Step 1: Write the failing tests**

```js
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
  assert.equal(isDue("*/5 * * * *", t0, t0 + 3 * 3600_000), true); // 36 missed times → just "due"
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
```

- [ ] **Step 2: Run and see them fail**

Run: `node --test electron/test/jobs.test.mjs`
Expected: FAIL, `scheduleInfo is not a function` (or not exported).

- [ ] **Step 3: Implement**

`npm --prefix electron install croner@11.0.1 --save-exact`. Use `new Cron(expr, { paused: true })`. Check for 5
fields first, then let croner throw and return its message prefixed with `Invalid schedule: `. Error messages
contain the words the tests match.

- [ ] **Step 4: Run the tests, expect PASS**

Run: `node --test electron/test/jobs.test.mjs`

- [ ] **Step 5: Commit**

```bash
git add electron/jobs.mjs electron/test/jobs.test.mjs electron/package.json electron/package-lock.json
git commit -m "feat(desktop): job schedule math and validation"
```

---

### Task 3: One run (`job-runner.mjs`)

**Files:**
- Create: `electron/job-runner.mjs`
- Test: `electron/test/job-runner.test.mjs` (scripts as `node -e "…"` command lines via `process.execPath`, so they run on every OS)

**Interfaces:**
- Consumes: `RESULT_CAP` from `jobs.mjs`; `RawRun` shape (Task 1).
- Produces: `startRun({ command: string, cwd: string, env: Record<string,string>, timeoutMs: number,
  jobName: string, runId: string }) -> { abort(): void, done: Promise<RawRun> }`. `abort()` kills the tree and
  resolves `done` with `reason: "aborted"`. `done` never rejects. Spawn errors and a missing `cwd` become
  `{ exitCode: null, error }`, with error `Folder does not exist: <cwd>` checked before spawning.

- [ ] **Step 1: Write the failing tests**

```js
const node = (code) => `"${process.execPath}" -e ${JSON.stringify(code)}`;
const base = { cwd: os.tmpdir(), env: {}, timeoutMs: 10_000, jobName: "t", runId: "r1" };

test("exit code, stdout and stderr", async () => {
  const r = await startRun({ ...base, command: node("console.log('hi');console.error('oops');process.exit(3)") }).done;
  assert.equal(r.reason, "exit"); assert.equal(r.exitCode, 3);
  assert.equal(r.stdout.trim(), "hi"); assert.equal(r.stderr.trim(), "oops");
});
test("env and $JOB_RESULT", async () => {
  const r = await startRun({ ...base, env: { FOO: "bar" }, command: node(
    "require('fs').writeFileSync(process.env.JOB_RESULT, process.env.FOO + ' ' + process.env.JOB_NAME + ' ' + process.env.JOB_RUN_ID)") }).done;
  assert.equal(r.resultText, "bar t r1");
});
test("result folder is removed after the run", async () => {
  const r = await startRun({ ...base, command: node("console.log(process.env.JOB_RESULT)") }).done;
  assert.equal(fs.existsSync(path.dirname(r.stdout.trim())), false);
});
test("timeout kills the whole tree", async () => {
  const r = await startRun({ ...base, timeoutMs: 500, command: node(
    `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});` +
    `console.log(c.pid);setInterval(()=>{},1000)`) }).done;
  assert.equal(r.reason, "timeout");
  const grandchild = Number(r.stdout.trim());
  await new Promise((res) => setTimeout(res, 300));
  assert.throws(() => process.kill(grandchild, 0)); // gone
});
test("abort resolves as aborted", async () => {
  const h = startRun({ ...base, command: node("setInterval(()=>{},1000)") });
  setTimeout(() => h.abort(), 200);
  assert.equal((await h.done).reason, "aborted");
});
test("missing folder", async () => {
  const r = await startRun({ ...base, cwd: path.join(os.tmpdir(), "no-such-dir-xyz"), command: "echo x" }).done;
  assert.equal(r.exitCode, null); assert.match(r.error, /^Folder does not exist: /);
});
test("caps a flood of output to the tail", async () => {
  const r = await startRun({ ...base, command: node(
    "const b='x'.repeat(1<<20);for(let i=0;i<30;i++)process.stdout.write(b);process.stdout.write('END')") }).done;
  assert.equal(r.stdoutTruncated, true);
  assert.ok(r.stdout.endsWith("END"));
  assert.ok(Buffer.byteLength(r.stdout) <= 65536 + 4096);
});
```

- [ ] **Step 2: Run and see them fail**

Run: `node --test electron/test/job-runner.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `startRun` in `electron/job-runner.mjs`**

- Keep a byte tail of `RESULT_CAP + 4096` for each stream: collect Buffers and drop whole chunks from the front
  while the total is too big, then slice once at the end.
- Kill sequence on POSIX: `SIGTERM` to `-pid`, then `SIGKILL` to `-pid` after 3 s if the process hasn't exited.
- Read the result file (at most `RESULT_CAP + 4096` bytes, `resultTruncated` if bigger), then remove the folder
  with `rmSync(…, { recursive: true, force: true })`. Do this in every outcome.
- `env`: `{ ...process.env, ...env, JOB_RESULT, JOB_NAME, JOB_RUN_ID }`.

- [ ] **Step 4: Run the tests, expect PASS**

Run: `node --test electron/test/job-runner.test.mjs`

- [ ] **Step 5: Commit**

```bash
git add electron/job-runner.mjs electron/test/job-runner.test.mjs
git commit -m "feat(desktop): run a job script with timeout, tree kill and capped output"
```

---

### Task 4: Stores and loop (`scheduler.mjs`)

**Files:**
- Create: `electron/scheduler.mjs`
- Test: `electron/test/scheduler.test.mjs` (temp `dir`, fake `startRun`, fake `now`, `tick()` called directly)

**Interfaces:**
- Consumes: `validateJob`, `isDue`, `scheduleInfo`, `finishRun`, `shouldNotify` (Tasks 1–2); `startRun` (Task 3).
- Produces: `class JobScheduler`
  - `constructor({ dir, secrets: { available(): boolean, encrypt(s): string, decrypt(s): string },
    onRunFinished(run: RunRecord, job: Job, notify: boolean): void, onChanged(): void, now = Date.now,
    tickMs = 30_000, startRun })`
  - `start()`: loads stores and sets `lastCheckedAt = now()` for every job. `stop()`.
  - `tick()`: for each enabled job with `isDue`, starts a run, or records a `skipped` run if one is running. Then sets
    `lastCheckedAt = now()`.
  - `list() -> { jobs: JobView[], loadError: string|null, secretsAvailable: boolean }`, where
    `JobView = Job` with secret entries replaced by `{ name, secret: true, set: boolean }`, plus
    `running: boolean, nextRunAt: string|null, lastRun: { id, status, startedAt, summary }|null`.
  - `save(input) -> JobView`: validates and requires an existing `cwd` folder (`Folder does not exist: <cwd>`). Secret
    entries without `value` keep the stored value. A new value goes through `encrypt`. Saving a secret when
    `!available()` throws the no-keychain copy. Removed secret names are deleted. Sets `lastCheckedAt = now()`.
  - `remove(id)`: aborts its run, deletes the job, its secrets and its history. The aborted run is not recorded.
  - `setEnabled(id, enabled)`, `runNow(id) -> runId` (throws `Already running` if running), `runs(jobId) -> RunRecord[]`
    newest first, `run(jobId, runId) -> RunRecord|null`
  - `abortAllSync()`: for quit. Aborts every run, records each as `aborted` without waiting for the processes, and
    writes `job-runs.json` synchronously. `onRunFinished` is not called.

- [ ] **Step 1: Write the failing tests**

Test names and their assertions:
- `due job runs once per tick and is recorded`: job `* * * * *`, `now` advances 61 s, `tick()`. The fake `startRun`
  was called once with the decrypted env. After `done`, `runs(id)[0].status === "success"`, `trigger === "schedule"`,
  and `onRunFinished` was called with `notify === true`.
- `skipped while running`: the fake run never resolves, two due ticks → `runs(id)[0].status === "skipped"`, `startRun` called once, `onRunFinished` not called for the skip.
- `disabled jobs never run`.
- `saving does not fire a passed time`: `now` = 10:05, save `0 10 * * *`, `tick()` at 10:05:30 → no run.
- `missing folder fails the run`: save with an existing temp dir, delete it, `runNow` with the **real** `startRun`
  → status `failed`, summary `Folder does not exist: …`, `notify === true`.
- `history keeps 20`: 25 manual runs → `runs(id).length === 20`, newest first.
- `secrets: stored encrypted, kept on save without value, never listed`: fake `encrypt = (s) => "enc:" + s`.
  `job-secrets.json` contains `enc:abcd1234` and `jobs.json` doesn't contain `abcd1234`. A second `save` without
  `value` keeps it. `list()` entry is `{ name, secret: true, set: true }`. The run's env has the decrypted value.
- `no keychain`: `available() === false`, saving a secret → throws `Secrets can't be saved: the system keychain is not available.`
- `remove aborts the run and deletes everything`.
- `abortAllSync records aborted runs`: one running job, `abortAllSync()`. A fresh `JobScheduler` on the same `dir`
  shows `aborted`.
- `corrupt jobs.json is kept aside`: write `{` to `jobs.json`, `start()` → `list().loadError` is set,
  `jobs.json.corrupt-*` exists, `jobs.json` is untouched until the next `save`.

- [ ] **Step 2: Run and see them fail**

Run: `node --test electron/test/scheduler.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `JobScheduler`**

- The timer is `setInterval(tick, tickMs)` with `unref()`.
- `notify` passed to `onRunFinished` = `shouldNotify(job.notify, run.status, run.hasResult, run.notifyOverride)`.
- Secret values given to `finishRun` are the decrypted values of that job.

- [ ] **Step 4: Run the tests, expect PASS**

Run: `node --test electron/test/scheduler.test.mjs`

- [ ] **Step 5: Commit**

```bash
git add electron/scheduler.mjs electron/test/scheduler.test.mjs
git commit -m "feat(desktop): job scheduler with stores, secrets and history"
```

---

### Task 5: Main process wiring and preload

**Files:**
- Modify: `electron/main.mjs`: imports, a `scheduler` created in `app.whenReady()` after `createWindow()`,
  `handle()` channels, notification, and `before-quit` / `window-all-closed` (call `scheduler.abortAllSync()` next to `killAll()`)
- Modify: `electron/preload.cjs`

**Interfaces:**
- Consumes: `JobScheduler` (Task 4), `scheduleInfo` (Task 2).
- Produces (preload `window.api`): `jobsList()`, `jobsSave(input)`, `jobsDelete(id)`, `jobsSetEnabled(id, on)`,
  `jobsRunNow(id)`, `jobsRuns(jobId)`, `jobsRun(jobId, runId)`, `jobsPreview(expr) -> scheduleInfo result`,
  `onJobsChanged(fn)`, `onJobRunFinished(fn /* { jobId, runId, status } */)`, `onJobOpenRun(fn /* { jobId, runId } */)`.
  Channels: `jobs:list`, `jobs:save`, `jobs:delete`, `jobs:setEnabled`, `jobs:runNow`, `jobs:runs`, `jobs:run`,
  `jobs:previewSchedule`. Pushed events: `jobs:changed`, `jobs:runFinished`, `jobs:openRun`.

- [ ] **Step 1: Wire it**

- `secrets` = `{ available: () => safeStorage.isEncryptionAvailable(), encrypt: (s) => safeStorage.encryptString(s).toString("base64"),
  decrypt: (b) => safeStorage.decryptString(Buffer.from(b, "base64")) }`.
- `onRunFinished(run, job, notify)` sends `jobs:runFinished`. When `notify && Notification.isSupported()`, it shows
  `new Notification({ title, body: run.summary })` with the title from Global Constraints. Unlike
  `notifyIfUnfocused`, this shows even when the window is focused.
- On `click`: `win.show()`, `win.focus()`, then send `jobs:openRun`.

- [ ] **Step 2: Verify**

Run: `npm test`, expect all PASS (no regressions). Then `npm run app`. In the DevTools console:
`await api.jobsSave({ name: "t", enabled: true, schedule: { kind: "cron", expr: "* * * * *" }, command: "echo hi", cwd: "/tmp", env: [] })`
and `await api.jobsRunNow(id)`. A `✓ t` notification with body `hi` appears, and `await api.jobsRuns(id)` shows the run.

- [ ] **Step 3: Commit**

```bash
git add electron/main.mjs electron/preload.cjs
git commit -m "feat(desktop): wire the job scheduler to IPC and notifications"
```

---

### Task 6: Form helpers (`renderer/schedule-form.js`)

**Files:**
- Create: `electron/renderer/schedule-form.js` (classic script: `globalThis.ScheduleForm` + `module.exports`, like `ui-state.js`)
- Modify: `electron/renderer/index.html` (script tag after `ui-state.js`)
- Test: `electron/test/schedule-form.test.mjs`

**Interfaces:**
- Produces:
  - `EVERY_MINUTES = [1, 2, 5, 10, 15, 30]`, `EVERY_HOURS = [1, 2, 3, 4, 6, 8, 12]`
  - `Preset = { kind: "minutes", n } | { kind: "hours", n } | { kind: "daily", hh, mm } | { kind: "weekdays", days: number[] /* 0=Sun..6 */, hh, mm } | { kind: "custom", expr }`
  - `presetToCron(p: Preset) -> string`: `*/n * * * *` (`* * * * *` for n=1), `0 */n * * *` (`0 * * * *` for 1),
    `mm hh * * *`, and `mm hh * * d1,d2` (days sorted).
  - `cronToPreset(expr) -> Preset`: the exact inverse for these shapes, `custom` otherwise.
  - `describeSchedule(expr) -> string`: `every 5 minutes`, `every hour`, `every 2 hours`, `daily at 08:00`,
    `Mon, Wed, Fri at 08:00`, `weekdays at 08:00` (for 1–5), and the raw expr for custom.
  - `NOTIFY_LABELS = { always: "Always", result: "When there is a result or an error", failure: "Failure only", never: "Never" }`
  - `ago(iso, now) -> string`: `just now` (< 60 s), `5 min ago`, `2 h ago`, `3 d ago`.

- [ ] **Step 1: Write the failing tests**: round-trip `cronToPreset(presetToCron(p))` deep-equals `p` for one
  example of each preset kind. `cronToPreset("*/7 * * * *").kind === "custom"`.
  `describeSchedule("0 8 * * 1-5") === "weekdays at 08:00"` (the `1-5` range is also recognized).
  `describeSchedule("0 8 * * 1,3,5") === "Mon, Wed, Fri at 08:00"`. `ago` boundaries 59 s / 60 s / 60 min / 24 h.
- [ ] **Step 2: Run, expect FAIL**: `node --test electron/test/schedule-form.test.mjs`
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run, expect PASS**
- [ ] **Step 5: Commit**: `git commit -m "feat(desktop): schedule presets and labels"`

---

### Task 7: Schedules page, form and help

**Files:**
- Create: `electron/renderer/schedules.js` (classic script, `globalThis.Schedules = { show, hide, openRun }`)
- Modify: `electron/renderer/index.html`:
  - `⏰` button `#btn-schedules` in `.side-actions` after `#btn-refresh`;
  - `<section id="schedules" hidden>` inside `#main`;
  - script tag after `schedule-form.js`.
- Modify: `electron/renderer/app.js`:
  - `activate()` calls `Schedules.hide()`;
  - `#btn-schedules` click hides `#empty` and every `.session-view`, then calls `Schedules.show()`;
  - expose the existing `h`, `md` and `copyBtn` on `globalThis.AppUi` for `schedules.js`.
- Modify: `electron/renderer/style.css` (reuse the settings dialog's form styles)

**Interfaces:**
- Consumes: `window.api.jobs*` (Task 5), `ScheduleForm` (Task 6), `AppUi.{ h, md, copyBtn }`.
- Produces: `Schedules.openRun(jobId, runId)` (Task 8 fills the run view; here it shows the job's history list).

- [ ] **Step 1: Build the list**: rows as in the spec. The enabled dot, name and `describeSchedule` text. Next run as
  a local date and time. Last run shows its icon (`✓`/`✗`/`⏱`/`⏭` for skipped) and `ago`. Buttons: `▶ Run now`
  (disabled while running), enable toggle, Edit, Delete (`confirm`-style inline: the row shows
  `Delete "<name>"? [Delete] [Cancel]`; no browser `confirm()`). `list().loadError` shows as a red banner on top.
  The page re-renders on `onJobsChanged` and `onJobRunFinished`, and every 30 s so the `ago` texts stay current.
- [ ] **Step 2: Build the form** (inline, replacing the list).
  - **Schedule:** a preset select with its fields, plus Custom. Each change calls `api.jobsPreview(presetToCron(...))`
    and shows the next 3 times, or the error in red. Save is disabled while the schedule is invalid.
  - **Basic fields:** command, folder (text and a `Pick…` button calling `api.pickDir()`), timeout, notify (select
    with `NOTIFY_LABELS`).
  - **Environment rows:** name, value, a `secret` checkbox and a remove button. A stored secret shows `••••
    (set)` and a `Replace` button, and its value is sent only when replaced. When `!secretsAvailable`, the secret
    checkbox is disabled with the no-keychain copy as its title.
  - **The `result` notify mode:** shows the hint from Global Constraints. Its link opens the help panel.
  - **Save errors:** shown under the form.
- [ ] **Step 3: The help panel**: a `<details>` with summary `How a script reports its result`. It lists the three
  variables, the text and JSON formats (`summary`, `details`, `notify`) and the rule that the exit code decides
  success. The three examples (bash, PowerShell, Python) are copied verbatim from the spec, each with `copyBtn`.
- [ ] **Step 4: Manual check** (`npm run app`):
  1. Create a job `* * * * *` running `echo hi`; within about 90 s the row shows `✓ … just now`.
  2. An invalid cron disables Save.
  3. Reopening the form keeps the preset.
  4. A secret shows `(set)` after save.
  5. Opening a session hides the page.
- [ ] **Step 5: Run `npm test`, then commit**: `git commit -m "feat(desktop): schedules page with job form and result help"`

---

### Task 8: Run summary, notification click, README

**Files:**
- Modify: `electron/renderer/schedules.js`, `electron/renderer/app.js` (`api.onJobOpenRun(({ jobId, runId }) => { show page; Schedules.openRun(jobId, runId) })`), `electron/renderer/style.css`
- Modify: `electron/README.md` (new `## Schedules` section)

**Interfaces:**
- Consumes: `api.jobsRun`, `api.jobsRuns`, `AppUi.md`.

- [ ] **Step 1: Run view.**
  - **Header:** status icon and word, trigger, start (local), duration, exit code, then `summary` in bold.
  - **Body:** `details` rendered with `AppUi.md`.
  - **When `!hasResult`:** the no-result line with the `How to report a result` link, which opens the job's form
    with the help panel expanded. A collapsible stdout tail is expanded by default.
  - **When `invalidJson`:** the invalid-JSON warning.
  - **Output blocks:** stdout and stderr each in a collapsible `<pre>` with `copyBtn`, and the truncation line when
    the flag is set.
  - **History:** the job's history below, each entry opening its run.
- [ ] **Step 2: Notification click.** Clicking a notification opens that run from any state, including with a
  session open.
- [ ] **Step 3: README.** A `## Schedules` section covering:
  - what runs, and that nothing runs while the app is closed;
  - the env variables and the contract with the same three examples;
  - the notify modes;
  - where the files live and how secrets are stored;
  - ADO: `az login` works through the inherited environment, or a PAT goes in a secret variable such as
    `AZURE_DEVOPS_EXT_PAT`.
- [ ] **Step 4: Manual check.**
  1. A script writing `{"summary":"3 new PRs","details":"- #12 **x**"}` → the notification `✓ name / 3 new PRs`,
     and a click opens the run with rendered Markdown.
  2. `{"summary": "x",}` → the invalid-JSON warning.
  3. `exit 2` with no result → `✗`, summary `exit code 2`, the no-result line.
  4. `sleep 120` with a 1-minute timeout → `⏱`.
  5. `notify: result` with a silent script → no notification.
  6. Quit during a run → after restart the run shows `aborted`.
- [ ] **Step 5: Run `npm test`, then commit**: `git commit -m "feat(desktop): job run summary, notification click and README"`
