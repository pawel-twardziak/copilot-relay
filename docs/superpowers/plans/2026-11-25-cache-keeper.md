# Cache keeper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While a session waits for the user, the app sends up to N hidden keep-alive prompts, each just before the
prompt cache expires. If the user stays away, it then compacts the session (`/compact`) just before the cache expires,
with a visible countdown and **Not now**.

**Architecture:** The work is split into four layers:
- A pure rules module (`electron/cache-keeper.mjs`) decides the next step from a session's state.
- A runner (`electron/cache-keeper-runner.mjs`) owns the timers and actions, with every effect injected, so it is
  unit-tested with fakes.
- `electron/main.mjs` only wires the runner to the ACP connections, the guards and IPC.
- The window shows the state and reports the queue and the draft.

**Tech Stack:** Electron main + renderer (plain ES modules), Node built-ins, `node:test`, and the UI checks
(`scripts/ui-check`, real app under xvfb against `electron/test/fixtures/acp/scripted-agent.mjs`).

**Spec:** `docs/superpowers/specs/2026-11-25-cache-keeper-design.md` (read it first; this plan does not repeat its
reasons).

## Global Constraints

**Timing and text**
- `LATE_MS = 30_000`: an action is too late when `expiresAt - now < LATE_MS`; a planned action whose time has passed
  but is not too late is due now.
- Leads, in ms: `PING_LEAD_MS = 60_000`, `COUNTDOWN_LEAD_MS = 120_000`, `COMPACT_LEAD_MS = 60_000`, all before the
  session's `cacheExpiresAt`.
- `KEEPALIVE_MARKER = "[keep-alive]"`.
- Keep-alive text: `[keep-alive] The user is away. Reply with a single dot. Do not use any tool and do not continue any task.`
- Compact text: `/compact Quote verbatim the last user message and your last answer.`
- Compact text for a parent with active children: the line above, then
  ` For each delegated child session, keep verbatim what you asked it to do and how you planned to check its result.`

**Settings**
- `cacheKeeper: { enabled: false, pings: 6, minContext: 50000 }`.
- `pings`: 0 or empty means 0. `minContext` is in tokens.

**UI strings (English, like the rest of the app)**
- Settings checkbox: "Keep idle sessions' prompt cache warm, then compact them".
- Settings number fields: "Keep-alive prompts before compacting" and "Minimum context (k tokens)".
- Settings hint: "Spends a few AI credits per pause to save the cost of rewriting the cache. Compaction replaces the conversation with a summary."
- Ping chip: "♻ Keeping the cache warm (3/6)".
- Countdown chip: "⏳ Compacting in 0:42".
- Button: "Not now".
- Compaction notice: "Compacted automatically before the prompt cache expired (−N messages)".
- Failure notice: "Automatic compaction failed: <reason>".
- Ping stop notice: "Keep-alive stopped: the agent started working."

**Session-level behaviour**
- Per-session opt-out. The spec says "session menu", but the app has none: the per-session switches live in the
  status bar (the hold switches). Use a status-bar checkbox "Keep cache", checked = keeper on, and update the spec's
  line in Task 6.
- Phase values: `idle | pinging | countdown | compacting | done | off`.
- Activity is anything in spec Goal 6, including config changes. The keeper's own ping or compaction is never
  activity and never `turnEnded`.
- Every handler that refuses while `entry.prompting` is set first awaits `keeper.whenIdle(sessionId)` (spec Goal 10).

**Tests**
- Run with `npm test` from the repo root (`node --test "electron/test/*.test.mjs"`).
- UI checks run with `node scripts/ui-check/run.mjs`. Run `npm --prefix electron run copy-relay` first.

## Review Focus

1. **A prompt arrives while a ping or compaction is in flight** (typed, from the relay, or a queued one): it waits and
   is then sent. The chat shows only that prompt and its answer. Test: Task 4 "a prompt during a ping waits for it",
   and the UI check in Task 7.
2. **The session closes or its Copilot exits** during a countdown or a ping: timers are cleared, nothing is sent to a
   dead connection, and no chip remains. Test: Task 4 "close clears the timer and the state".
3. **The checkpoint is stale**: `cacheExpiresAt` in the past, the same checkpoint as before the turn, or no entry for
   the current model. The keeper does nothing for that pause. Test: Task 1 "too late does nothing", Task 2 "the
   current model's entry only", Task 4 "an unchanged checkpoint gives no expiry".
4. **A history with pings is replayed, forked or cut** at a real message: numbering and cut positions are those of the
   real messages. Test: Task 3 "a ping right after the cut target", Task 3 "the replay filter swallows a ping span".
5. **The settings change mid-pause** (disabled, pings lowered to 0, threshold raised): a pending ping or countdown is
   dropped at once. Test: Task 4 "settings change re-plans the pause".

---

### Task 1: The rules (`electron/cache-keeper.mjs`)

**Files:**
- Create: `electron/cache-keeper.mjs`
- Test: `electron/test/cache-keeper.test.mjs`

**Interfaces:**
- Produces:
  - `PING_LEAD_MS`, `COUNTDOWN_LEAD_MS`, `COMPACT_LEAD_MS`, `KEEPALIVE_MARKER`.
  - `isKeepAlive(text: string): boolean`: true when the trimmed text starts with the marker. It also matches when the
    marker follows a leading `<current_datetime>…</current_datetime>` block (Task 3 decides whether that is needed;
    accept both).
  - `keepAliveText(): string`.
  - `compactText({ parent: boolean }): string`.
  - `normalizeKeeperSettings(raw): { enabled: boolean, pings: number, minContext: number }`. Defaults as in the
    Global Constraints. `pings` is a whole number ≥ 0 (empty, NaN or a negative value → 0, not 6, when the field was
    sent). `minContext` is a whole number ≥ 0.
  - `initialState(): { expiresAt: null, pingsSent: 0, skipped: false, phase: "idle" }`.
  - `reduce(state, event): state`. `event` is one of:
    - `{ type: "turnEnded", expiresAt }`
    - `{ type: "pingEnded", expiresAt }`
    - `{ type: "compactEnded" }`
    - `{ type: "activity" }`
    - `{ type: "notNow" }`
  - `next({ state, now, settings, facts, leads? }): { action: "none" | "ping" | "countdown" | "compact", at: number | null }`.
    - `facts = { enabled, busy, held, replaying, contextUsed }`.
    - `leads` defaults to the three constants and is overridable (`{ ping, countdown, compact, late }`) for the UI checks.

- [ ] **Step 1: Write the failing tests**

  In `electron/test/cache-keeper.test.mjs`, with `const T = Date.parse("2026-11-25T10:00:00Z")`, `exp = T + 300_000`,
  `S = { enabled: true, pings: 6, minContext: 50_000 }`,
  `F = { enabled: true, busy: false, held: false, replaying: false, contextUsed: 160_000 }`:

  - `"a pause pings N times 60 s before expiry, then counts down and compacts"`:
    - Start from `reduce(initialState(), { type: "turnEnded", expiresAt: exp })`.
    - `next(...)` at `now = T` → `{ action: "ping", at: exp - 60_000 }`.
    - After six `pingEnded` events (each with `expiresAt` 300 s after the previous one's `at`): `next` →
      `{ action: "countdown", at: expiresAt - 120_000 }`.
    - At `now = expiresAt - 120_000` with phase `countdown` → `{ action: "compact", at: expiresAt - 60_000 }`.
  - `"no pings when pings is 0"`: right after `turnEnded`, the action is `countdown` at `exp - 120_000`.
  - `"the countdown starts at once when its time has passed but compaction still fits"`: `now = exp - 90_000`,
    `pings: 0` → `{ action: "countdown", at: now }`.
  - `"too late does nothing"`: `now = exp - 29_000` → `{ action: "none", at: null }` (too late = `expiresAt - now < LATE_MS`, 30 s). With `expiresAt: null` →
    `none`.
  - `"each fact or setting can stop it"`: each of these alone gives `none`:
    - `enabled: false`, `busy: true`, `held: true`, `replaying: true`;
    - `contextUsed: 49_999`;
    - `settings.enabled: false`;
    - `state.skipped`;
    - phase `done`.
  - `"Not now skips the rest of the pause, the next turn starts a new one"`: `notNow` → `none`. Then `turnEnded` →
    `pingsSent 0`, `skipped false`, and the action is `ping` again.
  - `"activity resets the count and waits for a turn"`: after 3 `pingEnded`, `activity` gives `pingsSent 0`,
    `expiresAt null` and action `none`.
  - `"after a compaction the pause is done"`: `compactEnded` → phase `done`, `none` even with a fresh `expiresAt`.
    Then `turnEnded` → `ping`.
  - `"texts"`:
    - `keepAliveText()` starts with `KEEPALIVE_MARKER`.
    - `compactText({ parent: false })` and `compactText({ parent: true })` equal the Global Constraints strings
      exactly.
    - `isKeepAlive` is true for `keepAliveText()`, for `"<current_datetime>x</current_datetime> " + keepAliveText()`,
      and for the text with leading whitespace. It is false for `"hello [keep-alive]"`.
  - `"settings are normalised"`:
    - `normalizeKeeperSettings(undefined)` → `{ enabled: false, pings: 6, minContext: 50_000 }`.
    - `{ enabled: true, pings: "" }` → `pings 0`.
    - `{ pings: -2 }` → 0, and `{ pings: 2.7 }` → 2.
    - `{ minContext: "abc" }` → 50_000.
  - `"leads can be overridden"`: `leads: { ping: 3000, countdown: 5000, compact: 2000 }` moves `at` accordingly.

- [ ] **Step 2: Run the tests to verify they fail**

  Run: `node --test electron/test/cache-keeper.test.mjs`
  Expected: FAIL (module not found).

- [ ] **Step 3: Implement `electron/cache-keeper.mjs`**

  A pure ES module with no imports. `next` applies the spec's rules 1–4 in order. Rule 5 is the `compactEnded` →
  `done` transition in `reduce`. In phase `countdown`, `next` returns `compact`. Phase `pinging` and `compacting` are
  set by the runner (Task 4) through the facts' `busy`; `reduce` does not need them.

- [ ] **Step 4: Run the tests to verify they pass**

  Run: `node --test electron/test/cache-keeper.test.mjs`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add electron/cache-keeper.mjs electron/test/cache-keeper.test.mjs
  git commit -m "feat(cache-keeper): rules for keep-alive pings and compaction before the cache expires"
  ```

### Task 2: The cache expiry reader (`electron/usage.mjs`)

**Files:**
- Modify: `electron/usage.mjs` (next to `readSessionUsage`)
- Create: `electron/test/fixtures/usage/events-cache.jsonl`
- Test: `electron/test/usage.test.mjs`

**Interfaces:**
- Produces: `readCacheExpiry(sessionId: string, { copilotHome?: string, modelId?: string | null }):
  Promise<{ expiresAt: number, ttlSeconds: number, modelId: string, checkpointId: string | null } | null>`.
  - It reads the last `session.usage_checkpoint` with a non-empty `modelCacheState`, using the existing `scan`.
  - With `modelId`, it takes only that model's entry; no entry → `null`.
  - With `modelId` null, `undefined` or `"auto"`, it takes the entry with the latest `cacheExpiresAt`.
  - It returns `null` for an invalid id, no file, no such checkpoint, or an unparsable date.
  - `checkpointId` is the event's `id`.

- [ ] **Step 1: Write the fixture and the failing tests**

  The fixture holds, in order:
  - a `session.start`;
  - a checkpoint `id: "c1"` with `modelCacheState: [{ modelId: "claude-opus-5.5", cacheExpiresAt:
    "2026-11-25T10:05:00.000Z", cacheTtlSeconds: 300 }]`;
  - a `user.message`;
  - a checkpoint `id: "c2"` with two entries, `claude-opus-5.5` expiring at `10:15:00Z` and `claude-haiku-5.5` at
    `10:16:00Z`;
  - a checkpoint `id: "c3"` with `modelCacheState: []`.

  Tests in `usage.test.mjs`, copying the fixture into a temp `copilotHome/session-state/<uuid>/events.jsonl` like the
  existing tests:
  - `"readCacheExpiry takes the current model's entry only"`:
    - `modelId: "claude-opus-5.5"` → `expiresAt` = `Date.parse("2026-11-25T10:15:00Z")`, `ttlSeconds 300`,
      `checkpointId "c2"`.
    - `modelId: "gpt-6-luna"` → `null`.
  - `"readCacheExpiry falls back to the latest entry for an unknown model"`: `modelId: "auto"` and no `modelId` both
    give the haiku entry (`10:16:00Z`).
  - `"readCacheExpiry is null without a checkpoint"`: a file with only `session.start` → `null`; an invalid id →
    `null`.

- [ ] **Step 2: Run the tests to verify they fail**

  Run: `node --test electron/test/usage.test.mjs`
  Expected: the three new tests FAIL (not a function).

- [ ] **Step 3: Implement `readCacheExpiry` in `electron/usage.mjs`**

  Use `scan(file, '"session.usage_checkpoint"', pick)`, where `pick` accepts only checkpoints whose
  `modelCacheState` has at least one entry. That way `c3` is skipped and `c2` is found.

- [ ] **Step 4: Run the tests to verify they pass**

  Run: `node --test electron/test/usage.test.mjs`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add electron/usage.mjs electron/test/usage.test.mjs electron/test/fixtures/usage/events-cache.jsonl
  git commit -m "feat(usage): read a session's prompt-cache expiry from its last checkpoint"
  ```

### Task 3: Pings out of the history and the replay

**Files:**
- Modify: `electron/history.mjs` (`isUser`, `messageTimes`)
- Modify: `electron/cache-keeper.mjs` (add the replay filter)
- Test: `electron/test/history.test.mjs`
- Test: `electron/test/cache-keeper.test.mjs`

**Interfaces:**
- Consumes: `isKeepAlive` (Task 1).
- Produces: `createReplayFilter(): { pass(update): boolean }`, in `cache-keeper.mjs`. A `user_message_chunk` whose
  text is a keep-alive starts a swallowed span: `pass` returns false for it and every update until the next
  `user_message_chunk` that is not a keep-alive, which passes and ends the span. Everything else passes. The
  `/compact` answer (an `agent_message_chunk` starting "Compacted conversation history") is swallowed too, outside a
  span.

- [ ] **Step 1: Check the stored content of a ping**

  Run a ping once against the real CLI on this machine (the cheap `auto` model). Use
  `scripts/sdk-probe/lib.mjs` `Acp` with a prompt `keepAliveText()`, then read `user.message.data.content` in the
  session's `events.jsonl`. Note in the commit message whether it starts with the marker or with a
  `<current_datetime>` block. Also check what `session/load` replays for the ping and for a `/compact`. Delete the test
  session afterwards.
  - Expected: one `user.message` whose content contains the marker.
  - If a `/compact` reply is replayed, the swallow rule above covers it.

- [ ] **Step 2: Write the failing tests**

  In `history.test.mjs`, build an events file with:
  - `session.start`;
  - user "a", assistant;
  - user = `keepAliveText()`, assistant ".";
  - user "b", assistant.

  Tests:
  - `"pings are not user messages"`: `countUserMessages` → 2. `messageTimes(id).users.length` → 2.
  - `"a ping right after the cut target"`:
    - `cutIndex(events, { ordinal: 1, text: "a", where: "afterReply" })` is the index of user "b", so the ping is
      removed with what follows.
    - `ordinal: 2, text: "b"` finds user "b".
    - `countFrom(events, indexOfB)` → 1.

  In `cache-keeper.test.mjs`:
  - `"the replay filter swallows a ping span"`: the sequence user "a", agent chunk, user ping, agent ".", `tool_call`,
    user "b", agent chunk passes exactly user "a", its chunk, user "b" and its chunk.
  - `"the replay filter swallows the compact reply"`: an agent chunk "Compacted conversation history and removed 4
    messages and 900 tokens." outside a span is swallowed.

- [ ] **Step 3: Run the tests to verify they fail**

  Run: `node --test electron/test/history.test.mjs electron/test/cache-keeper.test.mjs`
  Expected: the new tests FAIL.

- [ ] **Step 4: Implement**

  - In `history.mjs`, `isUser = (e) => e.type === "user.message" && !isKeepAlive(e.data?.content ?? "")`.
  - `messageTimes` skips keep-alive user messages the same way. Its fast line filter stays, and the parsed event is
    checked.
  - Add `createReplayFilter` to `cache-keeper.mjs`. The text of a chunk is `update.content?.text`.

- [ ] **Step 5: Run the tests to verify they pass**

  Run: `npm test`
  Expected: PASS (the whole suite: `cutIndex` callers such as fork and edit keep working).

- [ ] **Step 6: Commit**

  ```bash
  git add electron/history.mjs electron/cache-keeper.mjs electron/test/history.test.mjs electron/test/cache-keeper.test.mjs
  git commit -m "feat(cache-keeper): keep-alive prompts are not messages in history, numbering or replay"
  ```

### Task 4: The runner (`electron/cache-keeper-runner.mjs`) and the opt-out store

**Files:**
- Create: `electron/cache-keeper-runner.mjs`
- Create: `electron/test/cache-keeper-runner.test.mjs`
- Modify: `electron/held-replies.mjs`, only if `createHoldStore`'s file logic is reused. Otherwise create the store in
  `cache-keeper-runner.mjs`.

**Interfaces:**
- Consumes: `reduce`, `next`, `initialState`, `keepAliveText`, `compactText` (Task 1).
- Produces:
  - `createKeeperOptOut(file): { get(id): boolean, set(id, off: boolean), copy(from, to), delete(id) }`.
    - Only opted-out ids are stored: `{ "<id>": true }`.
    - `get` is true when opted out.
    - Same file handling as `createHoldStore`.
  - `createKeeperRunner(deps)`. `deps` is:
    - `settings(): { enabled, pings, minContext }`;
    - `optedOut(id): boolean`;
    - `facts(id): { busy: boolean, replaying: boolean, contextUsed: number, modelId: string | null, parent: boolean }`;
    - `readExpiry(id, modelId): Promise<{ expiresAt, checkpointId } | null>`;
    - `run(id, text, kind: "ping" | "compact"): Promise<{ text: string, toolCalled: boolean, error: string | null }>`;
    - `emit(channel: "keeper:state" | "acp:notice", payload)`;
    - `now(): number`;
    - `setTimer(fn, ms): handle` and `clearTimer(handle)`;
    - `leads?`;
    - `retry?: { tries: 3, ms: 1000 }`.

    The runner returns:
    - `turnEnded(id): Promise<void>`: re-reads the expiry until `checkpointId` differs from the last one seen, at
      most `retry.tries` times, `retry.ms` apart. An unchanged checkpoint means `expiresAt` null.
    - `activity(id)`: also used for config changes.
    - `setHeld(id, held: boolean)`, `notNow(id)`, `replan(id?)` (settings or opt-out changed; no id → all),
      `closed(id)`.
    - `whenIdle(id): Promise<void>`: resolves when no ping or compaction of `id` is in flight.
    - `state(id): { phase, pingsSent, pings, compactAt }`.
  - `keeper:state` payload: `{ sessionId, phase, pingsSent, pings, compactAt: number | null }`. It is emitted on every
    phase or count change; `phase: "off"` when nothing is planned.

- [ ] **Step 1: Write the failing tests**

  Fake timers: a list of `{ fn, at }`, with `now` advanced by hand. `run` is a fake that records `(id, text, kind)` and
  resolves when the test says so. `readExpiry` returns a scripted queue.

  - `"a pause runs N pings then the countdown and the compaction"`, with pings 2 and contexts above the threshold:
    - after `turnEnded`, a timer at `exp - 60_000`;
    - firing it calls `run(id, keepAliveText(), "ping")` and emits `phase: "pinging"`;
    - resolving it re-reads the expiry, which gives the next ping;
    - after 2 pings it emits `countdown` with `compactAt = exp' - 60_000`;
    - then `run(id, compactText({ parent: false }), "compact")`;
    - after it, an `acp:notice` with "Compacted automatically before the prompt cache expired (−4 messages)" for a
      run result "Compacted conversation history and removed 4 messages and 900 tokens.";
    - then `phase: "done"`.
  - `"the parent gets the long focus text"`: `facts().parent = true` → the compact text equals
    `compactText({ parent: true })`.
  - `"a failed compaction leaves a notice and ends the pause"`: for `error: "boom"`, the notice is
    "Automatic compaction failed: boom", phase `done`, and no more timers.
  - `"a tool call during a ping stops the pause"`: for `toolCalled: true`, the notice is "Keep-alive stopped: the agent
    started working." and nothing more is planned until `turnEnded`.
  - `"a prompt during a ping waits for it"`: `whenIdle(id)` stays pending while `run` is unresolved and resolves right
    after it.
  - `"activity cancels the plan"`: `activity` during the countdown clears the timer and emits `phase: "off"`.
  - `"Not now"`: `notNow` during the countdown clears the timer, emits `off`, and does not run the compaction.
  - `"an unchanged checkpoint gives no expiry"`: `readExpiry` returns the same `checkpointId` 3 times → no timer.
  - `"close clears the timer and the state"`: `closed(id)` during a pending ping timer → the timer is cleared,
    `run` is never called, and `off` is emitted.
  - `"settings change re-plans the pause"`: `replan()` after `settings().enabled` turns false clears every timer.
    Lowering `pings` to 0 mid-pause turns the next step into the countdown.
  - `"held and busy block"`: `setHeld(id, true)` clears the plan, and `setHeld(id, false)` re-plans it. `facts().busy`
    at fire time → nothing runs and the plan waits for the next `turnEnded`.
  - `"opt-out store"`: `set(id, true)` → `get` true, stored `{ id: true }`. `copy(a, b)`. `delete`. `set(id, false)`
    removes the key.

- [ ] **Step 2: Run the tests to verify they fail**

  Run: `node --test electron/test/cache-keeper-runner.test.mjs`
  Expected: FAIL (module not found).

- [ ] **Step 3: Implement `createKeeperRunner` and `createKeeperOptOut`**

  - The runner keeps `Map<id, { state, timer, inFlight: Promise | null, held }>`.
  - Every planning step builds the facts from `deps.facts(id)`:
    - `enabled = settings().enabled && !optedOut(id)`;
    - `held` from `setHeld`;
    - `busy` from `deps.facts` or an action in flight;
    - plus `replaying` and `contextUsed`.
  - It calls `next` and arms one timer for `at`.
  - When a timer fires, it re-checks `next` with fresh facts before acting.
  - N for the notice: `/removed (\d+) messages/` from the run's text. Without a match, the notice drops the
    "(−N messages)" part.

- [ ] **Step 4: Run the tests to verify they pass**

  Run: `node --test electron/test/cache-keeper-runner.test.mjs`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add electron/cache-keeper-runner.mjs electron/test/cache-keeper-runner.test.mjs
  git commit -m "feat(cache-keeper): runner with timers, actions, notices and the per-session opt-out store"
  ```

### Task 5: Wiring in the main process (`electron/main.mjs`, `electron/preload.cjs`)

**Files:**
- Modify: `electron/main.mjs`, in:
  - `attach` / `entry.update` (~405–420);
  - the permission handler (~423);
  - `sessions:prompt` (~799–822);
  - `slashRename` (~840);
  - `refuseWhilePrompting` (~1150);
  - fork and delete (~1207–1256);
  - `sessions:setConfig` (~1266);
  - `restartGuards` (~1281);
  - `sessions:close` (~878);
  - the connection `exit` handler;
  - `settings:get` and `settings:set` (~1335–1360);
  - the stores (~91–102).
- Modify: `electron/preload.cjs`

**Interfaces:**
- Consumes:
  - `createKeeperRunner`, `createKeeperOptOut` (Task 4);
  - `createReplayFilter`, `normalizeKeeperSettings` (Tasks 1, 3);
  - `readCacheExpiry` (Task 2);
  - `findModelOption` (`delegation.mjs`);
  - `heldCache.list` and `heldKind` (`held-replies.mjs`).
- Produces:
  - IPC handlers:
    - `keeper:held(sessionId, held)`;
    - `keeper:notNow(sessionId)`;
    - `keeper:optOut(sessionId, off)`;
    - `keeper:get(sessionId) → { optedOut, state }`.
  - Window events: `keeper:state` and `acp:notice`.
  - `settings:get` returns `cacheKeeper` (normalised); `settings:set` stores `normalizeKeeperSettings(s.cacheKeeper)`
    when sent and calls `keeper.replan()`.
  - Preload: `keeperHeld`, `keeperNotNow`, `keeperOptOut`, `keeperGet`, `onKeeperState`.

- [ ] **Step 1: Wire it**

  **Stores**
  - `const keeperOptOut = createKeeperOptOut(path.join(app.getPath("userData"), "cache-keeper.json"))`.
  - Copy it next to `holds.copy` on a fork, and delete it next to `holds.delete`.

  **Runner deps**
  - `facts(id)`:
    - `busy`: `Boolean(e.prompting) || e.permissions.size > 0`, or any card of this session:
      `pendingRequests` for `id` as parent, `reopenCards` or `linkCards` entries with `sessionId === id`.
    - `replaying: Boolean(e.replaying)`.
    - `contextUsed`: the last `usage_update.used`, kept in a `Map` in `entry.update`.
    - `modelId`: `findModelOption(e.configOptions)?.currentValue ?? null`.
    - `parent`: an open entry with `parentSessionId === id && !reported`, or
      `heldCache.list(id).some((m) => heldKind(m) === "child")`.
  - `run(id, text, kind)`:
    - set `entry.keeping = kind`, then `beginPrompt` and relay state as `slashRename` does, and
      `conn.request("session/prompt", …)`;
    - collect the `agent_message_chunk` text;
    - `finally` clear `keeping` and `endPrompt`;
    - return `{ text, toolCalled, error }`. A JSON-RPC error goes in `error`, and so does a compaction reply without
      "Compacted".

  **While `entry.keeping` is set, in `entry.update`**
  - Updates are not sent to the window and not given to `tracker.update`.
  - A `tool_call` sets `toolCalled` and calls `cancelTurn`.
  - The permission handler answers `cancelled` at once and sets `toolCalled`. No `acp:permission` and no
    `notifyIfUnfocused`.
  - `last-activity` is not touched. The builder checks what feeds it; it must skip keeper turns.

  **Replay**
  - One `createReplayFilter()` per `session/load`, used in `entry.update` while `entry.replaying` is set.
  - The filter's `pass` also runs on live updates, so a live `/compact` reply from the CLI is swallowed.
  - Updates with `pass === false` are dropped before `send("acp:update", …)`.

  **`turnEnded`**
  - Called where `endPrompt` returns true, in `sessions:prompt` and `slashRename`, unless the turn was the keeper's
    own (`run` handles its own re-plan).
  - `activity` is called at the start of `sessions:prompt`, and in `sessions:setConfig`, `restartGuards` and when a
    permission request arrives outside a keeper turn.

  **Waiting for the keeper**
  - `await keeper.whenIdle(sessionId)` first in:
    - `sessions:prompt`;
    - `sessions:rename`;
    - the fork, truncate and edit handlers, before `refuseWhilePrompting`;
    - `sessions:setConfig`;
    - `sessions:setContextTier` and `sessions:setPrompt`, before `restartGuards`.
  - `sessions:delete` and `sessions:close` call `cancelTurn` as today, then `keeper.closed(id)`. The connection's
    `exit` handler calls `keeper.closed(id)`.

  **Test hook**
  - `COPILOT_RELAY_KEEPER_LEADS_MS="ping,countdown,compact,late"` (four numbers) overrides the leads, for the UI checks
    only.
  - `COPILOT_RELAY_KEEPER_RETRY_MS` overrides the retry gap.

- [ ] **Step 2: Run the whole suite**

  Run: `npm test`
  Expected: PASS (no regressions; main has no unit tests of its own here, it is covered by the UI checks in Task 7).

- [ ] **Step 3: Commit**

  ```bash
  git add electron/main.mjs electron/preload.cjs
  git commit -m "feat(cache-keeper): wire the keeper into sessions, guards, replay, settings and IPC"
  ```

### Task 6: The window (`electron/renderer/app.js`, `index.html`, `style.css`)

**Files:**
- Modify: `electron/renderer/index.html` (the Settings dialog, after `#set-queue`)
- Modify: `electron/renderer/app.js`, in:
  - the settings load/save (~283, ~3681);
  - `SessionView` (the header chip after `this.usageChip`, the status-bar switch after `this.holdBar`, and the queue
    and draft reports);
  - `item()` (~3176, the ⏳ mark);
  - the `api.onKeeperState` handler.
- Modify: `electron/renderer/style.css`
- Modify: `docs/superpowers/specs/2026-11-25-cache-keeper-design.md`, the "Session menu" line → status-bar switch.
- Modify: `electron/README.md` (feature list and settings)

**Interfaces:**
- Consumes: the preload API of Task 5 and `keeper:state` payloads (Task 4).
- Produces:
  - DOM ids `#set-keeper`, `#set-keeper-pings`, `#set-keeper-min`.
  - The chip element `.keeper-chip` with a `button.keeper-not-now`.
  - The status-bar `input.keeper-switch`.
  - The sidebar `span.keeper-mark`. Task 7 uses these selectors.

- [ ] **Step 1: Implement**

  **Settings**
  - The checkbox and the two number inputs with the Global Constraints labels and hint.
  - `pings` is an empty-allowed number input; `minContext` is shown in k tokens and saved × 1000.

  **Chip**
  - Hidden in phase `off`, `idle` and `done`.
  - `pinging`: "♻ Keeping the cache warm (n/N)".
  - `countdown`: "⏳ Compacting in m:ss", ticking every second from `compactAt`.
  - `compacting`: "⏳ Compacting…".
  - **Not now** calls `api.keeperNotNow`.

  **Status-bar switch**
  - "Keep cache", checked = on.
  - Its initial value comes from `api.keeperGet`; a change calls `api.keeperOptOut(id, !checked)`.

  **Reports**
  - `api.keeperHeld(id, held)` with `held = this.queue.length > 0 || this.input.value.trim() !== ""`.
  - Sent on queue changes and on `input` events, debounced 300 ms, only when the value changes.

  **Sidebar**
  - `⏳` (`span.keeper-mark`, title "Compacting soon") when the view's last keeper phase is `countdown`.

- [ ] **Step 2: Run the suite and a manual look**

  Run: `npm test`. Expected: PASS.

  Run the app (`npm --prefix electron start`) against the scripted agent, or look in Task 7's check. In Settings the
  three fields load and save.

- [ ] **Step 3: Commit**

  ```bash
  git add electron/renderer electron/README.md docs/superpowers/specs/2026-11-25-cache-keeper-design.md
  git commit -m "feat(cache-keeper): settings, countdown chip with Not now, per-session switch, sidebar mark"
  ```

### Task 7: UI checks against the scripted agent

**Files:**
- Modify: `electron/test/fixtures/acp/scripted-agent.mjs`, adding a step
  `{ checkpoint: { ttlMs: number, model: string } }`.
- Modify: `electron/test/scripted-agent.test.mjs`
- Create: `electron/test/fixtures/acp/keeper-scenario.mjs`
- Modify: `scripts/ui-check/checks.mjs`

**Interfaces:**
- Consumes: the selectors of Task 6, the env hooks of Task 5, and `KEEPALIVE_MARKER` (Task 1).
- Produces: the scripted-agent step `checkpoint`. It appends to `$COPILOT_HOME/session-state/<session id>/events.jsonl`:
  - a `session.start` line first, if the file has none;
  - a `user.message` for each prompt received, with `data.content` = the prompt text;
  - a `session.usage_checkpoint` with a fresh `id`, `timestamp` now, and
    `modelCacheState: [{ modelId: model, cacheExpiresAt: now + ttlMs, cacheTtlSeconds: ttlMs / 1000 }]`.

- [ ] **Step 1: Test the new step**

  In `scripted-agent.test.mjs`, add `"a checkpoint step writes a usage checkpoint"`. A prompt with
  `[{ checkpoint: { ttlMs: 9000, model: "claude-opus-5.5" } }, { end: "end_turn" }]` leaves an `events.jsonl` whose
  last line is a checkpoint expiring about 9 s after the step ran. Run `node --test electron/test/scripted-agent.test.mjs`:
  FAIL, then PASS after implementing the step.

- [ ] **Step 2: Write the scenario and the checks**

  `keeper-scenario.mjs`: a session with a `UUID` id (driver `sessionId`) and `configOptions` with a model option whose
  `currentValue` is `claude-opus-5.5`. Every prompt plays:
  - `{ u: { sessionUpdate: "usage_update", used: 160000, size: 200000 } }`;
  - `{ checkpoint: { ttlMs: 9000, model: "claude-opus-5.5" } }`;
  - an answer chunk;
  - `{ end: "end_turn" }`.

  A prompt starting with `/compact` answers "Compacted conversation history and removed 4 messages and 900 tokens."

  Checks in `checks.mjs`, launched with:
  - settings `cacheKeeper: { enabled: true, pings: 1, minContext: 50000 }`;
  - env `COPILOT_RELAY_KEEPER_LEADS_MS="6000,5000,3000,1000"` and `COPILOT_RELAY_KEEPER_RETRY_MS=200`.

  The checks:
  - `keeper-ping-not-now`:
    - send "hello", then idle;
    - within ~5 s the agent records a prompt that starts with `[keep-alive]` (read `.scripted-agent.json`);
    - the chat shows no bubble for it;
    - the chip then shows "⏳ Compacting in";
    - clicking **Not now** hides the chip;
    - after 6 s no `/compact` prompt was recorded.
  - `keeper-compact`:
    - same start, without clicking **Not now**;
    - the agent records `/compact Quote verbatim the last user message and your last answer.`;
    - the chat shows "Compacted automatically before the prompt cache expired (−4 messages)" and no "Compacted
      conversation history" line.
  - `keeper-prompt-waits`:
    - send "hello" with a scenario whose ping turn waits 1500 ms;
    - type and send "second" while the ping runs;
    - "second" is answered and appears once;
    - no error notice.
  - `keeper-switch-off`: uncheck `input.keeper-switch`, send "hello", and after 8 s
    nothing was recorded after it.

- [ ] **Step 3: Run the UI checks**

  Run: `npm --prefix electron run copy-relay && node scripts/ui-check/run.mjs keeper-ping-not-now keeper-compact keeper-prompt-waits keeper-switch-off`
  Expected: the four keeper checks pass. Then run all checks: no regressions.

- [ ] **Step 4: Commit**

  ```bash
  git add electron/test/fixtures/acp scripts/ui-check electron/test/scripted-agent.test.mjs
  git commit -m "test(cache-keeper): UI checks for the hidden ping, countdown, Not now, compaction and the switch"
  ```
