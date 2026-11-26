# Settings and Schedules pages: deferred findings

**Sources:** the final whole-branch review (Fable 5.2, medium) of `feat/settings-page`. Execution was inline (no
per-task reviews).

Spec: `docs/superpowers/specs/2026-11-26-settings-page-design.md`. Plan: `docs/superpowers/plans/2026-11-26-settings-page.md`.

None of these blocked the merge. Line numbers were taken at the review and may drift.

**Fixed on the branch, so not listed below:** a notification click (`openJobRun`, `electron/renderer/app.js`) left the
image viewer open, invisible under the modal Schedules page, with its keys (`+ = - _ 0 f F`, Tab, Escape) still
captured; it now closes the viewer (check `schedules-page`).

## A. Worth doing first

1. **A session waiting for an answer is invisible while Schedules (or Settings) is open.**
   - Where: the design (both pages cover the whole window, the owner's choice); the sidebar "!" marker
     (`needsAttention`, `app.js` ~3356) is under the modal.
   - `notifyIfUnfocused` (`electron/main.mjs` ~2007) sends nothing while the window is focused, and a non-delegated
     permission request has no OS notification. A session blocked on a permission, delegation, reopen or link card
     waits unnoticed while the user stays on a page, e.g. watching a job run.
   - Proposal: a "N sessions waiting" marker in `.page-head` of both pages (click: close the page and activate the
     first waiting session).
2. **Enter in any single-line Settings field closes the page and discards every change** (`index.html`, the
   `#settings` form). Enter submits through the first button, Cancel (kept "as today" by the spec). The page now holds
   every setting and Save is far from the field. Proposal: Enter does nothing in Settings' inputs (a `keydown` handler
   on the form, as the template-name input already has), or Enter saves.

## B. Window and wording

3. **Settings opens with focus on Cancel** (`index.html` ~43). The header now comes before the fields, so `showModal()`
   focuses Cancel instead of `#set-command`: Space/Enter right after opening closes the page, typing does not land in
   the first field. Proposal: `autofocus` on `#set-command`.
4. **Reopening Schedules leaves focus on `<body>`** (`schedules.js`, `setVisible` ~113 and `render()` ~146).
   `showModal()` focuses a control of the previous render, then the async `render()` replaces it. The 30 s list refresh
   and `onChanged` drop focus the same way. Proposal: after `replaceChildren`, focus the dialog (or the form's first
   field in form mode) when focus was inside it or on `body`.
5. **Markdown headings in run details change look** (`style.css`: `dialog h2` ~253, `dialog h3` ~374). These rules now
   match headings inside `#schedules`, including script-authored Markdown in `.sch-details` (`##` shrinks to 16 px,
   no top margin) and the "History" `h3`. Proposal: scope them to `dialog:not(.page-dialog)`.
6. **The comment on the `returnValue` reset is wrong** (`app.js` `openSettings`, ~3999). It says Escape keeps the
   previous value; in Electron 45 Escape sets `returnValue` to `""` (probed). The line is a guard only. Reword it.

## C. Small behaviour

7. **`hide()` then `show()`/`openRun()` in one task leaves the page closed** (`schedules.js` `init`, the `close`
   listener ~426). The queued `close` event of the first close runs `hide()` after the reopen. No caller does this
   today; a `jobs:openRun` IPC landing between an Escape/✕ and its `close` event would. Proposal: ignore the event
   while `root().open`.
8. **Escape over two pages may close both** (Chromium close-watcher grouping). When Schedules opens from a notification
   while Settings is open and there was no user activation since Settings opened, one Escape closes both and discards
   Settings' edits. Seen with a synthetic `.click()` on ⚙; with a real click (the check uses `driver.click`) each page
   gets its own Escape. Not checked with a real keyboard.
9. **Ctrl+N and Left Ctrl +/- still act under an open page** (`app.js` ~4322-4338): a new session can start under
   Settings. Predates the branch (the old Settings dialog was modal too).
10. **The inline "Delete job?" state survives an Escape and reopen** (`st.confirm` is not cleared by `show()`).
    Predates the branch.

## D. Tests and housekeeping

11. **Test gaps** (`scripts/ui-check/checks.mjs`, `settings-page`, `schedules-page`): no check for `hide()`+`show()`
    (7), focus after open (3, 4), or long content at narrow width (the "no horizontal scroll at 700 px" assertion sees
    fixture content only; the reviewer probed 400-character strings at 500-1400 px with no overflow).
12. **Not verified:** a native `confirm()` from inside the Settings page (Delete pasted images, Update and restart
    broker; the checks stub it), the native folder picker from either page, native `<select>`/time-picker popups inside
    the modal, Windows, macOS and the corp PC (only Linux/xvfb ran).
