# Spec: Edit a message (desktop app)

## Intent

In Claude Code you can go back to one of your earlier prompts, change it and continue from there in the same
conversation. The desktop app (`electron/`) has two related actions, but neither one is an edit:

- **Fork** on a prompt opens a *new* session (`Fork of …`) with the history before the prompt and puts the
  prompt in its message box. You end up somewhere else, and the session list gets another entry.
- **Delete** on a prompt cuts the history in place, but cuts it *immediately*, behind a confirm dialog. The
  text is gone, and you would have to retype it.

**Edit** replaces one of your messages and everything after it with a new version, **in the same session**.
The history is cut only when you send the new version. Until then nothing on disk changes, and cancelling
leaves the session exactly as it was.

## Goals

- An **Edit** action on your own messages, next to Fork / Delete.
- Clicking it puts the message's text in the message box and enters *edit mode*. The log shows which message
  is being replaced and that everything after it goes too.
- **Send** in edit mode cuts the history before that message, reopens the session from its files and sends
  the edited text as the next prompt. It is one action for the user.
- **Cancel** (Esc, or a button in the edit banner) leaves edit mode, brings back the draft you had before and
  changes nothing on disk.

## Non-goals

- Reverting files the agent changed after that message (Claude Code has checkpoints, we don't). The edit
  banner says so, as the Delete dialog does now.
- More than one backup. The cut reuses `truncateSession`, which overwrites `events.jsonl.bak`, the same
  behaviour as Delete.
- Keeping the old branch (that is what Fork is for), or switching between branches.
- A keyboard shortcut that starts an edit (Claude Code's Esc Esc). Left Shift+Up/Down stays a plain recall of
  earlier messages, as now.
- Editing replies, or relay messages from other sessions.
- Any change to the history file format, `history.mjs` cut logic or the main-process IPC.

## Anti-goals (the feature fails if any of these happen)

- Anything on disk changes before you send. Clicking Edit and then cancelling, closing the tab, switching
  sessions or quitting the app leaves `events.jsonl` untouched.
- A failed send loses the edited text. If the cut or the reopen fails, the edited text is still in the
  message box and the error says what happened.
- Something else gets into the session between the cut and the edited prompt: no relay message, no queued
  note sent on its own, no second send.

## Current state (what this builds on)

- `history.mjs`: `cutIndex` / `describeCut` / `truncateSession(id, { ordinal, text, where })`. The
  `"beforeUser"` cut removes user message N and everything after it, and writes `events.jsonl.bak` first.
- `main.mjs`: `sessions:truncate` refuses while a turn is running, closes the session and waits for the process
  to exit, then truncates. `sessions:countFrom` gives the number of messages a cut removes.
- `renderer/app.js`:
  - `markTurn` numbers user/relay bubbles (`_turn`, `_kind: "user"`). `addActions` adds the Fork/Delete bar.
  - `historyAction` / `deleteFrom` hold the `historyOp` flag and call `api.truncateSession`, then
    `reopenView(old, error)`, which rebuilds the view from the replay. The view's draft, inbox,
    `pendingNotes`, `seenDeliveries` and `parentSessionId` move to the new view.
  - `ownMessages()` decides what counts as *your* message: `.msg.user` plus `.msg.relay` with `_human`,
    excluding hidden or empty bubbles and replayed `[from …]` relay messages.
  - `runPrompt(text, bubble, source)` sends a prompt, puts queued `pendingNotes` in front of it and records the
    sent text in `_matchText` (your own text in `_ownText`).
  - `pump()` starts the next queued relay message whenever the view is not busy.

## Design

### The Edit action

- Shown on bubbles that `ownMessages()` accepts (the same rule as Left Shift+Up recall), as the first button of the bar: **Edit · Fork · Delete ·
  Copy**. Tooltip: "Edit this message: sending replaces it and everything after it". Not shown on replies, on
  relay messages from other sessions, or on hidden/empty bubbles. A replayed bubble's text is complete only
  after it has been appended, so whether it gets Edit is decided once its text is final.
- A message that was sent with notes in front of it is editable only while its live bubble exists. After a
  replay (reopen, app restart) its text starts with `[from relay]`, so `ownMessages()` rejects it like a real
  relay message, and it gets no Edit, just as recall skips it now. *(Builder's call: the notes and your text
  can't be told apart reliably in the replayed text.)*
- Disabled whenever Fork/Delete are disabled now (`.busy` on the view: a turn is running, the session is dead
  or being deleted, a history operation is running).

### Edit mode (nothing on disk changes)

Clicking Edit on message N:

1. Saves what is in the message box as the draft. If a recalled message is shown (Left Shift+Up), the draft
   is the text that was typed before the recall, as in `send()`. Then it clears the recall state.
2. Puts the message's own text in the box (`_ownText ?? _matchText`, without the notes that were put in front
   of it when it was sent), puts the caret at the end, autosizes and focuses the box.
3. Marks message N as being edited and dims it and everything after it in the log.
4. Shows a banner above the composer: "Editing a message. Sending replaces it and everything after it (N
   messages). Files changed by the agent are not reverted. Esc to cancel." It also has a **Cancel** button.
   The count comes from `api.countFrom(sessionId, { ordinal, text, where: "beforeUser" })`. If that call
   fails (the message is not in the history), edit mode is not entered and the error is shown, the same text
   Delete shows now.

While in edit mode:

- Clicking **Edit on another message** switches the edit to that message. The draft from step 1 is kept.
- **Fork / Delete** stay available. Using one of them first cancels the edit.
- **Left Shift+Up/Down** does nothing, because it would replace the text being edited.
- **The relay inbox waits**: `pump()` does not start queued relay messages. They stay queued and start after
  the edited prompt's turn, or right away on cancel. New relay messages are queued in the same way.
- **Esc** cancels the edit when no turn is running. Esc during a turn still stops the turn, as now. The command
  popup's own Esc handling runs first, as now.

Cancel (Esc, the banner button, or one of the triggers below) restores the draft, removes the dimming and
the banner, and lets the inbox run again.

Edit mode also ends, without any change on disk, when:

- the view is closed or reopened (session closed, `reopenView`, delete of the whole session), or
- the session's process dies (`markDead`).

Edit mode is not saved between app runs.

### Send in edit mode

`send()` in edit mode, with non-empty text:

1. **Slash commands are refused.** If the text is a command handled in the app (`/agent`, `/rename`) or a CLI
   command (`SlashCommands.isCommandPrompt`), nothing is sent and edit mode stays. The status line says:
   "Commands can't replace a message. Cancel the edit to run a command." A CLI command is not recorded in
   `events.jsonl`, so cutting the history for it would drop the old turns with nothing in their place.
2. Takes the `historyOp` flag and sets busy, as `deleteFrom` does. Status: "Replacing the message…".
3. `api.truncateSession(sessionId, { ordinal, text: matchText, where: "beforeUser" })`. `matchText` is the
   edited message's `_matchText()` (what was sent, notes included), so the history match works as it does for
   Delete.
4. `reopenView(this, error)`, as `deleteFrom` does after a truncate. The edited text and the edit state go to
   the new view (below), and the inbox moves but does not run yet.
5. In the new view: `runPrompt(editedText, bubble, "app")`, with the bubble built as in `send()` (mention
   thumbnails, path links). `pendingNotes` carried over by `reopenView` go in front of it, as in any prompt.
6. After that turn, the inbox runs again as usual.

**The notes of the replaced message (builder's call, marked as such).** This applies only to live bubbles
(see the Edit action). If message N was sent with notes in
front of it (`_matchText() !== _ownText()`), the model saw those notes only in that message, and the cut
drops them. They are put in front of the edited text in the same way: `sent = <notes part of message N> +
"\n\n" + editedText`, followed by any newer `pendingNotes`. The bubble shows only the edited text, and the
`_ownText` / `_matchText` split stays as in `runPrompt`.

**Failure.**

- *The truncate fails* (the message no longer matches the history, the process did not exit, I/O error): the
  session is reopened unchanged, as `deleteFrom` does (close for sure, then `reopenView` with the error). Edit
  mode ends and **the edited text stays in the box as an ordinary draft**. To try again, you click Edit again.
  *(Builder's call: re-entering edit mode after a replay would need the notes split that a replay loses, see
  above.)* Send does not check the target again before cutting. The truncate's own match is the check.
- *The reopen fails* (`openSession` gives no view, or a dead one): the history is already cut. The edited text
  must not be lost, so it goes back into the box of whatever view `openSession` produced, without edit mode,
  with the error. If no view was produced, it goes back into the old view.
- *The prompt fails* after a successful cut: shown as any failed prompt is now. The history stays cut and the
  bubble stays in the log. Left Shift+Up brings the text back.

### How the edit state crosses `reopenView`

`reopenView` already moves the draft and inbox to the new view. For the edit it also needs:

- `editText`: the edited text plus the notes part of message N, sent right after the replay (the success
  path) or put back in the box without the notes (the failure paths).
- `holdInbox`: keeps the inbox from running in the new view until the edited prompt has started, or until the
  failure path has put the text back. `openSession` ends with `setBusy(false)`, which queues a `pump()`, so the
  hold must already be in place by then.

After a successful send, the draft from before the edit comes back into the box, as `send()` does for a
recalled message.

How these are passed (more arguments to `reopenView`/`openSession`, or one `afterReopen` callback) is up to
the builder.

### Look

- The edited message and everything after it in the log: lower opacity, not hidden, so you can still read what
  you are replacing.
- The banner: a slim strip above the composer, in the style of the existing status/notice strips, with a
  Cancel button at the right. The same in light and dark theme.
- Exact styles are up to the builder.

## Constraints

- The same safety rules as Delete: no cut while a turn runs, while the session is still opening, while it is
  being deleted, or while its process lingers. Most of these refusals already come from `sessions:truncate` /
  `historyOp` in main. The renderer must not get around them.
- The same caveat as Delete about a session that is also open in a terminal Copilot CLI. The banner can leave
  it out, but the README must say it.
- Renderer only, plus `README.md`. `history.mjs`, `main.mjs` and `preload.cjs` already have everything needed.
  If the builder finds that main must change after all (for example to cut and prompt in one call), that is
  allowed, but it must keep the main-side refusals.

## Testing

- Pure logic (which bubbles get Edit, the notes prefix of a replaced message, what is restored on cancel, the
  rules that refuse a slash command) goes into a testable module next to `ui-state.js`. It is tested in
  `electron/test/` in the style of `ui-state.test.mjs`.
- `history.test.mjs` already covers `truncateSession` with `beforeUser`. Add a case only if the notes-prefix
  match needs one.
- Manual check in the running app (`npm start` in `electron/`) with a cheap model:
  1. Edit, then cancel. `events.jsonl` is byte-identical (compare the hash).
  2. Edit the 2nd of 3 messages and send. The log shows turn 1 and the new message with its reply. The
     model's answer shows it has not seen the old turns 2–3. `events.jsonl.bak` holds the old history.
  3. Edit a message. While in edit mode, change that message's text in `events.jsonl` by hand (or remove its
     line), then send. You get an error, the history is not cut further, and the edited text stays in the box
     as a plain draft.
  4. A relay message that arrives during edit mode is not sent until the edited prompt's turn has started.
  5. Edit, then type `/context` and send: refused, nothing cut.

## Left to the builder

- How the edit state is passed through `reopenView` / `openSession`.
- The banner and dimming styles, the button order within the rules above, and the exact wording of strings
  other than the ones given here.
- Whether the dimming uses a class on each element after N or a single marker plus a CSS sibling selector.
- README wording (a line next to the existing Fork/Delete entry, plus the terminal-CLI caveat).
