# Settings and Schedules as full-window pages: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settings and Schedules open as modal pages over the whole app window. Settings lays its sections out in
3, 2 or 1 columns. Schedules gets a Close button.

**Architecture:** Both pages are `<dialog>` elements opened with `showModal()` and stretched over the viewport by a
shared `page-dialog` class. Settings keeps its form, ids and `returnValue` save path. Only the markup is regrouped
into section cards inside a CSS grid with media-query breakpoints. Schedules moves from `#main` into its own dialog.
`schedules.js` keeps rendering into it.

**Tech Stack:** Electron 45 renderer (plain JS, no framework), CSS, UI checks in `scripts/ui-check` (CDP driver,
xvfb), `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-26-settings-page-design.md`

## Global Constraints

- Every existing settings field, id and hint text moves unchanged. Nothing about what is saved changes.
- Settings header button order: `Cancel`, then `Save`. Enter in a field still submits through Cancel.
- Columns by viewport width: ≥ 1280 px → 3, 800–1279 px → 2, < 800 px → 1. Prompts spans 2 columns in the
  3- and 2-column layouts.
- Section order: Copilot, Sessions, Cache keeper, Prompts (wide), Relay, Files.
- Settings grid `max-width` about 1600 px, centered. The Schedules content keeps `max-width: 920px`, centered.
- Escape on either page ends in the same state as its Cancel / Close button.
- Work on branch `feat/settings-page` in a worktree. Release tag `v0.34.0` goes on the merge commit on `main`.

## Review Focus

- A window narrower than a card's content (long CLI hint, long paths in Files, broker steps). Expected: text wraps
  and no horizontal page scroll appears. Task 1 checks `scrollWidth <= clientWidth` of the page body at 700 px.
- Escape after an earlier Save. Expected: it discards, it does not save again. Task 1 check.
- A notification click (`api.onJobOpenRun` → `Schedules.openRun`) while Settings is open. Expected: Schedules
  opens on top and works, and closing it leaves Settings as it was. Task 2 check (`Schedules.openRun` called with
  Settings open).
- Escape in the Schedules form with typed text. Expected: the page closes and the text is there on reopening.
  Task 2 check.
- `confirm()` called from inside the Settings modal (Delete pasted images, Update and restart broker). Expected: it
  still shows and answers. The existing `broker-restart` UI check covers this and must stay green.

---

### Task 1: Settings page

**Files:**
- Modify: `electron/renderer/index.html:37-122` (the `#settings` dialog)
- Modify: `electron/renderer/style.css` (dialog rules near 250-260 and 355-361; new `page-dialog` and `set-*` rules)
- Modify: `electron/renderer/app.js:3970-3998` (`openSettings`)
- Modify: `scripts/ui-check/driver.mjs:303` (add `pressEscape`)
- Test: `scripts/ui-check/checks.mjs` (new check `settings-page`)

**Interfaces:**
- Produces: CSS class `page-dialog` (full-viewport modal frame), `.page-head` (sticky header bar: `h2` + actions),
  `.page-body` (the scrolling area). Task 2 uses all three.
- Produces: driver method `pressEscape()`: a real Escape key press through CDP `Input.dispatchKeyEvent`, the same
  shape as `pressEnter` (`key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27`).
- Produces: markup `#settings.page-dialog > form > .page-head + .page-body > .set-grid > section.set-card` (×6,
  Prompts also `.wide`), each card starting with an `h3`.

- [ ] **Step 0: Set up the branch**

  Use superpowers:using-git-worktrees for `feat/settings-page` from `main`. Commit the spec and this plan there first
  (`docs: settings page design and plan`).

- [ ] **Step 1: Write the failing UI check `settings-page`** (`modes: ["off"]`)

  ```js
  // the page covers the window
  await app.resize(1400, 900);
  await app.ev(`document.querySelector("#btn-settings").click()`);
  await app.check(`document.querySelector("#settings").open`, "the Settings page");
  const r = await app.ev(`(() => { const b = document.querySelector("#settings").getBoundingClientRect(); return [b.left, b.top, b.width, b.height, innerWidth, innerHeight]; })()`);
  assert.deepStrictEqual(r.slice(0, 4), [0, 0, r[4], r[5]], "covers the window");
  // sections, in order
  assert.deepStrictEqual(await app.ev(`[...document.querySelectorAll("#settings .set-card > h3")].map((e) => e.textContent)`),
    ["Copilot", "Sessions", "Cache keeper", "Prompts", "Relay", "Files"]);
  // columns and the wide Prompts card per width
  const cols = `getComputedStyle(document.querySelector("#settings .set-grid")).gridTemplateColumns.split(" ").length`;
  const ratio = `(() => { const c = [...document.querySelectorAll("#settings .set-card")]; return c.find((e) => e.classList.contains("wide")).offsetWidth / c[0].offsetWidth; })()`;
  for (const [w, n, wide] of [[1400, 3, true], [1000, 2, true], [700, 1, false]]) {
    await app.resize(w, 900);
    await app.check(`${cols} === ${n}`, `${n} column(s) at ${w} px`);
    assert.equal((await app.ev(ratio)) > 1.5, wide, `Prompts wide at ${w} px`);
  }
  // no horizontal scroll at 700 px
  assert.ok(await app.ev(`(() => { const b = document.querySelector("#settings .page-body"); return b.scrollWidth <= b.clientWidth; })()`), "no horizontal scroll");
  // Save, reopen, change, Escape: not saved
  await app.ev(`document.querySelector("#set-save").click()`);
  await app.check(`!document.querySelector("#settings").open`, "Settings to close");
  const before = await app.ev(`api.getSettings().then((s) => s.queueMidTurn)`);
  await app.ev(`document.querySelector("#btn-settings").click()`);
  await app.check(`document.querySelector("#settings").open`, "the Settings page");
  await app.ev(`(() => { const q = document.querySelector("#set-queue"); q.focus(); q.checked = !q.checked; })()`);
  await app.pressEscape();
  await app.check(`!document.querySelector("#settings").open`, "Escape to close Settings");
  assert.equal(await app.ev(`api.getSettings().then((s) => s.queueMidTurn)`), before, "Escape did not save");
  ```

- [ ] **Step 2: Run it, and see it fail**

  Run: `node scripts/ui-check/run.mjs settings-page`
  Expected: FAIL at "covers the window" (the dialog is 520 px wide).

- [ ] **Step 3: Restructure the markup** in `index.html`

  `<dialog id="settings" class="page-dialog">` > `<form method="dialog">` > `.page-head` (`<h2>Settings</h2>`, then
  `.dialog-actions` with the existing Cancel and `#set-save` buttons, moved from the bottom) > `.page-body` >
  `.set-grid` with six `<section class="set-card">`, each starting with its `<h3>`, holding the existing elements as
  listed in the spec's section list. The current `<h3>Prompts</h3>`, `<h3>Relay broker</h3>`, `<h3>Files</h3>` are
  replaced by the card headings.

- [ ] **Step 4: Add the CSS** in `style.css`

  - `dialog.page-dialog`: `position: fixed; inset: 0; width: 100vw; height: 100vh; max-width: none; max-height: none;
    margin: 0; padding: 0; border: 0; border-radius: 0`. Its `form` is a flex column of full height.
  - `.page-head`: sticky top bar (`display: flex; align-items: center; gap: 8px`, `h2` with `flex: 1; margin: 0`,
    bottom border, panel background).
  - `.page-body`: `flex: 1; overflow-y: auto; min-height: 0`.
  - `.set-grid`: `display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); grid-auto-flow: dense; gap;
    max-width: 1600px; margin: 0 auto; align-items: start`.
  - `@media (max-width: 1279px)`: 2 columns. `@media (max-width: 799px)`: 1 column.
  - `.set-card.wide { grid-column: span 2 }`, reset to `span 1` inside the 1-column media query.
  - `.set-card`: panel-2 background, border, radius 8px, padding, flex column with a gap. `h3` in a card has no top
    margin. Long text (`.hint`, `code.path`) uses `overflow-wrap: anywhere`.
  - The general `dialog { width: 520px }` stays for the other dialogs. `dialog.page-dialog` overrides it.

- [ ] **Step 5: Reset the return value** in `openSettings()` (`app.js`)

  Set `$("#settings").returnValue = ""` right before `showModal()`, with a comment: "Escape keeps the previous value,
  which may be the last Save's".

- [ ] **Step 6: Add `pressEscape()`** to the driver, next to `pressEnter` (see Interfaces).

- [ ] **Step 7: Run the new check and the checks that use Settings**

  Run: `node scripts/ui-check/run.mjs settings-page save-keeps-mode broker-restart`
  Also run every check that calls `setMode` (they open Settings through `driver.mjs:359`), i.e. the full run:
  `node scripts/ui-check/run.mjs`
  Expected: all PASS.

- [ ] **Step 8: Commit**

  `git add electron/renderer/index.html electron/renderer/style.css electron/renderer/app.js scripts/ui-check/driver.mjs scripts/ui-check/checks.mjs`
  `git commit -m "feat(settings): full-window page with sections in 3/2/1 columns"`

### Task 2: Schedules page

**Files:**
- Modify: `electron/renderer/index.html:33` (`<section id="schedules" hidden>` moves out of `#main`)
- Modify: `electron/renderer/schedules.js:112-132` (`setVisible`, `show`, `hide`) and `:155` (`page`)
- Modify: `electron/renderer/style.css:541-547` (schedules rules)
- Test: `scripts/ui-check/checks.mjs` (new check `schedules-page`)

**Interfaces:**
- Consumes: `page-dialog`, `.page-head`, `.page-body` (Task 1). Driver `pressEscape()` (Task 1).
- Produces: `<dialog id="schedules" class="page-dialog">` after `#settings` in `index.html`. The page's Close button
  has class `sch-close` and the text `✕ Close`.

- [ ] **Step 1: Write the failing UI check `schedules-page`** (`modes: ["off"]`)

  ```js
  await app.ev(`document.querySelector("#btn-schedules").click()`);
  await app.check(`document.querySelector("#schedules").open`, "the Schedules page");
  const r = await app.ev(`(() => { const b = document.querySelector("#schedules").getBoundingClientRect(); return [b.left, b.top, b.width, b.height, innerWidth, innerHeight]; })()`);
  assert.deepStrictEqual(r.slice(0, 4), [0, 0, r[4], r[5]], "covers the window");
  // the sidebar is under the modal: the element at its middle is not part of it
  assert.equal(await app.ev(`(() => { const s = document.querySelector("#sidebar").getBoundingClientRect(); return document.querySelector("#sidebar").contains(document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2)); })()`), false, "sidebar covered");
  // ✕ Close
  await app.check(`!!document.querySelector("#schedules .sch-close")`, "the Close button");
  await app.ev(`document.querySelector("#schedules .sch-close").click()`);
  await app.check(`!document.querySelector("#schedules").open`, "Close to close Schedules");
  // a typed form survives Escape
  await app.ev(`document.querySelector("#btn-schedules").click()`);
  await app.check(`document.querySelector("#schedules").open`, "the Schedules page");
  // "+ New job" (schedules.js:201), then type into the form's first input (Name, schedules.js:379)
  await app.ev(`[...document.querySelectorAll("#schedules button")].find((b) => b.textContent === "+ New job").click()`);
  await app.check(`!!document.querySelector("#schedules .sch-form input")`, "the job form");
  await app.ev(`(() => { const i = document.querySelector("#schedules .sch-form input"); i.focus(); i.value = "Typed"; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await app.pressEscape();
  await app.check(`!document.querySelector("#schedules").open`, "Escape to close Schedules");
  await app.ev(`document.querySelector("#btn-schedules").click()`);
  await app.check(`document.querySelector("#schedules").open`, "the Schedules page again");
  assert.equal(await app.ev(`document.querySelector("#schedules .sch-form input").value`), "Typed", "the typed name survives");
  // a notification click with Settings open: Schedules on top, Settings untouched under it
  await app.ev(`document.querySelector("#schedules .sch-close").click()`);
  await app.ev(`document.querySelector("#btn-settings").click()`);
  await app.check(`document.querySelector("#settings").open`, "the Settings page");
  await app.ev(`Schedules.openRun("nope", "nope")`);
  await app.check(`document.querySelector("#schedules").open`, "Schedules over Settings");
  await app.pressEscape();
  await app.check(`!document.querySelector("#schedules").open && document.querySelector("#settings").open`, "Escape closes only Schedules");
  ```

- [ ] **Step 2: Run it, and see it fail**

  Run: `node scripts/ui-check/run.mjs schedules-page`
  Expected: FAIL at "the Schedules page" (`open` is undefined on a section).

- [ ] **Step 3: Move the element** in `index.html`: delete the `<section id="schedules">` line from `#main` and add
  `<dialog id="schedules" class="page-dialog"></dialog>` after the `#settings` dialog.

- [ ] **Step 4: Rework visibility** in `schedules.js`

  - `setVisible(on)`: `on` → `if (!root().open) root().showModal()`, else `if (root().open) root().close()`. Keep
    the `st.visible` / timer bookkeeping. Drop the `body.schedules-open` and `#btn-schedules.active` toggles.
  - At load (`init`), register `root().addEventListener("close", …)`. On a close it did not start (Escape), run the
    same bookkeeping as `setVisible(false)`: `st.visible = false`, clear the timer.
  - `page(title, actions, ...body)`: renders `.page-head` (the `h2`, the actions, then a `button.sch-close`
    `✕ Close` with `onclick: hide`) and `.page-body` > `.sch-page` (the body). The error fallback in `render()` goes
    through `page()` too, so it gets the button.

- [ ] **Step 5: Update the CSS**

  Delete `body.schedules-open …` (both rules) and `#btn-schedules.active`. Replace `#schedules { flex: 1; … }` with
  nothing: `page-dialog` covers it. `.sch-page`: `max-width: 920px; margin: 0 auto`. `.sch-head` is no longer used
  by `page()`, so delete its rules (check with grep first).

- [ ] **Step 6: Run the check and the unit tests**

  Run: `node scripts/ui-check/run.mjs schedules-page && npm test`
  Expected: PASS. `electron/test/schedules.test.mjs` tests pure helpers and must stay green.

- [ ] **Step 7: Commit**

  `git commit -m "feat(schedules): full-window page with a Close button"`

### Task 3: Whole-branch verification

- [ ] **Step 1:** `npm --prefix electron run copy-relay`, then `npm test` and `node scripts/ui-check/run.mjs`.
  Expected: all pass. Record the counts.
- [ ] **Step 2:** Screenshot Settings at 1400, 1000 and 700 px and Schedules at 1400 px (driver `resize` + CDP
  `Page.captureScreenshot`, into the scratchpad). Look at them for overlap, clipping and horizontal scroll.
- [ ] **Step 3:** Run the whole-branch review (Fable 5.2, `effort: medium`). Write the unfixed findings to
  `docs/superpowers/backlog/2026-11-26-settings-page-deferred.md`. Then finish with
  superpowers:finishing-a-development-branch: `git merge --no-ff`, tag `v0.34.0` on the merge commit.
