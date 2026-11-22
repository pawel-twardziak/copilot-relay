# Message times and day separators: deferred findings

Source: the final whole-branch review of `feat/message-times` (range `c09b18c..efe92b5`, then the fix commit
`86db72e`). Spec: `docs/superpowers/specs/2026-11-22-message-times-design.md`, plan:
`docs/superpowers/plans/2026-11-22-message-times.md`. Fixed in the fix pass and not listed below: a wide table or
image at the top of an answer ran under the time; the UI checks did not cover every message kind nor the real
`openSession` → `api.messageTimes` → `applyTimes` path. Symbols are given instead of line numbers.

## A. Worth doing first (analysed below)

1. **One count mismatch drops every user time of the session.** `MessageTimes.assign`
   (`electron/renderer/message-times.js`) gives user messages a time only when as many were replayed as
   `events.jsonl` records. A known trigger with the scripted agent: two prompts replayed with nothing between them
   (the first one stopped before any output) are joined into one bubble, because `StreamRuns.find`
   (`electron/renderer/stream-runs.js`) continues a block of id-less chunks. From then on that session shows no
   time on any of your messages after a reopen (answers keep theirs).
2. **The fork/delete bar covers the time while a message is hovered.** `.msg > .acts` (`style.css`) is opaque with
   `z-index: 1`; `.msg > .time` has none. On the continue line the bar (y 616..642) cuts the digits (y 630..646). On
   short bubbles ("ok") the squeezed bar wraps its labels letter by letter (53–103 px tall) and covers text and
   time; that bar bug is older than this feature.

### Analysis and proposals

**1.** Whether real Copilot replays such a pair adjacently is not verified (it needs a session with a prompt stopped
before any output). If it does, the all-or-nothing rule is too coarse. Proposal: `messageTimes`
(`electron/history.mjs`) returns the events in order (`[{ kind: "user", t } | { kind: "agent", id, t }]`), and
`assign` aligns user messages per segment between two matched agent `messageId`s: a segment with the same number of
user messages on both sides gets its times, a segment that differs gets none. A text cross-check as in `userIndex`
(`history.mjs`) would also rule out a shifted time when two anomalies cancel out. The joined bubble itself also
shifts the turn ordinals of fork/delete (which fall back to a text match): worth looking at together.

**2.** Proposal: `white-space: nowrap` on `.acts` (fixes the squeezed bar for good), and either fade
`.msg > .time` while a bar is shown (as with the bare Copy button) or move the continue line's time below the bar's
reach. Check with the plan's manual item "hover a user bubble: the bar floats above, the time stays".

## B. Window, wording

3. Under a count mismatch date lines are anchored on answers only (`SessionView.stamp` in `app.js`): a prompt sent
   on the 20th can sit above the "Fri, Nov 20" line and read as the 19th. No wrong clock is shown.
4. The answer's time assumes a paragraph first (`.msg.agent > .time { top: 16px }`). Measured offset from the first
   text line: −0.3 px for a paragraph, −15.5 px for a heading, +8.8 px for a table, +4.3 px for a code block.
5. On answers with a bare Copy button (every block but a turn's first reply block) the time is hidden while the
   message is hovered, so its tooltip (full date, seconds) can't be reached there. Spec: known limitation.

## C. Behaviour, small

6. A live answer's time is that of its first chunk; after a reopen it is when Copilot recorded the finished
   message (spec: known limitation).
7. A replayed *user* message that arrives after the replay marker (seen once, see `sendEdit`) gets the clock and
   possibly a date line for today (spec: known limitation). Answers in that position keep their recorded time
   (`SessionView.recordedTime`).
8. A window reload while main still holds the session open (`alreadyOpen`, no replay): a live chunk that lands
   during `await api.messageTimes` in `openSession` would stay untimed. Not tested.
9. `messageTimes` reads and splits the whole `events.jsonl` in the main process on every open (as
   `countUserMessages` does on demand); a very large history holds main for a moment.
10. `SessionView.recordedTime` repeats the own-key lookup of `MessageTimes.assign`; one helper would keep the rule
    in one place. `historyTimes` is not initialised in the `SessionView` constructor like the other fields.

## D. Tests and housekeeping (no behaviour impact)

- `message-times.test.mjs`: the `full` test asserts the implementation against itself.
- `message-times-replay` (`scripts/ui-check/checks.mjs`) hides the second prompt by hand; a replayed empty prompt
  would exercise the real path (the review's probe did, and it held).
- `message-times-history` covers the success branch of `openSession` only; the failed-load branch (dead view with
  times) has no check.

## Not verified

- **Windows**: nothing of this feature was run there (font metrics of the time in the padding, scrollbar of a wide
  table).
- **Real Copilot**, done on Linux: a two-day session with 7 prompts and 9 answers reopened from a copy of its
  `session-state` folder; every time equals its event's `timestamp` (local time), one date line per day.
- **Real Copilot, still open** (they need a signed-in session):
  - send a message, let it be answered, close and reopen: the times stay;
  - delete, fork and edit a message: the rebuilt view shows times, fork/delete still hit the right message;
  - a queued message delivered mid-turn and the continue line: both timed, nothing under the time;
  - a prompt stopped before any output, then another one, then a reopen (item 1);
  - long sessions: `messageId` equality after a compaction, an attachment-only prompt replayed as an empty chunk.
- **By hand**: hover a later answer block (the time gives way to Copy) and a user bubble (item 2).
