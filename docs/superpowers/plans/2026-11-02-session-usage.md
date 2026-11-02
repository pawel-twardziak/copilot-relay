# Session usage & context display — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every open session in the desktop app shows live context usage and Copilot session usage (AI credits, premium requests, tokens, lines changed), plus the account's monthly premium quota — matching Copilot CLI's `/context` and `/usage`.

**Architecture:** A pure Node module `electron/usage.mjs` reads Copilot's own `$COPILOT_HOME/session-state/<id>/events.jsonl` (usage) and formats everything into display strings; a small pusher in the same module debounces updates and caches quota. `electron/main.mjs` feeds it the ACP `usage_update` numbers and lifecycle events and sends a ready view over IPC; the renderer only paints it.

**Tech Stack:** Node ≥ 22 ESM, Electron 45, `node:test` (no new dependencies).

**Spec:** `docs/superpowers/specs/2026-11-02-session-usage-design.md`

## Global Constraints

- No new dependencies. UI copy in English.
- `electron/usage.mjs` has no Electron imports (testable with plain Node) and is added to `build.files` in `electron/package.json`.
- Unknown value → `—` or hidden, never an estimate. Nothing is ever sent to the Copilot session to obtain usage.
- `COPILOT_HOME` default: `process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot")`.
- Thresholds: `warn` ≥ 80 %, `full` ≥ 95 %; quota cache 60 s.
- `npm test` at repo root = `node --test test/`, green on `ubuntu-latest` and `windows-latest`.

## Review Focus

1. **Half-written last line / file being appended while read** → reader skips it and returns the previous checkpoint; never throws. (Task 1 test.)
2. **Large `events.jsonl` (long sessions, multiple MB)** → tail read finds the last checkpoint without reading the whole file; whole-file fallback is capped. (Task 1 test.)
3. **Copilot changes the format** (checkpoint lacks `accountingSnapshot`, `modelMetrics` empty) → credits still shown if `totalNanoAiu` exists, tokens omitted from tooltip; no `NaN`/`undefined` in any string. (Task 1 test.)
4. **Model switch or `/compact`** → `size` changes / `used` drops; view always reflects the latest `usage_update`, pct clamped 0–100. (Task 1 test.)
5. **Session closed or process exited while an update is debounced** → no IPC send for a closed session, no timer leak. (Task 2 test.)

---

### Task 1: Usage reader and formatter

**Files:**
- Create: `electron/usage.mjs`
- Create: `test/usage.test.mjs`, `test/fixtures/usage/events-basic.jsonl`, `test/fixtures/usage/events-quota.jsonl`
- Modify: `package.json` (root) — `"test": "node --test test/"`
- Create: `.github/workflows/test.yml`

**Interfaces:**
- Produces (all exported from `electron/usage.mjs`):
  - `copilotHomeDefault(): string`
  - `readSessionUsage(sessionId: string, { copilotHome?: string } = {}): Promise<SessionUsage | null>`
    `SessionUsage = { aiCredits: number | null, premiumRequests: number | null, tokens: { input, output, cacheRead, cacheWrite, reasoning } | null, linesAdded: number | null, linesRemoved: number | null }` — from the last `session.usage_checkpoint` (`aiCredits = data.totalNanoAiu / 1e9`; tokens summed over `data.accountingSnapshot.modelMetrics[*].usage.{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,reasoningTokens}`; lines from `data.accountingSnapshot.codeChanges`). Missing file / no checkpoint → `null`.
  - `readQuota({ copilotHome?: string } = {}): Promise<Quota | null>`
    `Quota = { used: number, total: number, remainingPct: number, resetDate: string, unlimited: boolean }` from the newest `data.quotaSnapshots.premium_interactions` (`usedRequests`, `entitlementRequests`, `remainingPercentage`, `resetDate`, `isUnlimitedEntitlement`) found in the tails of the 5 most recently modified `session-state/*/events.jsonl`.
  - `formatTokens(n: number): string`
  - `summarize({ context?: { used: number, size: number } | null, session?: SessionUsage | null, quota?: Quota | null }): UsageView`
    `UsageView = { context: { label: string, pct: number, level: "ok" | "warn" | "full" } | null, credits: string | null, tooltip: string, quota: string | null }`

- [ ] **Step 1: Fixtures.** `events-basic.jsonl`: a `session.start` line, two `session.usage_checkpoint` lines (first `totalNanoAiu 1000000000`, second the real values below), and a final half-written line `{"type":"session.usage_chec`. Second checkpoint: `totalNanoAiu 3863730000`, `totalPremiumRequests 1`, `accountingSnapshot.modelMetrics["claude-sonnet-5.5"].usage = { inputTokens 31081, outputTokens 4, cacheReadTokens 16293, cacheWriteTokens 14784, reasoningTokens 0 }`, `codeChanges { linesAdded 12, linesRemoved 3 }`. `events-quota.jsonl`: one `model.model_call_success` with `quotaSnapshots.premium_interactions = { isUnlimitedEntitlement false, entitlementRequests 1500, usedRequests 109, remainingPercentage 92.7, resetDate "2026-12-01T00:00:00Z" }`. Tests copy fixtures into `<os.tmpdir()>/<random>/home ł/session-state/<id>/events.jsonl` and pass that `home ł` dir as `copilotHome`.

- [ ] **Step 2: Write failing tests** in `test/usage.test.mjs`:
  - `readSessionUsage reads the last complete checkpoint`: `Math.abs(u.aiCredits - 3.86373) < 1e-9`, `premiumRequests === 1`, `tokens.input === 31081`, `tokens.cacheRead === 16293`, `linesAdded === 12`, `linesRemoved === 3`.
  - `readSessionUsage returns null for a missing file` and `… for a file with only garbage lines`.
  - `readSessionUsage finds a checkpoint far from the end`: fixture checkpoint followed by 3 MiB of `{"type":"assistant.message","data":{"content":"xxx…"}}` lines → still the same values.
  - `readSessionUsage tolerates a checkpoint without accountingSnapshot`: `{type:"session.usage_checkpoint",data:{totalNanoAiu:2e9}}` → `aiCredits === 2`, `tokens === null`, `linesAdded === null`.
  - `readSessionUsage honours COPILOT_HOME`: set `process.env.COPILOT_HOME` to the temp home, call without options → found (restore env after).
  - `readQuota returns the newest premium snapshot` → `{ used: 109, total: 1500, remainingPct: 92.7, resetDate: "2026-12-01T00:00:00Z", unlimited: false }`; with only `events-basic.jsonl` present → `null`.
  - `formatTokens`: `0→"0"`, `4→"4"`, `999→"999"`, `22899→"22.9k"`, `16293→"16.3k"`, `200000→"200k"`, `1250000→"1.25M"`.
  - `summarize context`: `{used:22899,size:200000}` → `{ label: "22.9k / 200k · 11%", pct: 11, level: "ok" }`; `used 160000` → `level "warn"`; `used 190000` → `"full"`; `used 210000` → `pct 100, "full"`; `size 0` or `context null` → `context === null`.
  - `summarize session`: real values → `credits === "3.86 AI credits"`; `tooltip` contains `"Requests: 1 premium"`, `"Tokens: input 31.1k, output 4, cached 16.3k"`, `"Changes: +12 −3"`; with `tokens null` tooltip has no `"Tokens"`; no part of any string matches `/NaN|undefined|null/`.
  - `summarize quota`: → `"Premium: 109 / 1500 used · 92.7% left · resets Dec 1"`; `unlimited: true` → `"Premium: unlimited"`; `quota null` → `quota === null`.
  - `summarize with nothing` → `{ context: null, credits: null, tooltip: "", quota: null }`.

- [ ] **Step 3: Run** `npm test` → FAIL (`Cannot find module …/electron/usage.mjs`).

- [ ] **Step 4: Implement `electron/usage.mjs`.** Tail read: `fs/promises` `open` + `read` of the last 2 MiB, drop the first (partial) line, scan lines from the end, pre-filter with `line.includes('"session.usage_checkpoint"')` before `JSON.parse` in try/catch. If not found and file > 2 MiB: read the whole file only if ≤ 64 MiB, else `null`. Quota: `readdir` + `stat` of `session-state/*/events.jsonl`, 5 newest by `mtimeMs`, same tail scan for `"quotaSnapshots"`, take the newest by event `timestamp` (fall back to file order). Reset date: `new Date(resetDate).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })`. Tooltip parts joined with `" · "`. `formatTokens`: < 1000 as integer; < 1e6 → `k` with up to 1 decimal, trailing `.0` dropped; else `M` with up to 2 decimals.

- [ ] **Step 5: Run** `npm test` → PASS.

- [ ] **Step 6: CI.** `.github/workflows/test.yml`: `on: [push, pull_request]`, matrix `os: [ubuntu-latest, windows-latest]`, steps checkout, `actions/setup-node@v4` (node 22, cache npm), `npm ci`, `npm test`.

- [ ] **Step 7: Commit**
```bash
git add electron/usage.mjs test/ package.json .github/workflows/test.yml
git commit -m "feat(desktop): read Copilot session usage and quota"
```

### Task 2: Usage pusher and main-process wiring

**Files:**
- Modify: `electron/usage.mjs` (add pusher), `test/usage.test.mjs`
- Modify: `electron/main.mjs` (`attach` ~line 142, `sessions:new`, `sessions:open`, `sessions:prompt` ~line 449, `sessions:close`, exit handler)
- Modify: `electron/preload.cjs` (`onUsage`)
- Modify: `electron/package.json` (`build.files` += `"usage.mjs"`)

**Interfaces:**
- Consumes: `readSessionUsage`, `readQuota`, `summarize` (Task 1).
- Produces:
  - `createUsagePusher({ send: (sessionId: string, view: UsageView) => void, readSession?: typeof readSessionUsage, readQuota?: typeof readQuota, debounceMs = 300, quotaTtlMs = 60_000, now = Date.now }): { context(sessionId, { used, size }): void, refresh(sessionId): void, forget(sessionId): void }` — `context` stores the latest numbers and schedules a push; `refresh` schedules a push; pushes per session are debounced; `forget` cancels the timer and drops state (no later `send`).
  - IPC channel `usage:update` with payload `{ sessionId, view: UsageView }`; preload `onUsage: on("usage:update")`.

- [ ] **Step 1: Write failing tests** (use `t.mock.timers.enable({ apis: ["setTimeout", "Date"] })`, fake `readSession`/`readQuota` counting calls):
  - `pusher debounces bursts into one send`: 5× `context("s1", …)` within 100 ms, tick 300 ms → `send` called once, view `context.label` reflects the last numbers.
  - `pusher keeps the latest context across refreshes`: `context("s1",{used:22899,size:200000})`, tick, `refresh("s1")`, tick → second view still has `pct 11`.
  - `pusher caches quota for 60 s`: two pushes 10 s apart → `readQuota` called once; after 61 s → twice.
  - `forget cancels pending sends`: `refresh("s1")`, `forget("s1")`, tick 1 s → `send` not called.
  - `a failing reader yields a view, not an exception`: `readSession` rejects → `send` called with `credits === null`.

- [ ] **Step 2: Run** `npm test` → FAIL.

- [ ] **Step 3: Implement `createUsagePusher`** in `electron/usage.mjs`.

- [ ] **Step 4: Wire main.** One pusher with `send: (sessionId, view) => send("usage:update", { sessionId, view })`. In `attach`'s notification handler: `u.sessionUpdate === "usage_update"` → `pusher.context(sessionId, { used: u.used, size: u.size })` (still forwarded as today). `pusher.refresh` after `sessions:new` and `sessions:open` succeed and in a `finally` around `conn.request("session/prompt", …)` in `sessions:prompt`. `pusher.forget` in `sessions:close` and the `exit` handler.

- [ ] **Step 5: Run** `npm test` → PASS; `cd electron && npm start` boots without errors in the terminal.

- [ ] **Step 6: Commit**
```bash
git add electron/usage.mjs electron/main.mjs electron/preload.cjs electron/package.json test/usage.test.mjs
git commit -m "feat(desktop): push session usage updates to the window"
```

### Task 3: Usage in the session header and sidebar

**Files:**
- Modify: `electron/renderer/app.js` (session view constructor ~line 214–230, new `usage(view)` method, `api.onUsage` subscription next to line ~906, sidebar quota)
- Modify: `electron/renderer/index.html` (`<div id="side-quota"></div>` above `#side-status`)
- Modify: `electron/renderer/style.css`
- Modify: `electron/README.md` (feature list: usage & context)

**Interfaces:**
- Consumes: `api.onUsage(({ sessionId, view }) => …)` with `UsageView` (Task 2).

- [ ] **Step 1: Header chip.** In `.head` right after `this.relayChip`: `this.usageChip = h("span", { class: "usage-chip" }, meter, label)` where `meter` is `span.meter > span.fill` (`style.width = pct + "%"`, class `ok|warn|full` on the chip) and `label` text = `context.label` or `"context: —"`, plus `` ` · ${credits}` `` when `credits`. `title` = `[view.tooltip, view.quota].filter(Boolean).join("\n")`. Visible from session open (`context: —`).
- [ ] **Step 2: Sidebar.** `#side-quota` text = latest non-null `view.quota` from any session; hidden while none.
- [ ] **Step 3: CSS.** `.usage-chip` styled like `.relay-chip` (muted), meter 40×6 px rounded; fill colours: ok `var(--accent)` or the relay blue, warn amber `#d29922`, full `var(--err)`.
- [ ] **Step 4: Manual check against the CLI.** `npm run app`; open a session, send 2 prompts → header shows `x / 200k · y%` and `z AI credits`. In a terminal `copilot --resume <id>` → `/usage` and `/context`: credits equal, context within ±1k. Open an existing session → `context: —` until the next prompt. Switch model to one with a different window → size follows. Hover → tooltip shows requests/tokens/changes (and quota line if recorded). Screenshot the header for the user.
- [ ] **Step 5: Commit**
```bash
git add electron/renderer electron/README.md
git commit -m "feat(desktop): show context window and Copilot usage per session"
```
