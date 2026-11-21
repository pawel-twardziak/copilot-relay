# Activity Panel (activity groups, phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An optional side panel in the Electron app that holds the content of work and subagent groups, while each
group's one-line header stays in the chat.

**Architecture:** The `details.group` element stays a child of the log in every mode; only its body (`group._body`)
moves into a per-group entry in a panel that is a sibling of the view's log (approach A′ in the spec). One function,
`place(group)`, decides where a body lives from the setting `activityPanel` (`off | subagents | all`). DOM behaviour
is checked by a scripted ACP agent driven over CDP against a baseline recorded before any renderer change.

**Tech Stack:** Electron renderer, plain DOM, classic-script modules (`globalThis.X` + `module.exports`),
`node --test`, Chrome DevTools Protocol over `--remote-debugging-port`, `xvfb-run`.

**Spec:** `docs/superpowers/specs/2026-11-21-activity-panel-design.md` (it builds on
`docs/superpowers/specs/2026-11-21-activity-groups-design.md`). Read both.

**Before Task 1:** work in a worktree on branch `feat/activity-panel` (superpowers:using-git-worktrees). The spec
and this plan are untracked on `main`: copy both into the worktree and commit them there first
(`docs: activity panel spec and plan`).

## Global Constraints

- No framework, no bundler. Renderer modules are classic scripts that set `globalThis.<Name>` and export through
  `module.exports`; main-side helpers are `.mjs` files that do not import `electron`.
- `activity.js` routing does not change. Only `Activity.inPanel` is added.
- The log is the only registry of groups and their order. Nothing enumerates the panel to find groups.
  `Activity.inPanel` is called in `place()` and nowhere else.
- These functions of `app.js` are not edited: `markTurn`, `isReply`, `dropTurn`, `addActions`, `workGroup`,
  `plan`, `copyThread`. `settleGroups` keeps its selector.
- Mode `off` must produce the same DOM as v0.15.0: no wrapper, no extra class on a group, no panel element shown.
- Setting: `activityPanel`, values `"off" | "subagents" | "all"`, default `"off"`.
- Sizes: panel default 420 px, minimum 280 px, chat keeps at least 480 px, narrow layout below a 760 px view, drawer
  never wider than the view minus 40 px.
- A body is moved only when its container changes; it is never re-created.
- UI copy in English. Settings select label "Tool and subagent details", options "In the chat", "Subagents in a side
  panel", "Everything in a side panel". Panel title "Activity".
- Full suite: `npm test` from the repo root (506 tests pass before this plan).
- UI checks: `node scripts/ui-check/run.mjs` (Task 1) exits 0. Every task from 3 on ends with it green.
- Commit style as in `git log`: `feat(desktop): …`, `test(desktop): …`, `docs: …`.
- Reviews run on model Fable with high effort. On this machine real Copilot runs subagents only when they are asked
  for model "auto".

## Review Focus

- The mode changes while a subagent streams: the text keeps growing in the same block, nothing is lost or doubled
  (check `switch-while-streaming`, Task 3).
- Settings saved without touching the new select must keep the stored mode (`settings:set` writes a field list)
  (check `save-keeps-mode`, Task 2).
- Parallel sync subagents merge while their bodies are in the panel: the source entry goes, the target keeps the
  open state, panel order still equals log order (check `merge-in-panel`, Task 3).
- A following log must stay at its bottom, and a scrolled-up log must stay put, when the panel first appears, is
  resized or is collapsed (checks `log-keeps-bottom`, `log-keeps-place`, Tasks 4 and 5).
- Esc with an open drawer while a turn runs: in the message box it stops the turn and leaves the drawer; inside the
  drawer it closes the drawer and the turn runs on (check `drawer-esc`, Task 5).

---

### Task 1: UI check harness and the v0.15.0 baseline

No renderer file changes in this task. The baseline must be recorded from the code as it is on `main`.

**Files:**
- Create: `electron/test/fixtures/acp/scripted-agent.mjs`
- Create: `electron/test/fixtures/acp/panel-scenario.mjs`
- Create: `scripts/ui-check/driver.mjs`
- Create: `scripts/ui-check/run.mjs`
- Create: `scripts/ui-check/checks.mjs`
- Create: `electron/test/fixtures/ui-baseline/live.json`, `electron/test/fixtures/ui-baseline/replay.json`
- Test: `electron/test/scripted-agent.test.mjs`

Reference only (not in the repo, may be gone): the phase 1 scripts in
`/tmp/claude-1000/-media-twapaw-ubuntu-data-1-0-Projekty-copilot-relay/e0ac7556-65bf-40b9-8e60-c805793b5bb8/scratchpad/`
(`drive.mjs`, `fake2.mjs`, `fake3.mjs`, `t5/`). They show the launch and the CDP calls that worked.

**Interfaces:**
- Produces:
  - `scripted-agent.mjs`: an ACP agent over stdio. `SCRIPTED_SCENARIO` (env) is the path of a module whose default
    export is `{ prompts: Step[][] }`; the n-th `session/prompt` of a session plays `prompts[n]`.
    - `Step`: `{ u: update }` sends a `session/update`; `{ perm: toolCall }` sends `session/request_permission`
      and waits for its answer before the next step; `{ wait: ms }`; `{ end: stopReason }` answers the prompt.
      Steps after `end` are sent after the prompt's answer (a subagent that outlives its turn).
    - It records every update it sends, and each prompt as a `user_message_chunk`, in
      `<cwd>/.scripted-agent.json`, and answers `session/load` by sending them again in order.
    - Session id: `"scripted-" + <basename of cwd>`.
  - `panel-scenario.mjs`: three prompts with fixed ids (`t1`…, agent ids as fixed UUIDs):
    1. main text, a thought, a tool (`pending` → `completed`), a plan of two entries, a second tool, the plan again
       with one entry completed, a sync `task` whose subagent sends text, a tool and a final text equal to the
       task's result, a background `task` (result `Agent started in background with agent_id: <uuid>.`) whose
       subagent sends text, main text, `end`.
    2. two sync `task`s; their subagents start in the opposite order as standalone chunks and the tasks complete
       with matching texts (merge); a `tool_call_update` for `t5` followed by a `tool_call` `t5` with
       `rawInput.agent_type` and `prompt` (`replacesTool`); a tool of the background subagent with a `perm`
       step; main text; `end`.
    3. a text chunk of an unknown agent id first (a standalone group after the user message), main text, `end`.
  - `driver.mjs` exports `launch({ scenario, settings = {}, width = 1280, height = 800 })` →
    `{ ev(expr), newSession(), send(text), answerPermission(), idle(), reload(), setMode(mode), resize(w, h), dump(), close() }`.
    - `launch` writes `settings.json` (with `copilotCommand` = the scripted agent) into a fresh
      `XDG_CONFIG_HOME`, starts `xvfb-run -a electron/node_modules/.bin/electron electron --remote-debugging-port=<free port>`
      and attaches to the page.
    - `reload()` closes the view and opens the session again (renderer `closeView`, `openSession`), then waits for
      the replay to end.
    - `setMode(mode)` goes through the Settings dialog (set the select, save), not through a variable. Until Task 2
      adds the select it throws for anything but `"off"`.
    - `dump()` → `{ thread, log }`: `thread` is the `_md()` of each log child, trimmed, non-empty, joined with a
      blank line (what Copy thread builds, without its two header lines); `log` is
      `[...v.log.children].map(e => [e.className.replace(/\s*\bin-panel\b/, ""), e._turn ?? null, e._kind ?? null, !!e.querySelector(".acts")])`.
  - `checks.mjs` exports `checks`: `{ name, modes?, run(app) }[]`, each throwing on failure.
  - `run.mjs [name…]`: runs the checks (all, or the named ones), in every mode a check lists (default `["off"]`
    until Task 2), prints one line per check and exits 1 if any failed. `run.mjs --record` writes the baseline
    files.

- [ ] **Step 1: Write the failing test** `electron/test/scripted-agent.test.mjs`: spawn the agent with a two-prompt
  inline scenario in a temp cwd and assert: `session/new` returns `sessionId` `"scripted-" + basename`; the first
  prompt's updates arrive in order before its `{ stopReason: "end_turn" }`; a `perm` step holds the following
  update until the request is answered; a second process answering `session/load` for the same cwd sends the
  `user_message_chunk` and the same updates, in order, before its result.
- [ ] **Step 2:** Run `node --test electron/test/scripted-agent.test.mjs`. Expected: FAIL, module not found.
- [ ] **Step 3:** Implement `scripted-agent.mjs`.
- [ ] **Step 4:** Run the test. Expected: PASS. Run `npm test`. Expected: all pass.
- [ ] **Step 5:** Write `panel-scenario.mjs`, `driver.mjs`, `run.mjs` and `checks.mjs` with two checks:
  - `baseline-live`: play the three prompts (answering the permission), `dump()` deep-equals `live.json`;
  - `baseline-replay`: the same, then `reload()`, `dump()` deep-equals `replay.json`.
- [ ] **Step 6:** Run `node scripts/ui-check/run.mjs --record`, then `node scripts/ui-check/run.mjs` three times.
  Expected: both checks pass every time (the recording is deterministic). Read `live.json`: it must contain a
  `plan` once, two `group subagent` entries from prompt 1, one merged pair from prompt 2 (not two), and exactly one
  entry with `"reply"` per turn.
- [ ] **Step 7: Commit** `test(desktop): scripted ACP agent, CDP driver and the v0.15.0 UI baseline`.

### Task 2: The setting and the pure helpers

**Files:**
- Create: `electron/activity-panel.mjs`, `electron/test/activity-panel.test.mjs`
- Modify: `electron/renderer/activity.js` (export list at the end), `electron/test/activity.test.mjs`
- Modify: `electron/renderer/ui-state.js` (export list), `electron/test/ui-state.test.mjs`
- Modify: `electron/main.mjs:1028-1040` (`settings:get`, `settings:set`)
- Modify: `electron/renderer/index.html` (after the `set-queue` hint, line ~51)
- Modify: `electron/renderer/app.js:234`, `:251-257`, `:2927`, `:2965-2971`
- Modify: `scripts/ui-check/driver.mjs`, `scripts/ui-check/checks.mjs`, `scripts/ui-check/run.mjs`

**Interfaces:**
- Produces:
  - `normalizePanelMode(value): "off" | "subagents" | "all"` in `electron/activity-panel.mjs` (anything else → `"off"`).
  - `Activity.inPanel(mode, kind): boolean`.
  - `UiState.PANEL = { min: 280, chatMin: 480, def: 420, drawerGap: 40 }`.
  - `UiState.panelLayout(viewWidth, stored): { narrow: boolean, width: number }`.
  - `settings:get` returns `activityPanel`; `settings:set` stores `normalizePanelMode(s.activityPanel)`.
  - Renderer global `let activityPanel = "off"` in `app.js`, set at startup and on Save before
    `v.settingChanged()` runs for every view.
  - Select `#set-activity` with values `off`, `subagents`, `all`.

- [ ] **Step 1: Write the failing tests**

```js
// electron/test/activity-panel.test.mjs
test("normalizePanelMode keeps the three modes and turns anything else into off", () => {
  for (const m of ["off", "subagents", "all"]) assert.equal(normalizePanelMode(m), m);
  for (const v of [undefined, null, "", "ALL", "panel", true, 1, {}]) assert.equal(normalizePanelMode(v), "off");
});

// electron/test/activity.test.mjs
test("inPanel: all takes both kinds, subagents only subagent groups, off none", () => {
  assert.deepEqual(["work", "subagent"].map((k) => Activity.inPanel("all", k)), [true, true]);
  assert.deepEqual(["work", "subagent"].map((k) => Activity.inPanel("subagents", k)), [false, true]);
  assert.deepEqual(["work", "subagent"].map((k) => Activity.inPanel("off", k)), [false, false]);
  assert.equal(Activity.inPanel(undefined, "subagent"), false);
});

// electron/test/ui-state.test.mjs
test("panelLayout: wide keeps 480 px for the chat, narrow below 760 px", () => {
  assert.deepEqual(UiState.panelLayout(980, 420), { narrow: false, width: 420 });
  assert.deepEqual(UiState.panelLayout(980, 900), { narrow: false, width: 500 }); // 980 - 480
  assert.deepEqual(UiState.panelLayout(980, 100), { narrow: false, width: 280 });
  assert.deepEqual(UiState.panelLayout(760, 420), { narrow: false, width: 280 });
  assert.deepEqual(UiState.panelLayout(759, 420), { narrow: true, width: 420 });
  assert.deepEqual(UiState.panelLayout(400, 420), { narrow: true, width: 360 }); // 400 - 40
  assert.deepEqual(UiState.panelLayout(980, NaN), { narrow: false, width: 420 }); // default
});
```

- [ ] **Step 2:** Run `npm test`. Expected: the three new tests FAIL (not defined).
- [ ] **Step 3:** Implement the three helpers.
- [ ] **Step 4:** Run `npm test`. Expected: all pass.
- [ ] **Step 5:** Wire the setting: `main.mjs` get/set, the select in `index.html` with a hint line ("Where the
  details of tool calls and subagents open. Applies at once to open sessions."), `app.js` loads it at startup and
  in the dialog, sends it in `api.setSettings`, and updates `activityPanel` before `settingChanged()`.
- [ ] **Step 6:** In the driver make `setMode` real. In `run.mjs` make the default mode list
  `["off", "subagents", "all"]`. Add the check `save-keeps-mode` (modes `["all"]`): after `setMode("all")`, open
  Settings and save without touching the select, then `getSettings()` in the page still returns
  `activityPanel: "all"`; relaunch the app with the same config dir and it is still `"all"`.
- [ ] **Step 7:** Run `node scripts/ui-check/run.mjs`. Expected: `baseline-live` and `baseline-replay` pass in all
  three modes (the setting has no effect yet), `save-keeps-mode` passes.
- [ ] **Step 8: Commit** `feat(desktop): activityPanel setting and its pure helpers`.

### Task 3: The panel and `place()`

**Files:**
- Modify: `electron/renderer/app.js`: the view's constructor (`:315-369`, `:427-436`), `settingChanged` (`:1001`),
  `groupElement` (`:1325-1353`), `addSubagentGroup` (`:1429-1449`), `mergeGroups` (`:1452-1468`), the
  `bgEl` click (`:370-373`)
- Modify: `electron/renderer/style.css` (after the group rules, `:154-175`; links `:271`; zoom `:319`)
- Modify: `scripts/ui-check/checks.mjs`

**Interfaces:**
- Consumes: `activityPanel`, `Activity.inPanel(mode, kind)` (Task 2); the driver and checks (Task 1).
- Produces, on `SessionView`:
  - `this.row`: `div.chat-row` holding `this.log`, `this.panelHandle` (`div.panel-handle`) and `this.panel`
    (`aside.activity-panel`, hidden until the view has a panel entry) with `this.panelBody` (`div.panel-body`, the
    scroller, carrying the zoom).
  - `group._entry`: `details.panel-entry.work|subagent` with a `summary` (mark and title); created by `place` the
    first time the group goes to the panel.
  - `place(group)`: moves `group._body` into the group or into its entry according to
    `Activity.inPanel(activityPanel, group._info.kind)`; keeps the entries in the order of their groups in the log;
    toggles the class `in-panel` on the group; carries the open state; shows or hides `this.panel`.
  - `placeAll()`: `place` for every group of the log, in log order. Called from `settingChanged()`.
  - `isOpen(group)`, `setOpen(group, open)`: on whatever holds the body.
  - `showInPanel(group)`: reveals the panel, opens the entry, `scrollIntoView({ block: "nearest" })`, adds the
    class `flash` for 1000 ms.
  - `removeGroup(group)`: removes the group and its entry.
  - `bindLinks(el)`: attaches the link and path handler (`click`, `auxclick`) to `el`; used for the log and
    `panelBody`.

- [ ] **Step 1: Write the failing checks** in `checks.mjs` (each plays the scenario unless said otherwise):
  - `panel-placement` (all modes): for every group in the log, its body is inside the group in the modes where
    `Activity.inPanel` is false, else inside `group._entry` inside `panelBody`; the entries' order equals the order
    of their groups in the log; `panel.hidden` is true exactly when there is no entry; in mode `off` no group has
    the class `in-panel` and none has `_entry` connected.
  - `header-shows` (`subagents`, `all`): clicking the summary of an in-panel group leaves `group.open` false, opens
    its entry and gives it the class `flash`; the entry header's text equals the group summary's title text; with
    the permission card open both headers contain ⏸.
  - `mode-transitions` (one run): after the scenario, walk off→subagents→all→off→all→subagents→off; after each
    step `panel-placement` holds, `dump()` equals the baseline, every `.group` has at most one `.acts`, and an
    entry opened before a step is still open after it (as the group, when it moved back).
  - `merge-in-panel` (`subagents`, `all`): open the standalone group's entry before the merging completion
    arrives; afterwards the log has one group for that task, its entry is open, no detached entry remains in
    `panelBody`.
  - `switch-while-streaming`: a scenario variant with a `wait` in the middle of a subagent's text; switch
    off→all during the wait; the subagent's block element is the same node before and after and ends with the
    full text once.
  - `panel-links` (`all`): a click and a middle click on a link inside a panel entry call `openLink` (wrap
    `v.openLink` in the page and count).
  - `running-button` (`subagents`): clicking "N subagents running" opens the first running subagent's entry.
- [ ] **Step 2:** Run `node scripts/ui-check/run.mjs`. Expected: the new checks FAIL in the panel modes; the
  baseline checks pass.
- [ ] **Step 3:** Build the row and the panel in the constructor (hidden), `bindLinks`, and the styles: the panel's
  content gets link colour and `zoom: var(--chat-scale)` on `.panel-body`; `.panel-entry` looks like `.group`
  without `max-width`; `.group.in-panel > summary::before` is `"⇢"`; `.flash` is a one-second highlight.
- [ ] **Step 4:** Implement `place`, `placeAll`, `isOpen`, `setOpen`, `removeGroup`, `showInPanel`:
  - `groupElement` makes `_renderHeader` also render `_entry`'s summary when it exists, and the summary's click
    handler calls `showInPanel` with `preventDefault` when the group has the class `in-panel`.
  - `append(el)` calls `this.place(el)` after `this.log.append(el)` when `el._info` exists (a group); this covers
    `workGroup` and `addSubagentGroup` without editing `workGroup`.
  - `addSubagentGroup` (`g.remove()`) and `mergeGroups` (`from.remove()`, `from.open`, `into.open`) use
    `removeGroup`, `isOpen`, `setOpen`.
  - `settingChanged` calls `placeAll()`.
  - The `bgEl` click uses `showInPanel` when the group has the class `in-panel`.
- [ ] **Step 5:** Run `node scripts/ui-check/run.mjs` and `npm test`. Expected: all pass, the baseline checks in all
  three modes included.
- [ ] **Step 6: Commit** `feat(desktop): activity panel, group bodies placed by the activityPanel setting`.

### Task 4: Scrolling and size changes

**Files:**
- Modify: `electron/renderer/app.js`: the constructor's scroll listener (`:316-322`), `toBottom` (`:714`),
  `append` (`:750`), `queueRender` (`:1285`), `groupAppend` (`:1364`), `showInPanel` (Task 3), the forced
  scrolls (`:2090`, `:2247`)
- Modify: `scripts/ui-check/checks.mjs`

**Interfaces:**
- Consumes: `this.panelBody`, `place`, `showInPanel` (Task 3); `ScrollFollow.followAfterScroll`.
- Produces, on `SessionView`:
  - `this.panelFollow` (starts true), `this.panelLastTop`, updated by a scroll listener on `panelBody` with the
    same rule as the log.
  - `panelToBottom()`: sets `panelFollow` true and scrolls `panelBody` to its end.
  - `followBottom()`: brings the log to its bottom if `this.follow`, and the panel if `this.panelFollow`; replaces
    the `if (this.follow) this.toBottom()` in `append`, `queueRender` and `groupAppend`.
  - The forced scrolls (send, end of replay) call `toBottom()` and `panelToBottom()`.
  - `showInPanel` sets `panelFollow` false and ignores the scroll event its own `scrollIntoView` causes.
  - A `ResizeObserver` on `this.log` and on `this.panelBody` calls `followBottom()`.

- [ ] **Step 1: Write the failing checks** (window height 500 so both containers overflow; a scenario variant with
  `wait` steps between a subagent's chunks):
  - `panel-follows` (`all`): during streaming `panelBody` is within 2 px of its bottom after each chunk.
  - `panel-stops-after-show` (`all`): click the first group's header in the chat; after the next two chunks
    `panelBody.scrollTop` has not changed and `v.panelFollow` is false; scroll `panelBody` to its end; after the
    next chunk it is at the bottom again.
  - `log-keeps-bottom` (`subagents`): the log follows; when the first subagent group appears (the panel shows and
    the log gets narrower) the log is still within 2 px of its bottom. The same after `setMode("off")` and back.
  - `log-keeps-place` (`all`): scroll the log to the top; create groups, click a header, switch the mode;
    `log.scrollTop` stays 0 and `v.follow` stays false.
  - `forced-scroll` (`all`): with the panel scrolled up, `send()` brings log and panel to their bottoms; after
    `reload()` both are at their bottoms.
- [ ] **Step 2:** Run the new checks. Expected: FAIL.
- [ ] **Step 3:** Implement the interface above.
- [ ] **Step 4:** Run `node scripts/ui-check/run.mjs` and `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(desktop): the activity panel follows its output; log and panel keep their bottom on size changes`.

### Task 5: Width, collapse and the narrow drawer

**Files:**
- Modify: `electron/renderer/app.js`: `loadUi`/`saveUi` (`:2675-2682`, `:2829-2833`), the view's head
  (`:347-362`), the panel head and handle (Task 3), `permission` (`:1682`)
- Modify: `electron/renderer/style.css`
- Modify: `scripts/ui-check/checks.mjs`

**Interfaces:**
- Consumes: `UiState.panelLayout`, `UiState.PANEL` (Task 2); `this.row`, `this.panel`, `this.panelHandle`,
  `showInPanel` (Task 3); the size rule (Task 4).
- Produces:
  - `ui.panelWidth` (number, default `UiState.PANEL.def`) and `ui.panelCollapsed` (boolean) in the stored UI state.
  - `SessionView.layoutPanel()`: applies `UiState.panelLayout(this.row.clientWidth, ui.panelWidth)`: sets the
    panel's width, the class `narrow` on `this.row`, and what is visible. Called on a `ResizeObserver` of
    `this.row`, after a drag, after collapse or expand (for every view), and from `place`.
  - `this.activityBtn`: button "Activity" in the view's head, hidden unless the view has a panel entry; toggles
    `ui.panelCollapsed` (wide) or `this.drawerOpen` (narrow).
  - `this.drawerOpen` (per view, not stored, starts false).
  - Panel head: the title "Activity" and a button that collapses (wide) or closes the drawer (narrow).
  - `showInPanel` clears `ui.panelCollapsed` (wide) or sets `drawerOpen` (narrow) first.
  - `permission()` sets `drawerOpen` false.
  - Esc: a `keydown` listener on `this.panel` only; in the narrow layout it closes the drawer and stops the event.

- [ ] **Step 1: Write the failing checks**:
  - `panel-width` (`all`): default width 420; dragging the handle 100 px left gives 520; dragging far left stops
    at "row width − 480"; far right stops at 280; a second view has the same width; after a relaunch with the same
    config dir the width is kept. Repeat the clamp at chat scale 0.7 and 2 (the width is in real pixels).
  - `panel-collapse` (`all`): the panel head's button hides the panel in both open views and survives a
    relaunch; "Activity" brings it back; a header click in the chat brings it back.
  - `drawer` (`all`, window 900 wide, so the view is below 760): the row has the class `narrow`, the panel is
    hidden and the log keeps its full width; a header click opens the drawer over the log without changing the
    log's width; its button closes it; resizing the window to 1280 and back writes neither `panelCollapsed` nor
    opens the drawer.
  - `drawer-esc` (`all`, narrow, a scenario variant with a long `wait` inside the turn): with the drawer open and the
    focus in the message box, Esc stops the turn and the drawer stays open; with the focus inside the drawer, Esc
    closes it and the turn is still running.
  - `drawer-permission` (`all`, narrow): with the drawer open, an arriving permission card closes it.
  - `log-keeps-bottom` gains: dragging the handle and collapsing keep a following log at its bottom.
- [ ] **Step 2:** Run the new checks. Expected: FAIL.
- [ ] **Step 3:** Implement the interface above; the drawer is `position: absolute` inside `.chat-row.narrow`.
- [ ] **Step 4:** Run `node scripts/ui-check/run.mjs` and `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(desktop): resizable, collapsible activity panel; a drawer in narrow views`.

### Task 6: Edit dimming, the remaining checks, docs

**Files:**
- Modify: `electron/renderer/app.js`: `startEdit` (`:868`), `clearEdit` (`:881`), `place`
- Modify: `electron/renderer/style.css` (next to `:217`)
- Modify: `scripts/ui-check/checks.mjs`
- Modify: `electron/README.md` (Settings and the panel), `docs/superpowers/backlog/2026-11-21-activity-groups-deferred.md`
  (the "Phase 2" section becomes what is left over)

**Interfaces:**
- Consumes: `group._entry`, `place` (Task 3).
- Produces: `SessionView.dimEntries()`: gives the class `dim` to exactly the entries whose group comes after
  `this.edit.el` in the log (none when not editing). Called from `startEdit`, `clearEdit` and `place`.

- [ ] **Step 1: Write the failing checks**:
  - `edit-dim` (`all`): start editing the second user message; the entries of the groups after it have `dim`,
    the earlier ones do not; a group created meanwhile is dimmed; cancelling removes every `dim`; a mode switch
    while editing keeps the rule.
  - `dead-view` (`all`): kill the agent process while a subagent group is ●; its entry header no longer shows ●;
    a mode switch on the dead view still satisfies `panel-placement`; resuming rebuilds the panel.
  - `stop-marks` (all modes): Stop during a sync subagent; the group's summary and the entry header show the same
    mark as in mode `off`.
  - `inactive-view` (`all`): switch the mode while another view is active; activating the first view,
    `panel-placement` holds and a following log is at its bottom.
  - `one-acts-per-turn` (all modes): after the scenario and after `reload()`, each turn has exactly one element
    with Fork and Delete among the non-user log children.
- [ ] **Step 2:** Run them. Expected: `edit-dim` FAILS; fix whatever else fails in the code that owns it.
- [ ] **Step 3:** Implement `dimEntries` and its style (the same opacity as `.log > .edit-from ~ *`).
- [ ] **Step 4:** Run `node scripts/ui-check/run.mjs` and `npm test`. Expected: all pass.
- [ ] **Step 5:** Run once with real Copilot in mode `all` and in `subagents` (ask for subagents on model "auto"):
  a sync and a background subagent, a permission ⏸, a mid-turn queued message, Fork and Delete from a group header,
  a `/context` turn followed by Fork on the next turn. Write what was run and what was seen into the backlog file;
  anything that cannot be run here goes there as a manual check, with the three phase 1 checks that were never run.
- [ ] **Step 6:** Update `electron/README.md` and the backlog file.
- [ ] **Step 7: Commit** `feat(desktop): the activity panel dims with an edit; checks and docs`.
