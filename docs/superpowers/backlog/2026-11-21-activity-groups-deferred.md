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
  yours. During a replay `finishRuns` brings the log to its bottom once per finished block.
- **Replay marker:** its counter restarts at 0 after a window reload, so an old window's marker could end a new open's
  wait.
- **Code:** `group._entry` stays set after a group goes back inline, and `showInPanel` uses it unguarded.
- **Checks:** the "panel after the replay" assertion of `forced-scroll` is likely vacuous; some checks depend on fixed
  pauses (500 ms, 3 s) and pass vacuously on a slow machine; no check fails when only the panel's `ResizeObserver` is
  removed.
