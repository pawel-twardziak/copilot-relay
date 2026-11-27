# Main process log file: deferred findings

**Sources:** the final whole-branch review (Fable 5.2, medium) of the first part of `feat/main-log` (main.log), the
re-review of its fix round (Opus 5.5, high), the task review (Opus 5.5, high) of the second part (the broker's
stream-close race and the relay trace), and the final whole-branch review (Fable 5.2, medium). Execution was inline.

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
- Broker: an older stream's close no longer takes a reconnected session offline (it did: messages to the session were
  "queued (recipient briefly offline)" while its newer stream was alive). Test in `broker-stream.test.mjs`.
- `git describe` for the broker's build takes no index lock (`--no-optional-locks`), reads a checkout owned by another
  user (`safe.directory`), never describes a repository above the broker's folder, and falls back to `.git/HEAD`.
- `registered` carries the stream's number and the broker log's path; the client prints both, so a client's lines can
  be matched with the broker's stream even when two streams of one key overlap.
- A `→` line says when the bytes did not leave at once (`buffered N bytes`): a stream that is dead but not closed grows.
- `comms` and `links_changed` are not traced per stream (they repeated N times per message, N = open app sessions).
- A refused `create_session` command is not echoed into the log (the refusal quotes a word of the model's command).
- `[api] send` cuts the model-written `to` (first line, 80 characters); acks are traced (`[api] ack <id> from <key>:
  taken|discarded`), so "shown and taken" can be told from "reached the window, never taken"; main says when a message
  was handed to the window; every relay tool's "not registered" answer is traced.
- The stream-close race test waits for the broker's "older stream" line instead of a fixed 300 ms (it could pass
  without the case).

## A. Worth doing first

1. **The missing approval card on the corp PC: cause not found.**
   - Where: `sessionRequested` (`electron/main.mjs`), `RelayClient` `session_request` (`electron/relay-client.mjs`),
     `requestCreate` (`src/delegation.mjs`).
   - Known: the broker answered "sent" (so the peer had a `control` stream); the window's console had no error; the
     Communication panel showed no pending proposal (so `openCard` never ran).
   - Possibly related, fixed on the branch: the broker's stream-close race (an older stream's close took a reconnected
     session offline). It explains messages that wait in the inbox of a session that is open, not the "sent" answer of
     `create_session` (with the race `control` is null and the answer is "not connected").
   - Open: whether the request reached main. With this build, `main.log` has either `[delegation] session_request <id>
     from <session>` (then the step it stopped at) or `session_request <id> dropped: session <id> is not open` if it
     did. Neither line: the session's relay stream was dead while the broker still wrote to it.
   - 2026-11-27: a restart of the corp PC made both work again (before this build, so no log of the case). Fits a
     broker process that kept running old code across updates of the app and the checkout, a dead stream, or the race
     above; a restart clears all three. Next time: the `← registered … (broker <build>)` line in main.log shows which
     broker the sessions talk to, and broker.log the path of each event.
   - Hypothesis (final review, not verified): a second client registering the same `cli:<sessionId>` key, e.g. the
     copilot-relay extension loaded inside the app's Copilot on the corp PC. `upsert` gives the session that stream's
     `control`; that client has no `onSessionRequest` (and injects messages into a Copilot the app does not show), so
     "sent" is true and nothing reaches the window. In broker.log: two `open cli:<id>` lines with no `closed` between them,
     the later one without `alias=app:…`, and `→ session_request` on a stream number other than the one in main.log's
     `← registered … on stream sN`. Check on the corp PC whether the extension loads under the app.
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

2. **The relay trace stops at the view.**
   - Where: `SessionView.incoming`, `SessionView.delegationCard` (`electron/renderer/app.js`).
   - When the view exists, a message or card that does not render leaves only a renderer console error (which reaches
     main.log). A card that renders but is not visible (scrolled, in a collapsed group) leaves nothing. Proposal: an
     info line per card shown, if the log of a real case points there.

## C. Small behaviour

1. **`createFileLog` never reports an unwritable folder.**
   - Where: `createFileLog` (`electron/main-log.mjs`); `startMainLog` (`electron/main.mjs`).
   - An unwritable `userData/logs` gives a non-null log whose lines are all lost, with no `[log] no log file` warning.
     Show Log File then opens the folder (or says it could not). Proposal: a first-write failure warns once on the
     console.

2. **The 16 KB cut of a line can split a surrogate pair.**
   - Where: `logLine` (`electron/main-log.mjs`). Harmless: one broken character at the cut.

3. **The broker now writes to stdout on every traced event.**
   - Where: `trace` in GET /api/peer/stream (`server.mjs`).
   - A broker run from a terminal whose stdout pipe has gone away could get an asynchronous EPIPE `error` on
     `process.stdout` (teeConsole catches only synchronous ones). A broker started detached (`stdio: "ignore"`) is not
     affected. Proposal: a no-op `process.stdout.on("error")` in the broker.

4. **A malformed request body's parse error now reaches broker.log.**
   - Where: the catch of the request handler (`console.error(e)`, `server.mjs`). Newer V8 versions quote a fragment of the
     input. Only a malformed body triggers it; the relay's own clients send `JSON.stringify` output.

5. **`git describe` delays the broker's start by up to 3 s** (`BUILD`, `server.mjs`), before `listen`. Acceptable with
   the clients' retry delays and broker-restart's 15 s health wait.

6. **The broker's log module lives in `electron/`.** `server.mjs` imports `./electron/main-log.mjs` dynamically; a copy
   of the broker without that folder (the broker-restart e2e test's copy) runs without broker.log. The canonical place
   would be `src/`, but the packaged app cannot import from it (only `electron/` is packaged).

7. **`GET /health` does not carry the broker's build**, and no README mentions `broker.log` or
   `COPILOT_RELAY_LOG_FILE`: the path is found only through main.log's `← registered … its log: …` line.

## D. Tests and housekeeping

1. **Not verified on Windows:** `renameSync` while an editor or antivirus holds `main.log` or `main.old.log` (the
   file then keeps growing until the next 5 MB or start); the cost of `appendFileSync` under real-time scanning; the
   portable build's `userData` folder name (expected `%APPDATA%\Copilot Sessions`); Show Log File through the hidden
   menu bar (Alt).
2. **Not verified:** whether Chromium's own console messages (CSP, deprecations) add noise at warning level in the real
   app, and Electron 45's unhandled-rejection mode in main (in throw mode `uncaughtExceptionMonitor` sees it; in warn
   mode the warning printer's `console.error` does).
3. **Volume (estimate):** about 2 + N broker.log lines per message to an app session (N open app sessions) since
   comms and links_changed are no longer traced; 5 MB rotates after thousands of messages. Each line is a synchronous
   append: 0.1–1 ms under real-time antivirus on Windows (not measured).
4. **No UI check for Show Log File.**
5. **`its log: \S+\)$` in `broker-stream.test.mjs`** fails on a temp path with a space (a Windows user name with one), if
   these tests ever run there.
6. **Not verified on Windows:** `safe.directory=${ROOT}` with backslashes (Git for Windows may match only the
   forward-slash form); the `.git/HEAD` fallback covers a refusal. The menu item calls `shell`, which the UI-check driver cannot observe.
