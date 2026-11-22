# Update and Restart the Relay Broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One button in the desktop app's Settings that brings the copilot-relay repo to the latest `main`, installs,
restarts the broker and reconnects the app's sessions, showing every step.

**Architecture:** The broker gets a shutdown endpoint and reports its pid and folder in `/health`. The run lives in
main-process modules that do not import `electron` and take every outside effect (programs, HTTP, spawn, clock) as an
argument, so it is tested with fakes and, once, end to end against a real broker in a temp repo. `main.mjs` only
wires IPC; the window renders snapshots of the run.

**Tech Stack:** Node 22 (`node --test`), plain `node:child_process`/`fetch`, Electron main + classic-script renderer
modules, real `git` in tests, the CDP UI checks in `scripts/ui-check`.

**Spec:** `docs/superpowers/specs/2026-11-22-broker-restart-design.md`. Read it first; this plan does not repeat it.

**Before Task 1:** work in a worktree on branch `feat/broker-restart` (superpowers:using-git-worktrees). The spec's
latest edits and this plan are uncommitted on `main`: copy both into the worktree and commit them there first
(`docs: broker restart decisions and plan`).

## Global Constraints

- **Never run the restart against this working repo or the broker on port 7777.** Tests use temp repos, free ports
  and temp state files (`COPILOT_RELAY_NAMES_FILE`, `COPILOT_RELAY_DELEGATIONS_FILE`, `COPILOT_HOME`). The UI check
  always has a folder that does not exist as the repository path before it clicks the button.
- Programs are spawned with argument arrays. The repo path is passed as `cwd` or as one array element, never inside
  a shell string. The only shell use is `npm ci` (fixed text) on Windows when `npm-cli.js` is not found.
- Electron's own binary (`process.execPath` in the app) never runs the installer, `npm` or the broker.
- Main-side modules added here do not import `electron`. Renderer modules are classic scripts that set
  `globalThis.<Name>` and export through `module.exports`.
- `extension/copilot-relay/relay-client.mjs` is the only copy to edit; `electron/relay-client.mjs` is a build copy
  (git-ignored).
- Limits (spec): git 60 s per command, `npm ci` 5 min, installer 30 s, stop 10 s, start 15 s, reconnect 20 s.
- Stash message: `copilot-sessions restart <ISO time>`. The stash is never applied or dropped.
- UI copy in English. Section "Relay broker", button "Update and restart broker", step labels Check, Update,
  Install, Stop, Start, Reconnect.
- Commit style `type(scope): sentence`, scopes `relay` (broker, extension) and `desktop` (app).
- Full suite: `npm test` from the repo root (527 tests pass before this plan). UI checks:
  `node scripts/ui-check/run.mjs` exits 0 (needed in Task 6 only).

## Review Focus

Conditions the spec implies and that are most likely to bite; each has a test in the task named.

1. A stash was made and a later git command fails: the failure must still name the stash and its branch, or the
   user's changes look lost (Task 3 `updateRepo`, Task 4 summary).
2. The repo path has spaces or non-ASCII letters (`C:\Users\Jan Żak\copilot relay`): every command still works
   (Task 3, git test in a folder named `re po ż`).
3. `/health` reports the same folder spelled differently (drive-letter case, trailing separator, a symlinked temp
   folder): it must count as the same folder, or every restart fails at Start (Task 4 `sameFolder`).
4. Something that is not a copilot-relay broker answers on the port, or the broker answers the shutdown and never
   exits: nothing is started over it and the step says so (Task 4).
5. A session is closed while the run waits for reconnects: its stopped client must not be revived by
   `reconnectNow()` and must not hold the run for 20 s (Task 2, Task 4 `reconnectClients`).

## File Structure

| File | Responsibility |
|---|---|
| `server.mjs` | `/health` fields, `POST /api/shutdown` |
| `extension/copilot-relay/relay-client.mjs` | delay reset after a registration, `reconnectNow()` |
| `electron/run-program.mjs` (new) | run one program with a timeout; readable errors |
| `electron/broker-git.mjs` (new) | step 1: stash, checkout, pull |
| `electron/broker-restart.mjs` (new) | the run (steps 0 to 5), one-run-at-a-time state, real effects |
| `electron/main.mjs`, `electron/preload.cjs` | settings key, three IPC channels |
| `electron/renderer/broker-restart.js` (new) | question text and step rows (pure) |
| `electron/renderer/index.html`, `app.js`, `style.css` | the "Relay broker" section |
| `electron/test/broker-helper.mjs` (new) | start a real broker for a test (moved out of `broker-stream.test.mjs`) |

---

### Task 1: Broker: `/health` fields and the shutdown endpoint

**Files:**
- Modify: `server.mjs` (`GET /health` near line 252, new route beside it; `shutdown` at the end of the file)
- Create: `electron/test/broker-helper.mjs`, `electron/test/broker-shutdown.test.mjs`
- Modify: `electron/test/broker-stream.test.mjs` (import the helper instead of its local copies), `README.md`
  (API table near line 223)

**Interfaces:**
- Produces: `GET /health` → `{ ok: true, app: "copilot-relay", peers, pid, startedAt, root, acpSessions }`
  (`pid` = `process.pid`, `startedAt` = epoch ms taken once at start, `root` = `ROOT`, `acpSessions` =
  `acpAgents.size`). `POST /api/shutdown` (JSON body) → 200 `{ ok: true, pid }`, then the process exits with code 0.
- Produces (tests): `broker-helper.mjs` exports `SERVER` (path of the repo's `server.mjs`), `freePort()`,
  `until(pred, what, ms = 5000)` and
  `startBroker(t, { script = SERVER, port, env } = {}) → { url, port, proc, exited, tmp, connect, disconnect, tool }`
  (`exited`: promise of the exit code; the rest as today's local `broker(t)`).

- [ ] **Step 1: Move the helper.** Move `freePort`, `until` and `broker` from `broker-stream.test.mjs` into
  `broker-helper.mjs` as above (`broker` becomes `startBroker`, with the `script`/`port`/`env` options and the extra
  returned fields). `broker-stream.test.mjs` imports them. Run `node --test electron/test/broker-stream.test.mjs`:
  9 tests pass, as before.

- [ ] **Step 2: Write the failing tests** in `broker-shutdown.test.mjs` (real broker through `startBroker`):

```js
test("health reports the pid, start time, folder and web sessions", async (t) => {
  const b = await startBroker(t);
  const h = await (await fetch(`${b.url}/health`)).json();
  assert.equal(h.ok, true);
  assert.equal(h.app, "copilot-relay");
  assert.equal(h.pid, b.proc.pid);
  assert.equal(realpathSync(h.root), realpathSync(path.dirname(SERVER)));
  assert.ok(Math.abs(Date.now() - h.startedAt) < 60_000);
  assert.equal(h.acpSessions, 0);
});

test("POST /api/shutdown answers with the pid and the broker exits", async (t) => {
  const b = await startBroker(t);
  const r = await fetch(`${b.url}/api/shutdown`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, pid: b.proc.pid });
  assert.equal(await b.exited, 0);
  await assert.rejects(fetch(`${b.url}/health`));
});
```

  Two more tests, same style:
  - `"a foreign shutdown request is refused and the broker keeps running"`: three requests, each answered 403 and
    followed by a `/health` with the same pid: `Host: evil.example` (send it with `http.request`, since `fetch`
    cannot set Host), `Origin: http://evil.example`, and `content-type: text/plain`.
  - `"GET /api/shutdown is not a route"`: 404, and `/health` still answers with the same pid.

- [ ] **Step 3: Run them.** `node --test electron/test/broker-shutdown.test.mjs` → all 4 fail (missing fields, 404).

- [ ] **Step 4: Implement** in `server.mjs`. The shutdown route writes its answer and calls the existing
  `shutdown()` from the callback of `res.end(...)`, so the answer is flushed before `process.exit`.

- [ ] **Step 5: Run** `npm test` → 531 pass.

- [ ] **Step 6: Document** the two rows in the README API table: `GET /health` with its fields, and
  `POST /api/shutdown` ("stops the broker; local processes only, like every route").

- [ ] **Step 7: Commit** `feat(relay): the broker reports its pid and folder and can be asked to stop`.

---

### Task 2: Relay client: delay reset and `reconnectNow()`

**Files:**
- Modify: `extension/copilot-relay/relay-client.mjs` (`#loop` lines 141-157, `#connectOnce`, `stop`)
- Create: `electron/test/relay-client.test.mjs`

**Interfaces:**
- Produces: constructor options `retryMs` (default `1000`) and `retryMaxMs` (default `15_000`): the first wait after
  a failure and the cap of the doubling. After every `registered` event the next wait is `retryMs` again.
- Produces: `reconnectNow(): Promise<boolean>`. Ends the current wait or the live stream, connects at once, and
  makes the next wait `retryMs`. Resolves `true` at the next `registered` event; resolves `false` when the client is
  stopped (already, or before that event). Several pending calls resolve together. It never restarts a stopped
  client.

- [ ] **Step 1: Write the failing tests.** In the test file, a stub broker (plain `http.createServer`):
  `stubBroker(t) → { url, attempts, fail, drop() }`. It answers `GET /api/peer/stream` with status 503 while
  `fail` is true, otherwise with an SSE response holding one `registered` event (`data: {"name":"stub"}`) kept
  open; `attempts` is the array of `Date.now()` of every stream request; `drop()` destroys the open responses.

```js
test("after a registration the next wait is the base delay again", async (t) => {
  const s = await stubBroker(t);
  s.fail = true;
  const c = client(t, s, { retryMs: 40, retryMaxMs: 5000 }); // started; t.after stops it
  await until(() => s.attempts.length >= 6, "six refused attempts"); // waits grew to 1280 ms
  s.fail = false;
  await until(() => c.connected && c.name === "stub", "the registration");
  const before = s.attempts.length;
  const dropped = Date.now();
  s.drop();
  await until(() => s.attempts.length > before, "the next attempt");
  assert.ok(s.attempts.at(-1) - dropped < 500, `waited ${s.attempts.at(-1) - dropped} ms`);
});

test("reconnectNow ends a wait and answers true once registered", async (t) => {
  const s = await stubBroker(t);
  s.fail = true;
  const c = client(t, s, { retryMs: 60_000 });
  await until(() => s.attempts.length === 1, "the first attempt");
  s.fail = false;
  assert.equal(await c.reconnectNow(), true); // the test's own timeout guards the 60 s wait
  assert.equal(s.attempts.length, 2);
});
```

  Four more tests, same style:
  - `"reconnectNow ends a live stream and registers again"`: registered once; `await c.reconnectNow()` is `true`;
    `onRegistered` was called twice; the stub saw the first response close.
  - `"reconnectNow on a stopped client answers false and does not connect"` (Review Focus 5): `c.stop()`;
    `await c.reconnectNow()` is `false`; 200 ms later `s.attempts.length` is unchanged.
  - `"stop() ends a pending reconnectNow with false"`: `fail = true`; `const p = c.reconnectNow(); c.stop();`
    `await p` is `false`.
  - `"default delays"`: a client built without the options has `retryMs === 1000` and `retryMaxMs === 15_000`.

- [ ] **Step 2: Run** `node --test electron/test/relay-client.test.mjs` → fail (no `reconnectNow`; the first test
  fails on the 500 ms assertion).

- [ ] **Step 3: Implement.** Keep `#autostart` and the event handling as they are.

- [ ] **Step 4: Run** `npm test` → 537 pass (the broker-stream tests use the same client: they must stay green).

- [ ] **Step 5: Commit** `fix(relay): a session reconnects after 1 s again once it has been connected`.

---

### Task 3: Running programs and the git step

**Files:**
- Create: `electron/run-program.mjs`, `electron/broker-git.mjs`
- Modify: `electron/job-runner.mjs` (export the existing `killTree`, no other change)
- Test: `electron/test/run-program.test.mjs`, `electron/test/broker-git.test.mjs`, `electron/test/git-helper.mjs`

**Interfaces:**
- Produces: `runProgram(program, args, { cwd, env, timeoutMs, shell = false } = {}) → Promise<{ stdout, stderr }>`
  (strings, each capped to its last 64 KiB). Spawned with `windowsHide`, stdin ignored, `env` merged over
  `process.env`, `detached` off Windows so `killTree(child, "SIGKILL")` ends the whole tree on a timeout. Rejects
  with an `Error` carrying `code`, `stdout`, `stderr`:
  - `code: "ENOENT"`, message `` `${program} was not found (is it installed and on PATH?)` ``
  - `code: "TIMEOUT"`, message `` `${label} did not finish in ${timeoutMs / 1000} s` ``
  - `code: "EXIT"`, message `` `${label} failed (exit ${n}): ${tail}` `` (`tail`: the last 400 characters of
    stderr, or of stdout when stderr is empty, trimmed)

  `label` is the program's base name without extension plus the first argument that is not a path or an option
  (`git pull`, `npm ci`, `node install-extension.mjs`).
- Produces: `GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }`
- Produces: `updateRepo({ repo, run, now = () => new Date(), timeoutMs = 60_000 }) → Promise<{ before, after, stash }>`
  where `run` has `runProgram`'s signature, `before`/`after` are short hashes of `HEAD`, and `stash` is `null` or
  `{ branch, message }`. Commands, in order, each as `run("git", [...], { cwd: repo, env: GIT_ENV, timeoutMs })`:
  `rev-parse --abbrev-ref HEAD`, `rev-parse --short HEAD`, `status --porcelain`; when that is not empty
  `stash push --include-untracked -m <message>`; when the branch is not `main` `checkout main`;
  `pull --ff-only origin main`; `rev-parse --short HEAD`. An error thrown after the stash was made is rethrown with
  `err.stash = { branch, message }`.
- Produces: `describeUpdate({ before, after, stash }) → string`: `"already up to date (abc1234)"` or
  `"abc1234 → def5678"`, followed by `"; changes stashed from <branch>"` when there is a stash.

- [ ] **Step 1: Write the failing `runProgram` tests** (`process.execPath -e ...` as the program):
  - output is returned: `runProgram(process.execPath, ["-e", "console.log('hi')"])` → `stdout === "hi\n"`;
  - `env` and `cwd` reach the program (print `process.env.X` and `process.cwd()`);
  - exit 3 with `console.error("boom")`: rejects, `code === "EXIT"`, message matches `/failed \(exit 3\): boom/`;
  - `runProgram("no-such-program-xyz", [])` rejects with `code === "ENOENT"` and
    `/no-such-program-xyz was not found/`;
  - a program that sleeps 60 s with `timeoutMs: 300` rejects with `code === "TIMEOUT"` and
    `/did not finish in 0\.3 s/`, in under 5 s.

- [ ] **Step 2: Run** → fail (module missing). **Implement** `run-program.mjs`. **Run** → pass.

- [ ] **Step 3: Write the failing git tests** with real git. Test helper in `electron/test/git-helper.mjs` (Task 5
  uses it too): `repoWithRemote(t, name = "repo") → { tmp, repo, git(...args), upstream(file, text) }`: a bare remote and a clone on
  `main` with one pushed commit, in a temp folder removed after the test; `git` runs in the clone with
  `-c user.name=test -c user.email=test@example.invalid`; `upstream` pushes one more commit to `main` through a
  second clone and returns its short hash. Use `git init -b main`. `now` is fixed to
  `new Date("2026-11-22T12:00:00.000Z")`, so the message is
  `copilot-sessions restart 2026-11-22T12:00:00.000Z`.

```js
test("on main with local changes: stashed, then pulled", async (t) => {
  const r = await repoWithRemote(t);
  const head = await r.upstream("new.txt", "x");
  writeFileSync(path.join(r.repo, "README.md"), "edited");
  writeFileSync(path.join(r.repo, "untracked.txt"), "u");
  const out = await updateRepo({ repo: r.repo, run: runProgram, now });
  assert.deepEqual(out.stash, { branch: "main", message: "copilot-sessions restart 2026-11-22T12:00:00.000Z" });
  assert.equal(out.after, head);
  assert.notEqual(out.before, out.after);
  assert.equal((await r.git("status", "--porcelain")).trim(), "");
  assert.match(await r.git("stash", "list"), /copilot-sessions restart 2026-11-22T12:00:00\.000Z/);
});
```

  Further tests, same style:
  - on `main`, behind, clean: `stash === null`, `after` is the upstream hash;
  - on `main`, up to date: `before === after`, `stash === null`;
  - on branch `feature`, clean: ends on `main` (`rev-parse --abbrev-ref HEAD`), pulled, `stash === null`;
  - on branch `feature` with changes: `stash.branch === "feature"`, ends on `main`, work tree clean;
  - detached `HEAD`: ends on `main`, pulled;
  - diverged `main` (a local commit and an upstream commit): rejects with `/git pull failed/`; `HEAD` is still the
    local commit; `err.stash` is undefined;
  - diverged `main` with a dirty work tree (Review Focus 1): rejects, `err.stash` equals `{ branch: "main", message }`
    and `git stash list` has one entry;
  - the same "behind, clean" case in a repo folder named `re po ż` (Review Focus 2);
  - with a recording fake `run`: every call is `git` with `cwd === repo`, `env.GIT_TERMINAL_PROMPT === "0"`,
    `env.GCM_INTERACTIVE === "never"` and `timeoutMs === 60_000`;
  - `describeUpdate`: the three strings above.

- [ ] **Step 4: Run** → fail. **Implement** `broker-git.mjs`. **Run** `npm test` → all pass.

- [ ] **Step 5: Commit** `feat(desktop): update the broker repo to main, stashing local changes`.

---

### Task 4: The run

**Files:**
- Create: `electron/broker-restart.mjs`
- Test: `electron/test/broker-restart.test.mjs`

**Interfaces:**
- Consumes: `runProgram` (Task 3), `updateRepo`, `describeUpdate`, `GIT_ENV` (Task 3), `/health` and
  `POST /api/shutdown` (Task 1), `client.reconnectNow()` (Task 2).
- Produces:

```js
export const LIMITS = { npmMs: 300_000, installMs: 30_000, stopMs: 10_000, startMs: 15_000, reconnectMs: 20_000, healthMs: 2_000, pollMs: 200 };
export const STEP_IDS = ["check", "update", "install", "stop", "start", "reconnect"];
export const STEP_LABELS = { check: "Check", update: "Update", install: "Install", stop: "Stop", start: "Start", reconnect: "Reconnect" };

/** Same folder after resolve + realpath (when it exists), ignoring a trailing separator; case-insensitive on Windows. */
export function sameFolder(a, b, platform = process.platform) // → boolean
/** $COPILOT_HOME/extensions/copilot-relay/config.json; copilotHome defaults to ~/.copilot. */
export function readInstalled(copilotHome) // → { installed: boolean, brokerScript: string | null, nodePath: string | null }
/** npm for this Node: its npm-cli.js when found, else npm from PATH. */
export function npmCommand(nodeExe, { platform = process.platform, exists = existsSync } = {}) // → { program, args, shell }
export async function runRestart({ repo, url, copilotHome }, fx, onStep = () => {}) // → { ok, steps, summary }; never rejects
export async function reconnectClients(clients, ms) // → { total, back }
export function createRestarter({ fx, notify }) // → { snapshot(), start(input) → boolean }
export function realEffects({ reconnect }) // → fx
```

  - `fx = { run, fetch, spawnBroker(node, script, { cwd, env }) → Promise<void>, reconnect(ms) → Promise<{ total, back }>, sleep(ms), now() }`.
    `run` has `runProgram`'s signature; `fetch` the global one's. Waiting is done only through `fx.sleep` and
    measured only through `fx.now`.
  - A step is `{ id, label, status, detail, warning? }`, status `pending | running | done | failed | skipped`.
    `onStep(step)` is called when a step starts running and when it ends. `steps` in the result always has all six,
    in order; steps after a failure stay `pending`.
  - `npmCommand`: Windows looks for `<node folder>/node_modules/npm/bin/npm-cli.js`, other systems for
    `<node folder>/../lib/node_modules/npm/bin/npm-cli.js`. Found: `{ program: nodeExe, args: [cli, "ci"], shell: false }`.
    Not found: `{ program: "npm", args: ["ci"], shell: platform === "win32" }`.
  - `createRestarter`: `snapshot()` → `{ running, steps, summary, ok }` (before any run:
    `{ running: false, steps: [], summary: "", ok: null }`). `start(input)` returns `false` while a run is going;
    otherwise it starts `runRestart(input, fx, …)`, returns `true` at once, and calls `notify(snapshot())` at the
    start (six pending steps, `running: true`), after every step change and at the end.
  - `reconnectClients`: calls `reconnectNow()` on every client, waits until all have answered or `ms` passed;
    `back` counts the answers that were `true` by then.
  - `realEffects`: `run: runProgram`, global `fetch`, real timers, and `spawnBroker` as `RelayClient#autostart`
    spawns (detached, `stdio: "ignore"`, `windowsHide`, unref'd, `env` merged over `process.env`), resolving on the
    child's `spawn` event and rejecting on its `error` event.

**What each step does and says** (texts are exact; `port` is the URL's port, 80 when absent):

| Step | Does | `detail` when done | Failure `detail` |
|---|---|---|---|
| check | `repo` has `server.mjs` and `scripts/install-extension.mjs`; `git rev-parse --show-toplevel` (with `GIT_ENV`, 60 s) is `sameFolder` as `repo`; the URL's host is `127.0.0.1`, `localhost` or `[::1]`; Node = `readInstalled().nodePath` when that file exists, else the output of `run("node", ["-p", "process.execPath"], { timeoutMs: 10_000 })` | the repo path | `Not a copilot-relay folder: <repo> (server.mjs and scripts/install-extension.mjs are expected there).` / `<repo> is not the top folder of a git repository.` / `The broker address <url> is not on this computer.` / the error's message |
| update | `updateRepo({ repo, run: fx.run })` | `describeUpdate(...)` | the error's message, plus ` Your changes from <branch> are in the stash "<message>".` when `err.stash` is set |
| install | `npmCommand(node)` run in `repo` with `timeoutMs: LIMITS.npmMs`; then `run(node, [<repo>/scripts/install-extension.mjs, ...(noAutostart ? ["--no-autostart"] : [])], { cwd: repo, env: { COPILOT_RELAY_PORT: port, COPILOT_HOME: copilotHome (only when given) }, timeoutMs: LIMITS.installMs })`; `noAutostart` = an installed config whose `brokerScript` is null | `dependencies and extension installed` | the error's message |
| stop | `GET <url>/health` (abort after `healthMs`): no answer → skipped. An answer whose `app` is not `copilot-relay` → failed. Else `POST <url>/api/shutdown` with body `{}`, then poll every `pollMs` until `/health` does not answer or has another pid, for at most `stopMs` | `stopped pid <pid>`; skipped: `no broker was running` | `Something else answers at <url>; it is not a copilot-relay broker.` / on 404: `This broker is older than the restart button. Stop it by hand once; it will then run the updated files.` / other status: `The broker refused to stop: HTTP <status>.` / `The broker did not stop within 10 s.` |
| start | `spawnBroker(node, <repo>/server.mjs, { cwd: repo, env: { COPILOT_RELAY_PORT: port } })`, then poll `/health` for at most `startMs`: an answer with a pid other than the stopped one and a `root` that is `sameFolder` as `repo` ends the step; such an answer with another `root` fails it at once | `pid <pid>` | `A broker from another folder answers: <root or "unknown folder">.` / `The broker did not answer within 15 s.` / the spawn error's message |
| reconnect | `fx.reconnect(LIMITS.reconnectMs)` | `<back> of <total> sessions reconnected` (with `warning: true` when `back < total`); `total === 0` → skipped, `no open sessions` | (does not fail; a thrown error becomes a `warning` with its message) |

**`summary`** (one line; the stash sentence ` Your changes from <branch> are in the stash "<message>".` is appended
to every form when a stash was made):

- success: `Broker running: pid <pid>, commit <after>.`
- failed at check, update or install: `Stopped at <Label>. The broker was not restarted.`
- failed at stop: `Stopped at Stop. The old broker is still running.`
- failed at start, another folder: `Stopped at Start. A different broker is running.`
- failed at start otherwise: `Stopped at Start. No broker is running; opening a session starts it.`

- [ ] **Step 1: Write the failing tests.** In the test file, `fakeFx(script)` builds an `fx` with a virtual clock
  (`sleep` advances `now`), a `run` that records calls and answers from a table keyed by the label
  (`"git rev-parse --show-toplevel"` → the repo path, and so on; an `Error` value is thrown), a `fetch` that
  answers `/health` from a list of states over time (`null` = connection refused) and records the shutdown POST,
  a recording `spawnBroker`, and a `reconnect` returning `script.reconnect`. `repo` is a real temp folder holding
  empty `server.mjs` and `scripts/install-extension.mjs`; `copilotHome` a temp folder; `"<repo>"` in a health
  state stands for that repo path. `calls.order` holds the kind of each effect the first time it is used
  (`git`, `node` for the `node -p` lookup, `npm`, `installer`, `shutdown`, `spawn`, `reconnect`; `/health` reads
  are not listed).

```js
test("a full run: six steps in order, summary with pid and commit", async (t) => {
  const { fx, calls, input } = fakeFx(t, {
    update: { before: "abc1234", after: "def5678" },
    health: [{ pid: 100, app: "copilot-relay" }, null, { pid: 200, app: "copilot-relay", root: "<repo>" }],
    reconnect: { total: 2, back: 2 },
  });
  const seen = [];
  const out = await runRestart(input, fx, (s) => seen.push(`${s.id}:${s.status}`));
  assert.equal(out.ok, true);
  assert.deepEqual(out.steps.map((s) => s.status), ["done", "done", "done", "done", "done", "done"]);
  assert.deepEqual(seen.filter((s) => s.endsWith(":running")).map((s) => s.split(":")[0]), STEP_IDS);
  assert.equal(out.steps[1].detail, "abc1234 → def5678");
  assert.equal(out.steps[3].detail, "stopped pid 100");
  assert.equal(out.steps[4].detail, "pid 200");
  assert.equal(out.steps[5].detail, "2 of 2 sessions reconnected");
  assert.equal(out.summary, "Broker running: pid 200, commit def5678.");
  assert.deepEqual(calls.order, ["git", "node", "npm", "installer", "shutdown", "spawn", "reconnect"]); // install before stop
});
```

  Further tests (each asserts the step statuses, the failing step's exact `detail`, the `summary`, and that no later
  effect was called):
  - check: a folder without `server.mjs`; git's top level is another folder; URL `http://10.0.0.5:7777`; `node`
    not found (`ENOENT` from `run`). In each, `calls.order` has no `npm`, `shutdown` or `spawn`.
  - update fails with `err.stash` set (Review Focus 1): detail and summary both end with the stash sentence; no
    `npm` call.
  - `npm ci` runs on every run, with `cwd` = repo and `timeoutMs` 300 000, also when `before === after`.
  - installer arguments and env: installed config with a `brokerScript` → no `--no-autostart`; installed with
    `brokerScript: null` → `--no-autostart`; nothing installed → no `--no-autostart`; `COPILOT_RELAY_PORT` is the
    URL's port (`"7790"` for `http://127.0.0.1:7790`) in all three; the program is the resolved Node, never
    `process.execPath` of the test unless that is what `readInstalled` returned.
  - install fails: summary `Stopped at Install. The broker was not restarted.`; no shutdown.
  - no broker running: stop is `skipped` with `no broker was running`; the start check accepts any pid.
  - an old broker (shutdown answers 404): the 404 detail; summary `Stopped at Stop. The old broker is still running.`;
    no spawn.
  - something else on the port (`/health` answers `{ ok: true }` without `app`) (Review Focus 4): the
    "Something else answers" detail; no shutdown POST; no spawn.
  - the broker answers the shutdown and keeps answering with the same pid (Review Focus 4): fails after 10 s of
    virtual time with `The broker did not stop within 10 s.`; no spawn.
  - the port taken by another starter: after the stop, `/health` answers pid 300 with `root` = repo while our spawn
    "exits": start is done with `pid 300`.
  - a broker from another folder: `root: "/somewhere/else"` → `A broker from another folder answers: /somewhere/else.`
    and summary `Stopped at Start. A different broker is running.`
  - a start that never answers: fails after 15 s of virtual time; summary ends
    `No broker is running; opening a session starts it.`
  - sessions not back: `reconnect: { total: 3, back: 1 }` → the step is `done` with `warning: true`,
    `1 of 3 sessions reconnected`, and `out.ok === true`.
  - no sessions: `reconnect: { total: 0, back: 0 }` → `skipped`, `no open sessions`.
  - `sameFolder` (Review Focus 3): `("/a/b", "/a/b/")` true; `("C:\\Repo", "c:\\repo\\", "win32")` true and
    `("/a/B", "/a/b", "linux")` false; a temp folder and a symlink to it are the same (skip the symlink case when
    creating one fails with `EPERM`).
  - `readInstalled`: no file → `{ installed: false, brokerScript: null, nodePath: null }`; a file with
    `brokerScript: null` → `installed: true, brokerScript: null`.
  - `npmCommand`: the four cases (win32/linux × found/not found) with an injected `exists`.
  - `reconnectClients` (Review Focus 5): clients answering `true`, `false` and never, `ms = 50` →
    `{ total: 3, back: 1 }` after about 50 ms; an empty list → `{ total: 0, back: 0 }` at once.
  - `createRestarter`: `start` returns `true`, a second `start` during the run returns `false`; the first
    notification has `running: true` and six `pending` steps; the last has `running: false`, `ok` and `summary`;
    `snapshot()` afterwards equals the last notification; a new `start` is accepted again.

- [ ] **Step 2: Run** `node --test electron/test/broker-restart.test.mjs` → fail (module missing).

- [ ] **Step 3: Implement** `broker-restart.mjs`.

- [ ] **Step 4: Run** `npm test` → all pass.

- [ ] **Step 5: Commit** `feat(desktop): the broker restart run (check, update, install, stop, start, reconnect)`.

---

### Task 5: End to end against a real broker

**Files:**
- Create: `electron/test/broker-restart-e2e.test.mjs`

**Interfaces:**
- Consumes: `startBroker`, `until` (Task 1); `reconnectNow()` (Task 2); `repoWithRemote` (Task 3); `runRestart`,
  `realEffects`, `reconnectClients`, `sameFolder` (Task 4).

- [ ] **Step 1: Write the test** `"the run updates a repo copy and replaces its running broker"` (test timeout 60 s):
  1. `repoWithRemote(t)`: a bare remote and a clone `repo` on `main`. Copy into the clone, commit and push:
     `server.mjs`, `src/`, `public/`, `scripts/`, `extension/`, `package.json`, `package-lock.json`,
     `relay.config.json`, `.gitignore`. Link `repo/node_modules` to this repo's `node_modules`
     (`symlinkSync(target, link, "junction")`); `.gitignore` keeps it out of `git status`.
  2. `upstream("MARK.txt", "x")`: one more commit on the remote.
  3. `const old = await startBroker(t, { script: path.join(repo, "server.mjs") })`. Connect two sessions with
     `old.connect(...)`; one sends "before" to the other and it arrives.
  4. `fx = realEffects({ reconnect: (ms) => reconnectClients([a.client, b.client], ms) })`, with two wrappers:
     `run` answers `{ stdout: "", stderr: "" }` for the `npm ci` call and records it (no network in tests);
     `spawnBroker` adds `COPILOT_RELAY_NAMES_FILE` and `COPILOT_RELAY_DELEGATIONS_FILE` (temp files) to `env`, so
     the test never touches the user's relay state.
  5. `const out = await runRestart({ repo, url: old.url, copilotHome: path.join(tmp, "copilot-home") }, fx)`.
  6. In `t.after`, before the folders are removed: `POST /api/shutdown` to the new broker and wait until `/health`
     does not answer.

  Assertions: `out.ok === true` and every step is `done` without `warning` (print `out.steps` in the failure
  message); `await old.exited` is `0`; `/health` now has a pid other than `old.proc.pid` and a `root` that is
  `sameFolder` as `repo`; `repo/MARK.txt` exists; `copilot-home/extensions/copilot-relay/config.json` has
  `url === old.url` and a `brokerScript` in `repo`; the `npm ci` call was recorded once with `cwd === repo`;
  `out.steps[5].detail === "2 of 2 sessions reconnected"`; a message "after" sent by one session reaches the other.

- [ ] **Step 2: Run** `node --test electron/test/broker-restart-e2e.test.mjs` → pass. If it fails, the fault is in
  Tasks 1 to 4: fix it there, with a unit test for it in that task's test file.

- [ ] **Step 3: Run** `npm test` twice in a row → all pass both times (no broker left behind, no port clash).

- [ ] **Step 4: Commit** `test(desktop): restart a real broker from a temp repo`.

---

### Task 6: Settings section and wiring

**Files:**
- Create: `electron/renderer/broker-restart.js`, `electron/test/broker-restart-ui.test.mjs`
- Modify: `electron/main.mjs` (imports; `dialog:pickDir` ~1035; `settings:get` ~1040; `settings:set` ~1051; new
  handlers beside them), `electron/preload.cjs`, `electron/renderer/index.html` (`dialog#settings`, before
  `<h3>Files</h3>`; script tag before `app.js`), `electron/renderer/app.js` (`openSettings` ~3202, close handler
  ~3251), `electron/renderer/style.css`, `electron/package.json` (`build.files`), `scripts/ui-check/checks.mjs`,
  `electron/README.md`

**Interfaces:**
- Consumes: `createRestarter`, `realEffects`, `reconnectClients` (Task 4).
- Produces (renderer module, `globalThis.BrokerRestart`):
  - `restartQuestion({ working, acpSessions }) → string | null`: `null` when both are 0. Otherwise the sentences
    that apply, joined by a space, then ` Restart the broker now?`:
    `1 session is working; its relay tools will not answer for a few seconds.` /
    `<n> sessions are working; their relay tools will not answer for a few seconds.` and
    `1 session started from the broker's web page will end.` /
    `<n> sessions started from the broker's web page will end.`
  - `stepRow(step) → { mark, text, cls }`: marks `○` pending, `…` running, `✓` done, `✗` failed, `–` skipped, and
    `!` for a done step with `warning`; `cls` is the status, or `warning`; `text` is `<label>: <detail>`, or the
    label alone without a detail.
- Produces (IPC, all through `handle`):
  - `broker:status` → `{ ...restarter.snapshot(), working, acpSessions }`. `working`: open sessions with
    `prompting` or a pending permission. `acpSessions`: from `GET <relay url>/health` (2 s limit), `0` when it does
    not answer or has no such field.
  - `broker:restart(repo)` → `restarter.start({ repo: <trimmed repo, or the default>, url: relayConfig().url, copilotHome: process.env.COPILOT_HOME || undefined })`.
  - event `broker:restart` → the snapshot, sent by the restarter's `notify`.
  - `settings:get` adds `brokerRepo` (stored value or `""`) and `brokerRepoDefault` (the folder of
    `relayConfig().brokerScript`, or `""`). `settings:set` stores `brokerRepo` trimmed.
  - `dialog:pickDir(title)`: the dialog title, default `"Folder for the new session"` as today.
- Produces (preload): `brokerStatus()`, `brokerRestart(repo)`, `onBrokerRestart(fn)`, `pickDir(title)`.
- Markup ids: `#set-broker-repo` (input), `#set-broker-browse`, `#broker-restart`, `#broker-steps` (`ul`),
  `#broker-summary`. Both buttons are `type="button"` (the dialog's form would close on any other).

- [ ] **Step 1: Write the failing unit tests** in `broker-restart-ui.test.mjs` (load the module with
  `createRequire`, as `schedule-form.test.mjs` does):

```js
test("restartQuestion", () => {
  assert.equal(restartQuestion({ working: 0, acpSessions: 0 }), null);
  assert.equal(restartQuestion({ working: 1, acpSessions: 0 }),
    "1 session is working; its relay tools will not answer for a few seconds. Restart the broker now?");
  assert.equal(restartQuestion({ working: 3, acpSessions: 2 }),
    "3 sessions are working; their relay tools will not answer for a few seconds. 2 sessions started from the broker's web page will end. Restart the broker now?");
  assert.equal(restartQuestion({ working: 0, acpSessions: 1 }),
    "1 session started from the broker's web page will end. Restart the broker now?");
});

test("stepRow", () => {
  assert.deepEqual(stepRow({ label: "Update", status: "done", detail: "abc1234 → def5678" }), { mark: "✓", text: "Update: abc1234 → def5678", cls: "done" });
  assert.deepEqual(stepRow({ label: "Start", status: "pending", detail: "" }), { mark: "○", text: "Start", cls: "pending" });
  assert.deepEqual(stepRow({ label: "Reconnect", status: "done", detail: "1 of 3 sessions reconnected", warning: true }), { mark: "!", text: "Reconnect: 1 of 3 sessions reconnected", cls: "warning" });
});
```

  Plus one assertion per remaining mark (`running`, `failed`, `skipped`).

- [ ] **Step 2: Run** → fail. **Implement** `broker-restart.js`. **Run** → pass.

- [ ] **Step 3: Wire the main process and preload** as in Interfaces. The restarter is created once:
  `createRestarter({ fx: realEffects({ reconnect: (ms) => reconnectClients([...open.values()].map((e) => e.relay).filter(Boolean), ms) }), notify: (s) => send("broker:restart", s) })`.
  The button works with the relay switched off in the app too (Reconnect is then skipped).

- [ ] **Step 4: Packaging.** Run `node --test electron/test/packaging.test.mjs` → fails, naming
  `run-program.mjs`, `broker-git.mjs` and `broker-restart.mjs`. Add the three to `build.files` in
  `electron/package.json`. Run again → pass.

- [ ] **Step 5: The section.** In `index.html`, before `<h3>Files</h3>`:

```html
<h3>Relay broker</h3>
<label>
  Repository folder
  <span class="field-row"><input id="set-broker-repo" spellcheck="false" /><button id="set-broker-browse" type="button">Browse…</button></span>
</label>
<p class="hint">The copilot-relay folder the broker runs from. The button brings it to the latest main (uncommitted changes go to a stash), installs it and restarts the broker. The app and its sessions stay open.</p>
<div class="store-actions"><button id="broker-restart" type="button">Update and restart broker</button></div>
<ul id="broker-steps"></ul>
<p class="hint" id="broker-summary"></p>
```

  In `app.js`:
  - `openSettings` sets the field to `s.brokerRepo || s.brokerRepoDefault` and renders `await api.brokerStatus()`.
  - One function renders a snapshot: a `li` per step with `stepRow`'s mark, text and class; the summary; the
    button disabled while `running`. `api.onBrokerRestart` calls it, whether the dialog is open or not.
  - Browse: `api.pickDir("copilot-relay repository")` → the field.
  - The button: `const st = await api.brokerStatus(); const q = BrokerRestart.restartQuestion(st);`
    `if (q && !confirm(q)) return;` then `api.brokerRestart(field value)`.
  - The close handler passes `brokerRepo` to `setSettings`: `""` when the field equals `brokerRepoDefault`, else
    the field's value.
  - Closing the dialog does not cancel a run.

  In `style.css`: `.field-row` (input grows, button beside it) and the step list (no bullets, the mark in a fixed
  column, `failed` and `warning` in the existing danger/warning colours).

- [ ] **Step 6: UI check.** Add to `scripts/ui-check/checks.mjs` a check `broker-restart` with `modes: ["off"]`,
  launched with `settings: { brokerRepo: <a path that does not exist> }`:
  1. Open Settings: `#set-broker-repo` holds that path; `#broker-restart` is enabled; `#broker-steps` is empty.
  2. Stub `window.confirm = (m) => ((window.__q = m), false)`, start a turn so the session is working (as
     `drawer-esc` does), click the button: `__q` starts with `1 session is working`, and no step is rendered.
     Let the turn end (or cancel it).
  3. Click again (no question now): six `li` appear; the first has class `failed` and its text starts with
     `Check: Not a copilot-relay folder:`; the other five have class `pending`; `#broker-summary` is
     `Stopped at Check. The broker was not restarted.`; the button is enabled again.
  4. Close and reopen Settings: the same six rows and summary are shown.

  Run `node scripts/ui-check/run.mjs broker-restart` → `ok`. Then `node scripts/ui-check/run.mjs` → exit 0.

- [ ] **Step 7: Run** `npm test` → all pass.

- [ ] **Step 8: Document** in `electron/README.md` (beside the relay paragraph near line 110): what the button
  does step by step, that local changes go to a stash that is named and kept, that a broker started before this
  version must be stopped by hand once, and that sessions in terminals reconnect on their own.

- [ ] **Step 9: Commit** `feat(desktop): update and restart the relay broker from Settings`.

---

## After the last task

Manual checks that no test covers (corporate PC, real Copilot):

- A broker started before this version: the button stops at Stop with the "older than the restart button" text;
  after one manual restart the button completes.
- A relay tool call made by Copilot during the gap fails, and the next call in the same session works without
  reopening the session (spec, "Not verified yet").
- Windows: no console window flashes during git, `npm ci` or the broker start.
