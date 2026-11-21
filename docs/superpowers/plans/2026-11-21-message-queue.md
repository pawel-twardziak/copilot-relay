# Message Queue for Busy Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the desktop app, messages for a working session (relay messages and the user's own prompts) wait in a per-session queue and are delivered as ordinary prompts at the first tool boundary of the running turn, or at its end; off by default behind a setting.

**Architecture:** A pure renderer helper (`electron/renderer/message-queue.js`) holds the rules: wrapper format, tool in-flight tracking, delivery decisions, pause rules, status text. `SessionView` in `renderer/app.js` turns its `inbox` into a queue of items, sends the head item with a second `session/prompt` when a tool completes and none is in flight, treats the overlapping prompts as one turn, and shows a queue strip. The main process counts overlapping prompts per session instead of a boolean.

**Tech Stack:** Electron, plain-JS renderer (classic scripts, `require()` in tests), Node `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-21-message-queue-design.md`

## Global Constraints

- Setting key `queueMidTurn` in the app's `settings.json`, **default off** (a missing key is off); label "Deliver queued messages during a turn". Off = today's behaviour exactly.
- Wrapper format is fixed. First line exactly `[queued message, delivered during your work]`; last paragraph exactly `[End of the queued message. Handle it now. Then go back to the task you were doing and finish it, unless this message changes or cancels that task.]`.
- Abort marker: an `agent_message_chunk` whose text is exactly `Info: Operation cancelled by user`.
- A tool is in flight from `tool_call` until `tool_call_update` status `completed` or `failed`; pending permission counts as in flight.
- One queued item per delivery; mid-turn only when no tool is in flight.
- No new dependencies. Renderer modules follow `ui-state.js`: classic script setting a global, `module.exports` for tests.
- Every new module that `main.mjs` imports goes into `electron/package.json` `build.files` (`electron/test/packaging.test.mjs` checks it).
- Tests: `npm test`. Copilot answers 403 on the dev machine; real-Copilot checks are the manual list at the end.

## Review Focus

- A relay message or delegated task arriving while the queue is paused and the session idle must wait, not start a turn (Task 1 `canDeliverIdle` test).
- The setting turned off while own prompts are queued: they go at the end of the turn, never mid-turn (Task 1 `canDeliverMidTurn` test).
- A user message that happens to start with the marker line but lacks the end paragraph must be shown and edited as typed (Task 1 `unwrap` test).
- A `tool_call_update` `completed` for a tool the tracker never saw (replayed history, another prompt) must not count as a boundary (Task 1 tracker test).
- Agent text that merely contains "Info: Operation cancelled by user" inside a longer chunk must not be swallowed (Task 1 `isAbortChunk` test).

---

### Task 1: Pure queue rules (`message-queue.js`)

**Files:**
- Create: `electron/renderer/message-queue.js`
- Modify: `electron/renderer/index.html` (add `<script src="message-queue.js"></script>` before `app.js`, after `edit-message.js`)
- Test: `electron/test/message-queue.test.mjs`

**Interfaces:**
- Produces (global `MessageQueue`, also `module.exports`):
  - `MARKER: string`, `END: string`, `ABORT_TEXT: string` (values from Global Constraints)
  - `wrap(text: string) -> string` = `MARKER + "\n" + text + "\n\n" + END`
  - `unwrap(text: string) -> string | null` — the inner text when `text` starts with `MARKER + "\n"` and ends with `"\n\n" + END`, else null
  - `isAbortChunk(text: string) -> boolean` — `text === ABORT_TEXT`
  - `createToolTracker() -> { update(u) -> boolean, size() -> number, drop() -> string[], reset() -> void }` — `update` adds the id on `tool_call` (unless its status is already terminal) and on a non-terminal `tool_call_update` for an unknown id; removes it on terminal status; returns true only when a tracked id reached `completed`/`failed` and the set is now empty. `drop()` returns and clears the ids still in flight.
  - `canDeliverMidTurn(s) -> boolean`, `s = { enabled, paused, prompting, edit, historyOp, holdInbox, deleting, dead, inFlight, head }` — true when `enabled && !paused && prompting && !edit && !historyOp && !holdInbox && !deleting && !dead && inFlight === 0 && head && !head.command`
  - `canDeliverIdle(s) -> boolean`, `s = { busy, paused, edit, historyOp, holdInbox, deleting, dead, queued }` — today's `pump()` condition plus `!paused`, `queued > 0`
  - `pauseOnStop({ enabled, queued }) -> boolean` — `enabled && queued > 0`
  - `statusText({ busy, dead, deleting, queued, paused }) -> string` — deleting → `"Deleting session…"`; busy → `"Working…"` plus `" (N queued)"` when N > 0 and `" (queue paused)"` when paused; dead → `"Copilot process ended"`; idle with N > 0 → `"Queue paused (N)"` when paused, else `"N message(s) waiting"`; else `""`
- Queue item shape used by later tasks (documented in the module header): `{ id, kind: "app" | "relay", text, prompt, from, human, fromCwd, deliveryId, command }` — `text` is what the bubble shows, `prompt` what is sent, `command` true for a slash command.

- [ ] **Step 1: Write the failing tests** in `electron/test/message-queue.test.mjs` (load with `createRequire(import.meta.url)("../renderer/message-queue.js")`, as `ui-state.test.mjs` does):
  - `wrap/unwrap round trip`: `unwrap(wrap("hi"))` is `"hi"`; `unwrap(wrap("[from backend-a1b2c3]\nhello"))` keeps the `[from …]` line; `unwrap(wrap("a\n\nb"))` is `"a\n\nb"`.
  - `unwrap needs both ends`: `unwrap(MARKER + "\nhi")` is null; `unwrap("hi\n\n" + END)` is null; `unwrap("plain")` is null.
  - `isAbortChunk is exact`: true for `"Info: Operation cancelled by user"`; false for `"Info: Operation cancelled by userThe ping…"` and for `"x Info: Operation cancelled by user"`.
  - `tracker boundary`: `tool_call a` → false; `tool_call_update a completed` → true; `size()` 0.
  - `tracker waits for parallel tools`: `tool_call a`, `tool_call b`, `a completed` → false (size 1), `b failed` → true.
  - `tracker ignores unknown completions`: on an empty tracker `tool_call_update x completed` → false.
  - `tracker drop`: `tool_call a`, `tool_call b`, `drop()` deep-equals `["a","b"]`, then `size()` 0.
  - `canDeliverMidTurn`: true for the all-clear state with `head: { command: false }`; false for each of `enabled:false`, `paused:true`, `prompting:false`, `inFlight:1`, `head:{command:true}`, `head:undefined`, `edit:{}`, `historyOp:true`, `holdInbox:true`.
  - `canDeliverIdle`: true when idle with `queued:1`; false with `paused:true`, `busy:true`, `queued:0`.
  - `pauseOnStop`: `{enabled:true, queued:2}` true; `{enabled:true, queued:0}` false; `{enabled:false, queued:2}` false.
  - `statusText`: `{busy:true, queued:2}` → `"Working… (2 queued)"`; `{busy:false, queued:2, paused:true}` → `"Queue paused (2)"`; `{busy:false, queued:1}` → `"1 message(s) waiting"`; `{deleting:true, busy:true}` → `"Deleting session…"`.

- [ ] **Step 2: Run** `node --test electron/test/message-queue.test.mjs` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement `electron/renderer/message-queue.js`** with the interface above (`"use strict"`, `globalThis.MessageQueue = …`, `if (typeof module !== "undefined") module.exports = …`), and add the script tag to `index.html`.
- [ ] **Step 4: Run** `npm test` — Expected: all pass.
- [ ] **Step 5: Commit** `feat(desktop): queue rules for messages to a busy session`

### Task 2: Main-process prompt counter and the setting

**Files:**
- Create: `electron/prompt-count.mjs`
- Modify: `electron/main.mjs` (`sessions:prompt` ~639-663, `slashRename` ~680-690, `settings:get`/`settings:set` ~1027-1038), `electron/package.json` (`build.files`: add `"prompt-count.mjs"`), `electron/renderer/index.html` (settings dialog, next to `#set-relay`), `electron/renderer/app.js` (`openSettings` ~2358, settings `close` handler ~2405, startup)
- Test: `electron/test/prompt-count.test.mjs`

**Interfaces:**
- Produces: `beginPrompt(entry) -> boolean` (increments `entry.prompting`, a number; true when it went 0 → 1), `endPrompt(entry) -> boolean` (decrements, never below 0; true when it reached 0). `entry.prompting` stays truthy while any prompt is pending, so every existing `if (entry.prompting)` check keeps working.
- Produces (renderer): a module-level `let queueMidTurn = false;` in `app.js`, set from `api.getSettings()` at startup and after saving settings; `SessionView.settingChanged()` refreshes the view's Send button and status line (used by Tasks 3-4).
- `settings:get` returns `queueMidTurn: loadSettings().queueMidTurn === true`; `settings:set` stores `queueMidTurn: s.queueMidTurn === true` alongside the existing fields.

- [ ] **Step 1: Write the failing tests** in `electron/test/prompt-count.test.mjs`: `beginPrompt` on `{}` returns true and sets `prompting` to 1; a second `beginPrompt` returns false (2); `endPrompt` returns false (1) then true (0); `endPrompt` on `{prompting: 0}` returns false and leaves 0 (never negative).
- [ ] **Step 2: Run** `node --test electron/test/prompt-count.test.mjs` — Expected: FAIL.
- [ ] **Step 3: Implement `electron/prompt-count.mjs`**; in `sessions:prompt` replace `entry.prompting = true` / `= false` with `if (beginPrompt(entry)) entry.relay?.state(true)` and, in `finally`, `if (endPrompt(entry)) { entry.relay?.state(false); if (open.get(sessionId) === entry) usage.refresh(sessionId); }`. `slashRename` uses `beginPrompt`/`endPrompt` too (keeps `entry.renaming`). Add the file to `build.files`.
- [ ] **Step 4: Add the setting:** `settings:get`/`settings:set` as above; checkbox `<input id="set-queue" type="checkbox" />` labelled "Deliver queued messages during a turn" with a hint line "Messages for a working session are delivered after its current tool step. Off: they wait until the turn ends." in the settings dialog; `openSettings` sets it from `s.queueMidTurn`; the `close` handler passes `queueMidTurn: $("#set-queue").checked`, then updates `queueMidTurn` and calls `settingChanged()` on every open view. At startup read `api.getSettings()` once into `queueMidTurn`.
- [ ] **Step 5: Run** `npm test` — Expected: all pass (packaging test included).
- [ ] **Step 6: Commit** `feat(desktop): count overlapping prompts; queue setting (off by default)`

### Task 3: Queue and delivery in `SessionView`

**Files:**
- Modify: `electron/renderer/app.js` — constructor (~246-271: `inbox`), `setBusy` (~936), `incoming`/`pump` (~1008-1036), `onUpdate` (~1090), `toolCall` (~1133: an `interrupted` status), `send` (~1474), `runPrompt` (~1580-1625), `cancel` (~1627); `electron/renderer/style.css` (`.tool .st.interrupted`)

**Interfaces:**
- Consumes: Task 1 `MessageQueue` (all of it), Task 2 `queueMidTurn`, `settingChanged()`.
- Produces (used by Task 4): `this.queue: Item[]` (replaces `this.inbox`; every `this.inbox` use moves to it), `this.paused: boolean`, `this.renderQueue()` (called after every queue change; Task 3 defines it as a no-op that Task 4 fills), `this.enqueue(item)`, `deliverMidTurn()`, `runPrompt(text, bubble, source, delivery = null, { midTurn = false } = {})`.

Behaviour to implement (the spec's Delivery rules and "The turn as the app sees it"):

- [ ] **Step 1: Queue items.** `incoming(m)` (waking messages) builds a relay item (`kind:"relay"`, `text: m.text`, `prompt: m.prompt`, `from`, `human`, `fromCwd`, `deliveryId`, `command:false`) and calls `enqueue`. `send()` while busy: when `queueMidTurn` is on and the text is not `/rename` or an `/agent` command, clear the input exactly as a sent prompt does (recall/draft handling) and enqueue `{ kind:"app", text, prompt:text, command: SlashCommands.isCommandPrompt(text) }`; otherwise keep today's refusal. `setBusy` keeps Send enabled while busy when `queueMidTurn` is on (still disabled when dead/deleting); `settingChanged()` re-applies this. Status line text comes from `MessageQueue.statusText`.
- [ ] **Step 2: End-of-turn delivery.** `pump()` uses `MessageQueue.canDeliverIdle`; it shifts the head item and starts it as today: relay items exactly as now (relay bubble, `deliveryAck`, source `"human"`/`"relay"`), app items with `this.userBubble(item.text)` and source `"app"`.
- [ ] **Step 3: Chain bookkeeping in `runPrompt`.** Replace the single-prompt assumptions with a per-view count `this.chain` and per-call record `{ interrupted:false }` kept in `this.chainRecords`: `this.prompting` is `this.chain > 0`; when the chain starts (0 → 1) reset `this.tracker = MessageQueue.createToolTracker()` and `this.midTurnSent = false`. On each return: show "Stopped." only when `stop === "cancelled" && !record.interrupted`; other stop reasons as today. Only when the chain ends (→ 0): run today's `finally` work (`dismissPermissions`, the command `dropTurn` check, `setBusy(false)`, `scheduleRefresh`), and if `this.midTurnSent`, mark every id from `this.tracker.drop()` interrupted.
- [ ] **Step 4: Mid-turn send.** In `onUpdate`, for `tool_call`/`tool_call_update` while `this.chain > 0`, call `this.tracker.update(u)`; when it returns true and `MessageQueue.canDeliverMidTurn({... inFlight: this.tracker.size(), head: this.queue[0] })`, call `deliverMidTurn()`: shift the head, mark all current `chainRecords` interrupted, set `this.midTurnSent = true`, build the bubble (relay or user, as in `pump`) and call `runPrompt(item.prompt, el, source, delivery, { midTurn: true })`. With `midTurn`, `runPrompt` sends `MessageQueue.wrap(sent)` where `sent` already includes any `pendingNotes` prefix (`_matchText` returns the wrapped text, `_ownText` the original), and it does **not** assign `this.delivery`; it stores it as `this.pendingSwitch = { delivery }`.
- [ ] **Step 5: Switch point.** In `onUpdate`, an `agent_message_chunk` with `MessageQueue.isAbortChunk(text)` while `this.pendingSwitch` is set is not streamed; it clears `pendingSwitch`, marks every id from `this.tracker.drop()` as interrupted (`toolCall({ toolCallId, status: "interrupted" })`), calls `delivery?.returned()` (the ack) and sets `this.delivery = delivery`. If the delivered prompt returns while `pendingSwitch` is still its own, `returned()` acks there; on failure `failed()`, as `runPrompt` does today.
- [ ] **Step 6: Pause on Stop.** `cancel()` sets `this.paused = true` when `MessageQueue.pauseOnStop({ enabled: queueMidTurn, queued: this.queue.length })`, then cancels as today.
- [ ] **Step 7: Tool card status.** `toolCall` maps status `interrupted` to the symbol `⊘` and `_md` text "interrupted"; CSS `.tool .st.interrupted { color: var(--err); }`.
- [ ] **Step 8: Run** `npm test` — Expected: all pass. Then start the app (`npm run app`, or the project's run skill) on the dev machine and check that a session opens and the settings dialog shows the new checkbox; prompts can't run here (403).
- [ ] **Step 9: Commit** `feat(desktop): deliver queued messages at tool boundaries`

### Task 4: Queue strip, remove/edit, pause/resume

**Files:**
- Modify: `electron/renderer/app.js` (constructor: `this.queueEl` placed directly above the input row; `renderQueue()`), `electron/renderer/style.css` (`.queue-strip`)

**Interfaces:**
- Consumes: Task 3 `this.queue`, `this.paused`, `renderQueue()`, `pump()`, `deliverMidTurn()`.
- Produces: none for other tasks.

- [ ] **Step 1: Render.** `renderQueue()` hides `this.queueEl` when the queue is empty; otherwise a header `Queue (N)` plus `Paused` and a `▶ resume` button when `this.paused`, and one row per item: `you:` or `from <from>:`, the start of `item.text` on one line, the full text in `title`, and a `✕` button. It also refreshes the status line.
- [ ] **Step 2: Remove.** `✕` removes the item; for a relay item with `deliveryId` call `api.relayAck(this.sessionId, item.deliveryId)` and post `this.system(\`Removed a queued message from ${item.from}.\`)`. Removing the last item while paused clears `this.paused`.
- [ ] **Step 3: Edit.** Clicking an app item's text moves it into the input box and removes it from the queue, only when the input box is empty (otherwise the status line says "Clear the message box to edit a queued message."). Relay item rows are not clickable.
- [ ] **Step 4: Resume.** `▶` clears `this.paused`, re-renders, and calls `pump()` (idle) — mid-turn delivery then resumes at the next boundary by itself.
- [ ] **Step 5: Run** `npm test`; start the app and check the strip renders (empty strip hidden). Commit `feat(desktop): queue strip with remove, edit and resume`

### Task 5: Replayed and edited queued messages, docs

**Files:**
- Modify: `electron/renderer/app.js` — `stream()` (~1040-1056: `shown`, user `_matchText`), `flush()` relay header (~1083), `renderRun` (~1665), the edit flow's `EditMessage.notesPrefix(matchText, ownText)` call (~1538); `electron/README.md` (copilot-relay section, ~70-90)

**Interfaces:**
- Consumes: Task 1 `MessageQueue.unwrap`.
- Produces: a helper `shownUserText(raw) = MessageQueue.unwrap(raw) ?? raw` in `app.js`.

- [ ] **Step 1: Replay.** Everywhere a user run's text is shown or parsed (`shown` in `stream`, the `parseRelayHeader` calls in `flush` and `renderRun`) use `shownUserText(run.text)`. A replayed user bubble gets `_ownText = () => shownUserText(run.text)` and keeps `_matchText = () => run.text`, so `isEditableBubble`, recall and `_md` see the unwrapped text (a replayed relay message starts with `[from …]` again and is not editable) while history matching uses what was sent.
- [ ] **Step 2: Edit.** At the `notesPrefix` call pass `MessageQueue.unwrap(matchText) ?? matchText`, so the notes of a message delivered mid-turn are kept; the edited text is sent as a plain prompt (no `midTurn`).
- [ ] **Step 3: Docs.** In `electron/README.md`, copilot-relay section: replace "Messages that arrive while it is working wait in a queue." with the queue behaviour: off by default (**⚙ Settings → Deliver queued messages during a turn**); when on, messages and your own prompts sent while the session works are queued and delivered after the current tool step (never while a tool runs), the agent is told to return to its task; the queue strip (✕, click to edit your own, ▶); Stop pauses a non-empty queue.
- [ ] **Step 4: Run** `npm test` — Expected: all pass. Commit `feat(desktop): queued messages replay as their original bubbles; docs`

## Manual checks (work PC, real Copilot; setting on unless stated)

1. A long multi-tool task; type a prompt mid-turn: it shows in the strip, is delivered right after the current tool, the agent does it and returns to the task; no "Stopped." and no "Info: Operation cancelled by user" line; "Working…" stays on throughout.
2. Same with a relay message from another session; the sender gets the reply via `relay-send_message`; the message is not redelivered after an app restart.
3. Ask for two tools in parallel: nothing is delivered until both have finished.
4. Esc with items queued: the strip shows Paused; a new relay message waits; ▶ delivers.
5. Setting off: today's behaviour (own prompts refused while busy, relay messages after the turn).
6. Reopen the session: delivered messages are normal bubbles in place (relay ones "from X", not editable); edit and delete on an own delivered message work.
7. A queued `/context` waits until the turn ends.
