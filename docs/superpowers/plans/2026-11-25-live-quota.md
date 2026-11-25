# Live Copilot Quota Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The sidebar quota line shows the account's current figures, asked live from Copilot through the SDK, with
an aged fallback.

**Architecture:** A new `electron/copilot-runtime.mjs` starts the Settings Copilot command through the shell in
headless TCP mode and hands out SDK clients keyed by command. `electron/usage.mjs` gets pool selection, a quota
service (live → last live → file → none, 60 s cache) and the new line/tooltip. `main.mjs` wires the service to a new
`quota:update` push and a `quota:get` IPC; the renderer shows and hides the sidebar line.

**Tech Stack:** Node 22 ESM, Electron 45, `node:test`, `@microsoft/copilot-sdk` 2.0.1.

**Spec:** `docs/superpowers/specs/2026-11-25-live-quota-design.md`

## Global Constraints

- `@microsoft/copilot-sdk` exactly `"2.0.1"` in `electron/package.json` `dependencies` (no `^`).
- `build.files` excludes the platform runtimes: `"!node_modules/@microsoft/copilot-sdk-*/**"`.
- CLI line: `shellLine(command, ["--headless", "--no-auto-update", "--port", "0"])`, `shell: true`,
  `detached: !isWin`, `windowsHide: true`, `cwd: os.homedir()`, env `{ ...process.env, COPILOT_CONNECTION_TOKEN: <randomUUID per start> }`.
- Port: `/listening on port (\d+)/i` on stdout; connect `RuntimeConnection.forTcp("127.0.0.1", port, { connectionToken })`,
  `new CopilotClient({ mode: "coding-agent", runtime })`.
- Deadlines: port line 20 s, `client.start()` 10 s, `getQuota` 10 s. Failure hold (no respawn) 60 s. Idle stop 5 min.
  Kill grace (POSIX SIGTERM → SIGKILL) 3 s. Quota cache 60 s. Fallback max age 1 h.
- Pools in order `premium_interactions` → `chat`; `completions` never. Labels `Premium`, `Chat`.
- No session options (`enableConfigDiscovery`, permission handler, instructions) in `copilot-runtime.mjs`.
- The SDK is loaded with a dynamic `import()` on first start only.
- Copy (exact): `Live from Copilot` · `Last live figure; live query failed: <reason>` ·
  `From a session file; live query failed: <reason>` · ` · as of HH:MM` · `Premium: unlimited` / `Chat: unlimited`.
- Run all tests from the repo root with `npm test`; a single file with `node --test electron/test/<file>`.

## Review Focus

1. A Settings command with arguments or a quoted path with spaces: the spawned line is exactly `shellLine(command, args)` (Task 2 test `spawns the shell line`).
2. The port line split across chunks or after other output (a warning, a banner): it is still found (Task 2 test `finds a split port line after other output`).
3. Quit while a start is still waiting for the port: that process is killed too (Task 2 test `stopAll kills a start in progress`).
4. `getQuota` that never answers: the 10 s deadline turns it into a failure, so the fallback shows (Task 3 test `readLiveQuota times out`).
5. The CLI dies after a good start: the next call starts a new one, without the 60 s hold (Task 2 test `a died process is replaced on the next call`).

---

### Task 1: Pool selection and the quota line

**Files:**
- Modify: `electron/usage.mjs` (`validQuota`, `readQuota`, `quotaLine`, `summarize`)
- Test: `electron/test/usage.test.mjs`

**Interfaces:**
- Produces:
  - `pickPool(snapshots: object|null) -> QuotaPick|null`, where
    `QuotaPick = { pool: "premium"|"chat", used: number, total: number, remainingPct: number, resetDate: string, unlimited: boolean, tokenBased: boolean }`.
  - `readQuota({ copilotHome }) -> Promise<{ quota: QuotaPick, at: number }|null>` (`at` = event `timestamp` in ms).
  - `quotaLine(pick: QuotaPick|null, { at = null, timeZone } = {}) -> string|null`.

- [ ] **Step 1: Write the failing tests** (new `describe("pickPool")`, `describe("quotaLine")`; adapt `readQuota`)

```js
const snap = (o) => ({ isUnlimitedEntitlement: false, entitlementRequests: 1500, usedRequests: 533, remainingPercentage: 64.5, resetDate: "2026-12-01T00:00:00Z", ...o });
test("premium with an entitlement wins", () => {
  assert.deepEqual(pickPool({ premium_interactions: snap(), chat: snap({ entitlementRequests: 200 }) }),
    { pool: "premium", used: 533, total: 1500, remainingPct: 64.5, resetDate: "2026-12-01T00:00:00Z", unlimited: false, tokenBased: false });
});
test("premium 0 falls to chat", () => {
  const p = pickPool({ premium_interactions: snap({ entitlementRequests: 0, usedRequests: 0 }), chat: snap({ entitlementRequests: 200, usedRequests: 13, remainingPercentage: 93.6, tokenBasedBilling: true }), completions: snap({ entitlementRequests: 2000 }) });
  assert.equal(p.pool, "chat"); assert.equal(p.total, 200); assert.equal(p.tokenBased, true);
});
test("only completions → null", () => assert.equal(pickPool({ premium_interactions: snap({ entitlementRequests: 0 }), chat: snap({ entitlementRequests: 0 }), completions: snap() }), null));
test("unlimited premium", () => assert.equal(pickPool({ premium_interactions: { isUnlimitedEntitlement: true, entitlementRequests: -1 } }).unlimited, true));
test("a missing number makes a pool invalid", () => assert.equal(pickPool({ premium_interactions: snap({ usedRequests: undefined }) }), null));
test("a missing resetDate is allowed", () => assert.equal(pickPool({ premium_interactions: snap({ resetDate: undefined }) }).resetDate, ""));
test("null / non-object → null", () => { assert.equal(pickPool(null), null); assert.equal(pickPool("x"), null); });

// quotaLine
const P = { pool: "premium", used: 533, total: 1500, remainingPct: 64.5, resetDate: "2026-12-01T00:00:00Z", unlimited: false, tokenBased: false };
assert.equal(quotaLine(P), "Premium: 533 / 1500 used · 64.5% left · resets Dec 1");
assert.equal(quotaLine({ ...P, pool: "chat", used: 13, total: 200, remainingPct: 93.6, tokenBased: true }), "Chat: 13 / 200 used · 93.6% left");
assert.equal(quotaLine({ ...P, used: 187.25 }), "Premium: 187.3 / 1500 used · 64.5% left · resets Dec 1");
assert.equal(quotaLine({ ...P, unlimited: true }), "Premium: unlimited");
assert.equal(quotaLine({ ...P, pool: "chat", unlimited: true }), "Chat: unlimited");
assert.equal(quotaLine(P, { at: Date.UTC(2026, 10, 25, 18, 5), timeZone: "UTC" }), "Premium: 533 / 1500 used · 64.5% left · resets Dec 1 · as of 18:05");
assert.equal(quotaLine({ ...P, resetDate: "nonsense" }), "Premium: 533 / 1500 used · 64.5% left");
assert.equal(quotaLine(null), null);
```

`readQuota` tests: the existing ones assert `{ quota: { pool: "premium", ... }, at: Date.parse(<fixture timestamp>) }`;
add `picks chat from a file snapshot when premium is 0`; change `ignores snapshots with missing fields` to drop a
numeric field (not `resetDate`).

- [ ] **Step 2: Run** `node --test electron/test/usage.test.mjs` — Expected: FAIL (`pickPool` not exported).

- [ ] **Step 3: Implement** `pickPool`, then make `readQuota` scan for `"quotaSnapshots"` with `pickPool(e?.data?.quotaSnapshots)` as the pick and return `{ quota, at }`; rewrite `quotaLine` as above (numbers: `Math.round(n * 10) / 10`; reset date only when `!tokenBased` and it parses, formatted as today with `timeZone: "UTC"`; `as of` with `toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone })`). `summarize` keeps calling `quotaLine` (its `quota` input becomes a `QuotaState`, Task 3; for now pass `quota?.quota`).

- [ ] **Step 4: Run** `node --test electron/test/usage.test.mjs` — Expected: PASS.

- [ ] **Step 5: Commit** `git commit -am "feat(usage): pick the quota pool with an entitlement, name it in the line"`

---

### Task 2: Copilot runtime factory

**Files:**
- Create: `electron/copilot-runtime.mjs`
- Create: `electron/test/copilot-runtime.test.mjs`
- Create: `electron/test/copilot-runtime-live.test.mjs` (skipped unless `COPILOT_LIVE_TEST=1`)
- Modify: `electron/package.json` (dependency, `build.files`), `electron/package-lock.json`
- Modify: `electron/test/packaging.test.mjs`

**Interfaces:**
- Consumes: `shellLine` (`copilot-command.mjs`), `killTree(child, signal)` (`job-runner.mjs`).
- Produces:

```js
export function createCopilotRuntime({
  spawn, loadSdk = () => import("@microsoft/copilot-sdk"), killTree, platform = process.platform,
  homedir = os.homedir, randomUUID, now = Date.now, setTimeout, clearTimeout,
  idleMs = 300_000, portDeadlineMs = 20_000, startDeadlineMs = 10_000, failureHoldMs = 60_000, killGraceMs = 3_000,
} = {}) -> {
  withClient({ command }: { command: string }, fn: (client) => Promise<T>): Promise<T>,
  stopAll(): Promise<void>,   // resolves when every process exited, or after killGraceMs + 500 ms
  size(): number,             // live entries, for tests
}
```

Errors are `Error` with message `Could not start "<command>": <detail>` followed, if any, by `\n<stderr tail>` (last 4000 chars).

- [ ] **Step 1: Write the failing tests** with a fake `spawn` (an `EventEmitter` with `stdout`/`stderr` `PassThrough`, `pid`, `exitCode`, `signalCode`; records `(line, opts)`), a fake `killTree` (records `(child, signal)`, emits `exit` on the child), a fake SDK (`RuntimeConnection.forTcp` records its args; `CopilotClient` records options, `start()`/`stop()` resolve, `rpc.account.getQuota` resolves), and node:test mock timers.

```js
test("spawns the shell line", ...)            // spawn line === shellLine('"/opt/my copilot" --flag', ["--headless","--no-auto-update","--port","0"]) for that command; opts.shell true, opts.cwd homedir(), opts.env.COPILOT_CONNECTION_TOKEN === randomUUID() result, opts.detached === (platform !== "win32")
test("connects to the printed port with the token", ...) // stdout "CLI server listening on port 41529\n" → forTcp("127.0.0.1", 41529, { connectionToken: <token> }); CopilotClient options.mode === "coding-agent"; fn received that client
test("finds a split port line after other output", ...)  // writes "warning: x\nCLI server listen", then "ing on port 7\n" → port 7
test("shares one start between concurrent calls", ...)   // two withClient calls before the port line → spawn called once, both fns run
test("a deadline without the port line fails and kills", ...) // advance 20_000 → rejects /Could not start ".*": .*port/; killTree called on that child
test("exit before the port line fails with the stderr tail", ...) // stderr "not logged in", emit exit(1) → message contains "not logged in"
test("holds a failure for 60 s", ...)          // after a failure: call at +59_999 rejects without a new spawn; call at +60_000 spawns again
test("a died process is replaced on the next call", ...) // after a good start, child emits exit(0) → size() 0; next call spawns at once (no hold)
test("stops after 5 min idle, not during a call", ...)   // fn pending across 300_000 → no kill; 300_000 after it settles → client.stop() called, killTree(child, "SIGTERM") on POSIX
test("POSIX: SIGKILL after the grace", ...)    // child does not exit on SIGTERM → killTree(child, "SIGKILL") at +3_000
test("Windows: one killTree without a signal", ...) // platform "win32" → killTree(child, undefined)
test("two commands get two processes", ...)    // withClient({command:"a"}), withClient({command:"b"}) → 2 spawns, size() 2
test("stopAll kills a start in progress", ...) // spawn done, no port line yet, stopAll() → killTree on it; the pending withClient rejects; stopAll resolves after exit
test("stopAll resolves even if a process never exits", ...) // killTree that never emits exit → resolves at killGraceMs + 500
```

`copilot-runtime-live.test.mjs`: `test("live: getQuota through the real CLI", { skip: process.env.COPILOT_LIVE_TEST !== "1" }, ...)` — real `spawn`, real SDK, command `copilot`; `withClient` returns `quotaSnapshots` with an object; after `stopAll()`, `process.kill(pid, 0)` throws `ESRCH` for the shell pid.

`packaging.test.mjs`: add `test("the SDK is pinned and its platform runtimes are excluded")` — `dependencies["@microsoft/copilot-sdk"] === "2.0.1"` and `build.files` includes `"!node_modules/@microsoft/copilot-sdk-*/**"`.

- [ ] **Step 2: Run** `node --test electron/test/copilot-runtime.test.mjs electron/test/packaging.test.mjs` — Expected: FAIL (module missing; dependency missing).

- [ ] **Step 3: Install the SDK:** `npm install --prefix electron --save-exact @microsoft/copilot-sdk@2.0.1`; add `"copilot-runtime.mjs"` and `"!node_modules/@microsoft/copilot-sdk-*/**"` to `build.files`.

- [ ] **Step 4: Implement `createCopilotRuntime`** in `electron/copilot-runtime.mjs`. Entries in a `Map` keyed by command: `{ proc, client, starting: Promise, inFlight, idleTimer, failedAt, error }`. Stdout and stderr stay drained after the port line. On the child's `exit` the entry is dropped (POSIX: `killTree(child, "SIGKILL")` sweeps the group, errors ignored). Stop = `client?.stop()` raced against 3 s, then `killTree` (Windows: no signal; POSIX: `SIGTERM`, `SIGKILL` after `killGraceMs` unless exited). Timers of idle and grace are `unref()`'d when the real ones are used.

- [ ] **Step 5: Run** `node --test electron/test/copilot-runtime.test.mjs electron/test/packaging.test.mjs` — Expected: PASS. Then `COPILOT_LIVE_TEST=1 node --test electron/test/copilot-runtime-live.test.mjs` — Expected: PASS (this machine has `copilot` logged in).

- [ ] **Step 6: Check the SDK loads in Electron's Node:** `cd electron && ELECTRON_RUN_AS_NODE=1 npx electron -e "import('@microsoft/copilot-sdk').then(m => console.log(typeof m.CopilotClient))"` — Expected: `function`.

- [ ] **Step 7: Commit** `git add electron/copilot-runtime.mjs electron/test/copilot-runtime*.test.mjs electron/test/packaging.test.mjs electron/package.json electron/package-lock.json && git commit -m "feat(desktop): Copilot SDK clients over the Settings command in headless TCP mode"`

---

### Task 3: Quota service

**Files:**
- Modify: `electron/usage.mjs` (`createUsagePusher`, `summarize`; new `readLiveQuota`, `createQuotaService`, `quotaView`)
- Test: `electron/test/usage.test.mjs`

**Interfaces:**
- Consumes: `pickPool`, `readQuota`, `quotaLine` (Task 1); `runtime.withClient` (Task 2).
- Produces:

```js
export async function readLiveQuota({ runtime, command, deadlineMs = 10_000 }) -> Promise<QuotaPick|null>
  // throws on failure (start error, getQuota error, deadline: "Copilot did not answer in 10 s")
export function createQuotaService({ readLive: () => Promise<QuotaPick|null>, readFile = readQuota,
  now = Date.now, ttlMs = 60_000, maxAgeMs = 3_600_000, onChange = () => {} }) -> {
  get({ force = false } = {}): Promise<QuotaState>,
}
// QuotaState = { quota: QuotaPick|null, source: "live"|"earlier"|"file"|null, at: number|null, reason: string|null }
export function quotaView(state: QuotaState|null, { timeZone } = {}) -> { line: string, tooltip: string }|null
export function createUsagePusher({ send, readSession, quota: () => Promise<QuotaState|null>, debounceMs }) // replaces readQuota/quotaTtlMs/now
```

- [ ] **Step 1: Write the failing tests**

```js
const pick = { pool: "chat", used: 13, total: 200, remainingPct: 93.6, resetDate: "", unlimited: false, tokenBased: true };
test("live wins", ...)                     // readLive → pick ⇒ { quota: pick, source: "live", at: null, reason: null }
test("live fails → last live with its time", ...) // live ok at t0, fails at t0+61_000 ("boom") ⇒ { quota: pick, source: "earlier", at: t0, reason: "boom" }
test("last live older than 1 h → fresh file", ...) // live ok at t0, fails at t0+3_600_001; readFile → { quota: P, at: t0+3_590_000 } ⇒ source "file", at that time
test("no live ever → file under 1 h", ...)  // ⇒ source "file"
test("file older than 1 h → none", ...)     // ⇒ { quota: null, source: null, at: null, reason: "boom" }
test("live none is final", ...)             // readLive → null ⇒ { quota: null, source: "live", ... }; readFile not called
test("cached 60 s, success and failure", ...) // two get() within 59_999 ms → readLive called once; after 60_000 → twice
test("force skips the cache", ...)          // get({ force: true }) → readLive called again
test("onChange only on a different state", ...) // same pick twice → onChange once; then a failure → second call
test("readLiveQuota times out", ...)        // runtime.withClient never resolves; mock timers +10_000 → rejects /did not answer/
test("readLiveQuota picks from quotaSnapshots", ...) // withClient fn gets { rpc: { account: { getQuota: async () => ({ quotaSnapshots: { chat: snap({ entitlementRequests: 200 }) } }) } } } → pool "chat"
// quotaView
assert.deepEqual(quotaView({ quota: pick, source: "live", at: null, reason: null }), { line: "Chat: 13 / 200 used · 93.6% left", tooltip: "Live from Copilot" });
assert.equal(quotaView({ quota: pick, source: "earlier", at: Date.UTC(2026,10,25,18,5), reason: "boom" }, { timeZone: "UTC" }).tooltip, "Last live figure; live query failed: boom");
assert.equal(quotaView({ quota: P, source: "file", at: Date.UTC(2026,10,25,18,5), reason: "boom" }, { timeZone: "UTC" }).line, "Premium: 533 / 1500 used · 64.5% left · resets Dec 1 · as of 18:05");
assert.equal(quotaView({ quota: null, source: null, at: null, reason: "boom" }), null);
```

Adapt the `createUsagePusher` tests: `quota: async () => state` instead of `readQuota`; drop `pusher caches quota for 60 s` (now in the service); `summarize({ quota: state })` uses `quotaView(state)?.line`.

- [ ] **Step 2: Run** `node --test electron/test/usage.test.mjs` — Expected: FAIL.

- [ ] **Step 3: Implement** the four exports. The service keeps `lastLive = { quota, at }` from the last successful live read; `cache = { at, state }`; state equality by `JSON.stringify`. `summarize`'s `quota` field becomes `quotaView(quota)?.line ?? null`.

- [ ] **Step 4: Run** `npm test` — Expected: PASS (all files).

- [ ] **Step 5: Commit** `git commit -am "feat(usage): live quota service with last-live and file fallback"`

---

### Task 4: Wire it into the app

**Files:**
- Modify: `electron/main.mjs` (near `const usage = createUsagePusher` at ~399; `createWindow`; `killAll`; `will-quit` at ~1864; new handler next to the other `handle(...)` calls)
- Modify: `electron/preload.cjs` (`onQuota: on("quota:update")`, `quotaGet: (opts) => call("quota:get", opts)`)
- Modify: `electron/renderer/app.js` (~3887 `api.onUsage`; `refresh()` at ~3098; startup)

**Interfaces:**
- Consumes: `createCopilotRuntime` (Task 2); `createQuotaService`, `readLiveQuota`, `quotaView`, `createUsagePusher({ quota })` (Task 3); `settingsCommand()` (main.mjs:88).
- Produces: IPC `quota:get({ force })` → `{ line, tooltip } | null`; push `quota:update` with the same value.

- [ ] **Step 1: Main.** `const runtime = createCopilotRuntime({ spawn, killTree })`; `const quota = createQuotaService({ readLive: () => readLiveQuota({ runtime, command: settingsCommand().command }), onChange: (s) => send("quota:update", quotaView(s)) })`; pass `quota: () => quota.get()` to `createUsagePusher`; `handle("quota:get", async (o) => quotaView(await quota.get({ force: o?.force === true })))`; `win.on("focus", () => quota.get().catch(() => {}))` in `createWindow`; `runtime.stopAll()` started in `killAll()`, and `will-quit` also waits for that promise (with the prompt processes, same `promptsAwaited` guard).

- [ ] **Step 2: Renderer.** Sidebar handler `showQuota(view)`: `null` → `#side-quota` hidden, text cleared; else `textContent = view.line`, `title = view.tooltip`, shown. Subscribe `api.onQuota(showQuota)`; at startup `api.quotaGet().then((r) => r.ok && showQuota(r.value))`; in `refresh()` also `api.quotaGet({ force: true }).then(...)` without awaiting. Remove the old `lastQuota` sidebar code from `api.onUsage` (the session chip keeps `view.quota`).

- [ ] **Step 3: Run** `npm test` — Expected: PASS (packaging test sees `copilot-runtime.mjs` in `build.files`).

- [ ] **Step 4: Run the app** (`npm --prefix electron run copy-relay && npm --prefix electron start`): the sidebar shows `Chat: 13 / 200 used · 93.6% left` (or the current figures) with tooltip `Live from Copilot`; `ps -ef | grep -- "--headless"` shows one CLI; after quitting the app none is left.

- [ ] **Step 5: Check the package:** `npm --prefix electron run dist:linux -- --dir`, then `npx --prefix electron asar list electron/dist/linux-unpacked/resources/app.asar | grep -c "copilot-sdk-"` — Expected: `0`; `grep -c "copilot-sdk/"` > 0. Start `electron/dist/linux-unpacked/copilot-sessions` (or the produced binary) and see the live line.

- [ ] **Step 6: Commit** `git commit -am "feat(desktop): live quota in the sidebar, refreshed on start, focus, activity and Refresh"`

---

## After the last task

- Backlog (`docs/superpowers/backlog/2026-11-25-live-quota-deferred.md`, committed on this branch): the known
  limitation (CLI left after a crash or kill of the app), the spec's "Not verified" list (Windows `cmd.exe` port
  line with `copilot.exe` and `copilot.cmd`, process tree after quit/idle, corporate figures vs GitHub, SDK in the
  packaged Windows app, installer size), and every review finding not fixed.
- Release v0.29.0: `git merge --no-ff` to `main`, annotated tag `v0.29.0` on the merge commit.
