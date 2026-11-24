# Session Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every session can have its own Copilot command (a program with arguments, run by the system shell) that
replaces the Settings command; the Settings command becomes such a line too.

**Architecture:** A pure module turns a command into the line for the shell and says which command a start gets.
`AcpConnection` starts that line with `shell: true` (POSIX: as the leader of its own process group), kills the group,
and reports `exit` only when Copilot is gone. Own commands live in `session-commands.json`, next to the own prompts;
the session's dialog edits both and restarts once.

**Tech Stack:** Node.js (ESM), Electron, vanilla JS renderer, `node:test`, the UI checks in `scripts/ui-check` (Xvfb,
scripted ACP agent).

**Spec:** `docs/superpowers/specs/2026-11-24-session-command-design.md`

## Global Constraints

- Branch `feat/session-command`, cut from `main`, in a worktree (`.claude/worktrees/feat+session-command`). The spec
  and this plan are untracked in the main checkout: move both into the worktree and commit them first
  (`docs: session command spec and plan`).
- Ships as v0.24.0. The tag goes on `main`'s `--no-ff` merge commit, never on a branch commit (CLAUDE.md).
- No new dependencies. Every new module `main.mjs` loads goes into `electron/package.json` `build.files`
  (`packaging.test.mjs` fails otherwise).
- The own command comes only from the user's typing in the app. No model, tool call, relay message or delegation
  request sets it; a child takes it only from its parent's stored command.
- A process is never signalled without a pid: `process.kill(-undefined)` throws and `process.kill(0)` would signal
  the app's own group.
- No `alert`/`confirm`/`prompt` browser dialogs.
- Tests: `npm test` from the repo root. UI checks: `npm --prefix electron run copy-relay` once, then
  `node scripts/ui-check/run.mjs <name…>`.
- Commits: `feat(desktop): …`, `test(desktop): …`, `docs: …`. Each ends with
  `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
- Reviews (CLAUDE.md): task reviews and re-reviews on `model: opus`, `effort: high`; the whole-branch review on
  `model: fable`, `effort: medium`. Findings that are not fixed go to
  `docs/superpowers/backlog/2026-11-24-session-command-deferred.md` before the worktree is removed.
- Exact values and texts:

| Id | Value |
|---|---|
| `COMMAND_MAX` | `4000` |
| `START_TIMEOUT_MS` | `60_000` |
| `START_TIMEOUT_TEXT` | `Copilot did not answer within 60 seconds.` |
| `KILL_GRACE_MS` (POSIX, `SIGTERM` to `SIGKILL`) | `3000` (today's value) |
| group check interval | `50` ms |
| store file | `userData/session-commands.json`, `{ [sessionId]: string }` |
| `REFUSED_BREAK` | `The command must be one line.` |
| `REFUSED_LONG` | `The command is longer than 4000 characters.` |
| `REFUSED_TYPE` | `The command must be text.` |
| `WHERE.session` | `This is this session's own command. Change it in the session's Setup.` |
| `WHERE.settings` | `This is the command from Settings. Change it there, or give this session its own in Setup.` |
| `WHERE.parent` | `This is the parent session's command. Change it in the parent's Setup.` |
| `NOT_FOUND` | `The program was not found, or cannot be run.` |
| button | text `Setup`, title `This session's prompt and Copilot command (saving restarts its Copilot)` |
| dialog title (session) | `Setup: <session title or folder>` |
| field label | `Copilot command` |
| field placeholder | `Settings: <effective Settings command>` |
| field hint | `Empty: the command from Settings. May carry arguments; the app adds --acp --stdio at the end.` |

## Review Focus

1. A command that exits at once without speaking ACP (`echo hi`, a line whose flags went to the wrong program):
   the start fails with the exit text, it does not hang. Test in Task 2.
2. A wrapper that prints its own lines before the agent (`echo banner && <agent>`): the session still starts.
   Test in Task 2.
3. `kill()` and `forceKill()` on a connection that never got a pid (not started, spawn failed) or has exited:
   nothing is signalled, nothing throws. Test in Task 2.
4. A stored value that is not a valid command (a hand-edited `settings.json` or `session-commands.json` with a line
   break, a number, 5000 characters): it counts as "none" and the next source is used. Test in Task 1.
5. `$COPILOT_PATH` holding an existing file with a space in its path: quoted like a Settings value. Test in Task 1.

---

### Task 1: The command module

**Files:**
- Create: `electron/copilot-command.mjs`
- Modify: `electron/package.json` (`build.files`)
- Test: `electron/test/copilot-command.test.mjs`

**Interfaces:**
- Produces:
  - `COMMAND_MAX: number`
  - `normalizeCommand(value: unknown): { command: string } | { refused: string }` — trimmed; `""` is valid ("none").
  - `resolveCommand({ own?: unknown, settings?: unknown, envPath?: unknown, ownSource?: "session" | "parent" }): { command: string, source: "session" | "parent" | "settings" }`
    — the first valid non-empty of own, settings, envPath, else `copilot`. A value `normalizeCommand` refuses counts
    as none. `source` is `ownSource` (default `"session"`) when own won, else `"settings"`.
  - `shellLine(command: string, args: string[], opts?: { platform?: string, isFile?: (p: string) => boolean, pathext?: string }): string`
  - `startFailureText({ command: string, source: "session" | "parent" | "settings", detail: string, notFound: boolean, login: boolean, loginHint: string, generalHint: string }): string`
    — `Could not start "<command>": <detail>`, a blank line, then: `loginHint` when `login`; else `NOT_FOUND` + a
    space + `WHERE[source]` when `notFound`; else `generalHint` + a space + `WHERE[source]`.
  - `isNotFoundExit(error: { exitCode?: number }, platform?: string): boolean` — POSIX and exit code 127 or 126.

- [ ] **Step 1: Write the failing tests**

```js
test("normalizeCommand trims and takes an empty command", () => {
  assert.deepEqual(normalizeCommand("  copilot --x  "), { command: "copilot --x" });
  assert.deepEqual(normalizeCommand(""), { command: "" });
});
test("normalizeCommand refuses what is not one line of text", () => {
  assert.deepEqual(normalizeCommand("a\nb"), { refused: "The command must be one line." });
  assert.deepEqual(normalizeCommand("a\rb"), { refused: "The command must be one line." });
  assert.deepEqual(normalizeCommand("a\0b"), { refused: "The command must be one line." });
  assert.deepEqual(normalizeCommand("x".repeat(4001)), { refused: "The command is longer than 4000 characters." });
  assert.deepEqual(normalizeCommand(7), { refused: "The command must be text." });
});
test("resolveCommand: own, then Settings, then $COPILOT_PATH, then copilot", () => {
  assert.deepEqual(resolveCommand({ own: "a", settings: "b", envPath: "c" }), { command: "a", source: "session" });
  assert.deepEqual(resolveCommand({ own: "a", ownSource: "parent" }), { command: "a", source: "parent" });
  assert.deepEqual(resolveCommand({ own: "", settings: "b", envPath: "c" }), { command: "b", source: "settings" });
  assert.deepEqual(resolveCommand({ envPath: "c" }), { command: "c", source: "settings" });
  assert.deepEqual(resolveCommand({}), { command: "copilot", source: "settings" });
});
test("resolveCommand skips a stored value that is not a valid command", () => {   // Review Focus 4
  assert.deepEqual(resolveCommand({ own: "a\nb", settings: 7, envPath: "x".repeat(5000) }), { command: "copilot", source: "settings" });
});
const posix = { platform: "linux", isFile: (p) => p === "/opt/my tools/copilot" || p === "/opt/it's/copilot" };
test("shellLine (POSIX)", () => {
  assert.equal(shellLine("copilot", ["--acp", "--stdio"], posix), "copilot --acp --stdio");
  assert.equal(shellLine("FOO=1 copilot --x", ["--acp", "--stdio"], posix), "FOO=1 copilot --x --acp --stdio");
  assert.equal(shellLine("/opt/my tools/copilot", ["--acp", "--stdio"], posix), "'/opt/my tools/copilot' --acp --stdio"); // Review Focus 5 too
  assert.equal(shellLine("/opt/it's/copilot", ["--acp"], posix), `'/opt/it'\\''s/copilot' --acp`);
  assert.equal(shellLine("/opt/my tools/copilot --x", ["--acp"], posix), "/opt/my tools/copilot --x --acp"); // not a file: as written
  assert.equal(shellLine("my tools/copilot", ["--acp"], { ...posix, isFile: () => true }), "my tools/copilot --acp"); // relative: never checked
});
const win = { platform: "win32", pathext: ".COM;.EXE;.CMD", isFile: (p) => p === "C:\\Program Files\\GH\\copilot.EXE" || p === "C:\\Users\\me\\npm\\copilot.cmd" };
test("shellLine (Windows)", () => {
  assert.equal(shellLine("C:\\Users\\me\\npm\\copilot.cmd", ["--acp"], win), '"C:\\Users\\me\\npm\\copilot.cmd" --acp');
  assert.equal(shellLine("C:\\Program Files\\GH\\copilot", ["--acp"], win), '"C:\\Program Files\\GH\\copilot" --acp'); // PATHEXT
  assert.equal(shellLine('"C:\\Program Files\\GH\\copilot.exe" --x', ["--acp"], win), '"C:\\Program Files\\GH\\copilot.exe" --x --acp');
  assert.equal(shellLine("copilot --x", ["--acp"], win), "copilot --x --acp");
});
test("shellLine refuses an argument of the app that is not a plain word", () => {
  assert.throws(() => shellLine("copilot", ["--context", "a b"], posix));
});
test("startFailureText names the command and where it is set", () => {
  const base = { command: "cop --x", detail: "copilot exited (127)", loginHint: "LOGIN", generalHint: "GENERAL" };
  assert.equal(startFailureText({ ...base, source: "session", notFound: true, login: false }),
    'Could not start "cop --x": copilot exited (127)\n\nThe program was not found, or cannot be run. This is this session\'s own command. Change it in the session\'s Setup.');
  assert.equal(startFailureText({ ...base, source: "parent", notFound: false, login: false }),
    'Could not start "cop --x": copilot exited (127)\n\nGENERAL This is the parent session\'s command. Change it in the parent\'s Setup.');
  assert.equal(startFailureText({ ...base, source: "settings", notFound: false, login: true }), 'Could not start "cop --x": copilot exited (127)\n\nLOGIN');
});
test("isNotFoundExit", () => {
  assert.equal(isNotFoundExit({ exitCode: 127 }, "linux"), true);
  assert.equal(isNotFoundExit({ exitCode: 126 }, "darwin"), true);
  assert.equal(isNotFoundExit({ exitCode: 1 }, "linux"), false);
  assert.equal(isNotFoundExit({ exitCode: 127 }, "win32"), false);
});
```

- [ ] **Step 2: Run them** — `node --test electron/test/copilot-command.test.mjs`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement the module.** `shellLine`: the existing-file check runs only for `path.win32.isAbsolute` /
  `path.posix.isAbsolute` values (by `platform`); on Windows it also tries `command + ext` for each `pathext` entry.
  The default `isFile` is `statSync(p).isFile()` with a caught error as `false`. Each of `args` must match
  `/^[\w-]+$/`, else throw. Add `"copilot-command.mjs"` to `build.files`.

- [ ] **Step 4: Run them** — same command, then `node --test electron/test/packaging.test.mjs`. Expected: PASS.

- [ ] **Step 5: Commit** — `feat(desktop): the Copilot command as a shell line`

---

### Task 2: Start through the shell, kill the group, exit when Copilot is gone

**Files:**
- Modify: `electron/acp.mjs` (`start`, `kill`, the `exit` handling)
- Modify: `electron/test/fixtures/acp/fake-agent.mjs` (answer `initialize` with `{ argv, foo: process.env.FOO ?? null, pid: process.pid }`)
- Create: `electron/test/fixtures/acp/stubborn-agent.mjs` — as the fake agent, but it ignores `SIGTERM`, starts a
  child `node -e "setInterval(() => {}, 1000)"` (not detached) and answers `initialize` with `{ pid, childPid }`
- Modify: `scripts/ui-check/checks.mjs` (`agentPids`)
- Test: `electron/test/acp.test.mjs`

**Interfaces:**
- Consumes: `shellLine` (Task 1); `killTree(child, signal, sync?)` from `electron/job-runner.mjs` (import it, as
  `run-program.mjs` does).
- Produces (`AcpConnection`):
  - `new AcpConnection({ command, cwd, env?, args?, pollMs? })` — `command` is the user's line; `conn.command` keeps it.
  - `start()` spawns `shellLine(command, ["--acp", "--stdio", ...args])` with `{ shell: true, detached: !isWin, windowsHide: true }` and no argument array.
  - `kill()` — closes stdin; Windows: `taskkill` as today; POSIX: `SIGTERM` to the group, `SIGKILL` to the group after 3000 ms unless `exited`.
  - `forceKill()` — Windows: as `kill()`; POSIX: `SIGKILL` to the group at once.
  - `exited` / event `exit` `{ code, signal, stderr }` — POSIX: at the shell's exit when it exited with a code; when a
    signal ended it, only after the group is empty (checked every `pollMs`, default 50), and if this connection did
    not call `kill()` itself it calls it then. Windows: at the wrapper's exit, as today.
  - The error that rejects pending requests at exit carries `exitCode` (number or `null`) and `signal`.

- [ ] **Step 1: Rewrite the test helpers so the agent runs on Windows too**

```js
const NODE = `"${process.execPath}"`;
const agent = (file, extra = "") => `${NODE} "${path.join(FIXTURES, file)}"${extra}`;   // FIXTURES: test/fixtures/acp
const posixOnly = { skip: process.platform === "win32" && "POSIX process groups" };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const exitOf = (conn) => new Promise((r) => conn.once("exit", r));
```

The two existing tests lose `posixOnly` and use `command: agent("fake-agent.mjs")`.

- [ ] **Step 2: Write the failing tests**

```js
test("arguments in the command come before --acp --stdio", async () => {
  assert.deepEqual((await initOf({ command: agent("fake-agent.mjs", ' --tag "one two"') })).argv, ["--tag", "one two", "--acp", "--stdio"]);
});
test("an existing file with a space in its path starts unquoted", posixOnly, async () => {
  // copy fake-agent.mjs (mode 755) into mkdtemp(".../acp test ") and use that path alone as the command
  assert.deepEqual((await initOf({ command: copied })).argv, ["--acp", "--stdio"]);
});
test("a variable before the command reaches the agent", posixOnly, async () => {
  assert.equal((await initOf({ command: `FOO=bar ${agent("fake-agent.mjs")}` })).foo, "bar");
});
test("a wrapper's own output does not break the start", async () => {               // Review Focus 2
  assert.deepEqual((await initOf({ command: `echo banner && ${agent("fake-agent.mjs")}` })).argv, ["--acp", "--stdio"]);
});
test("a command that exits without speaking ACP fails the start", async () => {     // Review Focus 1
  await assert.rejects(new AcpConnection({ command: "echo hi", cwd }).start(), /copilot exited \(0\)/);
});
test("a missing program fails with exit code 127", posixOnly, async () => {
  await assert.rejects(new AcpConnection({ command: "/nonexistent/copilot-x", cwd }).start(), (e) => e.exitCode === 127 && /not found/.test(e.message));
});
test("kill ends the agent and what it started", posixOnly, async () => {
  const conn = new AcpConnection({ command: agent("stubborn-agent.mjs"), cwd });
  const { pid, childPid } = await conn.start();
  const gone = exitOf(conn);
  conn.kill();
  await gone;                                  // stubborn: comes after the SIGKILL at 3 s
  assert.equal(conn.exited, true);
  assert.equal(alive(pid), false);
  assert.equal(alive(childPid), false);
});
test("exit waits for the group when the shell was ended by a signal", posixOnly, async () => {
  const conn = new AcpConnection({ command: agent("stubborn-agent.mjs"), cwd });
  const { pid } = await conn.start();
  let exited = false;
  conn.once("exit", () => (exited = true));
  process.kill(conn.proc.pid, "SIGKILL");      // the shell only, from outside
  await new Promise((r) => setTimeout(r, 300));
  if (conn.proc.pid !== pid) assert.equal(exited, false, "the agent still runs");   // a shell that exec'd is the agent
  await exitOf(conn).catch(() => {});          // or already exited
  assert.equal(alive(pid), false);
});
test("forceKill ends a stubborn agent at once", posixOnly, async () => {
  const conn = new AcpConnection({ command: agent("stubborn-agent.mjs"), cwd });
  const { pid } = await conn.start();
  const t = Date.now();
  conn.forceKill();
  await exitOf(conn);
  assert.ok(Date.now() - t < 2000);
  assert.equal(alive(pid), false);
});
test("kill and forceKill without a process do nothing", () => {                     // Review Focus 3
  const conn = new AcpConnection({ command: "copilot", cwd });
  conn.kill();
  conn.forceKill();
});
```

`initOf(opts)` starts a connection, returns the `initialize` result and kills it in `finally`.

- [ ] **Step 3: Run them** — `node --test electron/test/acp.test.mjs`. Expected: the new tests FAIL.

- [ ] **Step 4: Implement in `acp.mjs`.** Keep `exited` false and hold back `#fail` and the `exit` event while the
  group is being checked. The group is empty when `process.kill(-pid, 0)` throws `ESRCH`. Every signal goes through
  `killTree`, and only when `this.proc?.pid` is a number.

- [ ] **Step 5: Fix `agentPids` in `scripts/ui-check/checks.mjs`.** Through a shell that does not replace itself
  there are two processes whose command line holds `scripted-agent.mjs`. A process counts only when it is the agent:
  split `/proc/<pid>/cmdline` on `\0` and require `argv[1]?.endsWith("scripted-agent.mjs")` (the shell's line is
  `sh -c '<…scripted-agent.mjs>' --acp --stdio`: there the name is in `argv[2]`).

- [ ] **Step 6: Run** — `npm test`, then `npm --prefix electron run copy-relay` and `node scripts/ui-check/run.mjs`
  (all checks). Expected: PASS (job-runner and run-program tests untouched).

- [ ] **Step 7: Commit** — `feat(desktop): Copilot starts through the shell, a close ends its process group`

---

### Task 3: `connect` takes the command, a start has a deadline, a failed start says where the command is set

**Files:**
- Modify: `electron/main.mjs` (`copilotCommand`, `connect`, `getLister`, `closeAndWait`, `settings:get`, `settings:set`)
- Test: `scripts/ui-check/checks.mjs` (`new-session-start-error`, `new-session-start-deadline`), `scripts/ui-check/driver.mjs`

**Interfaces:**
- Consumes: `resolveCommand`, `normalizeCommand`, `startFailureText`, `isNotFoundExit` (Task 1); `conn.forceKill()`,
  `error.exitCode` (Task 2).
- Produces (in `main.mjs`):
  - `settingsCommand(): { command, source: "settings" }` — `resolveCommand({ settings: loadSettings().copilotCommand, envPath: process.env.COPILOT_PATH })`; replaces `copilotCommand()`.
  - `connect(cwd, { deadline, args = [], prompt = "", command = settingsCommand() } = {})` — `command` is a
    `{ command, source }`. The callers of today's positional form are changed with it.
  - `START_TIMEOUT_MS`, `START_TIMEOUT_TEXT`.

- [ ] **Step 1: Extend `new-session-start-error`** (its Settings command is `/nonexistent/copilot-ui-check`): the
  note must also contain `The program was not found, or cannot be run.` and
  `This is the command from Settings.`

- [ ] **Step 2: Add the UI check `new-session-start-deadline`** (POSIX): settings
  `{ copilotCommand: "sh -c 'sleep 30' x" }` (the app's flags become that script's unused arguments) and the app
  started with `COPILOT_RELAY_START_TIMEOUT_MS=1000` in its environment (add an `env` option to `launch` in
  `driver.mjs` if it has none). New session, Start: the note contains `Copilot did not answer within 1 seconds.`,
  the dialog stays open with Start and Cancel enabled, and no process with the work folder as its `cwd` is left
  (`/proc/*/cwd`, as `agentPids` reads it).

- [ ] **Step 3: Run** — `node scripts/ui-check/run.mjs new-session-start-error new-session-start-deadline`.
  Expected: both FAIL (the new text; the dialog never answers).

- [ ] **Step 4: Implement.**
  - `connect`: the start is `withDeadline(conn.start(), Math.min(deadline ?? Infinity, Date.now() + START_TIMEOUT_MS), text)`,
    where `text` is `SETUP_TIMEOUT_TEXT` when the caller's deadline is the nearer one, else `START_TIMEOUT_TEXT`.
    `START_TIMEOUT_MS = Number(process.env.COPILOT_RELAY_START_TIMEOUT_MS) || 60_000` (the variable is for the UI
    check only), and `START_TIMEOUT_TEXT` is built from it: `Copilot did not answer within ${START_TIMEOUT_MS / 1000} seconds.`
    The catch builds the message with `startFailureText` (`notFound: isNotFoundExit(e)`, the two hints from today's
    texts without "set its full path in Settings", which `WHERE` now says). The `ENOENT` branch goes.
  - `closeAndWait`: `conn.forceKill()` replaces both branches (`conn.kill()` on Windows, `conn.proc?.kill("SIGKILL")`).
  - `settings:set`: `normalizeCommand(s.copilotCommand)`; a refusal keeps the stored command, saves the rest and
    `console.warn`s. `settings:get`: `effective: settingsCommand().command`.

- [ ] **Step 5: Run** — `npm test`, then `node scripts/ui-check/run.mjs` (all checks). Expected: PASS.

- [ ] **Step 6: Commit** — `feat(desktop): a start has a deadline and says where its command is set`

---

### Task 4: The own command of a session: stored, used on every start, inherited, copied, removed

**Files:**
- Modify: `electron/session-prompts.mjs` (`createPromptStore` takes a log label)
- Create: `electron/session-setup.mjs`
- Modify: `electron/main.mjs` (`createSession`, `sessions:new`, `openSession`, `createChild`, `sessions:fork`,
  `sessions:delete`, `sessions:getPrompt`, `sessions:setPrompt`), `electron/preload.cjs`, `electron/package.json`
- Test: `electron/test/session-setup.test.mjs`, `electron/test/session-prompts.test.mjs`

**Interfaces:**
- Consumes: `resolveCommand`, `normalizeCommand` (Task 1); `connect(cwd, { command })`, `settingsCommand()` (Task 3);
  `saveAndReopen` (`context-tier.mjs`).
- Produces:
  - `createPromptStore(file, label = "session-prompts")` — the label is the `[label]` of its warnings.
  - `session-setup.mjs`: `saveSetup({ sessionId, own, command, prompts, commands, refusal, close }): Promise<{ refused: string } | { unchanged: true } | { reopen: true }>`
    — refusals in this order: `own` not a string (`The session's prompt must be text.`), `normalizeCommand`'s,
    `refusal()`'s. Both unchanged: `{ unchanged: true }`, nothing closed. Else both are saved and `close()` runs; a
    failed close restores both and rethrows. If saving the second throws, the first is restored.
  - `main.mjs`: `commands` store; `commandFor(sessionId): { command, source }` —
    `resolveCommand({ own: commands.get(sessionId), settings: …, envPath: … })`.
  - `createSession(cwd, link = {}, deadline, tier = null, own = "", command = "", commandSource = "session")`.
  - IPC `sessions:new(cwd, own = "", command = "")`; `sessions:getPrompt` adds `command` (the stored own one) and
    `settingsCommand` (the effective Settings command); `sessions:setPrompt(sessionId, own, command)` runs `saveSetup`.
  - preload: `newSession(cwd, own = "", command = "")`, `setPrompt(sessionId, own, command = "")`.

- [ ] **Step 1: Write the failing tests** (`session-setup.test.mjs`; `store()` is `createPromptStore` on a temp file)

```js
const setup = (o) => saveSetup({ sessionId: "s", refusal: () => null, close: async () => {}, prompts, commands, ...o });
test("nothing changed: nothing is closed", async () => {
  prompts.set("s", "p"); commands.set("s", "c");
  let closed = 0;
  assert.deepEqual(await setup({ own: "p", command: " c ", close: async () => void closed++ }), { unchanged: true });
  assert.equal(closed, 0);
});
test("a change of both is saved and closes once", async () => {
  let closed = 0;
  assert.deepEqual(await setup({ own: "p2", command: "c2 --x", close: async () => void closed++ }), { reopen: true });
  assert.deepEqual([prompts.get("s"), commands.get("s"), closed], ["p2", "c2 --x", 1]);
});
test("an empty command removes the entry", async () => {
  commands.set("s", "c");
  await setup({ own: "", command: "" });
  assert.equal(commands.get("s"), "");
});
test("a refused command changes nothing", async () => {
  prompts.set("s", "p");
  assert.deepEqual(await setup({ own: "new", command: "a\nb" }), { refused: "The command must be one line." });
  assert.equal(prompts.get("s"), "p");
});
test("a guard's refusal changes nothing", async () => {
  assert.deepEqual(await setup({ own: "new", command: "c", refusal: () => "Wait until Copilot finishes this turn." }), { refused: "Wait until Copilot finishes this turn." });
  assert.equal(prompts.get("s"), "");
});
test("a failed close restores both", async () => {
  prompts.set("s", "p"); commands.set("s", "c");
  await assert.rejects(setup({ own: "p2", command: "c2", close: async () => { throw new Error("stuck"); } }), /stuck/);
  assert.deepEqual([prompts.get("s"), commands.get("s")], ["p", "c"]);
});
```

In `session-prompts.test.mjs`: a store on a file that holds `{ "s": 7 }` gives `get("s") === ""`.

- [ ] **Step 2: Run them** — `node --test electron/test/session-setup.test.mjs`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `session-setup.mjs` and the label; add the module to `build.files`.** Run the tests: PASS.

- [ ] **Step 4: Wire `main.mjs`.**
  - `commands = createPromptStore(path.join(app.getPath("userData"), "session-commands.json"), "session-commands")`.
  - `createSession`: normalize `command` (a refusal throws its text); connect with
    `resolveCommand({ own: command, ownSource: commandSource, settings…, envPath… })`; after `session/new`, next to
    `prompts.set`, `commands.set(res.sessionId, command)`.
  - `openSession`: `command: commandFor(sessionId)`.
  - `createChild`: passes `commands.get(parentSessionId)` and `"parent"`.
  - `sessions:fork`: `commands.copy`. `sessions:delete`: `commands.delete`, where the prompt's is.
  - `sessions:setPrompt`: `saveSetup({ …restartGuards(sessionId), sessionId, own, command, prompts, commands })` after
    the session id check.
  - The lister keeps `settingsCommand()` (the default of `connect`).

- [ ] **Step 5: Run** — `npm test`, then `node scripts/ui-check/run.mjs` (all). Expected: PASS (the renderer still
  sends no command: `""`).

- [ ] **Step 6: Commit** — `feat(desktop): a session keeps its own Copilot command`

---

### Task 5: The window: the command field, Setup, a dead view, the Settings hint

**Files:**
- Modify: `electron/renderer/prompt-editor.js` (`createPromptEditor`, `openPromptDialog`),
  `electron/renderer/app.js` (`newSession`, `editPrompt`, `setBusy`, the button at line 339, `openSettings`,
  `RESTART_NOTE`), `electron/renderer/index.html` (`#set-command`), `electron/renderer/style.css`
- Modify: `electron/test/fixtures/acp/scripted-agent.mjs` — at start, when `SCRIPTED_ARGV_FILE` is set, append
  `JSON.stringify(process.argv.slice(2)) + "\n"` to that file
- Test: `electron/test/prompt-editor.test.mjs`, `scripts/ui-check/checks.mjs`

**Interfaces:**
- Consumes: `api.newSession(cwd, own, command)`, `api.setPrompt(sessionId, own, command)`, `api.getPrompt` →
  `{ own, command, settingsCommand, … }` (Task 4); `api.getSettings().effective`.
- Produces:
  - `createPromptEditor({ …, command?: { value: string, settings: string } })` — with `command`, the field of the
    Global Constraints table is added under the text area: `<input class="pe-command" maxlength="4000" spellcheck="false">`.
    Returns `{ el, value(), command(), focus() }`; `command()` is `""` without the field.
  - `openPromptDialog`: `onOk(text, command)`.

- [ ] **Step 1: Write the failing unit tests** (`prompt-editor.test.mjs`, with its existing DOM helper)

```js
test("the command field shows the stored command and the Settings one as placeholder", () => {
  const e = createPromptEditor({ ...base, command: { value: "cop --x", settings: "copilot" } });
  const input = e.el.querySelector(".pe-command");
  assert.equal(input.value, "cop --x");
  assert.equal(input.placeholder, "Settings: copilot");
  assert.equal(input.maxLength, 4000);
  assert.equal(e.command(), "cop --x");
});
test("without command there is no field", () => {
  const e = createPromptEditor(base);
  assert.equal(e.el.querySelector(".pe-command"), null);
  assert.equal(e.command(), "");
});
```

- [ ] **Step 2: Write the failing UI checks** (in `scripts/ui-check/checks.mjs`; `ARGV` is a file in `app.dir`,
  `AGENT` the scripted agent's path, `D` the dialog, `btn` = `${V}.el.querySelector(".head .prompt-btn")`)

  - `session-command-new`: `newSession(work)`; type `SCRIPTED_ARGV_FILE='<ARGV>' '<AGENT>' --tag one` into
    `.pe-command`; Start. The view opens; the last line of `ARGV` is `["--tag","one","--acp","--stdio"]`;
    `session-commands.json` in the app's data folder holds that line for the session id.
  - `session-command-setup`: on an open session, `btn.textContent === "Setup"` and its title is the table's; click
    it; the dialog's title starts with `Setup: `; `.pe-command` is empty with the placeholder
    `Settings: <AGENT>`; set the command of the check above with `--tag two` and change the prompt text too;
    "Save and restart". `ARGV` gets exactly one more line, `["--tag","two","--acp","--stdio"]`. Open Setup again
    and press "Save and restart" unchanged: no new line.
  - `session-command-repair`: Setup, command `/nonexistent/copilot-ui-check`, save. The view is dead and its error
    contains `This is this session's own command.` `btn.disabled === false`; click it, clear the field, save: the
    view is alive again and `session-commands.json` has no entry for it.
  - `session-command-fork-delete`: a session with an own command, forked from a message: the fork's id has the same
    entry; deleting the fork removes it.
  - `settings-command-hint`: `#set-hint` contains `May carry arguments`, `--acp --stdio` and `Currently used:`;
    `#set-command.maxLength === 4000`.
  - Update the checks that read the button's text or the dialog's title (`Prompt`, `Prompt: `) to the new ones.

- [ ] **Step 3: Run** — `node --test electron/test/prompt-editor.test.mjs` and
  `node scripts/ui-check/run.mjs session-command-new session-command-setup session-command-repair session-command-fork-delete settings-command-hint`.
  Expected: FAIL.

- [ ] **Step 4: Implement.**
  - `newSession`: `command: { value: "", settings: s.effective }`; `onOk(own, command)` calls
    `api.newSession(cwd, own, command)`.
  - `editPrompt`: opens on a dead view too (it returns only while `busy`, `deleting`, or the dialog is open); the
    editor gets `command: { value: p.command, settings: p.settingsCommand }`; title `Setup: …`; `onOk` sends both.
    On a dead view `setBusy(true)` is skipped and a `{ reopen: true }` goes through `restarted` as today.
  - `setBusy`: `this.promptBtn.disabled = b || this.deleting` (no longer off for a dead view).
  - The button: text and title of the table. `RESTART_NOTE` stays.
  - The child's approval card passes no `command`: no field there.
  - `openSettings`: the hint becomes

    ```
    Leave empty to use "copilot" from PATH (or $COPILOT_PATH). Currently used: <effective>
    May carry arguments; the system shell runs it and the app adds --acp --stdio at the end.
    Quote a path with spaces, or give the path alone, e.g. <example>
    A session can have its own command in its Setup. Find Copilot with: <where copilot | which copilot>
    ```

    and `#set-command` gets `maxlength="4000"`.

- [ ] **Step 5: Run** — `npm test`, then `npm --prefix electron run copy-relay` and `node scripts/ui-check/run.mjs`
  (all). Expected: PASS.

- [ ] **Step 6: Commit** — `feat(desktop): a session's Copilot command in its Setup dialog`

---

### Task 6: A child takes its parent's command; the notes for the hand checks

**Files:**
- Test: `scripts/ui-check/checks.mjs`
- Modify: `README.md` (the paragraph on the Copilot command, if it has one), `docs/superpowers/backlog/2026-11-24-session-command-deferred.md` (created when the branch is finished)

**Interfaces:**
- Consumes: everything above; the `child-card-prompt` check's scenario (`CHILD_PROMPT_SCENARIO`, a real broker).

- [ ] **Step 1: Write the UI checks**
  - `child-command-inherited`: as `child-card-prompt`, with the parent given the own command
    `SCRIPTED_ARGV_FILE='<ARGV>' '<AGENT>' --tag parent` before it asks for the child. After Approve:
    `session-commands.json` holds the same line for the child's id, and `ARGV` has a second line with `--tag parent`.
    The approval card has no `.pe-command`.
  - `child-command-broken`: the parent's stored command is replaced in `session-commands.json` by
    `/nonexistent/copilot-ui-check` while the parent runs; Approve. The parent is told (the scripted scenario
    records what `tellParent` sent) a text that contains `This is the parent session's command.`; no child view.

- [ ] **Step 2: Run** — `node scripts/ui-check/run.mjs child-command-inherited child-command-broken`. Expected: PASS
  (Task 4 built it); a failure here is a bug of Task 4 to fix in this task.

- [ ] **Step 3: Run everything** — `npm test` and `node scripts/ui-check/run.mjs`. Expected: PASS.

- [ ] **Step 4: Commit** — `test(desktop): a delegated child starts with its parent's command`

- [ ] **Step 5: When the branch is finished**, write the backlog file (CLAUDE.md) with the findings left open and,
  under "Not verified", the hand checks on the Windows machine: `copilot.cmd` at a path with spaces; a command with
  arguments; a path without its extension; closing a session leaves no Copilot process; and on Linux with the real
  Copilot: whether a command its tool put in the background dies with the session.
