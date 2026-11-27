# Main process log file: deferred findings

**Sources:** the final whole-branch review (Fable 5.2, medium) of `feat/main-log`. Execution was inline, one task.

Why the branch exists: on the corp PC (Windows, portable build) a parent's `create_session` returned
`Request … sent; the user must approve it`, but no approval card appeared, the window's console was clean and the
main process's console could not be seen (the portable launcher cannot have its output redirected). The log file is
the tool to find where the request stops; the cause itself is **not found yet** (see A.1).

None of these blocked the merge. Line numbers were taken at the review and may drift.

**Fixed on the branch, so not listed below:**
- "card sent to the window" is logged only when `send` really sent it; otherwise a warning says there was no window.
- A delegation request with no view for its parent session leaves a warning in the log (parked in `early`, or dropped
  for a deleted session), so "rendered but not visible" can be told apart from "never rendered".
- The `warning` listener was dropped: Node's warning printer writes with `console.error`, which is teed already
  (checked: a teed `console.error` receives `process.emitWarning` output), so each warning would have been written twice.
- The comment on `uncaughtExceptionMonitor` says what Electron does (its error dialog), not that the process ends.
- View → Show Log File opens the folder when the file is missing, and says so when the run has no log at all.

## A. Worth doing first

1. **The missing approval card on the corp PC: cause not found.**
   - Where: `sessionRequested` (`electron/main.mjs`), `RelayClient` `session_request` (`electron/relay-client.mjs`),
     `requestCreate` (`src/delegation.mjs`).
   - Known: the broker answered "sent" (so the peer had a `control` stream); the window's console had no error; the
     Communication panel showed no pending proposal (so `openCard` never ran).
   - Open: whether the request reached main. With this build, `main.log` has either `[delegation] session_request <id>
     from <session>` (then the step it stopped at) or `session_request <id> dropped: session <id> is not open` if it
     did. Neither line: the session's relay stream was dead while the broker still wrote to it.
   - Proposal: if the stream is the cause, the broker should treat a `control` write as delivered only after the app
     acknowledges it (or the app should re-register on a stalled stream), and `requestCreate` should say "not delivered"
     instead of "sent". Decide after the log of one real case.

## B. Window and wording

1. **The log file keeps the window's error text and file paths in plain text.**
   - Where: `attachRendererLog` (`electron/main-log.mjs`).
   - `sourceId` paths contain the Windows user name; up to 10 MB (`main.log` + `main.old.log`) stays in
     `userData/logs`. No secret was found in any logged message (review: all `console.*` sites log `e.message`, paths,
     session ids, job names; the connection token travels only in a child's env). Worth a line in the docs, since the
     user will share this file.

## C. Small behaviour

1. **`createFileLog` never reports an unwritable folder.**
   - Where: `createFileLog` (`electron/main-log.mjs`); `startMainLog` (`electron/main.mjs`).
   - An unwritable `userData/logs` gives a non-null log whose lines are all lost, with no `[log] no log file` warning.
     Show Log File then opens the folder (or says it could not). Proposal: a first-write failure warns once on the
     console.

2. **The 16 KB cut of a line can split a surrogate pair.**
   - Where: `logLine` (`electron/main-log.mjs`). Harmless: one broken character at the cut.

## D. Tests and housekeeping

1. **Not verified on Windows:** `renameSync` while an editor or antivirus holds `main.log` or `main.old.log` (the
   file then keeps growing until the next 5 MB or start); the cost of `appendFileSync` under real-time scanning; the
   portable build's `userData` folder name (expected `%APPDATA%\Copilot Sessions`); Show Log File through the hidden
   menu bar (Alt).
2. **Not verified:** whether Chromium's own console messages (CSP, deprecations) add noise at warning level in the real
   app, and Electron 45's unhandled-rejection mode in main (in throw mode `uncaughtExceptionMonitor` sees it; in warn
   mode the warning printer's `console.error` does).
3. **No UI check for Show Log File.** The menu item calls `shell`, which the UI-check driver cannot observe.
