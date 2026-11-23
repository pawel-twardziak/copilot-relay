# Changes browser: file tree with commits, three view modes, opened files

Date: 2026-11-23. Builds on `2026-11-22-changes-browser-design.md` (shipped as v0.19.0); what that document says
stays true unless this one changes it.

## Intent

The owner wants the changes browser organised around the file, not around a strip of versions:

- the left panel is a list of files, each of which unfolds to its commits;
- the right side has three explicit modes: the diff, the file, or both;
- files opened from links in the chat that the session did not change are listed again, in a list of their own.
  v0.19.0 removed the list of opened files, so such a file can only be reached again by finding its link in the chat.

Why the second list matters more than convenience: after Copilot compacts a session, the messages that carried the
links may no longer be in the chat. The list is then the only way back to those files.

## Goals

- A file row shows its current (uncommitted) changes on a click, or `No changes.` when it has none.
- An arrow in front of a file that has commits since the start point unfolds them under the file; a click on a
  commit shows that commit's diff.
- One control with three modes, `Diff`, `File`, `Both`, replaces `Show file` and the version strip.
- A second list, `Opened files`, below the changes: files opened from chat links that are not in the changes list.
  It survives an app restart and a compaction, and goes away with the session.

## Non-goals

- Listing files the session only read (tool calls of kind `read`): only a click on a link adds to the list.
- Bringing back lists from before v0.19.0 (their localStorage key is already removed).
- Copying a session's records to its fork. Unchanged from today: a fork starts with empty records.
- Keyboard navigation of the list (rows are not focusable today either).
- A tree of folders. Files stay a flat list per repository, sorted by path.

## Anti-goals

- A link in the chat no longer opening the file it names, at its line.
- Reading a file on a network location, or showing a file outside the session folder that the user never confirmed.
- A git call per file when the list is read (the arrow must not cost one).
- A file listed in both lists at once (paths compared as text; the symlink case under Known limits is accepted).

## Approaches

1. **Rework the existing modules (chosen).** `changes-list.js` draws the tree and the second list,
   `file-preview.js` drops the strip and gets the mode control, the record store gets an `opened` list per session.
   No new dependency, no new window. The list already carries `committed` per file, so the arrow needs no git call;
   commits are read when a file is unfolded.
2. **Opened files in localStorage, as before v0.19.0.** Less code in the main process, but the list would live
   apart from the session's records: not removed with the session, lost with the window's storage. Rejected: the
   owner wants it to survive what the chat does not.
3. **Read every file's commits with the list.** The tree would be complete at once, but costs one `git log` per
   listed file (up to 2000) on every refresh. Rejected: slow for nothing, since most files are never unfolded.

## Design

### Left panel

```
┌ Changes               ⟳  + ┐
│ ▾ copilot-relay          ✕ │   repository group, as today
│   ▾ M ● electron/main.mjs  │   file with commits: arrow, unfolded
│       a1b2c3d fix: …       │   commit rows, newest first
│       d4e5f6a feat: …      │
│   ▸ M ✓ src/x.ts           │   file with commits, folded
│     ? ● notes.md           │   no commits: no arrow (its place stays empty, names line up)
│ ▾ No repository            │   loose files, as today
│     ● /tmp/out.txt         │
│ Opened files               │   second list; heading and list absent when it is empty
│     docs/README.md       ✕ │
│     /home/me/notes/todo… ✕ │
└────────────────────────────┘
```

- **File row.** State letter, the three marks and the path as today. A click on the row (anywhere but the arrow)
  selects the file's uncommitted version: its diff, or `No changes.` when `uncommitted` is false. An untracked file
  shows its content as additions, as today.
- **Arrow.** Shown when the file's `committed` is true. A click toggles the fold and does not change the selection.
  The first unfold asks `changes:commits`; a small `Reading…` row shows until it answers, an error shows as a note
  row under the file. The answer is kept until the next list refresh.
- **Commit row.** Short id and subject; date and author in the tooltip (the strip's content). A click selects that
  commit of that file and shows its diff. When the stored mode is `File`, the diff pane would be hidden: the click
  then shows `Diff` for that showing, preference untouched (the mirror of the rule for files without a diff).
- **Selection** is a pair: the file's key and a version (`uncommitted` or a commit id). The selected row is marked:
  the file row for `uncommitted`, the commit row for a commit; with a commit selected its file row carries a weaker
  mark, so the file is findable when its commits are folded.
- **Fold state** of files is kept in memory per session, like the groups' today. After a refresh (`⟳`, reopening,
  a link) unfolded files that are still listed stay unfolded and their commits are read again; the selection is kept
  when the file is still listed, falling back to `uncommitted` when the selected commit is gone, else the first file
  is selected, as today.
- **Opened files.** One row per file, newest first: the path relative to the session folder when the file is inside
  it, else the absolute path (the name stays readable, the folder part gives way first, as in the upper list), and
  `✕` to take it off the list. The full path is the tooltip. The heading's tooltip: `Files opened from links in the
  chat that this session has not changed`.

### Right side

- The header gets a three-part control `Diff | File | Both` in place of `Show file`; the version strip
  (`.fp-versions`) is removed. `Both` is today's split with the draggable divider and its ratio.
- The mode is one preference for all sessions, stored with the ratio under the existing key as
  `{ view: "diff" | "file" | "both", ratio }`. An old value is read as: `showFile: true` → `both`, else `diff`.
- The file pane always shows the file on disk, whichever version is selected (unchanged). The diff pane shows the
  selected version.
- A hidden pane is not painted, but the file is still read (main watches only a path it has read, as today) and the
  diff is read when its pane is first shown for the selection.
- `This diff is larger than 2 MB. Use Show file.` becomes `… Use File.`

### Files without a diff, and links

- A row of `No repository` or of `Opened files` has no diff. A click on it shows the file in `File` mode for that
  showing, without changing the stored preference; the control shows `File`. Choosing `Diff` or `Both` there is
  allowed, saves the preference like any click on the control, and the diff pane says `No changes.`
- A link in the chat keeps today's behaviour: the browser opens showing that file at its line, in `File` mode for
  that showing (preference untouched), after the confirmation when the file is outside the session folder. When
  the file is in the changes list, its row is selected (version `uncommitted`), so `Diff` or `Both` is one click
  away. When it is not, it is selected in `Opened files`.
- The next click on a changed file's row shows it in the stored mode again.

### Opened files: storage and rules

- **Where.** The record store (`repo-records.mjs`): each session's entry gets `opened`, an array of absolute real
  paths (the `path` that `files:read` returned), newest first, at most 200. Opening a file already there moves it to
  the front (compared without case on win32, as `sameRoot` does); the 201st drops the oldest. The list on screen
  shows the newest 20 that pass the filter below, so files hidden because the session changed them do not push
  unchanged ones out. `forget(sessionId)` removes it with the rest, so deleting a session clears
  it. An entry without `opened` loads as `[]`.
- **When a file is added.** When a link's file is shown in the browser as text (after the confirmation, if one was
  needed), whether or not it is in the changes list. A link that opens in the system app or the image viewer adds
  nothing.
- **What is shown.** `changes:list` returns `{ repos, loose, opened }`. The renderer leaves out of `Opened files`
  every path that the changes list holds (a repository's file, by `ChangesModel.locate`, or a loose file). So a file
  moves to the upper list when the session changes it, and comes back when it leaves that list (its repository
  removed with `✕`). The filter is a pure function in `ChangesModel` and compares path text with `locate`'s
  platform rules; it touches no disk.
- **IPC.** Two calls beside the existing `changes:*`: one to record an opened file, one to remove it. Both take a
  known session id (`knownSession`). Recording accepts only a path in `readablePaths` (one `files:read` returned in
  this run), so the list cannot be filled with paths the user never opened.
- **Access.** A row of `Opened files` is first read unconfirmed. When that answers `outside`, the read is repeated
  as confirmed only if the real path it reports equals the recorded one: the user confirmed exactly that file when
  it was first opened in this session. Any other `outside` answer (the path now leads elsewhere, through a link made
  since) asks the confirmation, as a chat link does. A file on a network location is still never read. A file that
  is gone shows `This file is deleted.` and stays listed until `✕`.

## My calls (correct them if wrong)

- **Heading and list of `Opened files` are absent when empty**, rather than an empty section.
- **The arrow's place stays empty for a file without commits**, so file names line up.
- **`File` for one showing does not overwrite the stored mode.** Otherwise opening one link would switch the whole
  browser to `File` for good.
- **Every link's text file is recorded, also one that is in the changes list.** The display hides it while it is
  there; it needs no second write when it leaves that list.
- **Selecting a file never unfolds it.** A file with only committed changes (`✓`) shows `No changes.` until its
  arrow is used, as the owner described.
- **A commit click in `File` mode shows `Diff` for that showing.** Otherwise the click would change nothing
  visible.
- **200 stored, 20 shown.** The owner agreed to 20 per session; counting the hidden ones against it would let
  clicks on changed files push the unchanged ones out.
- **An `Opened files` row is read without a question only when it is still the file that was opened.** Stricter
  than a loose file (which the agent's own edit vouches for), in line with the second anti-goal.
- **Release:** minor, `v0.20.0`, on the merge commit.

## Known limits (to the backlog when the branch is finished)

- **A loose file reached through a symlink can show in both lists.** Loose files are recorded as the agent wrote
  their path (`repo-track.mjs`, no real path), opened files by real path, and the filter compares text. Example:
  `/tmp/out.txt` on macOS, whose real path is `/private/tmp/out.txt`; the same under a symlinked home. A link to
  such a file is then selected in `Opened files`, not on its loose row. Resolving loose paths when the list is read
  would fix it at the price of disk access per loose file.

## Left to the builder

- The control's markup and look (three buttons, the active one marked), the weaker mark's look, class names.
- The names of the two new IPC calls and of the store's methods.
- How the fold set and the per-file commit cache are held in `file-preview.js`.
- Which of `ChangesModel.versions` and the strip's code is deleted or reshaped.

## Touches

- `electron/renderer/changes-list.js` (tree, second list), `file-preview.js` (selection pair, modes, strip gone,
  recording an opened file), `changes-model.js` (prefs with migration, selection after refresh, the filter),
  `index.html`, `style.css`.
- `electron/repo-records.mjs` (`opened`), `repo-changes.mjs` (`list` returns it), `main.mjs` and the preload (two
  calls).
- Tests: `changes-model.test.mjs`, `repo-records.test.mjs`, `repo-changes.test.mjs`, `scripts/ui-check/checks.mjs`.
- Backlog `2026-11-22-changes-browser-deferred.md`: its items about the version strip and `Show file` are checked
  against this change while planning; the ones it makes moot are struck there.

## Checks by hand (open)

- **Compaction with real Copilot: the session id is kept; the replay of old links is still open.** Checked
  2026-11-23 with a probe on local Copilot 1.0.115: `/compact` sent over ACP is accepted and records
  `session.compaction_start` in the same session's `events.jsonl`; no new session folder appears, so the session id
  is kept and the records stay valid (the app has no handling of compaction and needs none for that). The compaction
  did not finish within 8.5 minutes in that tiny session, so what the chat replays of the old links after a
  finished compaction is still not verified (the hang itself is in the backlog). To finish the check: run
  `/compact` in a session with recorded changes, let it finish, reopen the session, and look at the chat's old links
  and the list.
- Windows: the two lists with long paths, the divider in `Both`, a link to a file outside the session folder.
