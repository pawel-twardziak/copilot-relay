# Activity panel: groups in a side panel (activity groups, phase 2)

Follows `2026-11-21-activity-groups-design.md` (phase 1, shipped as v0.15.0). Read that first: the ACP facts, the
`Activity` module and the group rules are unchanged and not repeated here.

## Intent

Phase 1 collapsed the main agent's work and every subagent into one-line groups inside the chat. Opening a group still
pushes the conversation apart, and a running subagent can only be watched by scrolling away from the answer. Phase 2
adds an optional side panel: the content of the groups lives there, the chat keeps each group's one-line header where
it was, and the work can be read next to the conversation.

## Goals

- A Settings option `activityPanel` with three values, default `off`:
  - `off`: groups inline, exactly as v0.15.0;
  - `subagents`: subagent groups in the panel, work groups inline;
  - `all`: both kinds in the panel.
- The option applies to every open view when Settings is saved, without rebuilding a view and while a turn streams.
- In the chat, a group whose content is in the panel keeps its one-line header (same mark and text). A click on it
  shows that group in the panel.
- Everything that works on groups today works the same in all three modes: Fork/Delete, Copy thread, the plan updating
  in place, permission ⏸, "N subagents running", merge of parallel sync subagents, settle, replay by `session/load`.

## Non-goals

- No change to `activity.js` routing, to what is sent to Copilot, to the relay or to the queue.
- No per-session switch, no "current turn only" filter, no link from the panel back to the chat.
- No persistence of a group's open state (as in phase 1). Only the panel's width and collapsed state are remembered.
- Permission cards do not move: they stay in the chat, where the user answers them.
- Fork/Delete stay in the chat, on the group's header there. The panel has none.
- No extra visual distinction of subagents in the panel beyond the existing `.group.subagent` style. To be judged
  after use.
- The other items of `docs/superpowers/backlog/2026-11-21-activity-groups-deferred.md`. One of them shows in the
  panel: an empty work group kept after `replacesTool` (because it is its turn's reply) gives an empty panel entry
  in mode `all`. Known, rare, left as is.

## Anti-goals (a failure even if it works)

- Every phase 1 anti-goal, in all three modes.
- Mode `off` looking or behaving differently from v0.15.0.
- Switching the mode losing content, a group's open state, or text that is streaming.
- Fork/Delete missing on a turn's reply, or shown twice.
- Copy thread giving a different result depending on the mode.
- The chat losing its place (follow state or scroll position) when a group is created, moved or shown in the panel,
  or when the panel is resized, collapsed or opened.

## Constraints

- `app.js` is a classic script with no DOM tests; `npm test` covers the pure modules only. Pure logic goes into
  modules that `node --test` can load, as in phase 1. `main.mjs` cannot be loaded by `node --test` (it imports
  electron), so main-side helpers live in their own `.mjs` (as `normalizeTier` in `context-tier.mjs`).
- A view is rebuilt from the replay after Delete, after an edited message is sent and after a context switch
  (`reopenView`), so nothing has to cut the panel in place.
- Stream blocks (`StreamRuns`), tool badges (`tools.get(id).group`) and permission cards (`card._group`) hold
  references to group elements and their bodies. They must stay valid across a mode switch.

## Approaches considered

- **A. Slots: a wrapper per group in the log, and the whole group element moves.** The slot owns the turn mark,
  Fork/Delete and `_md`; the group sits in the slot or in the panel. Named as the basis in the phase 1 spec. Costs
  a refactor of every place that assumes "a group is a child of the log" (`markTurn`, `isReply`, `dropTurn`,
  `addActions`, `workGroup`, `settleGroups`, `plan`, `copyThread`), with no DOM tests to catch a silent
  regression, and a Fork/Delete bar that has to move between two hosts.
- **A′. Only the group's body moves (chosen).** The `details.group` element, with its summary, mark, Fork/Delete and
  turn mark, stays a child of the log in every mode. In a panel mode its body (`group._body`) is moved into an entry
  in the panel that has its own header. Every access to the body already goes through `_body` or a closure, so the
  places listed under A stay untouched, and mode `off` changes nothing in the DOM. Found in the spec review; it
  gives the same result as A with far less to break.
- **B. A second renderer for the panel, fed from `Activity`.** Nothing moves, but `Activity` holds no item content
  (the text lives in the DOM blocks), so it needs a view model for every item and everything renders twice.
- **C. CSS only** (take groups out of the log's flow). One DOM flow cannot give two independently scrolling columns.

Chosen by the user: both kinds can go to the panel, with the three-value setting from the start.

## Design

### 1. Where a group's body lives

- **Invariant.** The log is the only registry of groups and of their order. Nothing enumerates the panel to find
  groups, and nothing in the log changes with the mode except what is said here.
- `Activity.inPanel(mode, kind)` (pure, tested): `all` → every kind, `subagents` → `subagent` only, `off` → none.
  It is read in one place only, `place(group)`.
- `place(group)` puts the body where the mode says, per group:
  - inline: the body is inside its `details.group`, as in v0.15.0;
  - panel: the body is inside that group's panel entry, and the panel entries are in the order of their groups in
    the log.
- A panel entry is a collapsible block with its own header (mark and text). `_renderHeader` renders the group's
  summary and the entry's header from the same `_info`, so ●, ⏸ and the last line show in both.
- `place` runs when a group is created, when the mode changes (for every group of the view, in log order), and
  tolerates a group already in place: only a body whose container changes is moved.
- Open state belongs to whatever holds the body: the `details.group` inline, the entry in the panel. A mode switch
  carries it over. `mergeGroups` reads and sets it through that holder (today `from.open` / `into.open`).
- Removing a group (an empty one after `replacesTool`, the source of a merge) removes its panel entry too.
- **Collapsed by default.** As inline: an entry starts collapsed and streaming never opens it.

### 2. The group's header in the chat, in a panel mode

- It is the same `summary` as today, with the turn mark and Fork/Delete where they are.
- It carries a distinct marker instead of ▸/▾, so that in mode `subagents` it cannot be mistaken for an inline work
  group, which still opens in place.
- A click does not toggle it (its body is elsewhere). It shows the group in the panel: un-collapses the panel or
  opens the drawer, opens the entry, scrolls it into view (`block: "nearest"`) and highlights it for about a second.
- "N subagents running" does the same for the first running subagent when subagents are in the panel; otherwise it
  scrolls the log as today.

### 3. Setting

- `settings.json`: `activityPanel`: `"off" | "subagents" | "all"`. A main-side helper in its own `.mjs`, with a
  test, normalises anything else to `"off"`.
- `settings:set` writes an explicit field list and has one caller: both must carry the new field, or every Save
  resets the mode.
- Settings dialog: a select "Tool and subagent details": "In the chat" / "Subagents in a side panel" / "Everything in
  a side panel".
- The mode reaches the views the way `queueMidTurn` does: at startup when the settings arrive (views may already be
  open) and on Save, through `settingChanged()`. A Save that does not change the mode moves nothing.

### 4. Panel

One panel per session view, a sibling of that view's log; the head, composer and status bar keep the full width.

```
┌ head ───────────────────────────────────────────── [Activity] ┐
│ You: …                           ║ Activity              [»]  │
│ ⇢ ✓ 3 tools, 1 thought           ║ ▸ ✓ 3 tools, 1 thought     │
│ Agent text …                     ║ ▾ ● Subagent: explore …    │
│ ⇢ ● Subagent: explore …          ║     prompt, text, tools    │
│ [Permission needed: …]           ║     (opened by the user)   │
├ composer ────────────────────────╨────────────────────────────┤
```

- **When it shows.** The panel appears in a view with the first group bound for it, not before: in mode
  `subagents` a session that never starts a subagent keeps the full width.
- **Scrolling.** The panel has its own follow state, on the same `ScrollFollow.followAfterScroll` rule as the log.
  - Whatever changes a group brings its container to the bottom if that container follows: `groupAppend`,
    `queueRender`, and `append()` of a group whose body goes to the panel.
  - The forced scrolls (sending a message, the end of a replay) take the panel to its bottom too.
  - Showing or opening an entry (a header click in the chat, "N subagents running", the entry's own header) turns
    the panel's follow off, so the next update elsewhere does not pull it away from what is being read. The scroll
    the app makes itself must not turn it back on. It follows again once the user scrolls near the bottom.
  - The log's follow state is never changed by panel content.
- **Size changes.** A following container (log or panel) goes to its bottom whenever its size changes or it becomes
  visible (a `ResizeObserver` on each). This covers resizing, collapsing, the panel appearing, the mode switch and
  a view becoming active; no scroll event fires for these today.
- **Links.** The link and path click handler (`onLink`, today on the log only) becomes a helper attached to the log
  and to the panel, for click and middle click.
- **Zoom.** The panel's content scales with `--chat-scale`. The zoom goes on the content box, not on the element
  that carries the width, so the width, its limits and the drag are in real pixels.
- **Styles.** The rules tied to the log apply to the panel's content as well: link colour (`.log a`), the group
  body's look, no `max-width: 920px` inside the panel.
- **Permission cards.** Unchanged, in the log. Their group's header shows ⏸ in the chat and in the panel.
- **Edit mode.** A panel entry is dimmed exactly when its group in the log is (it comes after the message being
  edited). Recomputed when an edit starts or ends and when a group is placed; today's dimming is a CSS sibling rule
  that cannot reach the panel.

### 5. Width, collapse, narrow views

- **Wide layout.** A drag handle between log and panel. Default 420 px. The width is clamped to at least 280 px and
  at most "view width − 480 px", so the chat always keeps 480 px. The clamp is a pure, tested helper in
  `ui-state.js`. The chosen width is stored with the other UI state in `localStorage` (`panelWidth`), shared by
  all sessions.
- **Collapse.** A button in the panel's head hides the panel; an "Activity" button in the view's head (shown while
  the view has panel groups) brings it back, as does showing a group. `panelCollapsed` is stored like the width
  and applies to the wide layout only.
- **Narrow layout.** When the view cannot give the chat 480 px next to a 280 px panel (view narrower than 760 px),
  the panel is an overlay drawer over the right side of the log, as wide as the stored width but never wider than
  the view minus 40 px.
  - It is closed until a group is shown or the "Activity" button opens it. Open or closed is per view and not
    stored. Crossing between the layouts writes neither state.
  - It closes by its button, by Esc while the focus is inside it, and when a permission card arrives (the question
    must be visible). Esc elsewhere keeps its meaning: stop the turn, cancel an edit, close the command popup, the
    image viewer or the file preview.
  - The layout follows the view's width, not the window's; no group moves because of the size.

### 6. Switching while a turn streams

Bodies are moved, never re-created: blocks keep streaming into the same elements, badges and permission cards keep
their group. Moving a node resets its inner scroll offsets, selection and focus, so only bodies whose container
changes are moved (`Element.moveBefore()` where available keeps more state).

## Verification

There is no DOM test harness in the repo. The phase 1 scripted ACP agents and the CDP driver exist only in a
scratch directory (`drive.mjs`, `fake2.mjs`, `fake3.mjs`); `electron/test/fixtures/acp/fake-agent.mjs` only
answers `initialize`.

**First step, before any panel code:** bring a scripted ACP agent and the driver into the repo
(`electron/test/fixtures`, `scripts/`), and record a baseline on v0.15.0, live and after replay:
- the Copy thread text;
- `[...log.children].map(e => [e.className, e._turn, e._kind, !!e.querySelector(".acts")])`.

The scenario covers tools, thinking, a plan updated twice, a sync and a background subagent, parallel sync subagents
(merge), a `task` replacing its badge, a subagent's permission request, and a standalone group arriving after the
next user message.

**After the work, in every mode,** both recordings must be identical to the baseline (the log's children do not
change with the mode).

**Unit tests:** `Activity.inPanel`, the setting's normaliser, the width clamp.

**In the app** (`off`, `subagents`, `all` unless said otherwise):
- the scenario above live, then the session reloaded;
- exactly one Fork/Delete per turn; Fork and Delete from a reply that is a group; a `/context` turn (`dropTurn`),
  then Fork/Delete on the next turn; a `task` replacing its badge when the emptied work group is the turn's reply;
- permission ⏸ in the chat header and the panel entry, the card in the chat;
- mid-turn delivery and Stop: ⊘/○ on the badge, the work mark, both headers;
- all six mode transitions, also with groups open, with an open permission card, in a non-active view, during a
  replay and while a subagent streams; Save without touching the select keeps the mode;
- edit mode: dim and undim, a switch while editing, a sent edit and the panel after the rebuild;
- a dead view: the process killed with a ● group in the panel, a switch on the dead view, resume;
- scrolling: a scrolled-up log stays put on create, move, show, resize and collapse; a following log stays at its
  bottom through the same; the panel follows, stops after a group is shown, follows again near the bottom;
- width: drag and clamp, at zoom 70 % and 200 %; two open views share width and collapsed state; both kept after a
  restart; the narrow layout: drawer open/close, Esc inside and in the message box while a turn runs, a permission
  card arriving under an open drawer;
- a link, a file path and a middle click inside a panel group;
- one run with real Copilot (on this machine subagents run only when asked for model "auto"), and the three phase 1
  checks never run in the app: the mid-turn ⊘ path, Fork/Delete from a group header, ⏸ with real Copilot.

## Left to the builder

- Element and class names, the marker glyph, the highlight style, the drawer's mechanics.
- How the panel entry is built (a `<details>` or not), as long as its header comes from `_renderHeader`.
- The order of the steps after the baseline.
