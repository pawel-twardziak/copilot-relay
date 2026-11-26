# Live quota: deferred findings

**Sources:** the task reviews and the final whole-branch review (fable, medium) of `feat/live-quota`.

Spec: `docs/superpowers/specs/2026-11-25-live-quota-design.md`.

None of these blocked the merge. Line numbers are those of the branch head after the fix wave and may drift.

**Fixed on the branch, so not listed below:**
- **A hung `getQuota` never recovered (I1):** `withClient` has an optional `deadlineMs`; past it the call rejects and
  the entry is stopped, so the next call starts a fresh CLI. `readLiveQuota` passes its deadline to it.
- **README and spec:** the README describes the live quota line; the spec says v0.32.0 from main v0.30.1.

## A. Worth doing first

The first four belong together as one "no orphan CLI" change.

1. **Known limitation: the quota CLI survives a crash or a forced kill of the app.** The headless CLI ignores a closed
   stdio and has no idle timeout of its own (verified with CLI 1.0.115). No pid file or sweep, by the owner's choice.
   - *Proposal:* a pid file written at spawn (`createCopilotRuntime`, `begin`, `electron/copilot-runtime.mjs:83`) and
     a sweep at app start that kills a leftover group whose command line still matches `--headless`. It would cover
     crash, SIGKILL and SIGTERM together; it needs care with the `confirmLeavingChildren` dialog, so check it on its own.
2. **SIGTERM to the app skips before-quit and orphaned the quota CLI** (observed on a Linux dev run; cause unknown,
   Electron may install its own POSIX shutdown handlers; `electron/main.mjs`, `killAll` ~1972, `before-quit` ~2051).
   - *Proposal:* on SIGTERM/SIGHUP call `killAll()` (it sends SIGTERM synchronously) and then exit; or the pid-file
     sweep of A.1.
3. **Idle stop leaves a window where `stopAll` neither kills nor waits** (`stop`, `copilot-runtime.mjs:67-81`). The
   idle stop removes the entry first and then waits on `client.stop()` (ms normally, up to 3 s if unresponsive)
   before `terminate()`; a `stopAll` in that window does not see the entry.
   - *Proposal:* keep entries that are stopping in a set that `stopAll` also terminates quickly; or a synchronous
     last-chance kill of all known groups on `process.on("exit")`.
4. **A refresh between before-quit and will-quit can start a CLI nobody waits for** (`electron/main.mjs`, `killAll`
   ~1972, `will-quit` ~2044). A pending 300 ms usage debounce fires after `stopAll` settled while the 60 s quota cache
   is stale; `killAll` does not cancel usage timers.
   - *Proposal:* `will-quit` calls `runtime.stopAll()` itself, or a permanent close latch is set there.
5. **M1: the session chip's usage push waits for the live quota query** (`createUsagePusher.push`, `Promise.all`,
   `electron/usage.mjs:351-357`). Context meter and credits wait for a CLI cold start (655 ms on Linux, Windows
   unknown) or up to 10 s when the query fails, once per 60 s.
   - *Proposal:* push with the cached state and refresh the quota in the background (`onChange` already updates
     the sidebar).

## B. Window and wording

1. **Wrong detail in "ended before it printed its port"** when the exit comes after the port line
   (`copilot-runtime.mjs:146`, `proc.on("exit")`). The message is only accurate before the port line.
2. **Open question: a null quota hides the line and its failure reason shows nowhere** (a broken command, not logged
   in). The spec says hidden, so the user gets no hint. The reviewer declined to judge; the owner decides.
3. **Spec not updated for the deadline in `withClient`:** spec "Design → 1" gives `withClient({ command }, fn)` and
   "2. Quota reading" gives `readLiveQuota` via `withClient({ command }, …)`; neither mentions `deadlineMs` or that the
   CLI is replaced past the deadline. The spec's "Not verified" still says "installer size about the same as v0.28.0"
   (should be v0.31.0).

## C. Small behaviour

1. **M3: `PORT_RE` matches as soon as one digit has arrived** (`copilot-runtime.mjs:12`, used at `:129`). A chunk that
   ends inside the number gives a wrong port. Use `/listening on port (\d+)\D/` or wait for the newline.
2. **M4: a cold start slower than 10 s reads as a failure for 60 s;** the late answer is dropped though the CLI is warm
   (`readLiveQuota` deadline, `usage.mjs:247`; `failureHoldMs`). Tie to the Windows manual check below.
3. **Exit before settle may miss the last stderr chunk** (`copilot-runtime.mjs:139-148`). Wait for `close` with a short cap.
4. **No deadline while the SDK import loads** (`copilot-runtime.mjs:121`, `:156`). Arm `startTimer` before the await.
5. **`terminate()` caches `entry.terminating`** (`:48`), so a later `stopAll` sends no new signal to a survivor.
6. **A live "none" clears `lastLive`** (`createQuotaService.compute`, `usage.mjs:278`). A later failure may then show a
   file figure that live had just ruled out.
7. **A missing `quotaSnapshots` counts as a final none** (`readLiveQuota`, `usage.mjs:250-251`). Consider throwing; note
   it beside the corporate-account manual check.
8. **`onChange` throwing rejects `get()`** (`usage.mjs:302`). `send` can throw on a destroyed webContents during quit;
   callers catch.
9. **Every Settings save and every fork forces a live query** through `refresh()` (`electron/renderer/app.js:3175`,
   fork at `:1155`). The spec wants a forced query only on the Refresh button.
10. **A deadline during start skips the 60 s no-respawn hold** (`withClient`, `copilot-runtime.mjs:206`). A deadline
   that fires before `entry.started` calls `stop()`, which drops the entry before `fail()` sets `failedAt`, so a CLI that
   hangs before printing its port is spawned again on every forced query (Refresh, Settings save, fork); the 20 s port
   deadline and its detailed error (command + stderr tail) are never reached by quota calls. Proposal: on a deadline
   for a not-yet-started entry, record the failure hold (and keep the port error text).
11. **The deadline stop uses the slow stop path** (`withClient`, `copilot-runtime.mjs:206`, `stop(entry)` without
   `quick`). On a hung CLI `client.stop()` is the call most likely not to answer, so termination waits the full 3 s
   while the entry is already out of the map — the A.3 window, on the path where it is most likely. Proposal:
   `stop(entry, { quick: true })` there; fold into A.3.

## D. Tests and housekeeping

1. **M5: `stopAll` drops failed entries,** so the 60 s failure hold is lost (`copilot-runtime.mjs:221`; matters only on
   macOS, where the app survives `killAll`).
2. **M6: shadowed name** in `stop()` (`copilot-runtime.mjs:73`): a local `const stopping` shadows the module counter
   `stopping` (`:33`).
3. **Unlimited pick keeps the `total: -1` sentinel** (`pickPool`, `usage.mjs:160`). The `summarize` docstring says
   "premium quota" (`:330`). No `pickPool` test for an invalid premium with a valid chat pool.
4. **Quick stop kills before `client.stop()` runs** (`stop`, `copilot-runtime.mjs:74`): add a comment. An `error` after
   a good start is not logged (`:135`).
5. **The live test checks the shell pid only,** not the group (`electron/test/copilot-runtime-live.test.mjs:14`;
   use `process.kill(-pid, 0)`).
6. **koffi runs an install script in `npm ci`** (supply-chain note).
7. **`readFile` errors are swallowed silently** (`usage.mjs:289`). No tests for in-flight sharing and for a throwing
   `readFile`.
8. **Two `quota:get` calls at startup** (`electron/main.mjs:592`, `renderer/app.js:3974`). Share one in-flight query.
9. **No automated coverage for the main/renderer wiring and the quit wait.**
10. **No test for a stuck fn that settles late after a newer entry exists** (`withClient`, `copilot-runtime.mjs:202`,
   `:216-217`). Harmless by reading; nothing asserts it.

## Not verified (manual checks still open)

- **Windows:** the port line through cmd.exe with `copilot.exe` (WinGet / VS Code shim) and with npm's `copilot.cmd`;
  the process tree is gone after quit and after an idle stop; cold-start time against the 10 s deadline.
- **Corporate account:** the figures in the app match GitHub (the shape of its `getQuota` answer is unknown).
- **Packaged Windows app:** the SDK works from the asar; installer size is about the same as v0.31.0. (Linux packaged
  `--dir` was checked: 0 `copilot-sdk-*` in the asar, live line shown, graceful quit leaves no CLI.)
- **Quit waits for a CLI that ignores SIGTERM:** code reading only; bounded at `killGraceMs` + 500 ms.
- **A crash of the app leaves the quota CLI running** (known limitation, A.1): confirm it is the only process left.
