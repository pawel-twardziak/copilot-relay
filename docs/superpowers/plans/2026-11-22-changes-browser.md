# Changes Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The desktop app's file preview becomes a changes browser: per session it lists the files changed in the
repositories the agent works on, and shows each as a git diff with the whole file beside it on request.

**Architecture:** Four main-process modules that do not import `electron`: read-only git calls with their parsers,
a record store, the trigger that records a repository's start point from live ACP traffic, and the reader that turns
records into what the window shows. `main.mjs` only wires them to the ACP stream and to IPC. In the window, two pure
classic-script modules (diff parser, list model) carry the logic and `file-preview.js` is rebuilt around them.

**Tech Stack:** Node 22 (`node --test`), `git` from PATH through `runProgram`, Electron main + classic-script
renderer modules, real `git` in tests (`electron/test/git-helper.mjs`), the CDP UI checks in `scripts/ui-check`.

**Spec:** `docs/superpowers/specs/2026-11-22-changes-browser-design.md`. Read it first; this plan does not repeat it.

**Before Task 1:** work on branch `feat/changes-browser` (it exists and holds the spec and this plan), in a worktree
(superpowers:using-git-worktrees).

## Global Constraints

- **Read-only git.** Only the commands of the spec's table (section 3). Every call: argument array,
  `--literal-pathspecs`, `-C <root>`, `-c core.fsmonitor=false -c core.quotepath=false
  -c diff.autoRefreshIndex=false`, environment `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`. Diff-producing calls
  add `--no-ext-diff --no-textconv --no-color`; `log` and `show` add `--no-show-signature`; `show` adds
  `--diff-merges=first-parent`. Paths go after `--`.
- No new dependency. No write to a repository, including `index.lock`.
- Limits: a diff up to 2 MB (`tooLarge` above), 2000 files per repository, 10 s per git call, 5 s for the
  trigger's calls.
- Tests never run git against this working repository: temp repositories and `isolatedRun` / `isolatedEnv` from
  `electron/test/git-helper.mjs`. The suite runs on Linux and Windows CI; a test that needs a shell script or a
  symlink is skipped on `win32`.
- Main-side modules added here do not import `electron` and are listed in `electron/package.json` `build.files`.
  Renderer modules are classic scripts that set `globalThis.<Name>` and export through `module.exports`.
- Diff text and file text reach the DOM only as `textContent` (or through the existing code and Markdown views).
- UI copy in English: button and list title `Changes`, group `No repository`, version entry `Uncommitted`, toggle
  `Show file` / `Hide file`, loader `Reading changes…`.
- Commit style `type(scope): sentence`, scope `desktop`.
- Full suite: `npm test` from the repo root (622 tests pass before this plan). UI checks:
  `node scripts/ui-check/run.mjs <name>` exits 0.

## Review Focus

- **A nested repository or linked worktree inside a repository.** `git status` reports it as one entry ending in
  `/` (`?? nested/`). It is a folder: it must not become a file row. (Task 1)
- **One repository failing does not empty the browser.** A root that was deleted, is no longer a repository, or
  whose git call times out shows its error text; the other repositories are listed. (Task 5)
- **File names that look like link syntax** (`50% off.txt`, `notes#1.md`, `log:12`, names with spaces and
  non-ASCII) open in the full-content pane as the file they are. (Task 8)
- **A file reached through a symlinked folder.** The record's root is git's real path and the file's relative path
  is right, so its row matches git's own output. (Task 2)
- **Two sessions working in the same repository** have independent records: different start points, and removing
  one does not touch the other. (Task 3)

## File Structure

| File | Responsibility |
|---|---|
| `electron/run-program.mjs` (modify) | Output limit option. |
| `electron/repo-git.mjs` (new) | Parsers of git output; `createGit(run)` with the read commands. |
| `electron/repo-records.mjs` (new) | The record store (`session-repos.json`). |
| `electron/repo-track.mjs` (new) | `editPaths`, `createRepoTracker`: records start points from live traffic. |
| `electron/repo-changes.mjs` (new) | `createChanges`: list, commits, diff, add, remove, with validation. |
| `electron/history.mjs` (modify) | `sessionCreatedAt(id)`. |
| `electron/main.mjs`, `electron/preload.cjs`, `electron/package.json` (modify) | Wiring, IPC, packaging. |
| `electron/renderer/diff-view.js` (new) | Unified diff parser and its DOM rendering. |
| `electron/renderer/changes-model.js` (new) | Pure list logic: keys, selection, versions, path split, lookup. |
| `electron/renderer/file-preview.js`, `index.html`, `style.css`, `app.js` (modify) | The browser. |
| `electron/renderer/file-links.js` (modify) | The recent-list helpers are removed. |

---

### Task 1: Output limit and git output parsers

**Files:**
- Modify: `electron/run-program.mjs`, `electron/test/run-program.test.mjs`
- Create: `electron/repo-git.mjs`, `electron/test/repo-git-parse.test.mjs`

**Interfaces:**
- Produces: `runProgram(program, args, { …, outputLimit = 64 * 1024, keep = "end" })` resolving
  `{ stdout, stderr, truncated }`. `keep: "start"` keeps the first `outputLimit` characters of stdout and drops the
  rest (the program still runs to its end); `truncated` is true when stdout was cut, in either mode.
- Produces, in `repo-git.mjs`:
  - `parseStatus(text) → [{ path, state }]` for `status --porcelain=v1 -z`. `state`: `"?"` for `??`; else `"D"` if
    X or Y is `D`; else `"R"` if X is `R`; else `"A"` if X is `A`; else `"M"`. A rename's second field (the old
    path) is consumed and not returned. Entries whose path ends in `/` and `!!` entries are dropped.
  - `parseNameStatus(text) → [{ path, state }]` for `log --format= --name-status -z`: `R<n>` and `C<n>` take two
    paths and return the new one (`"R"`, and `"A"` for a copy); a path is returned once, with its first state.
  - `COMMIT_FORMAT = "%H%x1f%s%x1f%cI%x1f%an%x1e"` and `parseCommits(text) → [{ sha, subject, date, author }]`.

- [ ] **Step 1: Write the failing tests**

`run-program.test.mjs` (the program is `process.execPath -e`):

```js
test("keep start: the first characters, truncated", async () => {
  const r = await runProgram(process.execPath, ["-e", "process.stdout.write('a'.repeat(50) + 'b'.repeat(50))"], { outputLimit: 60, keep: "start" });
  assert.equal(r.stdout, "a".repeat(50) + "b".repeat(10));
  assert.equal(r.truncated, true);
});
test("a short output is not truncated", async () => {
  const r = await runProgram(process.execPath, ["-e", "process.stdout.write('ok')"]);
  assert.deepEqual({ stdout: r.stdout, truncated: r.truncated }, { stdout: "ok", truncated: false });
});
```

`repo-git-parse.test.mjs`:

```js
test("status: states, rename, folder entry, odd names", () => {
  const text = [" M a b.txt", "A  new.txt", " D gone.txt", "?? zażółć.md", "R  to.txt", "from.txt", "?? nested/", "UU both.txt", "!! ignored.log", ""].join("\0");
  assert.deepEqual(parseStatus(text), [
    { path: "a b.txt", state: "M" }, { path: "new.txt", state: "A" }, { path: "gone.txt", state: "D" },
    { path: "zażółć.md", state: "?" }, { path: "to.txt", state: "R" }, { path: "both.txt", state: "M" },
  ]);
});
test("name-status: newest state wins, rename gives the new path", () => {
  const text = ["M", "a.txt", "R100", "old.txt", "b.txt", "A", "a.txt", "D", "c.txt", ""].join("\0");
  assert.deepEqual(parseNameStatus(text), [{ path: "a.txt", state: "M" }, { path: "b.txt", state: "R" }, { path: "c.txt", state: "D" }]);
});
test("commits", () => {
  const text = "aaa\x1ffix: x\x1f2026-11-22T10:00:00+01:00\x1fAnn\x1e\nbbb\x1ffeat: y, z\x1f2026-11-21T09:00:00+01:00\x1fBob\x1e\n";
  assert.deepEqual(parseCommits(text), [
    { sha: "aaa", subject: "fix: x", date: "2026-11-22T10:00:00+01:00", author: "Ann" },
    { sha: "bbb", subject: "feat: y, z", date: "2026-11-21T09:00:00+01:00", author: "Bob" },
  ]);
  assert.deepEqual(parseCommits(""), []);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test electron/test/run-program.test.mjs electron/test/repo-git-parse.test.mjs`
Expected: FAIL (`truncated` undefined; `repo-git.mjs` not found).

- [ ] **Step 3: Add `outputLimit` and `keep` to `runProgram`; write the three parsers in `repo-git.mjs`**

The existing callers pass neither option and must see the same result fields as before plus `truncated`.

- [ ] **Step 4: Run the tests and the full suite**

Run: `npm test`
Expected: PASS, 627 tests.

- [ ] **Step 5: Commit**

```bash
git add electron/run-program.mjs electron/repo-git.mjs electron/test/run-program.test.mjs electron/test/repo-git-parse.test.mjs
git commit -m "feat(desktop): parsers for git status, name-status and commit lists; runProgram can keep the start of long output"
```

---

### Task 2: Read-only git calls

**Files:**
- Modify: `electron/repo-git.mjs`
- Create: `electron/test/repo-git.test.mjs`

**Interfaces:**
- Consumes: the parsers and `runProgram`'s `outputLimit` / `keep` / `truncated` (Task 1).
- Produces:

```js
export const DIFF_LIMIT = 2 * 1024 * 1024;
export function createGit(run, { timeoutMs = 10_000 } = {})  // run: (program, args, opts) => Promise<{ stdout, stderr, truncated }>
// returns:
//   where(dir)                 → { root, prefix } | null   null: dir is in no repository. root = path.resolve(git's
//                                 toplevel); prefix = `rev-parse --show-prefix` ("" or "sub/deep/")
//   head(root)                 → sha | null                 null: no commit yet
//   headAt(root, isoTime)      → sha | null                 `HEAD@{<isoTime>}`; null when it cannot be resolved
//   status(root)               → [{ path, state }]
//   commitFiles(root, base)    → [{ path, state }]          base null: all of HEAD's history; [] when no commit
//   fileCommits(root, base, rel) → [{ sha, subject, date, author }]   newest first
//   diffUncommitted(root, rel) → { text, tooLarge }
//   diffCommit(root, sha, rel) → { text, tooLarge }
```

- A base commit that no longer exists makes `commitFiles` and `fileCommits` reject with `err.code === "NOBASE"`.
- A missing `git` rejects with `runProgram`'s error (`code: "ENOENT"`). Other failures reject with git's message.
- `tooLarge` is `runProgram`'s `truncated` with `outputLimit: DIFF_LIMIT, keep: "start"`; `text` is then `""`.
- `status` and `commitFiles` use `outputLimit: 8 * 1024 * 1024, keep: "start"`; when the output was cut, the text
  after the last NUL is dropped before parsing (it is half an entry).

- [ ] **Step 1: Write the failing tests** against temp repositories (`repoWithRemote(t)`, `isolatedRun`), one test each:

  1. `where`: the root for a nested folder with `prefix: "sub/deep/"`; `null` for a temp folder that is no
     repository; through a symlinked folder the real root and the right prefix (skip on `win32`).
  2. `head`: the commit; `null` in a repository made with `git init` only.
  3. `status`: a modified, a staged new, a deleted and an untracked file give `M`, `A`, `D`, `?`.
  4. `commitFiles`: two commits after `base` list their files; a file changed in one commit and changed back in the
     next is still listed; `base: null` lists every file of the history; a made-up 40-hex base rejects with
     `code: "NOBASE"`.
  5. `fileCommits`: only the commits after `base` that touched the file, newest first, with subject and author.
  6. `diffUncommitted`: contains `-hello` and `+edited` for a changed `README.md`; staged and unstaged changes of
     one file are both in it.
  7. `diffCommit`: the commit's change of that file only. For a merge commit with a resolved conflict the text
     starts with `diff --git` (not `diff --cc`).
  8. A file named `app/[id]/page.tsx`: `fileCommits` and `diffUncommitted` return its own data, and a sibling
     `app/i/page.tsx` is not matched.
  9. `headAt`: commits made with `GIT_COMMITTER_DATE` `2026-01-10T10:00:00Z` and `2026-01-20T10:00:00Z`;
     `headAt(root, "2026-01-15T00:00:00.000Z")` is the first commit; a time before the first is the first commit.
  10. `tooLarge`: a changed file of 3 MB gives `{ text: "", tooLarge: true }`.
  11. **No writes.** After `status`, `commitFiles`, `fileCommits`, `diffUncommitted` and `diffCommit`: the bytes of
      `.git/index`, the output of `git for-each-ref` and of `git stash list` are as before. The repository has a
      file rewritten with the same content and a newer mtime. Then, with an empty `.git/index.lock` in place, all
      five calls still succeed.
  12. **No programs from config** (skip on `win32`): a shell script that creates a marker file is set as
      `core.fsmonitor`, `diff.external`, `diff.marker.textconv` (with `*.md diff=marker` in `.gitattributes`) and
      `gpg.program` (with `log.showSignature=true`). After the five calls the marker does not exist.

- [ ] **Step 2: Run them and see them fail**

Run: `node --test electron/test/repo-git.test.mjs`
Expected: FAIL (`createGit` is not exported).

- [ ] **Step 3: Implement `createGit`** with the flags of Global Constraints and the commands of the spec's table.

  `where` runs `rev-parse --show-toplevel --show-prefix` with `cwd: dir` (no `-C`) and returns `null` when git exits
  with "not a git repository". `NOBASE` is recognised from git's message (`bad revision`, `unknown revision`,
  `Invalid revision range`, `bad object`).

- [ ] **Step 4: Run the tests and the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/repo-git.mjs electron/test/repo-git.test.mjs
git commit -m "feat(desktop): read-only git calls for the changes browser"
```

---

### Task 3: Record store and the session's creation time

**Files:**
- Create: `electron/repo-records.mjs`, `electron/test/repo-records.test.mjs`
- Modify: `electron/history.mjs`, `electron/test/history.test.mjs`

**Interfaces:**
- Produces:

```js
// Record = { root, source: "auto" | "manual", base: string | null, at: string, dirtyAtStart: string[], touched: string[] }
export function sameRoot(a, b, platform = process.platform)   // resolved paths; case-insensitive on win32
export function createRecordStore(file)
// returns:
//   session(sessionId)            → { repos: Record[], loose: string[] }   copies; empty for an unknown session
//   repo(sessionId, root)         → Record | null
//   addRepo(sessionId, record)    → boolean    false, and nothing changed, when the root is already recorded
//   touch(sessionId, root, rel)   → void       adds rel to that record's touched once
//   addLoose(sessionId, abs)      → void       once
//   removeRepo(sessionId, root)   → boolean
//   forget(sessionId)             → void
export function sessionCreatedAt(id)   // history.mjs → ISO string | null
```

- The file is read once by `createRecordStore`; a missing or broken file is an empty store. Every change writes the
  whole file to `<file>.tmp` and renames it (as `links-cache.mjs`).
- `sessionCreatedAt` reads `created_at` from the session's `workspace.yaml` (`sessionDir`, `yamlGet`) and returns
  `new Date(value).toISOString()`; `null` when the session folder, the file or the key is missing or the value is no
  date.

- [ ] **Step 1: Write the failing tests**

  - Round trip: `addRepo`, `touch`, `addLoose`, then a second `createRecordStore(file)` returns the same data.
  - `addRepo` twice for one root: the second returns `false` and `base` / `at` stay those of the first.
  - `touch` twice with one path stores it once; `touch` for a root that is not recorded changes nothing.
  - Two sessions, one root: each has its own record; `removeRepo("s1", root)` leaves `repo("s2", root)` as it was;
    `forget("s1")` removes only `s1`.
  - A file holding `not json`: the store is empty and a following `addRepo` writes valid JSON.
  - `sameRoot("C:\\Repo", "c:/repo/", "win32")` is true; `sameRoot("/a/Repo", "/a/repo", "linux")` is false.
  - `sessionCreatedAt` (in `history.test.mjs`, with that file's temp `COPILOT_HOME` helper): a `workspace.yaml` with
    `created_at: 2026-11-02T19:39:49.716Z` gives `"2026-11-02T19:39:49.716Z"`; no key gives `null`; an unknown id
    gives `null`.

- [ ] **Step 2: Run them and see them fail**

Run: `node --test electron/test/repo-records.test.mjs electron/test/history.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement the store and `sessionCreatedAt`**

- [ ] **Step 4: Run the tests and the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/repo-records.mjs electron/history.mjs electron/test/repo-records.test.mjs electron/test/history.test.mjs
git commit -m "feat(desktop): per-session records of repositories and their start points"
```

---

### Task 4: The trigger

**Files:**
- Create: `electron/repo-track.mjs`, `electron/test/repo-track.test.mjs`

**Interfaces:**
- Consumes: `createRecordStore` (Task 3); a git object with `where`, `head`, `status` (Task 2).
- Produces:

```js
export function editPaths({ kind, locations, content } = {})   // → string[], unique, in order
export function createRepoTracker({ store, git, allow, nearestDir = defaultNearestDir, now = () => new Date() })
// allow(abs) → boolean | Promise<boolean>; nearestDir(abs) → Promise<string | null>: the nearest existing folder at
// or above the file's folder.
// returns:
//   update(sessionId, cwd, update)       → Promise<void>   a live session/update
//   permission(sessionId, cwd, toolCall) → Promise<void>   the toolCall of a session/request_permission
//   closed(sessionId)                    → void            forgets what was seen for that opened session
```

- `editPaths`: the `path` of every `content` item with `type: "diff"`, then, when `kind` is `edit`, `delete` or
  `move`, the `path` of every `locations` item.
- `update` acts on `sessionUpdate` `tool_call` and `tool_call_update` only. `permission` acts only when
  `toolCall.kind` is one of the three kinds (its paths are then its `locations`).
- For each path not seen before in the session: resolve against `cwd`; skip unless `allow`; `nearestDir`;
  `git.where`. In a repository: `store.addRepo` when the root is new, then `store.touch(sessionId, root, rel)` with
  `rel = prefix + <path of the file below that folder>`, forward slashes. In none: `store.addLoose`.
- A new record from an edit: `{ root, source: "auto", base: await git.head(root), at: now().toISOString(),
  dirtyAtStart: <git.status paths minus this call's paths in that root>, touched: [] }`.
- Session folder: at the first `tool_call` update since the session was opened (or since `closed`), if `allow(cwd)`
  and `git.where(cwd)` gives a root that is not recorded, record it the same way with nothing left out of
  `dirtyAtStart`.
- Work for one session runs in the order received (one promise chain per session). The returned promises never
  reject: a failure is `console.warn("[changes] …")`.

- [ ] **Step 1: Write the failing tests.** `editPaths` with the captured shapes:

```js
const ABS = "/w/repo/a.txt";
test("editPaths: the captured shapes", () => {
  assert.deepEqual(editPaths({ kind: "edit", status: "pending", content: [], rawInput: "*** Update File: repo/a.txt" }), []);
  assert.deepEqual(editPaths({ kind: "edit", locations: [{ path: ABS }], content: [] }), [ABS]);
  assert.deepEqual(editPaths({ status: "completed", content: [{ type: "diff", path: ABS, oldText: "a", newText: "b" }] }), [ABS]);
  assert.deepEqual(editPaths({ kind: "read", locations: [{ path: ABS }] }), []);
  assert.deepEqual(editPaths({ kind: "execute", rawInput: { command: "mv a b" } }), []);
  assert.deepEqual(editPaths({ kind: "edit", locations: [{ path: ABS }], content: [{ type: "diff", path: ABS }] }), [ABS]);
});
```

  Tracker tests use a real store on a temp file and a fake git (`where` from a map of folder → `{ root, prefix }`,
  `head` → `"h1"`, `status` → a fixed list) that counts its calls:

  1. A completed update with a diff, no earlier request: the root is recorded with `base: "h1"`, the file is in
     `touched`, and the file is **not** in `dirtyAtStart` while another dirty path from `status` is.
  2. A permission request with `locations`: recorded the same way.
  3. A pending `tool_call` of kind `edit` without a path, session folder in no repository: nothing is recorded.
  4. A pending `tool_call` of kind `execute`, session folder inside a repository: that root is recorded, and every
     path of `status` is in `dirtyAtStart`.
  5. A second edit in a recorded root: `base` and `at` are unchanged, the new path is added to `touched`, and
     `git.head` was not called again.
  6. Two updates for the same new root sent without awaiting the first: one record.
  7. A relative path (`"notes.txt"`) resolves against `cwd`.
  8. `allow` returning false: no `git.where` call, nothing recorded.
  9. A file in a folder that does not exist yet (`/w/repo/new/dir/x.txt`, `nearestDir` → `/w/repo`): recorded with
     `touched: ["new/dir/x.txt"]`.
  10. A file in no repository: in `loose`, once.
  11. `git.where` rejecting: the promise resolves, nothing is recorded, a later update for another path still works.
  12. After `closed(sessionId)`, the session-folder lookup runs again at the next `tool_call`.

- [ ] **Step 2: Run them and see them fail**

Run: `node --test electron/test/repo-track.test.mjs`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `editPaths`, `defaultNearestDir` and `createRepoTracker`**

- [ ] **Step 4: Run the tests and the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/repo-track.mjs electron/test/repo-track.test.mjs
git commit -m "feat(desktop): record a repository's start point at the agent's first change"
```

---

### Task 5: Reading the changes

**Files:**
- Create: `electron/repo-changes.mjs`, `electron/test/repo-changes.test.mjs`

**Interfaces:**
- Consumes: the store (Task 3), `createGit` (Task 2).
- Produces:

```js
export const FILE_LIMIT = 2000;
export function checkRel(rel)   // → rel; throws Error("Invalid path") unless a non-empty relative path without ".." segments
export function createChanges({ store, git, createdAt, allow, now = () => new Date() })
// createdAt(sessionId) → ISO string | null; allow(abs) → boolean | Promise<boolean>
// returns:
//   list(sessionId)                      → { repos: RepoView[], loose: string[] }
//   commits(sessionId, root, rel)        → [{ sha, subject, date, author }]
//   diff(sessionId, root, rel, version)  → { text } | { added: true } | { tooLarge: true }
//   add(sessionId, dir)                  → { root } | { message }
//   remove(sessionId, root)              → void
// RepoView = { root, name, source, at, noCommits, error: string | null, note: string | null, truncated, files: FileView[] }
// FileView = { path, state, uncommitted, committed, touched, dirtyAtStart }
```

- `list`: repositories in recorded order, read in parallel. `files` = `git.status` joined with
  `git.commitFiles(root, base)`, sorted by path, cut at `FILE_LIMIT` (`truncated: true`). `state` comes from the
  status when the file has uncommitted changes, else from the commits. `noCommits` is true when `git.head` is null.
  `name` is the root's folder name.
- A git failure for one repository gives that view `error: <message>` and `files: []`. `NOBASE` gives
  `note: "The start point of this session no longer exists in this repository. Only uncommitted changes are shown."`
  and the status files only.
- `commits`, `diff`, `remove` throw `Error("This repository is not listed for this session.")` for a root without a
  record, and run `checkRel` on `rel`.
- `diff`: `version` is `"uncommitted"` or a full sha that is in `git.fileCommits(root, base, rel)`, else
  `Error("Unknown version")`. Uncommitted in a repository without a commit gives `{ added: true }`. (The window
  does not ask for the diff of a `?` file; it shows the content as added.)
- `add`: `{ message: "Network folders are not read." }` unless `allow(dir)`;
  `{ message: "<dir> is not inside a git repository." }`; `{ message: "<name> is already listed." }`; else a record
  `{ source: "manual", base: (createdAt(id) && await git.headAt(root, createdAt(id))) ?? await git.head(root),
  at: now().toISOString(), dirtyAtStart: [], touched: [] }` and `{ root }`.

- [ ] **Step 1: Write the failing tests** (real git in temp repositories, records written through the store):

  1. A record with `base` = the first commit, then one more commit changing `b.txt`, an uncommitted change of
     `README.md` and an untracked `u.txt`: three files; `b.txt` is `{ uncommitted: false, committed: true }`,
     `README.md` `{ uncommitted: true, committed: false }`, `u.txt` state `?`; `touched` and `dirtyAtStart` follow
     the record.
  2. A file committed after the start and changed again: `uncommitted: true, committed: true`.
  3. Two repositories, the second root deleted from disk: the first is listed with files, the second has `error`
     set and `files: []`.
  4. A git whose `status` for one root rejects with a timeout error: the same isolation.
  5. `base` set to a made-up sha: `note` set, the uncommitted files listed.
  6. 2001 untracked files: `files.length === 2000`, `truncated: true`.
  7. `commits` / `diff` for a root that is not recorded reject; `rel` of `"../x"`, `"/etc/passwd"` and `""` reject.
  8. `diff` with a sha that is not in the file's list rejects with `Unknown version`; with one that is, returns the
     text of that commit.
  9. `diff` uncommitted in a repository without commits: `{ added: true }`.
  10. `add`: a folder inside a repository whose commits have `GIT_COMMITTER_DATE` set, `createdAt` between them:
      `base` is the earlier commit and `source` is `manual`; `createdAt` null: `base` is the current `HEAD`; the
      same root again: a message; a folder in no repository: a message; `allow` false: a message and no git call.
  11. `remove` drops the record; `list` no longer has it.

- [ ] **Step 2: Run them and see them fail**

Run: `node --test electron/test/repo-changes.test.mjs`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `checkRel` and `createChanges`**

- [ ] **Step 4: Run the tests and the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/repo-changes.mjs electron/test/repo-changes.test.mjs
git commit -m "feat(desktop): list a session's changed files, their commits and diffs"
```

---

### Task 6: Wiring in the main process

**Files:**
- Modify: `electron/main.mjs`, `electron/preload.cjs`, `electron/package.json` (`build.files`)
- Create: `electron/test/fixtures/acp/changes-scenario.mjs`
- Modify: `scripts/ui-check/checks.mjs`

**Interfaces:**
- Consumes: `createGit`, `createRecordStore`, `createRepoTracker`, `createChanges`, `sessionCreatedAt`.
- Produces, on `window.api`:
  `changesList(sessionId)`, `changesCommits(sessionId, root, rel)`, `changesDiff(sessionId, root, rel, version)`,
  `changesAdd(sessionId)` (opens the folder dialog; `null` when cancelled, else `{ root }` or `{ message }`),
  `changesRemove(sessionId, root)`. Channels `changes:list`, `changes:commits`, `changes:diff`, `changes:add`,
  `changes:remove`.

- [ ] **Step 1: Write the scenario and the failing UI check**

  `changes-scenario.mjs`, one prompt: a pending `tool_call` (`kind: "edit"`, title `apply_patch`, no path), then
  its `tool_call_update` `completed` with `content: [{ type: "diff", path: "notes.txt", oldText: "", newText:
  "hello\n" }]`, an agent message, `end`.

  Check `changes-records` (`modes: ["off"]`): before the prompt, the check makes the session folder a git
  repository with one commit (`git init`, a committed `README.md`, `.scripted-agent.json` in `.gitignore`) and
  writes `notes.txt`. After the turn, `await app.ev("api.changesList(<session id>)")` has one repository whose
  `root` is the session folder, `source: "auto"`, and a file `{ path: "notes.txt", state: "?", touched: true,
  dirtyAtStart: false }`. After `app.reload()` and the replay, the list has the same `at` and still one
  repository.

- [ ] **Step 2: Run it and see it fail**

Run: `node scripts/ui-check/run.mjs changes-records`
Expected: FAIL (`api.changesList` is not a function).

- [ ] **Step 3: Wire it**

  - Instances next to `tiers`: the store on `path.join(app.getPath("userData"), "session-repos.json")`, a git with
    the default timeout for `createChanges` and one with `{ timeoutMs: 5000 }` for the tracker, both on
    `runProgram`.
  - `allow`: the rule `files:check` builds today (location table, home and `knownFolders` as trusted roots). Move it
    into one function used by `files:check`, the tracker and `createChanges`.
  - `attach()`: after `send("acp:update", …)`, `if (!entry.replaying) tracker.update(sessionId, cwd, u)`. In the
    `session/request_permission` handler, first line: `tracker.permission(sessionId, cwd, params.toolCall)`. In the
    connection's `exit` handler: `tracker.closed(sessionId)`.
  - `openSession()`: `entry.replaying = true` right after `attach`, cleared when `session/load` settles (also on
    failure). `createSession()` leaves it unset.
  - `sessions:delete`: `records.forget(sessionId)` beside `tiers.delete(sessionId)`.
  - The five handlers; `changes:add` shows `dialog.showOpenDialog(win, { title: "Repository to add", properties:
    ["openDirectory"] })` and passes the folder to `changes.add`.
  - `preload.cjs`: the five functions. `package.json` `build.files`: the four new modules.

- [ ] **Step 4: Run the check, the full suite and the packaging test**

Run: `node scripts/ui-check/run.mjs changes-records && npm test`
Expected: the check prints one passing line; `npm test` PASS (`packaging.test.mjs` included).

- [ ] **Step 5: Commit**

```bash
git add electron/main.mjs electron/preload.cjs electron/package.json electron/test/fixtures/acp/changes-scenario.mjs scripts/ui-check/checks.mjs
git commit -m "feat(desktop): record and serve a session's repository changes"
```

---

### Task 7: Diff parser and list model (window, pure)

**Files:**
- Create: `electron/renderer/diff-view.js`, `electron/renderer/changes-model.js`,
  `electron/test/diff-view.test.mjs`, `electron/test/changes-model.test.mjs`
- Modify: `electron/renderer/index.html` (two `<script>` tags before `file-preview.js`)

**Interfaces:**
- Produces `globalThis.DiffView`:
  - `parse(text) → { binary, lines }`; a line is `{ type: "hunk" | "ctx" | "add" | "del" | "note", old, new, text }`
    with `old` / `new` line numbers or `null`. Git's header lines (`diff --git`, `index`, `---`, `+++`, mode,
    similarity and rename lines) are dropped. `\ No newline at end of file` is a `note`. `binary` is true when git
    printed `Binary files … differ`.
  - `added(text) → { binary: false, lines }`: every line of `text` as `add`, numbered from 1.
  - `render(parsed, h) → HTMLElement`: `div.dv` with one `div.dv-line.<type>` per line holding two number cells and
    the text, all through `textContent`. (No test: DOM.)
- Produces `globalThis.ChangesModel`:
  - `key(root, rel) → string` (`root` null for a loose file, `rel` then its absolute path).
  - `pick(data, prevKey) → key | null`: `prevKey` when that file is still in `data`, else the first file of the
    first repository that has files, else the first loose file, else `null`.
  - `versions(file, commits) → [{ id, label, title }]`: `{ id: "uncommitted", label: "Uncommitted", title: "" }`
    when `file.uncommitted`, then per commit `{ id: sha, label: "<7 chars> <subject>", title: "<author> · <date>" }`.
  - `splitName(rel) → { dir, name }` (`"electron/main.mjs"` → `{ dir: "electron/", name: "main.mjs" }`).
  - `locate(data, abs, platform) → { root, rel } | null`: the repository of `data` that contains the absolute path
    (longest root wins; case-insensitive and either slash on `win32`), `rel` with forward slashes.

- [ ] **Step 1: Write the failing tests**

```js
const DIFF = [
  "diff --git a/a.txt b/a.txt", "index 1..2 100644", "--- a/a.txt", "+++ b/a.txt",
  "@@ -1,3 +1,3 @@ fn()", " one", "-two", "+TWO", " three",
  "@@ -10,2 +10,3 @@", " ten", "+new", " eleven", "\\ No newline at end of file", "",
].join("\n");
test("parse: numbers, hunks, note", () => {
  const { binary, lines } = DiffView.parse(DIFF);
  assert.equal(binary, false);
  assert.deepEqual(lines.map((l) => [l.type, l.old, l.new, l.text]), [
    ["hunk", null, null, "@@ -1,3 +1,3 @@ fn()"], ["ctx", 1, 1, "one"], ["del", 2, null, "two"], ["add", null, 2, "TWO"], ["ctx", 3, 3, "three"],
    ["hunk", null, null, "@@ -10,2 +10,3 @@"], ["ctx", 10, 10, "ten"], ["add", null, 11, "new"], ["ctx", 11, 12, "eleven"],
    ["note", null, null, "\\ No newline at end of file"],
  ]);
});
test("parse: added file, deleted file, binary, empty", () => {
  assert.deepEqual(DiffView.parse("diff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n@@ -0,0 +1 @@\n+hi\n").lines.map((l) => [l.type, l.new]), [["hunk", null], ["add", 1]]);
  assert.deepEqual(DiffView.parse("diff --git a/g b/g\ndeleted file mode 100644\n--- a/g\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n").lines.map((l) => [l.type, l.old]), [["hunk", null], ["del", 1]]);
  assert.equal(DiffView.parse("diff --git a/i.png b/i.png\nindex 1..2\nBinary files a/i.png and b/i.png differ\n").binary, true);
  assert.deepEqual(DiffView.parse(""), { binary: false, lines: [] });
});
test("parse: a line that starts with +++ inside a hunk is content", () => {
  const { lines } = DiffView.parse("--- a/x\n+++ b/x\n@@ -1 +1 @@\n---- old\n++++ new\n");
  assert.deepEqual(lines.slice(1).map((l) => [l.type, l.text]), [["del", "--- old"], ["add", "+++ new"]]);
});
test("added", () => {
  assert.deepEqual(DiffView.added("a\nb\n").lines.map((l) => [l.type, l.new, l.text]), [["add", 1, "a"], ["add", 2, "b"]]);
});
```

  `changes-model.test.mjs`: `pick` keeps a key that is still listed, falls to the first file when it is gone, to a
  loose file when no repository has files, and to `null` for empty data; `versions` with and without `uncommitted`;
  `splitName` for a nested path and a bare name; `locate` picks the inner of two nested roots, returns `null`
  outside both, and matches `C:\Repo\a\b.txt` to root `c:/repo` on `win32` with `rel: "a/b.txt"`.

- [ ] **Step 2: Run them and see them fail**

Run: `node --test electron/test/diff-view.test.mjs electron/test/changes-model.test.mjs`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement both modules and add the script tags**

- [ ] **Step 4: Run the tests and the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/renderer/diff-view.js electron/renderer/changes-model.js electron/renderer/index.html electron/test/diff-view.test.mjs electron/test/changes-model.test.mjs
git commit -m "feat(desktop): unified diff parser and the changes list model"
```

---

### Task 8: The browser

**Files:**
- Modify: `electron/renderer/file-preview.js`, `electron/renderer/index.html`, `electron/renderer/style.css`,
  `electron/renderer/app.js`, `electron/renderer/file-links.js`, `electron/test/file-links.test.mjs`,
  `electron/test/file-access.test.mjs`, `scripts/ui-check/checks.mjs`

**Interfaces:**
- Consumes: `api.changes*` (Task 6), `DiffView`, `ChangesModel` (Task 7), `api.readFile`, `api.watchFile`.
- Produces: `createFilePreview({ api, h, md, onStatus })` → `{ open(view, href, base), show(view), close(),
  forget(sessionId), isOpen }`. `count` and `onChange` are gone.

Behaviour is the spec's section 5 without the split view and the disk following, which are Task 9. Decisions the
spec leaves open:

- **Markup** inside `#file-preview`: the list title row holds `Changes`, `⟳` (`data-act="refresh"`, title "Read the
  repositories again") and `+` (`data-act="add"`, title "Add a repository"). Below the header: `.fp-versions` (the
  strip), then `.fp-panes` holding `.fp-diff` and the existing `.fp-content`.
- **Two modes of the content area.** `change`: a list row is selected; the strip and `.fp-diff` show, `.fp-content`
  is hidden. `file`: opened from a chat link; `.fp-content` shows the file as today (line mark, confirmation for a
  file outside the session folder), `.fp-diff` is hidden; when `ChangesModel.locate` finds the file in the list its
  row is selected and the strip shows, and choosing a strip entry switches to `change`.
- **Rows.** State letter; `●` (title "Edited by the agent") when `touched`; `⏱` (title "Changed before the
  session") when `dirtyAtStart`; `✓` (title "Committed, no uncommitted change now") when `committed &&
  !uncommitted`; the name, with the folder part in muted text before it, shortened from its start so the name stays
  visible. A repository header: `▾`/`▸`, name, title = root and start time, `✕` (title "Remove from the list").
  `error` and `note` are shown as text under the header; `truncated` adds "Only the first 2000 files are shown."
- **Loose files** are a last group `No repository`, rows with `●` and the file name (title = full path). Selecting
  one shows its content in `.fp-content` only: no strip, no diff.
- **Selecting a row** asks `api.changesCommits`, builds the strip with `ChangesModel.versions`, selects its first
  entry and asks `api.changesDiff` for it. A file with no entry (a `?` file has only `Uncommitted`) never shows an
  empty strip.
- **Loading.** `show(view)` and `⟳` call `api.changesList`; until it answers the list shows `Reading changes…`
  above what it had. A newer request, a close or another session makes an older answer stale (sequence counter, as
  today's `seq`). After it: `ChangesModel.pick` with the previous key, and that file is loaded.
- **Empty.** No repository and no loose file: "No repository is recorded for this session yet." and a button
  `+ Add repository`.
- **Diff pane messages:** `Binary file.`, `This diff is larger than 2 MB. Use Show file.`, `No changes.`; a `?`
  file or `{ added: true }` is its content from `api.readFile` through `DiffView.added`.
- **Reading a listed file's content:** `api.readFile(root, <absolute path>, { viewingCwd: view.cwd, confirmed:
  true })`.
- **`+`:** `api.changesAdd`; a `{ message }` goes to the error line of the browser, a `{ root }` reloads the list.
- **`app.js`:** the header button is always shown, reads `Changes`, title "Changes in this session's
  repositories"; `updateFilesBtn` and its calls are removed. `localStorage.removeItem("copilot-sessions.files.v1")`
  once at start.
- **`file-links.js`:** `parseRecent`, `recentAdd`, `recentRemove` and their tests are removed.

- [ ] **Step 1: Write the failing tests**

  `file-access.test.mjs`, pinning what the browser relies on: in a temp folder, files named `50% off.txt`,
  `notes#1.md`, `log:12` (skip this one on `win32`) and `zażółć gęślą.txt` are each returned by
  `resolvePreview({ baseCwd: dir, target: <absolute path>, viewingCwd: dir, confirmed: true }, …)` with their own
  text. If one fails, fix `resolveTarget` so the literal path wins.

  UI check `changes-browser` (`modes: ["off"]`, `changes-scenario.mjs`, the repository prepared as in
  `changes-records`, plus an uncommitted change of `README.md` and one more commit that changes `b.txt`):

  1. A click on the `Changes` button opens `#file-preview`; the list has one group named after the session folder
     with rows `README.md` (`M`), `b.txt` (`M`, `✓`) and `notes.txt` (`?`, `●`).
  2. `README.md` selected: the strip's first entry is `Uncommitted`; `.fp-diff` has a `.dv-line.del` and a
     `.dv-line.add`.
  3. `b.txt` selected: the strip has no `Uncommitted` and one commit entry; its diff has an `add` line.
  4. `notes.txt` selected: every line is `add`.
  5. `Esc` closes. A click on the `notes.txt` path in the tool call's diff opens the browser with `.fp-content`
     showing `hello`, `.fp-diff` hidden, and the `notes.txt` row active.
  6. After `git commit` of everything from the check and `⟳`: `README.md` has `✓`, and the row that was selected is
     still selected.

- [ ] **Step 2: Run them and see them fail**

Run: `node --test electron/test/file-access.test.mjs; node scripts/ui-check/run.mjs changes-browser`
Expected: the UI check FAILS (no `Changes` button).

- [ ] **Step 3: Rebuild `file-preview.js`, the markup, the styles and the `app.js` call sites**

  Keep `codeView`, `markdownView`, `renderFile`, the confirmation, the keyboard handling and the copy handling.
  Colours of added and removed lines are those of `pre.diff .add` / `.del` in `style.css`.

- [ ] **Step 4: Run everything**

Run: `npm test && node scripts/ui-check/run.mjs`
Expected: PASS; every UI check passes (the earlier checks must not depend on the old `Files (n)` button).

- [ ] **Step 5: Commit**

```bash
git add electron/renderer electron/test/file-links.test.mjs electron/test/file-access.test.mjs scripts/ui-check/checks.mjs
git commit -m "feat(desktop): the file preview becomes a changes browser with git diffs"
```

---

### Task 9: Split view, following the disk, README

**Files:**
- Modify: `electron/renderer/file-preview.js`, `electron/renderer/index.html`, `electron/renderer/style.css`,
  `electron/renderer/changes-model.js`, `electron/test/changes-model.test.mjs`, `scripts/ui-check/checks.mjs`,
  `electron/README.md`

**Interfaces:**
- Consumes: Task 8's browser.
- Produces `ChangesModel.clampRatio(value) → number`: a finite number clamped to 0.2–0.8, else 0.5; and
  `ChangesModel.parsePrefs(text) → { showFile: boolean, ratio: number }` (`{ showFile: false, ratio: 0.5 }` for
  missing or broken text). Stored in localStorage `copilot-sessions.changes.v1`, for all sessions.

Behaviour (spec section 5, "Full content" and "Following the disk"):

- A header button `data-act="file"`, `Show file` / `Hide file`, only in `change` mode. On: `.fp-content` shows the
  selected file's current content to the right of `.fp-diff`, with a divider `.fp-split` between them. The divider
  drags with pointer capture (as `dragPanel` in `app.js`); the ratio is the diff pane's share of `.fp-panes`.
- The pane shows the file on disk whichever strip entry is selected. A deleted file: `This file is deleted.`
- The file on show is watched (`api.watchFile`) in both modes. On `files:changed` for it: its content is read again
  as today, and in `change` mode with `Uncommitted` selected its diff is asked for again; both keep their scroll
  positions. The list is not reloaded.
- `Ctrl/Cmd+A` selects the pane that has the focus.

- [ ] **Step 1: Write the failing tests**

  `changes-model.test.mjs`: `clampRatio(0.1) === 0.2`, `clampRatio(0.95) === 0.8`, `clampRatio(NaN) === 0.5`,
  `clampRatio("x") === 0.5`; `parsePrefs(null)`, `parsePrefs("{")` give the defaults; `parsePrefs('{"showFile":true,
  "ratio":0.3}')` gives `{ showFile: true, ratio: 0.3 }`.

  UI check `changes-split` (`modes: ["off"]`, set up as `changes-browser`):

  1. With `README.md` selected, `Show file` shows `.fp-content` beside `.fp-diff`, both with a width above 100 px,
     and the button reads `Hide file`.
  2. Dragging `.fp-split` 200 px to the left makes `.fp-diff` narrower by 200 px (±2).
  3. After `app.reload()` and reopening the browser the pane is shown and the ratio is the same (±0.01).
  4. The check appends a line to `README.md` on disk: within 2 s `.fp-content` contains it and `.fp-diff` has one
     more `add` line, while the list's rows are the same nodes as before.

- [ ] **Step 2: Run them and see them fail**

Run: `node --test electron/test/changes-model.test.mjs; node scripts/ui-check/run.mjs changes-split`
Expected: FAIL.

- [ ] **Step 3: Implement the split, the preferences and the refresh of the diff**

- [ ] **Step 4: Update `electron/README.md`**

  Replace the "File links and preview" section's description of the list (20 files per session) with the changes
  browser: what starts the tracking, what is listed, the marks, versions, `Show file`, `+` and `✕`, `⟳`, and the
  limits (2 MB per diff, 2000 files, read-only git, no background refresh). Correct the bullet near the top of the
  file that says file links open in the default app.

- [ ] **Step 5: Run everything**

Run: `npm test && node scripts/ui-check/run.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add electron/renderer electron/test/changes-model.test.mjs scripts/ui-check/checks.mjs electron/README.md
git commit -m "feat(desktop): the whole file beside its diff, and the file on show follows the disk"
```

---

## After the last task

- Manual check with real Copilot in a session whose folder holds two repositories: an edit in each, a commit from
  the agent's shell, `+` for a third repository, a model that edits with a tool other than `apply_patch` (spec, "Not
  verified yet").
- Review findings that are not fixed go to `docs/superpowers/backlog/2026-11-22-changes-browser-deferred.md` before
  the worktree is removed (repo rule in `CLAUDE.md`), together with the spec's "Not verified yet" items that are
  still open (Windows, macOS).
- The version tag goes on the merge commit on `main`.
