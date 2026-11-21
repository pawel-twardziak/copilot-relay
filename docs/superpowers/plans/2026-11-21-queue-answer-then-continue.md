# Queue: Answer, Then Continue — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A queued message is delivered as an answer prompt (reply to it and end the response; tools allowed), and after the last answer of a series the app sends one fixed "continue the task" prompt.

**Architecture:** Pure rules in `electron/renderer/message-queue.js` gain the answer-prompt ending, the continue prompt, and a small follow-up state (is an interrupted task waiting to be continued, and what to do when a turn ends). `SessionView` in `electron/renderer/app.js` wraps deliveries while a task is interrupted, sends the continue prompt at the end of the last answer turn, and shows the continue prompt as a "↻ continuing the task" line live and on replay.

**Tech Stack:** Electron, plain-JS renderer (classic scripts, `require()` in tests), Node `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-21-message-queue-design.md` — sections "Findings" (last bullet), "Delivery rules", "Answer, then continue", "Pausing".

## Global Constraints

- Answer prompt = `MARKER + "\n" + <message> + "\n\n" + ending` with MARKER `[queued message, delivered during your work]` and ending exactly END, or END_MORE when more items are still queued when it is sent:
  END: `[End of the queued message. Reply to it (to another session: with relay-send_message) and end your response there.]`
  END_MORE: `[End of the queued message. Reply to it (to another session: with relay-send_message) and end your response there. More queued messages follow; do not go back to your earlier task yet.]`
- `unwrap` also accepts these earlier endings exactly:
  `[End of the queued message. Handle it now. Then go back to the task you were doing and finish it, unless this message changes or cancels that task.]`
  `[End of the queued message. If it asks you something, answer it now in a short visible reply to the user (your thinking is not shown to them), then go back to the task you were doing and finish it, unless this message changes or cancels that task. Repeat the answer in your final message if the task goes on after it.]`
- Continue prompt, exact text (two lines):
  `[continue after queued messages]`
  `Continue the task you were working on before the queued message(s) above, taking them into account. If they changed the task, follow the change; if they cancelled it, do not continue and say so in one sentence.`
- Continue line label: `↻ continuing the task`.
- The answer prompt never mentions the coming continue prompt and never forbids tools.
- The continue prompt is sent with source `"relay"` (no image attachments, does not re-open the relay budget); no main-process change.
- Setting off (`queueMidTurn` false): behaviour unchanged (no mid-turn delivery → no interrupted task → no answer prompts, no continue prompt).
- No new dependencies. Tests: `npm test`. Real Copilot can't run on the dev machine (403).

## Review Focus

- Stop during an answer turn with nothing queued must not send the continue prompt (Task 1 `afterTurn` test).
- Stop with items still queued keeps the task pending: after ▶ the remaining items go as answer prompts and the continue prompt follows the last (Task 1 test).
- An own prompt sent while idle with a task pending drops the continue prompt (Task 1 `userPrompt` test).
- A replayed continue prompt must not be editable or recalled, and a user message that merely contains the continue text inside a longer message is a normal message (Task 1 `isContinuePrompt` exact-match test; Task 2 `ownUserText`).
- Items delivered at the end of a normal (not interrupted) turn stay plain prompts (Task 1 `answerDue` test).

---

### Task 1: Pure rules — answer ending, continue prompt, follow-up state

**Files:**
- Modify: `electron/renderer/message-queue.js` (constants near the top; `createChain().finish`; new `createFollowUp`; exports)
- Test: `electron/test/message-queue.test.mjs`

**Interfaces:**
- Produces:
  - `END`, `END_MORE` = the new answer endings; `wrap(text, { more = false } = {})` uses `END_MORE` when `more`; `OLD_ENDS` = the two earlier endings; `unwrap` accepts `END`, `END_MORE` and every `OLD_ENDS` entry.
  - `CONTINUE_PROMPT: string` (the two lines joined by `"\n"`), `CONTINUE_LABEL: string`, `isContinuePrompt(text) -> boolean` (`text === CONTINUE_PROMPT`).
  - `createChain()`: the object returned by `returned(...)` / `failed(...)` when the chain ends also carries `stopped: boolean` (the user stopped this chain, i.e. `stop()` was called on it). Not ended → `stopped: false`.
  - `createFollowUp() -> { interrupted(), answerDue() -> boolean, userPrompt(), afterTurn({ stopped, queued, paused, dead, deleting }) -> "continue" | "pump" | "none" }`:
    - `interrupted()`: a queued item was delivered mid-turn, so a task is waiting to be continued (pending = true).
    - `answerDue()`: true while pending (an item delivered now goes as an answer prompt).
    - `userPrompt()`: the user sent their own prompt while idle; pending = false.
    - `afterTurn(s)` at the end of a chain: not pending → `"none"`; `s.dead || s.deleting` → pending = false, `"none"`; `s.stopped` → if `s.queued > 0` keep pending, else pending = false; `"none"`; `s.queued > 0` → `"pump"` (pending kept: the next item goes as an answer prompt); `s.paused` → `"none"` (pending kept); otherwise pending = false and `"continue"`.

- [ ] **Step 1: Write the failing tests** in `electron/test/message-queue.test.mjs` (import the new names):
  - `answer ending`: `END` and `END_MORE` equal the exact Global Constraints strings; `wrap("x")` ends with `END`, `wrap("x", { more: true })` ends with `END_MORE`; `unwrap` of both is `"x"`; `unwrap` of `MARKER + "\nx\n\n" + e` is `"x"` for each `e` of `OLD_ENDS` (both exact strings from Global Constraints).
  - `continue prompt`: `isContinuePrompt(CONTINUE_PROMPT)` true; false for `CONTINUE_PROMPT + " "`, for `"x\n" + CONTINUE_PROMPT`, and for `""`; `CONTINUE_LABEL === "↻ continuing the task"`.
  - `chain stopped flag`: `start()`, `stop()`, `returned(rec, "cancelled")` → `ended: true, stopped: true`; a chain without `stop()` ends with `stopped: false`.
  - `follow-up, one answer`: `interrupted()`; `answerDue()` true; `afterTurn({ queued: 0 })` → `"continue"`; then `answerDue()` false and `afterTurn({ queued: 0 })` → `"none"`.
  - `follow-up, two answers`: `interrupted()`; `afterTurn({ queued: 1 })` → `"pump"`, `answerDue()` still true; `afterTurn({ queued: 0 })` → `"continue"`.
  - `follow-up, Stop`: `interrupted()`; `afterTurn({ stopped: true, queued: 0 })` → `"none"` and `answerDue()` false; separately `interrupted()`; `afterTurn({ stopped: true, queued: 2 })` → `"none"`, `answerDue()` true, then `afterTurn({ queued: 0 })` → `"continue"`.
  - `follow-up, paused / dead`: `interrupted()`; `afterTurn({ queued: 0, paused: true })` → `"none"`, `answerDue()` true; `afterTurn({ dead: true })` → `"none"`, `answerDue()` false.
  - `follow-up, own prompt`: `interrupted()`; `userPrompt()`; `answerDue()` false; `afterTurn({ queued: 0 })` → `"none"`.
  - `follow-up, normal turn`: a fresh follow-up: `answerDue()` false; `afterTurn({ queued: 1 })` → `"none"`.
- [ ] **Step 2: Run** `node --test electron/test/message-queue.test.mjs` — Expected: the new tests FAIL. (The test added in v0.13.2 that asserts the previous END wording must be replaced by the `answer ending` test — update it, don't keep both.)
- [ ] **Step 3: Implement** in `message-queue.js`; update the module header comment; export the new names.
- [ ] **Step 4: Run** `npm test` — Expected: all pass.
- [ ] **Step 5: Commit** `feat(desktop): answer-prompt ending, continue prompt and follow-up rules`

### Task 2: Wire answer-then-continue into `SessionView`; replay; docs

**Files:**
- Modify: `electron/renderer/app.js` — `shownUserText` (~236) plus a new `ownUserText`, `stream()` user runs (~1197-1205), `renderRun` (~1881), `pump()` (~1156), `deliverMidTurn()` (~1166), `runPrompt()` (~1773), `chainEnded()` (~1818), `send()` idle path, constructor (`this.followUp`); `electron/renderer/style.css` (`.msg.user.continue`); `electron/README.md` (copilot-relay "Queue:" bullet, ~84-88)

**Interfaces:**
- Consumes: Task 1 (`END`, `wrap`, `unwrap`, `CONTINUE_PROMPT`, `CONTINUE_LABEL`, `isContinuePrompt`, `createFollowUp`, chain `stopped`).
- Produces: `this.followUp = MessageQueue.createFollowUp()` per view; `runPrompt(text, bubble, source, delivery = null, { midTurn = false, answer = midTurn, more = false } = {})` — `answer` wraps with `MessageQueue.wrap(sent, { more })` (after the `pendingNotes` prefix, as today); `sendContinue()`.

- [ ] **Step 1: Delivery.** `deliverMidTurn()` calls `this.followUp.interrupted()` before sending, and sends with `{ midTurn: true, more }`; `pump()` sends the head item with `{ answer: this.followUp.answerDue(), more }`; in both, `more` is `this.queue.length > 0` after the item was taken off the queue. The idle path of `send()` (an own prompt sent as a turn, not queued) calls `this.followUp.userPrompt()` first.
- [ ] **Step 2: Continue.** In `chainEnded()`, after the existing work and only when the view is still the open one and no new chain started: `const next = this.followUp.afterTurn({ stopped: end.stopped, queued: this.queue.length, paused: this.paused, dead: this.dead, deleting: this.deleting })` (pass `stopped` from the chain's end result into `chainEnded`); `"continue"` → `this.sendContinue()`; `"pump"` → nothing extra (`setBusy(false)` already pumps). `sendContinue()` builds a continue line element (class `msg user continue`, body text `MessageQueue.CONTINUE_LABEL`, `_matchText = () => MessageQueue.CONTINUE_PROMPT`, `_ownText = () => ""` so it is never editable or recalled) and calls `this.runPrompt(MessageQueue.CONTINUE_PROMPT, el, "relay")`.
- [ ] **Step 3: Replay.** Add `ownUserText(raw) = MessageQueue.isContinuePrompt(raw) ? "" : shownUserText(raw)` and make `shownUserText` return `MessageQueue.CONTINUE_LABEL` for a continue prompt. Replayed user runs use `_ownText = () => ownUserText(run.text)`; `renderRun` adds the `continue` class to a user run whose text is a continue prompt. The copy/`_md` text of a continue line is the label.
- [ ] **Step 4: Style.** `.msg.user.continue`: small, muted, no bubble background (like a system line).
- [ ] **Step 5: Docs.** README "Queue:" bullet: replace "the agent is told to return to its task" with: a queued message is answered first (the agent replies and stops), then the app sends one "↻ continuing the task" prompt after the last answer; Stop cancels that continuation.
- [ ] **Step 6: Run** `npm test`; start the app under xvfb with CDP (scratch `--user-data-dir` with `{"relay":false,"queueMidTurn":true}`), construct a `SessionView`, call `sendContinue()` with `api.prompt` stubbed, and feed `onUpdate({ sessionUpdate: "user_message_chunk", content: { type: "text", text: MessageQueue.CONTINUE_PROMPT } })` while not prompting: both show "↻ continuing the task", neither has an Edit action. Screenshot.
- [ ] **Step 7: Commit** `feat(desktop): queued messages are answered, then the task is continued`

## Manual checks (work PC, real Copilot; setting on)

1. Long multi-tool task; queue "co robisz?": a visible answer, then "↻ continuing the task", and the task goes on to its final report.
1a. A relay message from another session mid-task: the agent replies with `relay-send_message`, ends its response, then continues.
2. Queue two messages: two answers, one continue line.
3. Queue a message that cancels the task ("stop, nie rób tego"): the answer acknowledges it; the continue prompt's reply says the task was cancelled in one sentence.
4. Press Stop during an answer with nothing queued: no continue line. With items queued: paused; ▶ → answers, then continue.
5. Reopen the session: answered messages are normal bubbles, continue prompts are "↻ continuing the task" lines without Edit.
