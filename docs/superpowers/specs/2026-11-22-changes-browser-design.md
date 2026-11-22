# Changes browser: the files a session changed, per repository, with git diffs

Date: 2026-11-22. Status: approved. Applies to the desktop app (`electron/`). It rebuilds the file preview of
`2026-11-09-file-links-preview-design.md`: path detection, the click rules and the access rules of that spec stay.

## Intent

Today a change made by the agent is visible only at its tool call in the log, and the file preview shows a file's
current content with a list of the files the user opened by hand. There is no place that answers "what changed in
this session". The preview becomes a changes browser: its list fills by itself with the files changed in the
repositories the agent works on, and a file is shown as a git diff, with its full content beside it on request.

## Goals

- The first change the agent makes in a repository records that repository's **start point** for the session.
- The browser lists, per repository, every file changed since the start point: files with uncommitted changes and
  files changed by commits made since then, whether the agent changed them or not.
- For a file: its current uncommitted diff, and the diff of each commit since the start point that touched it.
- Beside the diff, on request, the whole current file, in a split view with a draggable divider.
- Opening the browser reads the state of the recorded repositories again, with a loader.
- A repository can be added by hand; its start point is where `HEAD` was when the session was created.

## Non-goals

- Reverting, staging, committing or any other write to a repository.
- Telling apart, inside one file, what was changed before the session and what during it (decision A1 below).
- Side-by-side or word-level diffs, syntax colours inside a diff, search, blame.
- A file's content at a commit. The full-content pane always shows the file as it is on disk now.
- Following renames across commits (`--follow`), submodule content, binary diffs.
- Refreshing the list in the background.
- A parent session showing the changes of its delegated child sessions. Each session has its own records.
- The relay web panel (`public/index.html`).

## Anti-goals (a failure even if it works)

- Anything the app runs changing a repository: its work tree, index, refs, stashes or config. This includes taking
  `index.lock`, which would make a `git` command of the agent fail.
- A repository's own configuration making the app run a program through the fsmonitor hook, an external diff, a
  textconv driver or a signature check. (Clean and process filters are a known limit, see My calls.)
- An agent's tool call making the app touch a network location, or read file content, without a click.
- Opening the browser blocking the window while git runs.
- A file link in the chat no longer opening the file it names.

## Decisions made with the user

| Topic | Decision |
|---|---|
| List | The preview's list of opened files is removed. The panel is the changes browser only. |
| Grouping | Files are grouped per repository. |
| Trigger | The first file the agent edits in a repository records that repository's start point. The repository is found from the file's path. The session folder may hold many repositories, so it is not assumed to be one. |
| Session folder inside a repo | Only then, that repository also gets its start point at the first tool call of any kind, so a commit made from the shell before the first edit is not lost. |
| Start point | Option A1: the `HEAD` commit plus the list of paths that had uncommitted changes at that moment. Nothing is written to the repository and no file content is copied. |
| Earlier changes | A file from that list is marked "changed before the session". When the session changes it too, its uncommitted diff shows both together; the mark stays as the warning. |
| What is listed | All files with uncommitted changes now, plus all files touched by a commit since the start point, also when they have no uncommitted change now. |
| Versions of a file | "Uncommitted" and one entry per commit since the start point that touched the file. |
| Refresh | On opening the browser, with a loader. |
| Full content | Optional, beside the diff, divider draggable. |
| Manual repositories | A repository that is not listed can be added. It shows its uncommitted changes and the commits since the start of the session. The start point is read from the reflog. |
| Simplicity | KISS throughout: git's own text output, no new dependency. |

## How it works today

- `electron/renderer/file-preview.js` (`createFilePreview`): a full-screen overlay `#file-preview` with a list of up
  to 20 opened files per session (localStorage `copilot-sessions.files.v1`) and one content area: highlighted code,
  windowed plain text for 2-20 MB, rendered Markdown. `app.js` uses `open`, `show`, `close`, `forget`, `count`,
  `isOpen`, and shows a header button `Files (n)` while the list is not empty.
- Main: `files:read` (`resolvePreview` in `file-access.mjs`: text tiers, `{ outside }` until confirmed for a file
  outside the viewing folder, `{ notText }` for a network location, which the preview therefore never reads),
  `files:watch` for the one file on show, `files:check` for path detection.
- Every ACP `session/update`, live or replayed by `session/load`, goes through `entry.update` in `attach()`
  (`electron/main.mjs`) and on to the window as `acp:update`. Subagents write into the same session's stream.
  A delegated child session is a session of its own.
- An edit as Copilot sends it (captured on 2026-11-22 with Copilot CLI 1.0.115, tool `apply_patch`, for an update,
  a creation and a deletion of a file):
  1. `tool_call`, `status: "pending"`, `kind: "edit"`, no `locations`, no `content`. The file is named only inside
     `rawInput`, here as patch text with a path relative to the session folder.
  2. `session/request_permission`, only when the tool is not already allowed: `toolCall.kind: "edit"` and
     `toolCall.locations: [{ path }]` with the **absolute** path. This comes before the file is written.
  3. `tool_call_update`, `status: "completed"`: `content: [{ type: "diff", path, oldText, newText }]` with the
     absolute path. A creation has `oldText: ""`, a deletion `newText: ""`. This comes after the write.
- A shell command is `kind: "execute"` and names no file, also when it moves or deletes one.
- `run-program.mjs` `runProgram` spawns a program with an argument array and a timeout. It keeps only the **last**
  64 KB of the output, which suits logs and not diffs.
- `broker-git.mjs` already runs `git` from PATH with `GIT_TERMINAL_PROMPT=0`, with an injected `run` for tests.
- Copilot keeps a session's creation time in `session-state/<id>/workspace.yaml` (`created_at`, ISO time with
  milliseconds and `Z`). Nothing in the app reads it today; `yamlGet` in `history.mjs` is private to that module, so
  an exported reader is needed.

## Approaches

- **A. `git` from the command line in the main process, its diff text rendered by a small own renderer (chosen).**
  Git is already a requirement of the app's broker update and is on every machine the agent works on. Status, log
  and diff are one command each, the output is text, and nothing is added to the renderer, which has no bundler.
- **B. Compute diffs in the window** from two contents (`git show <commit>:<path>` and the file) with a diff
  library. It would allow side-by-side and word-level diffs, which are non-goals, and costs a dependency loaded as a
  browser script plus two full contents per view.
- **C. A git library** (isomorphic-git, simple-git). A dependency for what four commands do; isomorphic-git's status
  is slow on large repositories and reads config differently from the user's git.

## Design

### 1. Records (main, new store)

One JSON file in `userData` (written to a temp file and renamed, as `links-cache.mjs`), read once at start:

```
{ "<sessionId>": {
    "repos": [ { "root": "/abs/repo", "source": "auto" | "manual", "base": "<sha>" | null, "at": "<ISO time>",
                 "dirtyAtStart": ["rel/path", …], "touched": ["rel/path", …] } ],
    "loose": ["/abs/file", …] } }
```

- `root` is the repository's top folder as a real local path. One record per root and session; a root that is
  already recorded is never recorded again (its start point does not move).
- `base` is the commit `HEAD` pointed to; `null` when the repository had no commit yet.
- `dirtyAtStart`: the paths `git status` reported at the start point, minus the paths of the tool call that
  triggered the record when that call was an edit (see My calls). Empty for a manual repository.
- `touched`: paths (relative to the root) named by the agent's edit tool calls since. Only for the mark in the list.
- `loose`: files the agent edited that are in no repository.
- Deleting a session removes its entry.

### 2. Trigger (main, in `entry.update`)

Only for **live** updates: an entry is "replaying" from `attach()` until its `session/load` request settles, and
replayed updates never create or change a record.

- **Edit.** The paths of an edit come from two places, whichever arrives: the `locations` of a
  `session/request_permission` whose `toolCall.kind` is `edit`, `delete` or `move`, and the `path` of every `diff`
  item in the `content` of a `tool_call` or `tool_call_update` (plus its `locations` when its `kind` is one of the
  three). `rawInput` is not parsed: its form depends on the tool. A relative path resolves against the session
  folder.
- For each path not seen before in this session: refuse it unless the automatic-check rule of `files:check` allows
  it (`allowsAutomaticCheck`: local, not a network location; without a location table only under the home or a
  session folder). Then find the repository from the nearest existing folder at or above the file
  (`git rev-parse --show-toplevel`).
  - In a repository: record it if it is new (start point = now), and add the path to `touched`.
  - In none: add the file to `loose`.
- **Session folder.** Once per opened session, at its first live `tool_call` of any kind: if the session folder is
  inside a repository, record that repository if it is new.
- The trigger runs behind the update: the update is sent to the window first, and git failures are logged, never
  shown as a session error. Lookups for one session run one after another so two calls cannot record a root twice.

With a permission prompt the path is known before the write. With a standing approval there is no prompt, and the
path is first known from the completed update, after the write. The commit of the start point is the same either
way; the list of earlier changes is not, which is why the triggering edit's own paths are left out of
`dirtyAtStart`.

### 3. Git (main, new module with an injected `run`, as `broker-git.mjs`)

Every call: argument array, `git` from PATH, `--literal-pathspecs`, `-C <root>`, `-c core.fsmonitor=false
-c core.quotepath=false -c diff.autoRefreshIndex=false`, environment `GIT_OPTIONAL_LOCKS=0`,
`GIT_TERMINAL_PROMPT=0`, a timeout. Diff-producing calls add `--no-ext-diff --no-textconv --no-color`; `log` and
`show` add `--no-show-signature`. Only these commands are used:

| Purpose | Command |
|---|---|
| Repository of a folder | `rev-parse --show-toplevel` |
| Start point, automatic | `rev-parse --verify HEAD` |
| Start point, manual | `rev-parse --verify "HEAD@{<created_at>}"` |
| Uncommitted files | `status --porcelain=v1 -z --untracked-files=all` |
| Files of commits since the start | `log --format= --name-status -z <base>..HEAD` |
| Commits of one file | `log --format=<sha, subject, date, author> <base>..HEAD -- <path>` |
| Uncommitted diff of a file | `diff HEAD -- <path>` |
| A commit's diff of a file | `show --format= --diff-merges=first-parent <sha> -- <path>` |

- Verified here (git 2.43): `HEAD@{2026-11-21T12:00:00Z}` returns where `HEAD` was at that time; a time before the
  first reflog entry prints a warning, exits 0 and returns the oldest entry.
- Verified here: `GIT_OPTIONAL_LOCKS=0` alone is not enough. `git diff HEAD` rewrites the index when a file's
  timestamp changed and its content did not; with `diff.autoRefreshIndex=false` the index stays as it was, and the
  commands also succeed while an `index.lock` exists.
- A path after `--` is a pathspec, where `[`, `*` and `:(…)` have a meaning (`app/[id]/page.tsx`).
  `--literal-pathspecs` makes it a plain name.
- A merge commit with resolved conflicts is shown by default as a combined diff (`diff --cc`, `@@@`), which a
  unified-diff parser cannot read. `--diff-merges=first-parent` gives an ordinary diff against the first parent.
- With `base: null` the range is all of `HEAD`'s history, and the uncommitted diff of a file is its whole content
  as added while there is no commit.
- An untracked file has no diff in git: it is shown as its whole content added.
- The runner needs the **start** of long output and a larger limit than `runProgram` gives: up to 2 MB per diff,
  and more than that is reported as "diff too large" (the full-content pane still works). The file list of a
  repository is cut at 2000 entries with a note.

### 4. Reading the state (IPC)

Channel names are the builder's. The window passes a session id; main only accepts a `root` recorded for that
session, a `path` that is relative and stays inside the root, and a commit id that is a full sha from the file's
commit list.

- **List** (session) → per recorded repository: `root`, name (folder name), `source`, `at`, an error text if git
  failed (repository gone, not a repository any more, git not found, "dubious ownership"), and its files. A file:
  path relative to the root, state (`M` modified, `A` added, `D` deleted, `R` renamed, `?` untracked),
  `uncommitted` (has changes now), `committed` (touched by a commit since the start point), `touched`,
  `dirtyAtStart`. Plus the `loose` files. Repositories are read in parallel.
- **File** (session, root, path) → its commits since the start point, newest first.
- **Diff** (session, root, path, `uncommitted` or a commit) → the diff text, or `binary` / `tooLarge`.
- **Add** (session) → a folder dialog; the folder's repository is recorded as `manual` with the reflog start point
  (`created_at` of the session; when it cannot be read, the current `HEAD`). A folder outside any repository, on a
  network location, or whose repository is already listed gives a message and changes nothing.
- **Remove** (session, root) → drops the record. Offered for every repository (see My calls).
- A start point whose commit no longer exists in the repository: the repository shows its uncommitted changes and a
  note that the start point is gone.

### 5. The browser (window)

```
┌ Changes        ⟳  + ┬ main.mjs   electron/main.mjs      [Show file] [Open in system app] ✕ ┐
│ ▾ copilot-relay   ✕ │ [Uncommitted] [a1b2c3d fix: …] [d4e5f6a feat: …]                      │
│   M ● electron/ma…  ├──────────────────────────────────╥──────────────────────────────────┤
│   ? ● notes.md      │  12  12   context                ║  1  import …                      │
│   M   README.md  ⏱  │  13     - old line               ║  2  …                             │
│   M ✓ src/x.ts      │      13 + new line               ║                                   │
│ ▾ other-repo        │                                  ║                                   │
│ ▾ No repository     │              diff                ║        whole file (optional)      │
└─────────────────────┴──────────────────────────────────╨──────────────────────────────────┘
```

- **Entry.** The session header's button is always shown and reads `Changes`. It opens the browser, which asks for
  the list at once: a loader in the list until it arrives, while the content area stays empty or keeps what it
  showed. `⟳` does the same. After a refresh the selected file stays selected if it is still listed, else the first
  file is selected. With no repository recorded the list says so and offers `+ Add repository`.
- **List.** One collapsible group per repository in the order recorded, then `No repository` for loose files. Files
  sorted by path. Each row: state letter, `●` when the agent edited it, a mark for "changed before the session", a
  mark for "committed, no uncommitted change now", and the path relative to the root (the file name must stay
  readable when the path is long). A repository with an error shows the error text in place of its files.
- **Versions.** Selecting a file asks for its commits and shows a strip: `Uncommitted` (when it has uncommitted
  changes) and one entry per commit, newest first, with short id and subject, and date and author in the tooltip.
  The first entry is selected. Selecting an entry loads its diff.
- **Diff.** Git's unified diff, parsed by a pure module into hunks and lines and rendered as text: old and new line
  numbers, added and removed lines coloured as the chat's diffs, hunk headers, git's own header lines dropped.
  Binary, too large, and "no changes" are messages. Diff text reaches the DOM only as `textContent`.
- **Full content.** `Show file` adds the current file to the right of the diff, with today's code view (highlight,
  windowed plain text, Markdown toggle). The divider between the two drags; the ratio and whether the pane is shown
  are remembered for all sessions. The pane always shows the file on disk, whichever version entry is selected; a
  deleted file shows a message.
- **A file link in the chat** keeps today's behaviour: the browser opens showing that file alone at its line, with
  the confirmation for a file outside the session folder. If the file is in the list, its row is selected and the
  version strip is shown, so the diff is one click away. Nothing is added to the list by a link.
- **Following the disk.** The file on show is watched as today; when it changes, its content and its uncommitted
  diff are read again in place, keeping the scroll positions. The list does not follow.
- **Access.** A file of a recorded repository, or a loose file, is read without the "outside the session folder"
  confirmation: the agent edited there or the user added the repository. A file on a network location is still
  never read.
- **Keyboard** as today: `Esc` closes, `Tab` stays inside, `Ctrl/Cmd+A` selects the pane that has the focus.
- The old list's localStorage key is removed at start.

## My calls (not discussed; correct them if wrong)

- **The triggering edit's paths are never marked "changed before the session".** Without this, the first file
  edited under a standing approval would always get the mark wrongly, because its path is known only after the
  write. The cost: a file that really had earlier changes and is the first one the agent edits has no mark.
- **Only live tool calls count.** Opening an old session records nothing until the agent works again; its start
  point is then that moment, not the session's beginning. Add the repository by hand to get the beginning.
- **`●` comes from live edits only**, so after a restart of the app the marks of earlier edits are still there (they
  are stored), but edits made while the session ran in a terminal are not marked.
- **Every repository can be removed from the list**, automatic ones too. An automatic one comes back at the agent's
  next edit there, with a new start point.
- **Commits are `start point..HEAD` of whatever is checked out.** After a switch to another branch the list shows
  that branch's commits that the start point does not have. Pulled and merged commits are listed like local ones.
- **Staged and unstaged changes are one diff** (`diff HEAD`).
- **A merge commit's entry shows the file's diff against the merge's first parent**, so for a pull it repeats what
  the merged commits' own entries show.
- **Clean and process filters still run.** `status` and `diff` run a filter that git's configuration defines for a
  changed file (git-lfs is the everyday case), and git has no switch for that. A filter's command comes from git
  configuration on this machine, never from the repository's tracked files, so a cloned repository cannot bring
  one. Left as is.
- **Ignored files are not listed.** A file the agent edits that git ignores gets no row.
- **Timeouts:** 10 s for a repository's list, 10 s per diff or log, 5 s for the trigger's calls.
- **The `Changes` button has no count**: a count would need git calls for every session view.

## Constraints

- `main.mjs` cannot be loaded by `node --test` and `app.js` has no DOM tests. The record store, the trigger's
  path extraction, the git calls with their parsers, and the diff parser live in modules of their own that
  `node --test` can load. New main-process modules are listed in `electron/package.json` `build.files`.
- Paths go to git as arguments after `--`, never into a shell string, and as plain names (`--literal-pathspecs`).
- Windows: git prints the root with forward slashes; roots are compared as resolved paths, case-insensitively there.
- `README.md` in `electron/` describes the preview and its list; it is updated with the feature.

## Verification

- **Parsers, with fixed text:** `status -z` (modified, added, deleted, untracked, rename with its second path,
  names with spaces and non-ASCII), `log --name-status -z`, the commit list, the unified diff (several hunks, no
  newline at end of file, added and deleted file, binary notice).
- **Trigger, with fake updates** in the captured shapes: a permission request with `locations`, a completed update
  with a `diff` and no earlier request, a pending `tool_call` without a path (nothing recorded), `execute` and `read` ignored,
  relative paths, a replayed update ignored, a refused network path, the triggering paths left out of
  `dirtyAtStart`, a root recorded once under concurrent updates.
- **Git, real git in temp repositories:** a clean and a dirty start; commits after the start listed with their
  files, including a file changed and changed back; a file with only committed changes; an untracked and a deleted
  file; a repository without commits; a start point that no longer exists; the reflog start point with set commit
  dates, also before the first reflog entry; a repository inside a folder that is not one; a file named
  `app/[id]/page.tsx`; a merge commit with a resolved conflict.
- **No writes:** after every read command the repository's index file, refs and `stash` are byte-for-byte as
  before, also with a file whose timestamp changed and whose content did not, and a read succeeds while an
  `index.lock` exists.
- **No programs from config:** a temp repository whose config sets `core.fsmonitor`, `diff.external`, a textconv
  driver and `log.showSignature` with `gpg.program` to a script that leaves a marker file; after list, log and diff
  the marker does not exist.
- **Store:** round trip, a missing or broken file, removal with the session.
- **Window** (manual, and `scripts/ui-check` where it fits): loader on entry, groups, marks, version strip, split
  and divider remembered, a chat link opening the file alone, refresh keeping the selection, add and remove.

## Left to the builder

- Module, channel and CSS names; the look of the marks, the strip and the loader; wording of the messages.
- Whether `runProgram` gets options for the output limit or the git module spawns on its own.
- How a long relative path is shortened in a row.
- Whether very long diffs need windowed rendering below the 2 MB limit.
- How the session folder's repository lookup is cached per opened session.

## Not verified yet

- **Edit tools other than `apply_patch`.** The capture used the model Copilot picked by default. Another model may
  edit with a different tool; the rule of section 2 reads only `kind`, `locations` and `diff` items, which are part
  of ACP and not of a tool, but only `apply_patch` was seen.
- **A patch that changes several files**, and the kinds `delete` and `move`: not seen in the capture.
- Windows and macOS: git path output, case-insensitive roots, the folder dialog.
