# Settings and Schedules as full-window pages — design

## Intent

The Settings dialog is a 520 px column that has outgrown itself (command, relay, queue, cache keeper, activity panel,
context, prompts, broker, files). It becomes a page over the whole app window, grouped into sections laid out in
3, 2 or 1 columns depending on the window width. Schedules gets the same full-window treatment, with a Close button.

## Goals / non-goals

- Goals: Settings over the whole window (sidebar included), sections in a responsive grid; Schedules over the whole
  window with a Close button; nothing about what is saved or how changes.
- Non-goals: autosave, new settings, a new Schedules layout (its list and form stay as they are).
- Anti-goals: a save path that differs from today's (Cancel / Escape discard, Save saves), the sidebar or a chat
  reachable under an open page.

## Approaches

- **A (picked): a modal `<dialog>` stretched over the viewport, for both pages.** The top layer, Escape, focus kept
  inside and an inert background come with `showModal()`. Settings keeps `<dialog id="settings">`, its form and its
  `returnValue` save path, so the UI checks barely change.
- B: a custom `position: fixed` overlay. Escape, focus trapping and blocking the background would be hand-written,
  the settings save path rewritten. More control, no gain here.

## Design

### Shared page frame

- A class `page-dialog` on both dialogs: `position: fixed; inset: 0; width: 100vw; height: 100vh; max-width: none;
  max-height: none; margin: 0; border: 0; border-radius: 0; padding: 0`, flex column.
- A sticky header bar: the title on the left, the actions on the right. The body below scrolls (`overflow-y: auto`).

### Settings

- Header: "Settings", then `Cancel` and `Save` (in that order, so Enter in a field still submits through Cancel as
  today; the template-name Enter handler stays).
- `openSettings()` sets `returnValue = ""` before `showModal()` (today an Escape after an earlier Save keeps the
  value "save" and saves again).
- Body: a grid of section cards (`.set-card`: panel background, border, radius, `h3` header), centered, `max-width`
  about 1600 px.
  - Columns by viewport width: ≥ 1280 px → 3, 800–1279 px → 2, < 800 px → 1 (media queries;
    `repeat(n, minmax(0, 1fr))`, `grid-auto-flow: dense`).
  - Prompts spans 2 columns in the 3- and 2-column layouts.
- Sections, in this order (each existing field, id and hint moves unchanged):
  1. **Copilot**: CLI command + its hint; default context window + its hint.
  2. **Sessions**: deliver queued messages during a turn; tool and subagent details.
  3. **Cache keeper**: the toggle, keep-alive prompts, minimum context, the hint.
  4. **Prompts** (wide): default part, working with the parent, templates, the note.
  5. **Relay**: connect sessions to copilot-relay + hint; broker repository folder, Update and restart, steps,
     summary.
  6. **Files**: pasted images (path, info, Open folder, Delete) and the settings file path.

### Schedules

- `#schedules` moves out of `#main` into `<dialog id="schedules" class="page-dialog">`. `schedules.js` renders into
  it as today.
- `setVisible(on)` calls `showModal()` / `close()`; the dialog's `close` event (Escape included) runs the same
  bookkeeping (`st.visible`, the refresh timer), so Escape and the button end in the same state.
- The page header (`page()` in `schedules.js`) gets a `✕ Close` button that calls `hide()`. An open form keeps what
  was typed, as today.
- The list and form keep their `max-width: 920px`, centered in the window.
- Removed: `body.schedules-open` rules and `#btn-schedules.active` (the sidebar is under the modal now). `activate()`
  still calls `Schedules.hide()`, harmless.

### Tests

- The existing UI checks that open and save Settings keep working (same ids); adjusted where they assume the old
  layout.
- New UI checks: Settings at 1400 / 1000 / 700 px wide has 3 / 2 / 1 columns (computed `grid-template-columns`),
  covers the window, and Escape after an earlier Save does not save; Schedules opens over the sidebar, closes with
  ✕ Close and with Escape, and a typed form survives a close.

## Left to the builder

- Exact card spacing, header height, and the breakpoint pixel values within ±50 px.
- Release as v0.34.0 (minor).
