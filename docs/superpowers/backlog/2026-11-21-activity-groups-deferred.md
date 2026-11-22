# Activity groups (phase 1): deferred items

From the task reviews and the final whole-branch review of `feat/activity-groups`. None of these blocks the merge.

## Parked by decision
- **Replay shows ● briefly: mostly fixed.** The replay now ends only after its last replayed update (main sends a
  marker after it: baba155, ccd4ae2), so an opened session no longer shows ●. Left: a window reload during a resume
  (the new open does not wait for the load still running), and an agent that dies during `session/load` (its last
  updates can reach the dead view as live).
- **Group title is fixed at creation.** A title that arrives in a later `task` update is not applied.
- **Pure view logic still lives in `app.js`.** The work-group mark, the last-line extraction and the plan-in-place
  rule could move into `Activity` and get unit tests.

## Behaviour
- **Parallel sync subagents after a Stop.** Their standalone groups (mode null) go back to ● on late chunks and are
  counted in "N subagents running" until the next turn end.
- **Same final answer, opposite order.** If two parallel sync tasks end with the same text and complete in the
  opposite order to their subagents' last updates, the groups still swap. The data cannot tell them apart.
- **Approximate running count.** `running()` drops the first unlinked sync task groups. An unknown running standalone
  group next to a fresh sync task counts 1 instead of 2 until that task's subagent shows up.
- **A sync result that carries an `agent_id`** links the task group before `merge()` runs, so the merge is skipped
  (`activity.js` `linkResult`).
- **`read_agent` status search** covers the rest of the header line. A field value containing `status: completed`
  before the real `status:` would give a false ✓. Not seen in the real format.
- **Merging doesn't carry permission state.** `mergeGroups` doesn't re-point open permission cards (`card._group`) or
  carry `waiting`.
- **A `task` with no `rawInput.mode`** is treated as non-sync. Not seen from real Copilot.
- **The ⏸ glyph** renders as a box under xvfb fonts. Check it on Windows.

## Code and tests
- **Tests to add:**
  - an `Error:` chunk with a `messageId` must not fail its group;
  - a `read_agent` result without `idle|completed` must not complete its group;
  - replay-then-settle starting from a group that is still running;
  - a subagent's tool completion update returns false in the queue tracker.
  - The `MARKS` test is a tautology.
- **Small fixes:**
  - The set named `counted` in `running()` holds the groups that are left out.
  - The work group's ○ tooltip says "quiet (no news)", though for work it means a tool never ended or was
    interrupted.
  - Every chunk re-splits the whole `lastText` to find the header's last line.
- **Internal leftovers:** `messageOf` is not seeded after a merge, and `activity.js` ownedStatus has a dense ternary.
- **Edge cases:**
  - An empty work group can stay after `replacesTool`.
  - A permission for the `task` call itself gets no ⏸ (its badge is replaced by the group).

## Fixed on the way
- **A following log ended a turn ~50 px above its bottom** (every mode, since before the panel): the turn's last text
  is drawn when the turn ends and nothing scrolled after it. A following log now goes to its bottom then (9418355).

## Run with real Copilot (2026-11-22, Copilot CLI 1.0.115, Linux, phase 2 branch)
A new session in a throwaway `/tmp` folder, subagents asked for on model "auto"; the session and its forks were deleted
with the app afterwards.
- Mode `all`: a sync and a background subagent. Both headers stay in the chat with ⇢, their content in the panel. The
  background one's permission showed ⏸ in the chat header and in the panel entry, the card in the chat, "1 subagent
  running" under the composer.
- A message queued during that turn was delivered after the tool step, answered, then "↻ continuing the task". One
  Fork/Delete per turn.
- Fork from a group header (the first turn's reply, a subagent group): the fork opened with the history up to that
  reply. Its sync subagent shows ⊘ and the background one ○, as their completions come after the cut.
- `/context`, then a turn answered "OK", then Fork on it: the fork ends with "OK", `/context` gets no actions and is
  not in it.
- Switch to `subagents`: the work groups went inline, the subagent entries stayed. A second sync and background pair:
  ⏸ in both headers again; "1 subagent running" opened and highlighted the entry.
- Delete from a group header (that turn's reply): the view was rebuilt from the replay, the panel with the two entries
  left.
- Not seen: the mid-turn ⊘. With `sleep 30` running and a message queued, Copilot let the tool end (✓) before it took
  the message.

## Manual checks before release (not run in the app)
- A mid-turn queue delivery while a work tool is in flight (the synthetic ⊘ path). Tried once with real Copilot, see
  above.
- A sent edit, and the panel after the rebuild. The UI checks cannot send one: the scripted session has no Copilot
  history.
- A mode switch during a replay, and with a permission card open.
- The panel and the drawer on Windows (fonts, the ⏸ glyph, the drag).
- A `task` that replaces its badge when the emptied work group is the turn's reply (`replacesTool`): the scripted
  scenario does not exercise it.

## Phase 2: left over
The side panel shipped (`docs/superpowers/specs/2026-11-21-activity-panel-design.md`). Left:
- **Subagents in the panel** look like the work groups there. Whether they need more is to be judged after use.
- **An empty work group** kept after `replacesTool` (its turn's reply) gives an empty entry in mode `all`.
- **Not built (non-goals):** a per-session switch, a "current turn only" filter, a link from an entry back to the chat.
- **Drawer and focus:** the drawer does not take the focus when it opens, so `Esc` closes it only once you are inside.
  `drawerOpen` is not reset when the panel loses its last entry. Collapsing leaves the focus on the hidden button.
- **Drag:** no pointer capture and no buttons check (a lost `pointerup` keeps resizing). The 7 px grab area overlaps
  the log's scrollbar by 3 px.
- **Follow:** scroll anchoring within 80 px of the bottom can turn the panel's follow back on without a scroll of
  yours.
- **Replay marker:** its counter restarts at 0 after a window reload, so an old window's marker could end a new open's
  wait.
- **Code:** `group._entry` stays set after a group goes back inline, and `showInPanel` uses it unguarded.
- **Checks:** the "panel after the replay" assertion of `forced-scroll` is likely vacuous (`replay-ends-at-bottom`
  asserts it with an overflowing panel); some checks depend on fixed
  pauses (500 ms, 3 s) and pass vacuously on a slow machine; no check fails when only the panel's `ResizeObserver` is
  removed.

## Phase 2: smaller leftovers from the reviews
Set aside by the task reviews and the final review of `feat/activity-panel` (v0.16.0). None affects normal use.

**App**
- `UiState.panelLayout`: in the narrow branch the 280 px minimum beats "view − 40" below a 320 px view. Not reachable
  today (window minimum 760, sidebar 300).
- `app.js` repeats the pair `panelFollow = false; panelOwnTop = …` in two places.

**Checks that are weaker than they look**
- `log-keeps-place` only tests `scrollTop === 0`. It cannot fail on a lost reading position in the middle of the log.
- `replay-ends-at-bottom` and `failed-replay-ends-at-bottom` pin the outcome, not the mechanism: no check fails when
  the `resuming` guard in `followBottom` or the two scrolls at the end of a replay are removed. Replay speed is only
  measured by hand.
- `resize-keeps-bottom` does not assert that the resize took effect, and its "lower window" panel assertion was never
  seen failing through the check itself.
- `save-keeps-mode` reads the saved value once, right after the dialog closes, and never asserts the renderer's
  `activityPanel` after Save or at startup.
- `drawer` never reaches the "view − 40" cap. `drawer-esc` passes without `stopPropagation` in the panel's listener.
  Drags are synthetic pointer events dispatched in the page.
- `edit-dim`: the late group is timed by a fixed 3 s; its oracle repeats the implementation's expression;
  `stubEditCount` patches a copy of `startEdit` and leaves `window.__countFrom`; `cancelled.dimmed` is always 0;
  switching the edit to another message is not exercised.
- `stop-marks`: the scripted agent plays no further step after `session/cancel`, while real Copilot keeps sending
  subagent output after a Stop. Its `cancelPlaying` is one global that is never reset.
- `panel-wait-scenario.mjs` hard-codes the two halves of the split text and has no guard when its anchors are missing.

**Harness**
- `driver.mjs`:
  - `until()` swallows page errors, so a page exception shows up 20 s later as a timeout;
  - attaching polls the full 20 s when Electron died at start (seen with a long `TMPDIR`: "Socket path too long");
  - `reload()` breaks if the method is destructured;
  - `close()` is idempotent by a flag, not a promise, waits without a bound after SIGKILL, and falls through to the
    kill silently when the app does not exit within 5 s;
  - `launch({ dir, settings })` ignores `settings`, and the file's header comment is stale.
- `checks.mjs`: `relaunch()` leaks the kept temp dir if `launch` throws. The file is over 1000 lines; helpers and
  checks could be split. `WAIT_MS` is exported from `panel-scroll-scenario.mjs` but used only there.
- `run.mjs`: unknown flags are ignored; `--record` prints "(recorded)" for checks that record nothing; `--record`
  with a check that does not run in mode `off` runs nothing and says nothing.
- `scripted-agent.mjs`: a `session/prompt` before `session/new` throws instead of answering with an error; request
  handlers run in a microtask. `scripted-agent.test.mjs`: one 1000 ms bound is measured after a 200 ms sleep.
- The UI checks run on Linux only (Xvfb) and are not part of CI.
