# Spec: Live Copilot quota (`live-quota`)

Extends the usage figures of `electron/usage.mjs` (session credits, context meter, premium quota line). Where the
documents disagree, this one wins.

Implementation starts from `main` (v0.28.0 plus the Windows path test fix, 9b5d513); this feature ships as v0.29.0.

## Intent

The sidebar line `Premium: X / Y used · Z% left` is always about 10% lower ("fewer used") than what the user sees on
GitHub. The cause, verified on 2026-11-25:

- The app does not ask anyone for the quota. `readQuota()` takes the newest `quotaSnapshots.premium_interactions`
  that Copilot CLI wrote into a session's `events.jsonl` (5 most recently changed sessions, last 2 MiB of each).
  That is the server's figure at the moment of that model call, so anything used after it (other sessions, IDE,
  github.com, another machine) is missing.
- Copilot CLI 1.0.115 no longer writes `quotaSnapshots` at all. On the Linux machine the only snapshot left is from
  2026-11-16 (533 / 1500); the 7 newest sessions have none. The figure can only get older.
- The account moved to usage-based billing (`token_based_billing: true`, `access_type_sku: free_limited_copilot`):
  `premium_interactions` now has `entitlement 0`, the pool in use is `chat` (13 / 200). The line shows the wrong
  pool, or nothing.

The user wants the line to match GitHub.

## Goals

1. The quota line shows the account's current figures, asked from Copilot itself when it is shown or refreshed.
2. The live figures come through the Copilot SDK (`@microsoft/copilot-sdk`, `account.getQuota`) talking to the
   Copilot CLI that the app already uses, started with the same command as a session (the Settings command).
3. No browser login, no token handling: the CLI's own login is used.
4. The pool shown is `premium_interactions` when it has an entitlement (`entitlementRequests > 0`) or is unlimited,
   else `chat` under the same rule, else none.
5. When the live query fails, the line falls back to the last live figure kept in memory, else the newest file
   snapshot; it says how old the figure is, and is hidden when the figure is older than one hour.
6. The runtime module is a factory keyed by command, so the planned ACP→SDK migration can take it over (asked by
   the `copilot-sdk-vs-acp-probe` session).

## Non-goals

- The ACP→SDK migration of sessions. Nothing about sessions changes; they keep `copilot --acp --stdio`.
- Session credits (`AI credits`, tokens, lines changed) in the session chip: they stay as they are (read from
  `session.usage_checkpoint`, which the CLI still writes).
- The `completions` pool (IDE code completions): never shown.
- Showing more than one pool at a time, and showing the AI-credit amount of token-based billing in money.
- The runtime bundled with the SDK (`@microsoft/copilot-sdk-<platform>`, about 200 MB per platform).
- Calling `api.github.com/copilot_internal/user` over HTTP (needs a token the app does not have).

## Anti-goals

- A Copilot process left running after the app quit normally, or after it was idle for longer than the idle time.
  (A crash or forced kill of the app is excluded; see "Known limitation".)
- A spawn loop: a broken command restarted on every refresh.
- A figure presented as live when it is not, or an old figure with no age on it.
- A local port another process can use: the runtime listens on 127.0.0.1 only (verified) and refuses a connection
  without the per-start token (verified: `AUTHENTICATION_FAILED`).
- An installer that grows by the SDK's platform runtime.
- Any change to how sessions start, stop, or which command they use.

## Decisions (made with the user)

- Live source: the SDK's `account.getQuota` ("variant A"), not HTTP with a token ("variant B").
- Fallback: the file snapshot with its age, hidden after one hour ("variant 2" as fallback of "variant 1").
- Show the pool with `entitlement > 0`.
- The runtime is the Copilot command the app already uses, started through the system shell like a session, in
  headless TCP mode, not a path given to the SDK and not the bundled runtime.
- A CLI left running after a crash or forced kill of the app is accepted as a known limitation (no pid file, no
  sweep at start); it goes to the backlog.

## Known limitation

The headless CLI does not end when its stdin/stdout/stderr close and has no idle timeout of its own (verified with
CLI 1.0.115). If the app crashes or is killed (Task Manager, `kill -9`), the quota CLI keeps running until it is
killed by hand or the machine restarts. Sessions' ACP processes do not have this problem (they end with their
stdio). Chosen by the user: not handled in this feature; recorded in the backlog when the branch is finished.

## Approaches considered

1. **Installed CLI by path** (`RuntimeConnection.forSpawnedStdio({ path })`): the SDK spawns without a shell, so the
   Settings command would have to be turned into an executable path. Fails for npm's `copilot.cmd` and for any
   command with arguments or shell syntax. Rejected in favour of 4.
2. **Bundled runtime**: works for any command but adds ~200 MB per platform, needs unpacking from asar, lags the CLI
   (1.0.114 vs 1.0.115), and needs `COPILOT_CLI_PATH` removed. Rejected.
3. **Both** (1, then 2): full size cost. Rejected.
4. **Settings command through the shell, SDK over TCP** (picked): the app runs
   `<command> --headless --no-auto-update --port 0` exactly as it runs a session's command (`shellLine`), reads
   `listening on port N` from stdout, and connects with `RuntimeConnection.forTcp("127.0.0.1", N, { connectionToken })`.
   Same command, same CLI version as sessions; works with `copilot.cmd` and commands with arguments; no size cost.
   Measured on Linux: 655 ms from spawn to the quota answer.

## Design

### 1. `electron/copilot-runtime.mjs` (new)

A factory of SDK clients, one per resolved command line, each backed by a CLI process the module owns.

- `withClient({ command }, fn)`: gets or starts the client for `command` (the resolved line, from
  `resolveCommand(...)`), runs `fn(client)`, returns its result. Concurrent calls for the same command share one
  start. The client stays while calls are in flight.
- Start:
  - `spawn(shellLine(command, ["--headless", "--no-auto-update", "--port", "0"]), { shell: true, detached: !isWin,
    windowsHide: true, cwd: os.homedir(), env: { ...process.env, COPILOT_CONNECTION_TOKEN: token } })`, with
    `token = randomUUID()` per start.
  - Wait for `/listening on port (\d+)/i` on stdout (deadline 20 s), then
    `new CopilotClient({ mode: "coding-agent", runtime: RuntimeConnection.forTcp("127.0.0.1", port, { connectionToken: token }) })`
    and `client.start()` (deadline 10 s).
  - Keep draining stdout and stderr after the port line (a full pipe would block the CLI); keep the last 4000
    characters of stderr for the failure message.
  - A start that fails (spawn error, exit, deadline, no port line) kills what was spawned and rejects with a message
    naming the command and the stderr tail. For 60 s after a failure, calls for that command reject at once without a
    new spawn (no spawn loop).
- Process exit (the CLI died): the entry is dropped; the next call starts a new one (subject to the 60 s rule).
- Idle stop: when no call has been made for `idleMs` (default 5 min), the client is stopped and the process killed.
- Stop (idle, `stopAll`): `client.stop()` with a 3 s limit (it only closes the connection: in TCP mode it returns at
  once and leaves the CLI running, verified), then the process tree, which is the step that actually stops it:
  `killTree` from `job-runner.mjs` (Windows `taskkill /T /F`; POSIX SIGTERM to the group, SIGKILL after 3 s), as
  `AcpConnection.kill()` does. The entry counts as stopped once the shell process has exited (POSIX: its group is
  empty).
- `stopAll()`: stops every entry; called from the app's existing quit sequence, which waits for it (bounded like the
  Copilot processes of sessions).
- No session options here (`enableConfigDiscovery`, permission handler, instructions): they belong to the
  migration, which will call `withClient` with a session's own command.
- Injectable `spawn`, SDK module, clock and timers for tests (the module's other code is pure).

### 2. Quota reading (`electron/usage.mjs`)

- `readLiveQuota({ command })`: `withClient({ command }, (c) => c.rpc.account.getQuota({}))`, then `pickPool` on
  `quotaSnapshots`.
- `pickPool(snapshots)`: the first of `premium_interactions`, `chat` whose snapshot is valid and has
  `isUnlimitedEntitlement === true` or `entitlementRequests > 0`; returns `{ pool: "premium" | "chat", used, total,
  remainingPct, resetDate, unlimited, tokenBased }`, or null. `tokenBased` is the picked snapshot's own
  `tokenBasedBilling` (each pool of the live answer carries it; file snapshots lack it → false). The file snapshots
  have the same camelCase field names as `account.getQuota`, so the same function serves both sources.
- A live answer with no qualifying pool is a final "none" (the line is hidden; no fallback to memory or file),
  not a failure.
- Reset date: shown only when `tokenBasedBilling !== true` and the date parses. With token-based billing
  `account.getQuota` returns the current time as `resetDate` (seen on 2026-11-25), so it is not shown.
- `readQuota` (file fallback) keeps its scan, uses `pickPool`, and returns the snapshot's `timestamp` too.
- The quota service (replacing the 60 s cache inside `createUsagePusher`): live first; if it fails, the last
  successful live result kept in memory, if at most one hour old; else the file snapshot, if its timestamp is at most
  one hour old; else null. Result cached 60 s (also a failure). The result carries
  `source: "live" | "earlier" | "file"`, `at` (the figure's time for `earlier` and `file`), and the failure reason
  for `earlier`, `file` and null.
- `refresh({ force: true })` skips the 60 s cache (used by the Refresh button); the 60 s no-respawn rule of the
  runtime still applies.

### 3. Display

- Line (`quotaLine`), same as today with the pool named and the age when not live:
  - `Premium: 533 / 1500 used · 64.5% left · resets Dec 1`
  - `Chat: 13 / 200 used · 93.6% left` (token-based billing: no reset date)
  - `Premium: unlimited` / `Chat: unlimited`
  - fallback (`earlier` or `file`): `… · as of 18:05` (local time; the figure is under an hour old)
- Numbers are shown with at most one decimal (`187.2`), integers without.
- Sidebar `#side-quota`: its tooltip says where the figure is from: `Live from Copilot`,
  `Last live figure; live query failed: <reason>` or `From a session file; live query failed: <reason>`. A null quota hides the line (today it is never hidden once
  shown).
- The session chip tooltip keeps the quota line as today.

### 4. When it refreshes

- Main pushes `quota:update` to the window whenever the service produces a new value: at app start (after the
  window loads), when the window gets focus, and on every usage push (sessions' activity), each subject to the 60 s
  cache; and on the sidebar's Refresh button, which forces a live query (`force`). No timer of its own, so an idle
  app stops its CLI after 5 min.
- The usage view (`usage:update`) keeps carrying the quota line for the session chip.

### 5. Packaging

- `electron/package.json`: `"@microsoft/copilot-sdk": "2.0.1"` (exact, the version of `scripts/sdk-probe`, as the
  migration session asked); `copilot-runtime.mjs` added to `build.files`.
- `build.files` excludes `node_modules/@microsoft/copilot-sdk-*` (the optional platform runtimes), so the installer
  does not grow by ~200 MB. `koffi` (2 MB, native) stays: the SDK imports it only for the in-process runtime, which
  is not used.
- The SDK requires Node `^20.19.0 || >=22.12.0`; Electron 45's Node satisfies it (to be confirmed by the builder).

## Tests

- `pickPool`: premium with entitlement; premium 0 → chat; both 0 → null; unlimited; invalid fields; token-based
  (no reset date).
- `quotaLine`: the forms above, decimals, age suffix.
- Quota service: live wins; live fails → last live result with age; no live result (or older than 1 h) → fresh file
  snapshot with age; file older than 1 h → null; live answer without a qualifying pool → null without fallback;
  cache 60 s for success and failure; `force` skips the cache.
- `copilot-runtime.mjs` with fake spawn and fake SDK: port line parsed (also split across chunks); deadline; exit
  before the port; 60 s no-respawn after failure; shared concurrent start; idle stop after 5 min (none while a call is
  in flight); process exit drops the entry; `stopAll` stops, force-stops after the limit, kills the tree; the token is
  in the child's env and passed to `forTcp`; the line is `shellLine(command, [...])`.
- One optional test against the real CLI (skipped unless `COPILOT_LIVE_TEST=1`): start, `getQuota`, stop, no process
  left.

## Left to the builder

- Where the `quota:update` push is wired in `main.mjs` and how `stopAll` joins the existing quit wait.
- Whether `copilot-runtime.mjs` shares a helper with `AcpConnection` for spawn/kill or uses `killTree` directly.
- Exact renderer wiring (`api.onQuota` in `preload.cjs`).

## Not verified (manual checks after the build)

- Windows (corporate PC): the port line reaches stdout through `cmd.exe`, with `copilot.exe` (WinGet / VS Code shim)
  and with npm's `copilot.cmd`; the process tree is gone after quit and after idle stop.
- A crash of the app leaves the quota CLI running (known limitation, see above): confirm it is the only process left.
- The corporate account's figures in the app match GitHub (the shape of its `account.getQuota` answer was not kept by
  the probe).
- The SDK loads in the packaged app (asar) without the platform runtime package, on Linux and Windows.
- Installer size about the same as v0.28.0.
