# Activity groups (phase 1): deferred items

From the task reviews and the final whole-branch review of `feat/activity-groups`. None of these blocks the merge.

## Parked by decision
- **Replay shows ● briefly.** Replayed updates that arrive after `session/load` answers are treated as live until the
  settle at the end of the replay. The spec says no ● phase. Cosmetic.
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

## Manual checks before release (not run in the app)
- A mid-turn queue delivery while a work tool is in flight (the synthetic ⊘ path).
- Fork and Delete from a group header.
- A permission ⏸ with real Copilot.

## Phase 2
- Side panel (variant C), switchable in Settings, on the slot model described in the spec's Scope section.
