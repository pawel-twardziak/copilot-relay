# Cache keeper: deferred findings

**Sources:**
- the task reviews and re-reviews (opus, high);
- the final whole-branch review (fable, medium);
- the re-review of its fix wave (opus, high) of `feat/cache-keeper`.

Spec: `docs/superpowers/specs/2026-11-25-cache-keeper-design.md`. Plan: `docs/superpowers/plans/2026-11-25-cache-keeper.md`.

None of these blocked the merge. Line numbers were taken at the review that found them and may drift.

**Fixed on the branch, so not listed below:**
- **Late timers:** a timer that fired even 1 ms late did nothing. Now `LATE_MS` 30 s, and an action that is late but not too late is due now.
- **Cut "after reply":** it kept the pings that followed.
- **Replay filter:** it swallowed session state (command list, context usage) after a ping. It also ran on live updates and hid the reply of a typed `/compact`.
- **Turn baseline:** there was no baseline checkpoint before a turn (`turnStarted`).
- **Close and reopen:** a run could overlap after a close/reopen.
- **Duplicated file logic:** the opt-out store duplicated the hold store's file logic (`json-file-map.mjs`).
- **Cards:** the keeper never re-armed after an open card was answered.
- **Session state during keeper turns:** it was hidden.
- **Wasted reads:** a checkpoint read ran before every prompt with the keeper off.
- **Minimum context:** an empty field was saved as 0.
- **Switch:** it was not reverted after a failed opt-out.
- **Timers after close:** keeper timers outlived a closed view.
- **Tests:** a UI check did not prove the wait for a ping.
- **Compaction focus text:** it quoted the last ping instead of the last real exchange.
- **Late unblock:** a late unblock (held cleared, card answered, settings saved) compacted at once, without a visible countdown. Now `CATCHUP_MS` 2 s, typing during the countdown acts as Not now, and card answers count as activity.
- **Pings:** there was no upper bound (now at most 20).

## A. Worth doing first

1. **A failed compaction is recognised only by its reply text** (`keeperRun` in `electron/main.mjs`).
   - Spec §2 also counts `session.compaction_complete.success === false` as a failure.
   - *Proposal:* after the run, read the session's last `compaction_complete` (as `readCacheExpiry` does) and treat `success: false` as an error with its `error` text.
2. **Runner entries for closed or unknown ids.**
   - Where: `setHeld` and `turnStarted` go through `entryOf` in `electron/cache-keeper-runner.mjs`.
   - Callers: a debounce armed just before a delete click, a dead view that still reports held, an IPC call in flight across `closed()`.
   - Each re-creates an entry that is never closed. It plans nothing, but it is a leak.
   - *Proposal:* the `keeper:held` and `turnStarted` paths in main ignore ids that are not in `open`.
3. **A prompt overlapping a `/rename` can lose its `turnEnded`.**
   - Where: `sessions:prompt` and `slashRename` in `main.mjs`.
   - Case: `createChild`'s rename outlives its 10 s race, and the child's first prompt ends first. `endPrompt` is then false for the prompt, so no pause starts for that turn. Rare.
4. **Stop while a prompt waits for a ping still sends the prompt** (`main.mjs` `sessions:prompt`, after `whenIdle`).
   - *Proposal:* remember a cancel that arrives during the wait and drop the prompt.
5. **`held` stays true after a window reload** for sessions whose view is not opened again, so the keeper is silently off for them. This errs toward not acting.
   - *Proposal:* clear every `held` in `confirmedReload`.
6. **The `auto` fallback can overestimate the expiry** (`readCacheExpiry` in `electron/usage.mjs`).
   - Case: with an unknown model it takes the latest-expiring entry of any model. A 1800 s GPT entry next to a 300 s Claude entry would make the keeper ping or compact a cold cache.
   - *Check on the corp PC* whether `modelCacheState` keeps entries of models the last turn did not use.

## B. Window and wording

7. **A ping that fails without a tool call shows no notice.** The chip just disappears. Product call, e.g. "Keep-alive stopped: <reason>".
8. **The "Keep cache" switch shows while the keeper is off in Settings** (the default).
   - *Proposal:* hide it in `settingChanged()` when `cacheKeeper.enabled` is false.
9. **⏳ shows only for sessions with an open view** (`item()` reads `v?.keeperState`).
10. **The "Keep cache" label can wrap** at narrow widths (`.keeper-switch-label`: add `white-space: nowrap`).
11. **The chip stays until a running action settles** after activity (cosmetic).
12. **Spec wording:**
    - §3, first bullet: it still says `isUser` drives `cutIndex`. `afterReply` now stops at any `user.message`.
    - Rule 1: it does not mention an unknown `contextUsed`, which also stops the keeper.

## C. Small behaviour

13. **`turnEnded` re-reads checkpoints when the keeper is off** (up to 3 reads, 1 s apart; no delay to the prompt).
14. **A short turn whose checkpoint lands before `turnStarted`'s read loses its pause.** The baseline is then the new checkpoint.
15. **An empty newest `modelCacheState` makes the reader fall back to an older checkpoint.** That costs 3 wasted re-reads. Unverified whether an empty state means "cache dropped".
16. **The reader invents values for malformed entries:** `ttlSeconds` is 0 when `cacheTtlSeconds` is missing, and `modelId` is `""` in the fallback.
17. **A real user message starting with `[keep-alive]` counts as a ping everywhere.** It is hidden from numbering, cuts and replay. Known limitation of the marker.
18. **The replay filter assumes a ping arrives as one `user_message_chunk`.** That was seen live. A split ping would show its tail.
19. **The replay swallow span is open-ended.** Turn content after a ping is swallowed until the next `user_message_chunk`. A later turn without a user message (a slash-command reply, a system-started turn) would be hidden on replay.
20. **Slash commands without a model request end the pause** (e.g. `/context`). `/rename` is excluded by a ruling; others are not.
21. **A read-only tool can run once on a ping before the cancel lands** (`stopKeeperTurn` reacts to the `tool_call` update).
22. **Sidebar reads more on the first list.** `lastEventTimeOf` reads the 2 MB tail when the last turn is longer than 64 KB. It is cached by stamp afterwards.
23. **`held: true` is debounced 300 ms** (`app.js` `reportKeeperHeld`).
    - Text typed less than 300 ms before `compactAt` can arrive after the compaction has started.
    - *Proposal:* send `true` at once and debounce only `false`.
24. **A pause ends silently when a countdown or compaction is missed.** This happens when the timer fires more than `CATCHUP_MS` late (suspend/resume, a stalled event loop), or when pings are lowered mid-pause past the countdown time. The chip goes from countdown to off with no notice. It is safe; a notice would explain it.
25. **Code cleanups:**
    - `keeperOn` restates the runner's enabled rule;
    - duplicated `wholeNumber` logic for `minContext`;
    - a duplicate `reportKeeperHeld` call in the input handler;
    - `keeperHeld` errors are swallowed silently;
    - the replay filter is created twice when a session opens;
    - stale comments in `dropReopenCards`/`dropLinkCards`;
    - `?? ""` is redundant before `isKeepAlive`.

## D. Tests and housekeeping

26. **`keeper-prompt-waits` reads `.scripted-agent.json` while the agent may be writing it.** This could make `JSON.parse` fail now and then; it is the most likely flake.
    - *Proposal:* return `agentTalk(app)` from the `until` callback and assert on it.
27. **`keeper-switch-off` unchecks the switch before any turn.** A variant that unchecks while a ping is planned would cover cancelling it.
28. **No UI check for a replay without ping rows.** Covered by the filter's unit tests.
29. **The scripted agent's `checkpoint` step kills the agent without `$COPILOT_HOME`.** Document it in the header.
30. **Rules tests:**
    - no too-late test on the compact branch;
    - no exact-boundary test (`exp - 30_000` acts);
    - the N = 1 timeline stops at the countdown;
    - pings lowered below `pingsSent` mid-pause.
31. **Reader tests:** a missing `events.jsonl`, an unparsable `cacheExpiresAt`, only-empty checkpoints, and the fallback's `checkpointId`/`ttlSeconds`.
32. **History tests:** the `userIndex` text fallback with a ping present.
33. **Runner tests:**
    - "turnEnded waits for a turnStarted read still in flight" passes without the await, because the fake read resolves synchronously;
    - no `whenIdle` test after a compaction or a thrown run.
34. **Window tests:** non-numeric minimum context; the 12.5 k case is unreachable (`step="1"`).
35. **main.mjs wiring has no unit tests.** It is covered only by the suite totals and the UI checks. That includes card answers as activity.

## Open manual checks

- **Last activity:** whether an automatic `/compact` writes `assistant.*` events and so moves the sidebar's last activity. No local history had a compaction.
- **Model id on the corp PC:** whether a non-`auto` model id (e.g. `claude-opus-5.5`) in the session's config options matches `modelCacheState[].modelId`. Only `claude-haiku-4.5` was seen in both.
- **Model behaviour, live:**
  - whether the model follows the keep-alive text (no tool use, a single dot);
  - whether the new compaction focus text keeps the last real exchange verbatim.
- **Windows and macOS were not run.** The UI checks ran on Linux only.
