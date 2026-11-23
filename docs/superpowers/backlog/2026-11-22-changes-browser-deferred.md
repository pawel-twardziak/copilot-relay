# Changes browser: deferred findings

Source: the nine task reviews, their re-reviews and the final whole-branch review of `feat/changes-browser`.
Spec: `docs/superpowers/specs/2026-11-22-changes-browser-design.md`. Plan:
`docs/superpowers/plans/2026-11-22-changes-browser.md`. None of these blocked the merge. Line numbers are left out
on purpose: the fix rounds moved them; the symbol or test name is given instead.

## A. Worth doing first (analysed below)

1. **An older git still fetches on read in a partial clone.** `createGit` (`electron/repo-git.mjs`) sets
   `GIT_NO_LAZY_FETCH=1`, which a git that does not know the variable ignores. There `diffCommit`, and any call that
   needs a missing object, contacts the promisor remote, writes a pack into `.git/objects/pack` and runs the program
   named by `remote.origin.uploadpack`: all three are anti-goals of the spec. The test "partial clone" probes the
   installed git and skips itself there, so nothing fails.
   *Proposal:* add an empty `GIT_ALLOW_PROTOCOL` to the environment. Probed during review without
   `GIT_NO_LAZY_FETCH`: `fatal: transport 'file' not allowed`, no new pack, the script did not run. A read never
   needs a transport.
2. **In a blobless clone the commits of a whole repository can be unreadable.** `commitFiles` runs
   `log --name-status`, whose rename detection needs blobs; when a commit in the range deleted one file and added a
   similar one and those blobs are not local, git now dies ("could not fetch … from promisor remote"). `list` in
   `electron/repo-changes.mjs` then shows the uncommitted files and the note "The commits since the start point
   could not be read", so no commit is reachable for that repository. It needs fetched commits with missing blobs
   (after a pull or a branch switch); the agent's own commits have theirs.
   *Proposal:* on that failure retry the same `log` with `--no-renames` (verified: no fetch, the list is returned;
   a rename then shows as a deleted and an added file).
3. **A worktree whose git folder is on a network location passes the path rule.** `passesAutomaticCheck`
   (`electron/file-access.mjs`) checks the path and every link on it, but not what git follows: a local folder
   whose `.git` is a file `gitdir: <network>/…` (or a symlinked `.git`) is accepted and the tracker's git then reads
   the network location at the agent's tool call. Reproduced with a worktree. The agent's own git calls in that
   folder reach the same place, so the added exposure is small.
   *Proposal:* in the tracker, before `git.where`, read `<nearest folder>/.git` when it is a file and apply the same
   rule to its `gitdir` target; refuse a `.git` that is a link out of the allowed locations.
4. **Fork and truncate.** `sessions:fork` copies the context tier but not the repository records, so a fork starts
   with an empty browser. `sessions:truncate` keeps the `touched` marks of edits that were cut. The spec is silent
   on both.
   *Proposal:* copy the source's records to the fork (same start points, same marks); leave truncate as it is (the
   files are still changed on disk).
5. **With the file pane hidden, every change on disk reads the whole file again.** `refresh` in
   `electron/renderer/file-preview.js` re-reads up to 20 MB per change, and an untracked file twice (`showAdded`
   and `refresh`), though nothing on screen uses it. The first read per selection is needed, because the main
   process only watches a path it has read.
   *Proposal:* with the pane hidden, mark `cur` as out of date on a change and read when `File` or `Both` is chosen;
   reuse the text `showAdded` already has. Since the changes tree the diff is no longer read while its pane is
   hidden; the file read is the part that remains.
6. **Two races between a link and the version strip.** (The first race is moot since the changes tree,
   2026-11-23: the strip is gone; the second still applies.) Since `loadDiff` got its own counter (`diffSeq`), a strip
   click no longer cancels a link read in flight: the link's answer still switches to `file` mode and the diff is
   written into the hidden pane. And `openTarget` bumps `seq` before it knows it will take over, so a link to an
   image or a broken link clicked while a diff loads leaves the diff pane empty. Both windows are milliseconds
   wide; the Markdown pane in `change` mode makes them reachable.
   *Proposal:* `openTarget` checks a counter that `loadDiff` also bumps, and bumps `seq` only when it takes over.
7. **The list cannot be used from the keyboard.** Rows and group headers are `div`s with `onclick`, outside the
   Tab cycle. The old list was the same, but this list is now the main navigation.
   *Proposal:* rows as buttons (or `tabindex="0"` with Enter/Space and arrow keys), included in the Tab cycle of
   the overlay's keydown handler.
8. **The UI checks' app is not isolated from the caller's git environment.** `scripts/ui-check/driver.mjs` passes
   the caller's environment to the launched app, so its git calls see the user's global config and any exported
   `GIT_DIR`. Run from a git hook, the app would read this working repository (read-only) and the checks would
   fail. The checks' own git calls are isolated (`gitIn`).
   *Proposal:* add the `isolatedEnv()` variables of `electron/test/git-helper.mjs` to the launch environment.

## B. Window, wording

9. `add` in `repo-changes.mjs` answers "Network folders are not read." for a picked folder that no longer exists,
   and rejects with a raw `spawn ENOTDIR` when it is given a file path (not reachable through the folder dialog).
10. A change of line endings only (CRLF ↔ LF) renders as removed and added lines that look identical: `DiffView.parse`
    strips the `\r` it takes for the diff's own line end.
11. A copied hunk header and note line start with the blank of the sign column (`" @@ -1,6 +1,6 @@"`).
12. The header path flips between the path as listed and the real path through a symlink: `renderFile` writes the
    read's real path, `select` and `loadDiff` write `ChangesModel.abs(root, rel)`.
13. The diff's scroll position is read when the refresh is requested, not when it is rendered: scrolling while git
    runs jumps back.
14. `.fp-dir` uses `unicode-bidi: bidi-override` for the cut-at-start trick, which shows a folder name in a
    right-to-left script reversed (`isolate` may do; not tried).
15. After `⟳` the version strip goes back to its first entry; the chosen version is not kept. Moot since the changes tree (2026-11-23).
16. `ChangesList.render` rebuilds every group and row on each selection (up to 2000 rows per repository) and drops
    hover state; toggling `active` on two rows would do.
17. A deleted listed file named like link text (`a%20b.txt`, `x.md:12`) can show another existing file
    (`a b.txt`, `x.md`) in the file pane instead of "This file is deleted.": `files:read` resolves its target as
    link text.

17a. In `file` mode a file that turns into a non-text file gets no note (`refresh` in `file-preview.js`): a blank
    pane after a strip entry + `Show file`, and after delete → restore → binary a stale "This file is deleted."
    Set and clear `cur.note` on every read, in both modes. The strip case is moot since the changes tree
    (2026-11-23); the delete → restore → binary case was not looked at again.
17b. With `Show file` already on, a strip entry chosen from `file` mode does not repaint the pane (`loadDiff` calls
    `setMode("change")` without `paintFile`): it keeps the raw read error ("File not found…") instead of "This
    file is deleted." until toggled. Moot since the changes tree (2026-11-23).
17c. A second click on `✕` before the list re-renders now shows "This repository is not listed for this session."
    (the first remove already took it); the line stays when the list ends empty or the browser is in `file` mode.
    Reload the list on a failed remove too, or ignore `✕` while a remove is pending.

## C. Behaviour, small

17d. A removed session-folder repository is not remembered across a reopen: `tracker.closed` on the connection's
    exit and an app restart clear the session-folder flag, so it returns at the first tool call of any kind in the
    reopened session (the spec's "once per opened session"), not only at the next edit there.

18. Tracker (`electron/repo-track.mjs`): one path of a call failing to place drops the whole call (retried when the
    path is named again); the omit set for `dirtyAtStart` is built from the placed paths only (differs from "this
    call's paths" after a remove or an `allow` refusal); a session folder whose lookup keeps failing is looked up
    again at every `tool_call` (up to 5 s each, in that session's chain); the `chains` map is never pruned.
19. `sessions:delete`: `records.forget` can be undone by a tracker lookup still in flight, leaving an entry for a
    dead session id in `session-repos.json` (never read again).
20. Record store (`electron/repo-records.mjs`): a write failure that persists warns once per mutation (one line per
    touched file); `load` accepts a record with `root: ""` that `addRepo` refuses; `addLoose` compares exact
    strings (case on Windows); sessions are keys of a plain object (an id like `constructor` would throw; real ids
    pass `isSessionId`); `save()` is the fourth temp-file-and-rename writer in `electron/`.
21. `checkRel` accepts `"."` and `"dir/"` (a whole-repository diff and commit list; it stays inside the root) and
    `"C:x"` (drive-relative; not run on Windows).
22. `ChangesModel.locate` on Windows returns the first listed path that matches ignoring case, also when another
    listed path matches exactly.
23. Git layer: `headAt` turns every failure into `null`; `diff` for a commit runs `fileCommits` again only to
    check the sha; `parseCommits` drops a record whose subject or author holds `\x1f`; a copy is `M` in
    `parseStatus` and `A` in `parseNameStatus`; `runProgram` with `keep: "end"` and `outputLimit: 0` returns
    everything (`slice(-0)`).
24. Known limits of reading with git: clean and process filters (git-lfs) still run on `status` and `diff` (the
    spec's accepted limit); `--diff-merges=first-parent` needs a git from 2021 or newer; with a split index a read
    updates the mtime of `.git/sharedindex.*` (git's own freshening, no lock, no content change).
25. Comments: the one above `dragSplit` says `dragPanel` uses pointer capture (it does not); the empty `catch`
    around `setPointerCapture` has no reason (a synthetic event has no active pointer).

## D. Tests and housekeeping (no behaviour impact)

- `repo-git-parse.test.mjs` / `run-program.test.mjs`: no assertion of `truncated: true` in `"end"` mode; the
  `"start"` test writes one chunk; no case for a copy (`C<n>`) leaving its source unmarked, nor for `Y = C`.
- `repo-records.test.mjs`: no test of the `addRepo`-side normalisation; the write-failure injection (a directory at
  `<file>.tmp`) was not run on Windows; the first version of the store was written before its tests were seen
  failing.
- `repo-track.test.mjs`: no test for "one of several paths fails: nothing recorded, the retry records all", for a
  `permission` of a non-edit kind, another `sessionUpdate`, `git.status` / `git.head` rejecting, `nearestDir`
  returning `null`.
- `repo-git.test.mjs`: the submodule, partial-clone and no-programs tests are skipped on Windows; the `where` test
  compares with `realpathSync.native`, and the no-writes test lists `.git` by size and mtime: both unverified on
  Windows.
- `diff-view.test.mjs`: the long-render test would pass with the spread back (the clip cuts first) and does not
  check that the note is the last child.
- `main.mjs`: `allowClicked` and `knownSession` have no test (the file cannot be loaded by `node --test`).
- UI checks (`scripts/ui-check/checks.mjs`): none for the `No repository` group, the empty state with
  `+ Add repository`, `error` / `note` / `truncated` rows, `✕`, choosing a strip entry in `file` mode (moot since the changes tree, 2026-11-23), a
  stale-answer path, the preference read at start (`reload()` does not reload the page), following the disk with
  the pane hidden, either scroll position. `changes-records`' "removed repository after another replay" relies on
  `reload()` waiting 300 ms. `ChangesList.render` takes `h` as an argument and could cover the list rows with the
  stub `h` of `diff-view.test.mjs` under `node --test`.
- `changes-split`'s last step clicks `.fp-version` without waiting for the strip that `openTarget` has just emptied
  (the earlier use of that flow waits): on a slow machine a `null.click()` failure, never a false pass. Moot since the changes tree (2026-11-23).
- Final fix wave: the note set in `loadContent`'s `catch` (a loose or linked file that cannot be read) is not
  reached by any check; the tab-stop fix (`.dv-text { display: inline-block; }`) has no assertion of its own.
- `file-preview.js` is 868 lines (2026-11-23); the next addition should move the split (divider drag, preferences) into its own
  script.

## Not verified

- **Windows and macOS.** Nothing in the window was run there: git's path output, case-insensitive roots,
  `navigator.platform`, backslash paths in `ChangesModel.abs` / `locate`, the folder dialog. The UI checks are
  Linux-only and not in CI.
- **Edit tools other than `apply_patch`.** The trigger reads only `kind`, `locations` and `diff` items, which are
  part of ACP, but the capture of 2026-11-22 (Copilot CLI 1.0.115) saw one tool. A patch that changes several
  files and the kinds `delete` and `move` were not seen either.
- **By hand, with real Copilot:** a session whose folder holds two repositories (an edit in each, a commit from the
  agent's shell); `+` for a third repository and `✕`; one real mouse drag of the divider, also out of the window
  and back (the check drives it with synthetic pointer events).
