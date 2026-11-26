# Context meter on load: deferred findings

**Sources:** the final whole-branch review (fable, medium) of `fix/context-on-load`. The branch is a single fix
without a plan, so there were no task reviews.

**The fix:** Copilot CLI sends no `usage_update` during or after `session/load` (probed over raw ACP on 2026-11-26),
so a reopened session showed "context: —" until its next turn. `readLastContext` (`electron/usage.mjs`) now takes
`currentTokens` from the last `session.shutdown` of a run that had a turn, with the `maxPromptTokens` of that run's
last `session.usage_record` as the size. `createUsagePusher` reads it once per open session while no live figure
exists; the first `usage_update` replaces it.

**Probed on 2026-11-26 (Linux, Copilot CLI 1.0.115):** `session/close` followed by an immediate SIGKILL still writes
`session.shutdown` with `currentTokens`, which is what the app's close path (`closeEntry`, `electron/main.mjs`) does
before `kill()`, and what Windows' `taskkill /F` amounts to. In the probe, the file gave 21485 / 922000 and the live
`usage_update` gave 22411 / 922000: the size matched, and `used` was about 4% lower than the live figure.

None of these blocked the merge. Line numbers were taken at the review that found them and may drift.

**Fixed on the branch, so not listed below:**
- A run without a turn whose shutdown has no `currentTokens` is now skipped (before, it ended the walk with null).
- Tests: the truncated-tail fallback to the whole file is covered, and the pusher test helper counts `readContext`
  calls from 0.

## A. Worth doing first

- None.

## B. Window and wording

1. **The file figure is a little below the live one** (`readLastContext`, `electron/usage.mjs`). `currentTokens` at
   shutdown was 21485 where the live `usage_update` said 22411 for the same turn. The meter moves up a few percent at
   the next turn.
   - *Proposal:* none unless someone notices. Marking the figure as "from the last run" in the chip's tooltip would be
     an option.

## C. Small behaviour

1. **A late shutdown gives null, and it is never retried** (`lastRunContext` with `fileRead` in `createUsagePusher`,
   `electron/usage.mjs`). `closeEntry` (`electron/main.mjs`) returns right after `kill()` without waiting for the
   exit. On a fast close and reopen (Setup save, truncate), the old process may write its `session.shutdown` after
   the new run's events, or after the read 300 ms past load. The meter then shows "context: —" until the next turn,
   which is the old behaviour, not a wrong number.
   - *Proposal:* when the read finds no shutdown, retry once a second or two later.
2. **The size can be stale** (`readLastContext`). It comes from the run's last `usage_record`. If the model or
   context tier changed after that call, or the session is reopened on another tier (`tierArgs` in `openSession`), the
   meter shows the old window size until the first live update.
3. **A `/compact` on a reopened session before any turn.** If `/compact` sends no `usage_update`, the meter keeps the
   pre-compaction figure where it used to show "—". The 2026-11-02 session-usage plan says it does send one;
   not verified.
4. **A run that ended in a crash shows "—"** (`lastRunContext`). This is by design: the figure of an earlier run would
   be stale.

## D. Tests and housekeeping

1. **Manual check on the corp PC (Windows):** reopen a session closed by the app and confirm the header meter shows a
   figure before the first message. Only Linux was probed.
