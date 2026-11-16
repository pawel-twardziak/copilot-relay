# Edit a Message Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An **Edit** action on your own messages in the desktop app. Sending the edited text replaces that
message and everything after it in the same session. The history is cut only at send time.

**Architecture:** Renderer only (`electron/renderer/`), plus README. Edit mode is per-view state on
`SessionView` (`this.edit`) and touches nothing on disk. Send in edit mode reuses the Delete path
(`api.truncateSession` → `reopenView`) and then runs the edited prompt in the rebuilt view. The relay inbox
stays held until the edited prompt has started. Pure decisions go in a new classic-script module
`edit-message.js` (`globalThis.EditMessage`, `module.exports` for tests), in the style of `ui-state.js`.

**Tech Stack:** Electron, vanilla JS renderer, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-16-edit-message-design.md`

## Global Constraints

- No change to `history.mjs`, `main.mjs`, `preload.cjs`. Main's refusals stay the only gate on the cut.
- Nothing on disk changes before Send.
- Exact strings:
  - Edit tooltip: `Edit this message: sending replaces it and everything after it`
  - Banner: `Editing a message. Sending replaces it and everything after it (N messages). Files changed by the agent are not reverted. Esc to cancel.` (with `1 message` when N is 1)
  - Command refusal: `Commands can't replace a message. Cancel the edit to run a command.`
  - Status while sending: `Replacing the message…`
- Button order on your messages: **Edit · Fork · Delete · Copy**.
- Tests: `npm test` from the repo root (`node --test "electron/test/*.test.mjs"`).

## Review Focus

1. **A relay message or turn starts during the `countFrom` await in `startEdit`.** Expected: edit mode is not
   entered once the view became busy. Task 2: re-check `busy/dead/deleting/historyOp` after the await.
2. **Esc while the command popup is open in edit mode** closes only the popup, not the edit. Task 2: the
   popup handler keeps running first. Covered by the manual check.
3. **Notes arriving while editing** (`pendingNotes` grows) plus the replaced message's own notes. Both reach
   the model, oldest first. Task 1 test `notesPrefix`, Task 3 order rule.
4. **Switching tabs during an edit** keeps the edit (state is per view). Closing the tab ends it with nothing
   cut. Manual check, Task 4.
5. **Send with text identical to the original** still cuts and resends. No special-casing.

---

### Task 1: Pure helpers (`edit-message.js`)

**Files:**
- Create: `electron/renderer/edit-message.js`
- Modify: `electron/renderer/index.html` (add `<script src="edit-message.js"></script>` after `ui-state.js`)
- Modify: `electron/renderer/app.js:637-646` (`ownMessages` uses `isOwnMessage`)
- Test: `electron/test/edit-message.test.mjs`

**Interfaces:**
- Produces (on `globalThis.EditMessage` and `module.exports`):
  - `isOwnMessage({ relay: boolean, human: boolean, hidden: boolean, text: string }) -> boolean`. This is today's
    `ownMessages` filter: `false` if relay && !human, `false` if hidden or `text.trim()` is empty, `false` if
    `RELAY_PREFIX` (`/^\[from [^\]\n]+\]\n/`, moved here and exported as `RELAY_PREFIX`) matches.
  - `notesPrefix(matchText: string, ownText: string|undefined) -> string`. The notes part `runPrompt` put in front
    of your text (`notes.join("\n\n") + "\n\n" + text`), **without** the trailing `"\n\n"`. `""` if there was none.
  - `editRefusal(text: string, { agentAvailable: boolean }) -> string|null`. The refusal string (Global
    Constraints) if `SlashCommands.parseRenameCommand(text)`, or `agentAvailable && parseAgentCommand(text)`,
    or `isCommandPrompt(text)`. Otherwise `null`. `SlashCommands` comes from `globalThis.SlashCommands ??
    require("./commands.js")`.
  - `editBanner(n: number) -> string`.

- [ ] **Step 1: Write the failing tests**

```js
const EM = createRequire(import.meta.url)("../renderer/edit-message.js");
test("isOwnMessage", () => {
  assert.equal(EM.isOwnMessage({ relay: false, human: false, hidden: false, text: "hi" }), true);
  assert.equal(EM.isOwnMessage({ relay: true, human: false, hidden: false, text: "hi" }), false);
  assert.equal(EM.isOwnMessage({ relay: true, human: true, hidden: false, text: "hi" }), true);
  assert.equal(EM.isOwnMessage({ relay: false, human: false, hidden: true, text: "hi" }), false);
  assert.equal(EM.isOwnMessage({ relay: false, human: false, hidden: false, text: "  " }), false);
  assert.equal(EM.isOwnMessage({ relay: false, human: false, hidden: false, text: "[from relay]\nnote\n\nhi" }), false);
});
test("notesPrefix", () => {
  assert.equal(EM.notesPrefix("hi", undefined), "");
  assert.equal(EM.notesPrefix("hi", "hi"), "");
  assert.equal(EM.notesPrefix("n1\n\nn2\n\nhi", "hi"), "n1\n\nn2");
  assert.equal(EM.notesPrefix("something else", "hi"), "");
});
test("editRefusal", () => {
  const R = "Commands can't replace a message. Cancel the edit to run a command.";
  assert.equal(EM.editRefusal("/context", { agentAvailable: false }), R);
  assert.equal(EM.editRefusal("/rename x", { agentAvailable: false }), R);
  assert.equal(EM.editRefusal("/agent foo", { agentAvailable: true }), R);
  assert.equal(EM.editRefusal("fix the bug", { agentAvailable: true }), null);
});
test("editBanner", () => {
  assert.match(EM.editBanner(1), /\(1 message\)/);
  assert.match(EM.editBanner(3), /\(3 messages\)/);
});
```

Check `isCommandPrompt` / `parseAgentCommand` in `commands.js` against these inputs first. If `/agent foo`
with `agentAvailable: false` is a CLI command there, keep the assertion that matches its real behaviour.

- [ ] **Step 2:** `npm test`. Expected: FAIL, module not found.
- [ ] **Step 3:** Implement `edit-message.js` with the four functions and `RELAY_PREFIX`. Add the script tag.
  Replace `ownMessages`' inline filter with `EditMessage.isOwnMessage({ relay: el.classList.contains("relay"),
  human: !!el._human, hidden: el.hidden, text })`, and make `app.js`' `RELAY_PREFIX` refer to
  `EditMessage.RELAY_PREFIX`.
- [ ] **Step 4:** `npm test`. Expected: all pass, including the existing tests.
- [ ] **Step 5:** Commit `feat(desktop): helpers for editing a message`.

---

### Task 2: Edit mode (no disk change)

**Files:**
- Modify: `electron/renderer/app.js` (`SessionView`: constructor, `addActions`, `historyAction`, key handlers,
  `pump`, `markDead`, `renderRun`)
- Modify: `electron/renderer/style.css`

**Interfaces:**
- Consumes: `EditMessage.isOwnMessage`, `editBanner` (Task 1), `api.countFrom` (exists).
- Produces on `SessionView`:
  - `this.edit: { el, ordinal: number, matchText: string, ownText: string, draft: string } | null`
  - `async startEdit(el)`, `cancelEdit()` (restores `edit.draft`), `clearEdit()` (UI and state only, no restore)
  - `this.holdInbox: boolean` (constructor option `holdInbox`, default `false`) and `releaseInbox()` (sets it
    `false`, then `pump()`)
  - `isEditable(el) -> boolean` (`el._kind === "user" && isOwnMessage(...)`)

- [ ] **Step 1: The Edit button.** In `addActions`, for `_kind === "user"` create an `Edit` act button
  (tooltip from Global Constraints) first in the bar, kept as `el._editAct`, with `hidden = !this.isEditable(el)`.
  The click calls `this.startEdit(el)`, not `historyAction`. Recompute `el._editAct.hidden` where a replayed
  user bubble's text becomes final (`renderRun(r, true)` for `type === "user"`).
- [ ] **Step 2: `startEdit(el)`.** Return if busy/dead/deleting/historyOp. `await api.countFrom(sessionId,
  { ordinal: el._turn, text: el._matchText(), where: "beforeUser" })`. On error, `this.error(\`Could not edit:
  ${e.message}\`)` and return. After the await, re-check busy/dead/deleting/historyOp (Review Focus 1). If not
  already editing, the draft is `this.recallEl ? this.draft : this.input.value`, then `setRecalled(null)`.
  If already editing, keep the old `edit.draft` and `clearEdit()`. Set `this.edit`. Put `ownText` in the box,
  caret at the end, `autosize()`, focus. Add class `edit-from` to `el`. Show the banner with
  `editBanner(count.removedUserMessages)`.
- [ ] **Step 3: The banner.** In the constructor, add `this.editBar = h("div", { class: "edit-bar", hidden: true },
  this.editText = h("span"), h("button", { onclick: () => this.cancelEdit() }, "Cancel"))`, placed between
  `this.log` and the composer.
- [ ] **Step 4: Rules while editing.**
  - The Left Shift+Up/Down handler returns early (without `preventDefault`) when `this.edit`.
  - The Enter/Esc handler: `Escape` with `busy` stops the turn, as now. Otherwise `Escape` with `this.edit`
    calls `cancelEdit()`.
  - `pump()` returns when `this.edit || this.holdInbox`.
  - `historyAction` calls `cancelEdit()` first.
  - `markDead` calls `clearEdit()`. The text stays in the box.
  - `cancelEdit()` and `clearEdit()` end with `pump()` when not busy.
- [ ] **Step 5: CSS.** `.edit-bar` is a slim strip in `var(--panel)` with `var(--border)` and the Cancel button
  on the right. `.log > .edit-from, .log > .edit-from ~ * { opacity: .45 }`. Uses existing tokens only, so both
  themes work.
- [ ] **Step 6: Check.** `npm test` passes. In the app (`npm start` in `electron/`): Edit shows on your messages
  only, not on replies or on `[from …]` messages. Clicking it fills the box, dims and shows the banner. Esc
  and Cancel restore the draft. `sha256sum ~/.copilot/session-state/<id>/events.jsonl` is unchanged.
- [ ] **Step 7:** Commit `feat(desktop): edit mode for a message`.

---

### Task 3: Send in edit mode

**Files:**
- Modify: `electron/renderer/app.js` (`send`, new `sendEdit`, new `userBubble`, `reopenView`, `openSession` /
  `SessionView` constructor)
- Modify: `electron/README.md` (a line next to Fork/Delete, plus the terminal-CLI caveat)

**Interfaces:**
- Consumes: `this.edit`, `holdInbox`/`releaseInbox`, `clearEdit` (Task 2), and `notesPrefix`, `editRefusal`
  (Task 1).
- Produces:
  - `userBubble(text) -> Element`: the bubble + `mentionThumbs` + `linkPaths` block pulled out of `send()`, which
    `send()` now uses as well.
  - `reopenView(old, error, { holdInbox = false, typed } = {}) -> Promise<SessionView|undefined>`. It now returns
    the new view. `typed`, when given (including `""`), replaces the text carried over. `holdInbox` is passed
    to `openSession` and the constructor, so it is already set before `openSession`'s `setBusy(false)` queues
    `pump()`.

- [ ] **Step 1: Route.** At the top of `send()`, after the empty/dead/deleting/busy checks, `if (this.edit)
  return this.sendEdit(text)`.
- [ ] **Step 2: `async sendEdit(text)`.**
  1. If `editRefusal(text, { agentAvailable: this.agentAvailable() })` returns a string, show it in the status
     line and return.
  2. Take `{ ordinal, matchText, ownText, draft } = this.edit` and `prefix = notesPrefix(matchText, ownText)`.
     Set the `historyOp` flag, `setBusy(true)`, status `Replacing the message…`.
  3. `await api.truncateSession(sessionId, { ordinal, text: matchText, where: "beforeUser" })`. On failure,
     `await api.closeSession(sessionId).catch(() => {})`, as `deleteFrom` does.
  4. `const v = await reopenView(this, failure && \`Could not replace the message: ${failure.message}\`, {
     holdInbox: true, typed: failure ? text : draft })`.
  5. If there was a failure, or `!v`, or `v.dead`: the edited text goes into `(v ?? this).input` (autosize), then
     `v?.releaseInbox()` and return. When the cut succeeded but the reopen failed, `typed` is the edited text.
  6. Otherwise: if `prefix`, `v.pendingNotes.unshift(prefix)`, so the old notes come first. Then `const run =
     v.runPrompt(text, v.userBubble(text), "app")`. `runPrompt` sets busy synchronously, so call
     `v.releaseInbox()` right after it, then `await run`.
- [ ] **Step 3: README.** Next to Fork/Delete: Edit on your message puts it in the box. Sending replaces it and
  everything after it in the same session (backup `events.jsonl.bak`, files not reverted). Esc cancels and
  nothing changes. Don't use it while the session is open in a terminal Copilot CLI.
- [ ] **Step 4: Check.** `npm test` passes. Run the spec's manual checks 2–5 with a cheap model:
  - Edit the 2nd of 3 messages and send. The log shows turn 1 plus the new turn. The model doesn't know the old
    turns 2–3. `.bak` holds the old history.
  - In edit mode, change that message's text in `events.jsonl` by hand, then send. You get the error, the
    edited text stays as a plain draft, and the history is not cut.
  - A relay message that arrives during edit mode starts only after the edited prompt's turn.
  - `/context` in edit mode is refused and nothing is cut.
- [ ] **Step 5:** Commit `feat(desktop): send an edited message in place`.

---

### Task 4: Final pass

- [ ] **Step 1:** Run the spec's manual check 1 (Edit → cancel → hash unchanged) and Review Focus 2 and 4 in
  the app.
- [ ] **Step 2:** Run `npm test` from the repo root. Expected: all pass.
- [ ] **Step 3:** Commit any fixes. Hand over for the branch review.
