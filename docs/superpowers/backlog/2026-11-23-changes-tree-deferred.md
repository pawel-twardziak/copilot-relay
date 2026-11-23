# Changes tree: deferred findings

Source: the task reviews and re-reviews of `feat/changes-tree`, the probe of Task 0 and the spec's known limits.
Spec: `docs/superpowers/specs/2026-11-23-changes-tree-design.md`. Plan: `docs/superpowers/plans/2026-11-23-changes-tree.md`.
None of these blocked the merge. Line numbers are given only where they were checked on 2026-11-23, at the tip of
the branch; the fix rounds move them, so the symbol is the thing to search for.

## A. Worth doing first (analysed below)

1. **A false `No changes.` can still appear for a committed file that was edited on disk.** `loadDiff` in
   `electron/renderer/file-preview.js` answers `No changes.` without asking git when `file.uncommitted` is false and
   the key is not in `diskNewer`. The watched file (the one on show) is already handled by `diskNewer` (Task 4); the
   two gaps below remain.
   (a) `diskNewer` is cleared by `loadList` on every list answer. A list request sent before the edit and answered
   after it removes the mark that `refresh` has just set, so a click on the row says `No changes.` until the next
   list read.
   (b) `diskNewer` is only set for the file on show (the one the watcher follows). Another committed file edited on
   disk keeps the stale flag `file.uncommitted` until `⟳`.
   *Proposal:* do not answer `No changes.` from the flag at all. Ask `changesDiff` (one `git diff` for one file) when
   the row is clicked; keep the flag only to decide the `✓` mark. That removes `diskNewer` and both races. If a git
   call per click is too slow on a big repository, keep `diskNewer`, but make `loadList` remember the request's start
   time and drop only the keys that were marked before it.
2. **`Reading…` can stay for ever.** `readCommits` marks a file `loading` in `commitCache` and drops the answer when
   the list has been read again since (`my !== listSeq`). `loadList` clears `commitCache` only when its own answer
   arrives. When that list read fails (`fail(e.message)` and return), the cache keeps `loading` for a file whose
   answer was dropped, and a fold and unfold does not retry (`unfold` in `renderList` reads only when the key is not
   in `commitCache`).
   *Proposal:* in `readCommits`, when the answer is dropped for `listSeq`, delete the `loading` entry if it is still
   `loading` and redraw; or make `unfold` read again when the cached value is `loading`.
3. **A loose or repository file that became a symlink to an outside file is shown by a row click without the
   confirmation.** `loadContent` (loose rows) and `loadPaneFile` (repository rows) read with `confirmed: true` and do
   not compare the real path. `loadOpened` and `refresh` do (`readSame`, the note `LEADS_OUT`). Same class as the
   finding fixed for opened rows. The 2026-11-22 spec says loose and repository files are read without the
   confirmation, because the agent edited them or the user added their repository; a link swapped in later breaks
   the reason for that rule. Only the opened-row case has its own UI check; loose rows, links and repository files
   share the code path without one. This needs the owner's decision: the 2026-11-22 spec allows reading a
   repository's or a loose file without the confirmation, the 2026-11-23 anti-goal pulls the other way; nothing
   leaves the machine, and network targets are still refused.
   *Proposal:* route `loadContent` and `loadPaneFile` through `readSame` with the path as listed. The expected path
   is the listed one for a repository file and the recorded one for a loose file (which `repo-track.mjs` records as
   the agent wrote it, not as a real path, so compare with its real path read once at selection, or show the note
   only when the real path leaves the session folder and the repository root). Add a `changes-opened`-style check
   for a loose row and for a repository row.
4. **A failed commit read after a refresh silently drops the selected commit.** `afterList` in `file-preview.js`
   calls `select(key, keepVersion(version, commits))` where `commits` is `[]` when the read failed (`{ error }`),
   so the selection goes back to `uncommitted` with no word. The user was looking at a commit's diff and now sees
   another diff.
   *Proposal:* when the read failed, keep the selected version and show the error in the commit list; the diff read
   for that commit may still work.
5. **Opened files of a fork.** `sessions:fork` copies the context tier but not the repository records, so a fork
   starts with an empty browser and without its parent's opened files (the spec says so, "Left alone"). It is the
   same finding as item 4 of `2026-11-22-changes-browser-deferred.md`, now with a second list that a user may
   expect to be inherited. `sessions:truncate` keeps the opened files too (they were opened, so that is right).
   *Proposal:* copy the source's records, with `opened`, to the fork, as proposed there.
6. **A loose file reached through a symlink can show in both lists (the spec's known limit).** Loose files are
   recorded as the agent wrote their path (`handlePaths` in `electron/repo-track.mjs`, no real path); opened files by
   real path; `ChangesModel.openedShown` compares text (`samePath`). Example: `/tmp/out.txt` on macOS, whose real
   path is `/private/tmp/out.txt`, or any file under a symlinked home. The file is listed in `No repository` and in
   `Opened files`, and a link to it selects the `Opened files` row, not the loose one.
   *Proposal:* record the real path of a loose file in `handlePaths` too (one `realpath` per new loose path, not
   per list read), as opened files already are. Records written before that keep the agent's spelling; compare real
   paths in `openedShown` if those matter.

## B. Window and wording

7. **The note `This path now leads to a file outside the session folder.`** (`LEADS_OUT` in
   `electron/renderer/file-preview.js`) was worded during the work, for four places: a file on show that is now a
   link to an outside file (`refresh`), `Cancel` from an opened row's confirmation, the opened row itself before
   the confirmation, and an opened row selected automatically (the browser opened again, or `pick`'s fallback),
   which asks nothing. The owner may want other words, or a different note for `Cancel`.
8. **The empty state is drawn above `Opened files`.** With no repository recorded, `ChangesList.render` draws
   `No repository is recorded for this session yet.` and `+ Add repository` first and the `Opened files` block after
   it. Product question: should a session that only has opened files show the empty state at all?
9. **`Open in system app` and the three views.** Not a finding, a decision: in `File`, `Diff` and `Both` it opens
   `cur.path`, the file on show, never the diff. If `Diff` should open something else, say so (see "Not verified").

## C. Small behaviour

10. `openedShown` is recomputed on every `renderList` and on every missed `find` (up to 200 stored paths, each
    located in up to 2000 listed files). Compute it once per list answer if it ever shows in a profile.
11. `loadList` starts one `changesCommits` call for every unfolded file at once (the loop over `unfolded`), with no
    cap. Many unfolded files in a big repository mean many `git log` processes together.
    *Proposal:* a queue of 3 or 4 at a time.
12. `addOpened` in `electron/repo-records.mjs` writes the file even when the path is already first in the list
    (`touch` and `addLoose` return early in that case). One extra write per click on a link to the same file.
13. `ChangesModel.openedLabel` (`electron/renderer/changes-model.js`) slices the original path at the length of the
    lower-cased root, which is wrong for a character whose lower case has another length (`İ`) on win32; it also
    splits only on `\` on win32, though the prefix test accepts `/`. A label with the wrong cut is cosmetic.
14. `ChangesModel.openedShown` with `limit` 0 returns one path (the check runs after the push). Nothing passes 0
    today.
15. The win32 spelling rule (`\` to `/`, lower case) is written three times: `samePath`, `openedLabel`, `locate` in
    `changes-model.js`. One helper would do.
16. `ChangesModel.pick` throws on a `prevKey` whose root is neither `null` nor a string (for example
    `[1,"x"]`, reaching `abs`). Unreachable today: keys are built by `ChangesModel.key` from list data.
17. The `.fp-view` buttons (`Diff`, `File`, `Both`) have no `aria-pressed`; the active one is marked by a class only.
18. `errEl.hidden = true` is set in several places in `file-preview.js` (among them `select`, `loadDiff`, which
    `select` reaches through `setMode`, `renderFile` and `loadList`), and some of them run one after the other for
    one selection. One place per path would do.
19. A file pane that is hidden (`Diff`) and shown again repaints from the top, or from the link's line
    (`setView` → `paintFile` → `renderFile` without `keepScroll`), not from where it was scrolled.
20. The commit rows' indent (`.fp-commit`, `.fp-commits .fp-note` in `electron/renderer/style.css`) is a fixed
    padding that puts their text at or right of the file's name for a row with at most one flag. A row with two or
    three flags (`●✓`, `●⏱`, `●⏱✓`) has its name 13 or 26px further right, so its commits start left of it.
    *Proposal:* if that matters, give the commit rows the same leading boxes as the file row (empty arrow, state
    and flags spans), or set the padding from the file row's measured name offset.

Seen in the final review of the branch and judged to exist before it:

21. `loadContent` (a loose row) keeps the previous `cur` while the file is read, so a list answer landing in that
    window (`afterList` → `locateCur`) can mark another row.
    *Proposal:* set `cur = { path: filePath, line: null, result: null, note: null }` before the read, as `loadOpened`
    does.
22. A list answer landing while a link's file is read drops the link: `afterList` → `select` bumps `seq`, and
    `openTarget`'s read is then stale.
23. `⟳` loses the scroll position of the panes of a changes-list row: the list answer selects the row again
    (`afterList` → `select`), which empties both panes and reads its file and diff anew.
24. `knownSession` in `electron/main.mjs` accepts any well-formed session id, so `changes:opened` can create a record
    for a session that no longer exists (as all `changes:*` calls can).

## D. Tests and housekeeping (no behaviour impact)

- No test for `Unknown session` or a non-string path in `changes:opened` and `changes:forget-opened`
  (`electron/main.mjs`; the file cannot be loaded by `node --test`).
- No test proves that the diff is not read while its pane is hidden: `changes-split` in
  `scripts/ui-check/checks.mjs` asserts the pane's width (0), not the absence of the `changesDiff` call.
- The `changes-split` step that unfolds a file and presses `⟳` does not prove that the stale commit answer was
  dropped; the `keepVersion` fallback (a selected commit that is gone) has no end-to-end check.
- `changes-opened` in `scripts/ui-check/checks.mjs`: the assertion after the reload compares `[]` with `[]` on
  win32 (`listed` is empty there), so it asserts nothing on Windows.
- Test gaps of `changes-model.test.mjs`: `openedLabel` on win32 for a path outside the cwd, `pick` with loose and
  opened files together, `openedShown` with an explicit limit, `keepVersion` with `null` commits.
- `ChangesModel.pick` follows a file between the lists (see its doc comment); the test fixture has the moved file
  not first, as it should, but no test follows a loose file to an opened row.

## Not verified

- **Windows (the whole browser).** Nothing of the changes tree was run there: long paths in both lists (the
  `.fp-row-path` cut-at-start and `openedLabel` on win32), the divider in `Both`, a link outside the session folder
  (the confirmation and the note), and the win32 branch of the `changes-opened` check, which is skipped on other
  systems and was never run on Windows. The UI checks are Linux-only and not in CI.
- **The look of the new styles on Windows.** On Linux the final review looked at them: the names line up, the
  `.current` mark (the weaker mark of a file whose commit is selected) is visible, the `Diff`/`File`/`Both` control
  reads well. The commit rows' indent was changed after that review (now under the file's name, asserted by
  `changes-browser`). Windows stays open.
- **`Open in system app`** in each of the three views (`Diff`, `File`, `Both`): that it opens the file on show and
  not something else.
- **`/compact` and the chat's old links (Task 0).** The probe (Copilot CLI 1.0.115, `scratchpad/probe/compact-probe.mjs`)
  showed that `/compact` sent as a `session/prompt` over ACP is accepted and appends `session.compaction_start` to the
  same session's `events.jsonl`; no new session-state folder appeared, so the session id is kept and the records
  keyed by it stay valid. Open question: the compaction did not finish in 8.5 minutes (no completion event, the
  prompt never resolved, the probe was killed), so what a reload replays after a finished compaction is not known:
  are the old messages and their links still in the chat? If not, only the wording of the spec's motivation is off;
  no code depends on it. To check by hand: compact a session with real links, reload it, click an old link.
- **Side finding: `/compact` over ACP hung in a tiny session.** In the app that is a turn that never ends. Not
  caused by this branch and not investigated. The probe session `c1fcc165-6bd9-4858-a899-dbb1515e1b62` was left in
  `~/.copilot/session-state` and can be deleted.
