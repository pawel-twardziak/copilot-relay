# Changes Tree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The changes browser lists files that unfold to their commits, shows the right side as `Diff`, `File` or
`Both`, and keeps a second list of files opened from chat links that the session did not change.

**Architecture:** No new module. The record store gains an `opened` list per session and two IPC calls expose it.
The pure list model (`changes-model.js`) gets the new rules (stored view, which view a click shows, which opened
files are listed, labels), `changes-list.js` draws the tree and the second list, and `file-preview.js` replaces the
version strip and `Show file` with a selection pair (file, version) and a three-part control.

**Tech Stack:** Node 22 (`node --test`), Electron main + classic-script renderer modules (no bundler), real `git`
in tests through `electron/test/git-helper.mjs`, the CDP UI checks in `scripts/ui-check`.

**Spec:** `docs/superpowers/specs/2026-11-23-changes-tree-design.md`. Read it first; this plan does not repeat it.
It builds on `docs/superpowers/specs/2026-11-22-changes-browser-design.md`.

**Before Task 1:** the spec is on `main` (`66754f8`). Create branch `feat/changes-tree` from `main` in a worktree
(superpowers:using-git-worktrees) and commit this plan there as its first commit. If the plan is still an untracked
file in the main checkout then, move it into the worktree instead of copying it, so the merge finds nothing to
overwrite.

## Global Constraints

- No new dependency. No git call per listed file when the list is read: commits are read only for a file that is
  unfolded or whose commit is selected.
- File, diff and commit text reach the DOM only as `textContent` (or through the existing code and Markdown views).
- A file on a network location is never read; a file outside the session folder is shown only after the
  confirmation, except an `Opened files` row whose real path is still the recorded one.
- Limits: 200 opened files stored per session, the newest 20 that pass the filter are listed.
- Renderer modules stay classic scripts that set `globalThis.<Name>` and export through `module.exports`.
- UI copy, exact: control `Diff`, `File`, `Both`; heading `Opened files` with the tooltip `Files opened from links in
  the chat that this session has not changed`; `Reading…`; `No commits.`; `No changes.`; `Remove from the list`;
  `This diff is larger than 2 MB. Use File.`
- DOM names the UI checks rely on: `.fp-arrow`, `.fp-commits`, `.fp-commit`, `.fp-row.active`, `.fp-row.current`,
  `.fp-opened`, `.fp-opened-title`, `.fp-forget`, `.fp-view button[data-view]`.
- Commit style `type(scope): sentence`, scope `desktop`.
- Full suite: `npm test` from the repo root (727 tests pass before this plan). UI checks:
  `node scripts/ui-check/run.mjs <name>` exits 0. Tests never run git against this working repository.

## Review Focus

- **An unchanged file inside a recorded repository, opened from a link.** Its path is under a listed root but it is
  not one of that repository's files: it belongs in `Opened files`. (Task 2)
- **A file whose commits cannot be listed** (start point gone gives `[]`, git fails): the unfolded file shows
  `No commits.` or the error text, never an endless `Reading…`. (Task 3)
- **Unfolding a file and refreshing at once, or switching session while commits load.** The late answer must not
  paint under another list; the file ends up unfolded with its commits. (Task 3)
- **Stored preferences in the old shape or broken** (`{"showFile":true,"ratio":9}`, `{"view":"sideways"}`, `{`):
  the browser opens in a valid view with a clamped ratio. (Task 4)
- **An opened file that is gone from disk, and the same file under another letter case on Windows.** The row stays
  and says `This file is deleted.`; the store keeps one entry. (Tasks 1 and 5)

---

### Task 0: Gate. Compaction keeps the session id

Not a subagent task: it needs the real app and real Copilot (run by the owner, or by the controller with them).

- [ ] **Step 1:** `npm run app`; in a scratch git repository start a session and have the agent edit a file, so
  `Changes` lists it. Note the session id (the key in `session-repos.json` in the app's `userData` folder).
- [ ] **Step 2:** send `/compact` as a message. If Copilot does not accept it over ACP, write that down: only its
  automatic compaction then applies and this gate cannot be forced; continue and leave the check open in the spec.
- [ ] **Step 3:** compare. Pass: `session-repos.json` still has that id, `~/.copilot/session-state` has no new
  folder for the conversation, and after closing and reopening the session `Changes` lists the file. Also note
  whether the messages from before the compaction, with their file links, are still in the chat.
- [ ] **Step 4:** write the result and its date into the spec's "Checks by hand". **If the id changed: stop and
  report to the owner** (what the records are keyed by becomes a design question).

### Task 1: Opened files in the record store and over IPC

**Files:**
- Modify: `electron/repo-records.mjs`, `electron/repo-changes.mjs` (`list`), `electron/main.mjs` (the
  `changes:*` handlers), the preload (beside `changesRemove`)
- Test: `electron/test/repo-records.test.mjs`, `electron/test/repo-changes.test.mjs`,
  `scripts/ui-check/checks.mjs` (`changes-records`)

**Interfaces:**
- Produces (store): `session(id)` returns `{ repos, loose, opened }`; `addOpened(sessionId, abs, platform =
  process.platform): void`; `removeOpened(sessionId, abs, platform = process.platform): boolean`.
- Produces (changes): `list(sessionId)` resolves `{ repos, loose, opened }`, `opened` as stored.
- Produces (IPC / preload): `changes:opened` → `api.changesOpened(sessionId, path)`; `changes:forget-opened` →
  `api.changesForgetOpened(sessionId, path)`.

- [ ] **Step 1: Write the failing store tests**

```js
test("opened files: newest first, moved to the front, capped at 200, removed, kept in the file", (t) => {
  const file = tempFile(t);
  const store = createRecordStore(file);
  assert.deepEqual(store.session("s1"), { repos: [], loose: [], opened: [] });
  for (const p of ["/a.txt", "/b.txt", "/a.txt", "", 5]) store.addOpened("s1", p);
  assert.deepEqual(store.session("s1").opened, ["/a.txt", "/b.txt"]);
  for (let i = 0; i < 205; i++) store.addOpened("s1", `/f${i}.txt`);
  const { opened } = store.session("s1");
  assert.equal(opened.length, 200);
  assert.equal(opened[0], "/f204.txt");
  assert.equal(opened.includes("/a.txt"), false);
  assert.equal(store.removeOpened("s1", "/f204.txt"), true);
  assert.equal(store.removeOpened("s1", "/nope"), false);
  assert.equal(createRecordStore(file).session("s1").opened[0], "/f203.txt");
  store.forget("s1");
  assert.deepEqual(store.session("s1").opened, []);
});

test("opened files: one entry per file whatever the letter case on win32", (t) => {
  const store = createRecordStore(tempFile(t));
  store.addOpened("w", "C:\\Dir\\A.txt", "win32");
  store.addOpened("w", "c:\\dir\\a.txt", "win32");
  assert.deepEqual(store.session("w").opened, ["c:\\dir\\a.txt"]); // the newest spelling
  assert.equal(store.removeOpened("w", "C:\\DIR\\A.TXT", "win32"), true);
  store.addOpened("l", "/x/A.txt", "linux");
  store.addOpened("l", "/x/a.txt", "linux");
  assert.deepEqual(store.session("l").opened, ["/x/a.txt", "/x/A.txt"]);
});

test("an entry without opened, or with a malformed one, loads as its strings", (t) => {
  const file = tempFile(t);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ s1: { repos: [], loose: [] }, s2: { repos: [], loose: [], opened: ["/a", 5, null] } }));
  const store = createRecordStore(file);
  assert.deepEqual(store.session("s1").opened, []);
  assert.deepEqual(store.session("s2").opened, ["/a"]);
});
```

Update the existing assertions that compare a whole `session()` value: they gain `opened: []`.

- [ ] **Step 2:** `node --test electron/test/repo-records.test.mjs` fails with `store.addOpened is not a function`.
- [ ] **Step 3:** implement in `repo-records.mjs`: `opened` loaded with `strings()`, `OPENED_LIMIT = 200`, the two
  methods (same file: equal text, on win32 compared lower-cased), `entry()` and `session()` carrying `opened`.
- [ ] **Step 4:** in `repo-changes.test.mjs` add `list: the session's opened files, as stored` (with the file's
  existing store and changes setup: `store.addOpened("s1", "/x/a.txt")`, then
  `assert.deepEqual((await changes.list("s1")).opened, ["/x/a.txt"])`); make `list` return it.
- [ ] **Step 5:** `main.mjs`: `changes:opened` checks `knownSession(sessionId)`, throws
  `This file was not opened in the preview` unless `path` is a string in `readablePaths`, then
  `records.addOpened`. `changes:forget-opened` checks `knownSession` and calls `records.removeOpened`. Add both to
  the preload.
- [ ] **Step 6:** extend the UI check `changes-records`, after the first `live` assertions:

```js
const opened = (p) => `api.changesOpened(${JSON.stringify(id)}, ${JSON.stringify(p)})`;
const readme = path.join(repo.root, "README.md");
assert.deepStrictEqual(live.opened, [], "nothing opened yet");
assert.match(await app.ev(`${opened(readme)}.then(() => "ok", (e) => e.message)`), /not opened in the preview/, "a path that was not read");
await app.ev(`api.readFile(${JSON.stringify(work)}, "README.md", { viewingCwd: ${JSON.stringify(work)} })`);
await app.ev(opened(readme));
assert.deepStrictEqual((await app.ev(list)).opened, [readme], "the opened file");
await app.reload();
assert.deepStrictEqual((await app.ev(list)).opened, [readme], "after the replay");
await app.ev(`api.changesForgetOpened(${JSON.stringify(id)}, ${JSON.stringify(readme)})`);
assert.deepStrictEqual((await app.ev(list)).opened, [], "forgotten");
```

  (Place the reload part so it does not disturb the check's own reload assertions.)
- [ ] **Step 7:** `npm test` passes; `node scripts/ui-check/run.mjs changes-records` exits 0.
- [ ] **Step 8:** commit `feat(desktop): the record store keeps the files opened from links`.

### Task 2: The list model's new rules

**Files:**
- Modify: `electron/renderer/changes-model.js`
- Test: `electron/test/changes-model.test.mjs`

**Interfaces (all on `ChangesModel`, pure):**
- `viewFor(prefView, kind) → view`. `kind`: `"change"` (a changed file's row) gives `prefView`; `"commit"` gives
  `prefView`, but `"diff"` when it is `"file"`; `"nodiff"` (loose row, opened row, a link) gives `"file"`.
- `samePath(a, b, platform) → boolean`: equal text; on `"win32"` without case and with `/` equal to `\`.
- `openedShown(data, platform, limit = 20) → string[]`: `data.opened` in order, without every path that is hidden,
  cut to `limit`. Hidden: `locate()` finds a repository **and** that repository's `files` holds the returned `rel`,
  or `data.loose` holds the path by `samePath`.
- `openedLabel(abs, cwd, platform) → { dir, name }`: relative to `cwd` when `abs` is inside it (case rule and
  separators of `samePath`), else absolute; `dir` ends with its separator, `""` when there is none.
- `commitLabel(c) → { label: "<sha7> <subject>", title: "<author> · <date>" }`.
- `keepVersion(version, commits) → version`: `"uncommitted"`, or a sha that `commits` holds, else `"uncommitted"`.
- `pick(data, prevKey, platform)`: as today, and an opened row counts: `prevKey` is kept when it is
  `key(null, p)` of a path in `openedShown`; the fallback order is first repository file, first loose file, first
  opened file, `null`.
- `versions` stays until Task 3 removes it.

- [ ] **Step 1: Write the failing tests**

```js
test("viewFor: the stored view, the diff for a commit, the file where there is no diff", () => {
  for (const v of ["diff", "file", "both"]) {
    assert.equal(ChangesModel.viewFor(v, "change"), v);
    assert.equal(ChangesModel.viewFor(v, "nodiff"), "file");
  }
  assert.equal(ChangesModel.viewFor("file", "commit"), "diff");
  assert.equal(ChangesModel.viewFor("both", "commit"), "both");
  assert.equal(ChangesModel.viewFor("diff", "commit"), "diff");
});

test("openedShown: without the files the changes list holds, the newest 20", () => {
  const data = { repos: [repo("/r", [file("a.txt")])], loose: ["/tmp/l.txt"], opened: ["/r/a.txt", "/r/docs/b.md", "/tmp/l.txt", "/else/c.txt", "/r/A.txt"] };
  // /r/docs/b.md is under a listed root but not a changed file: it stays
  assert.deepEqual(ChangesModel.openedShown(data, "linux"), ["/r/docs/b.md", "/else/c.txt", "/r/A.txt"]);
  const win = { repos: [repo("C:\\R", [file("Sub/A.txt")])], loose: ["C:\\T\\L.txt"], opened: ["c:\\r\\sub\\a.txt", "C:\\t\\l.TXT", "C:\\R\\other.txt"] };
  assert.deepEqual(ChangesModel.openedShown(win, "win32"), ["C:\\R\\other.txt"]);
  const many = { repos: [repo("/r", [file("a.txt")])], loose: [], opened: ["/r/a.txt", ...Array.from({ length: 25 }, (_, i) => `/o/${i}.txt`)] };
  const shown = ChangesModel.openedShown(many, "linux");
  assert.equal(shown.length, 20);
  assert.equal(shown[0], "/o/0.txt"); // the hidden one does not use a place
  assert.deepEqual(ChangesModel.openedShown(null, "linux"), []);
  assert.deepEqual(ChangesModel.openedShown({ repos: [], loose: [] }, "linux"), []);
});

test("openedLabel: relative inside the session folder, else absolute", () => {
  const l = ChangesModel.openedLabel;
  assert.deepEqual(l("/w/docs/b.md", "/w", "linux"), { dir: "docs/", name: "b.md" });
  assert.deepEqual(l("/w/b.md", "/w/", "linux"), { dir: "", name: "b.md" });
  assert.deepEqual(l("/work2/a.txt", "/w", "linux"), { dir: "/work2/", name: "a.txt" });
  assert.deepEqual(l("/else/c.txt", null, "linux"), { dir: "/else/", name: "c.txt" });
  assert.deepEqual(l("C:\\W\\docs\\b.md", "c:\\w", "win32"), { dir: "docs\\", name: "b.md" });
});

test("samePath, commitLabel, keepVersion", () => {
  assert.equal(ChangesModel.samePath("/a/B", "/a/b", "linux"), false);
  assert.equal(ChangesModel.samePath("C:\\a\\B", "c:/A/b", "win32"), true);
  const c = { sha: "a1b2c3d4e5f6", subject: "fix: x", author: "Ann", date: "2026-11-22 10:00" };
  assert.deepEqual(ChangesModel.commitLabel(c), { label: "a1b2c3d fix: x", title: "Ann · 2026-11-22 10:00" });
  assert.equal(ChangesModel.keepVersion("uncommitted", []), "uncommitted");
  assert.equal(ChangesModel.keepVersion("a1b2c3d4e5f6", [c]), "a1b2c3d4e5f6");
  assert.equal(ChangesModel.keepVersion("gone", [c]), "uncommitted");
});

test("pick: an opened row is kept while it is listed, and is the last fallback", () => {
  const k = ChangesModel.key;
  assert.equal(ChangesModel.pick({ repos: [], loose: [], opened: ["/o/x.txt"] }, null, "linux"), k(null, "/o/x.txt"));
  const d = { repos: [repo("/r", [file("a.txt")])], loose: [], opened: ["/o/x.txt", "/r/a.txt"] };
  assert.equal(ChangesModel.pick(d, k(null, "/o/x.txt"), "linux"), k(null, "/o/x.txt"));
  assert.equal(ChangesModel.pick(d, k(null, "/r/a.txt"), "linux"), k("/r", "a.txt")); // hidden: it moved up
});
```

  The existing tests stay green (`pick` without a platform behaves as before for data without `opened`;
  `parsePrefs` changes in Task 4).
- [ ] **Step 2:** `node --test electron/test/changes-model.test.mjs` fails on the new names.
- [ ] **Step 3:** implement the functions and export them.
- [ ] **Step 4:** the test file passes; `npm test` passes.
- [ ] **Step 5:** commit `feat(desktop): the changes model knows the three views and the opened files`.

### Task 3: Files unfold to their commits; the version strip goes

**Files:**
- Modify: `electron/renderer/changes-list.js`, `electron/renderer/file-preview.js`,
  `electron/renderer/index.html` (remove `.fp-versions`), `electron/renderer/style.css`,
  `electron/renderer/changes-model.js` (remove `versions` and its test)
- Create: `electron/test/changes-list.test.mjs`
- Test: `scripts/ui-check/checks.mjs` (`changes-browser`, and the strip lines of `changes-split`)

**Interfaces:**
- Consumes: `ChangesModel.commitLabel`, `keepVersion`, `pick`.
- Produces: `ChangesList.render(data, { h, sel, isShut, isUnfolded, commitsOf, opened = [], on })`
  - `sel`: `{ key, version } | null`; `isUnfolded(key) → boolean`;
  - `commitsOf(key) → undefined | "loading" | { error: string } | Array<{ sha, subject, author, date }>`;
  - `on`: `{ select(key), commit(key, sha), unfold(key), toggle(foldId), remove(root), add(), forget(path) }`
    (`opened` and `on.forget` are drawn in Task 5).
- Produces (`file-preview.js` state, used by Tasks 4 and 5): `sel` (`{ key, version } | null`, replacing `selKey`,
  `versions`, `version`); `select(key, version = "uncommitted", showDiff = true)`; `unfolded` (a `Set` of
  `${sessionId}\n${key}`); `commitCache` (a `Map` key → the `commitsOf` values, emptied by every list answer).

DOM, per file row: `.fp-row` whose first child is `.fp-arrow` (`▸` or `▾` when the file's `committed` is true,
empty otherwise and for loose rows; its click calls `on.unfold(key)` and stops the row's click). `.active` when
`sel` is this file's `uncommitted`, `.current` when `sel` is one of its commits. Under an unfolded file a
`.fp-commits` block: one `.fp-commit` per commit (label and tooltip of `commitLabel`, `.active` when selected, click
calls `on.commit(key, sha)`), or a `.fp-note` reading `Reading…`, the error text (`.fp-note err`), or `No commits.`

- [ ] **Step 1: Write the failing list tests** (`electron/test/changes-list.test.mjs`)

```js
const require = createRequire(import.meta.url);
const ChangesModel = require("../renderer/changes-model.js"); // sets globalThis.ChangesModel for changes-list.js
const ChangesList = require("../renderer/changes-list.js");
const h = (tag, props, ...kids) => ({ tag, props: props ?? {}, kids: kids.flat(Infinity).filter((k) => k != null && k !== false && k !== "") });
const all = (n, cls, out = []) => {
  if (n && typeof n === "object") {
    if (String(n.props.class ?? "").split(" ").includes(cls)) out.push(n);
    n.kids.forEach((k) => all(k, cls, out));
  }
  return out;
};
const text = (n) => (typeof n === "string" ? n : n.kids.map(text).join(""));
const file = (p, extra = {}) => ({ path: p, state: "M", uncommitted: true, committed: false, touched: false, dirtyAtStart: false, ...extra });
const data = { repos: [{ root: "/r", name: "r", files: [file("a.txt", { committed: true }), file("b.txt")] }], loose: ["/tmp/l.txt"] };
const KA = ChangesModel.key("/r", "a.txt");
const commits = [{ sha: "a1b2c3d4", subject: "two", author: "Ann", date: "d2" }, { sha: "e5f6a7b8", subject: "one", author: "Bob", date: "d1" }];
const draw = (over = {}) => ({ tag: "root", props: {}, kids: ChangesList.render(data, { h, sel: null, isShut: () => false, isUnfolded: () => false, commitsOf: () => undefined, on: {}, ...over }) });

test("an arrow only for a file with commits; folded shows none of them", () => {
  const root = draw();
  assert.deepEqual(all(root, "fp-row").map((r) => text(all(r, "fp-arrow")[0])), ["▸", "", ""]);
  assert.equal(all(root, "fp-commit").length, 0);
});

test("an unfolded file lists its commits, newest first, and the selection marks one row", () => {
  const root = draw({ sel: { key: KA, version: "e5f6a7b8" }, isUnfolded: (k) => k === KA, commitsOf: () => commits });
  assert.deepEqual(all(root, "fp-commit").map(text), ["a1b2c3d two", "e5f6a7b one"]);
  assert.equal(all(root, "fp-commit")[1].props.title, "Bob · d1");
  assert.deepEqual(all(root, "active").map(text), ["e5f6a7b one"]);
  assert.equal(all(root, "current").length, 1); // its file row
  assert.equal(text(all(all(root, "fp-row")[0], "fp-arrow")[0]), "▾");
  const plain = draw({ sel: { key: KA, version: "uncommitted" } });
  assert.equal(all(plain, "active").length, 1);
  assert.equal(all(plain, "current").length, 0);
});

test("an unfolded file whose commits are loading, failed or none", () => {
  const notes = (value) => all(draw({ isUnfolded: (k) => k === KA, commitsOf: () => value }), "fp-commits")[0];
  assert.equal(text(notes("loading")), "Reading…");
  assert.equal(text(notes(undefined)), "Reading…");
  assert.equal(text(notes({ error: "git failed" })), "git failed");
  assert.equal(all(notes({ error: "git failed" }), "err").length, 1);
  assert.equal(text(notes([])), "No commits.");
});

test("the arrow unfolds without selecting; the row and a commit select", () => {
  const calls = [];
  const on = { select: (k) => calls.push(["select", k]), unfold: (k) => calls.push(["unfold", k]), commit: (k, sha) => calls.push(["commit", k, sha]) };
  const root = draw({ on, isUnfolded: (k) => k === KA, commitsOf: () => commits });
  let stopped = false;
  all(root, "fp-arrow")[0].props.onclick({ stopPropagation: () => (stopped = true) });
  all(root, "fp-row")[0].props.onclick({});
  all(root, "fp-commit")[0].props.onclick({});
  assert.equal(stopped, true);
  assert.deepEqual(calls, [["unfold", KA], ["select", KA], ["commit", KA, "a1b2c3d4"]]);
});
```

- [ ] **Step 2:** the file fails (`fp-arrow` not found).
- [ ] **Step 3:** rework `ChangesList.render` to the interface and DOM above; styles for the new classes (commit
  rows indented under their file, the weaker `.current` mark, the arrow's fixed width).
- [ ] **Step 4:** rework `file-preview.js`:
  - the strip (`stripEl`, `renderStrip`, `versions`, `version`) is removed; `sel` and `select` as in Interfaces;
  - a file row's click selects `uncommitted`: the diff as today, and `No changes.` without a git call when the
    file's `uncommitted` is false; a commit's click selects it and loads its diff;
  - `on.unfold` toggles the file in `unfolded` and, on the first unfold, sets `commitCache` to `"loading"`, asks
    `api.changesCommits`, stores the answer or `{ error }`, and redraws. An answer for another list load or session
    is dropped (use the list's sequence);
  - a list answer empties `commitCache`, then for each unfolded file that is still listed reads its commits again.
    With a commit selected, that file's commits are read too and `sel.version = keepVersion(...)`; when it fell
    back, the uncommitted diff is shown;
  - `forget(sessionId)` also drops that session's `unfolded` entries;
  - `tooLarge` text: `This diff is larger than 2 MB. Use File.`
- [ ] **Step 5:** update the UI check `changes-browser` (helper `fpCommits(rel)`: labels and `active` of the
  `.fp-commit` rows under that file; `fpStrip` is removed). It asserts, in order:
  - README.md: arrow text `""`, row `.active`, its diff has `del` and `add` (the copy assertion stays);
  - b.txt: arrow `▸`; a click on the row gives `.fp-diff .fp-msg` reading `No changes.` and no `.fp-commit`;
  - a click on b.txt's arrow: `fpCommits("b.txt")` has one entry matching `/^[0-9a-f]{7} second$/`, not active, and
    b.txt's row is still `.active`;
  - a click on that commit: it is `.active`, b.txt's row is `.current` and not `.active`, the diff has `add`;
  - notes.txt is all `add`; the link part stays (notes.txt alone, its row `.active`, no diff pane);
  - after the `third` commit and `⟳`: README.md's flags are `✓` and its arrow `▸`; with b.txt's commit selected
    before `⟳`, it is still `.active` after it;
  - README.md's arrow and `⟳` clicked in the same evaluation: once the list settles, `fpCommits("README.md")` has
    one entry ending in ` third` and no `.fp-note.err` is in the list.
  In `changes-split`, the two places that click `.fp-version` click notes.txt's row instead (`fpSelect`).
- [ ] **Step 6:** `npm test` passes; `node scripts/ui-check/run.mjs changes-browser changes-split` exits 0.
- [ ] **Step 7:** commit `feat(desktop): a file in the changes list unfolds to its commits`.

### Task 4: Diff, File, Both

**Files:**
- Modify: `electron/renderer/file-preview.js`, `electron/renderer/changes-model.js` (`parsePrefs`),
  `electron/renderer/index.html`, `electron/renderer/style.css`
- Test: `electron/test/changes-model.test.mjs`, `scripts/ui-check/checks.mjs` (`changes-split` rewritten, one
  assertion in `changes-browser`)

**Interfaces:**
- Consumes: `ChangesModel.viewFor`; `sel`, `select` from Task 3.
- Produces: `ChangesModel.parsePrefs(text) → { view: "diff" | "file" | "both", ratio }`: a valid `view` wins; else
  `showFile === true` gives `"both"`; else `"diff"`. `prefs = { view, ratio }` under the existing key `copilot-sessions.changes.v1`; `shown` (the view of
  the current showing, `null` with nothing on show); markup in place of the `data-act="file"` button:
  `<div class="fp-view" role="group" aria-label="View" hidden>` with three buttons `data-view="diff|file|both"`
  reading `Diff`, `File`, `Both`; the one equal to `shown` has class `active`.

Rules (spec, "Right side" and "Files without a diff, and links"):
- `shown = viewFor(prefs.view, kind)` at every selection: `"change"` for a changed file's row, `"commit"` for a
  commit row, `"nodiff"` for a loose row and for a link. Nothing is saved by a selection.
- A click on the control sets `prefs.view` and `shown` to it and saves. `.fp-view` is hidden with nothing on show.
- Panes: diff pane visible for `diff` and `both`, file pane for `file` and `both`, divider and ratio for `both`.
- The file is always read (the watch needs it) and painted when its pane shows. The diff is read when its pane
  first shows for the current `sel`, not before. A row without a diff says `No changes.` in the diff pane.
- `Open in system app` opens the file on show (`cur.path`) in every view. `Ctrl/Cmd+A` selects in the file pane
  when it shows and either the diff pane is hidden or the focus is inside the file pane; else in the diff.

- [ ] **Step 1: Replace the model's `parsePrefs` test**, see it fail, implement, see it pass:

```js
test("parsePrefs: the view and the ratio, old and broken values", () => {
  const p = (v) => ChangesModel.parsePrefs(JSON.stringify(v));
  assert.deepEqual(ChangesModel.parsePrefs(null), { view: "diff", ratio: 0.5 });
  assert.deepEqual(ChangesModel.parsePrefs("{"), { view: "diff", ratio: 0.5 });
  assert.deepEqual(p({ view: "both", ratio: 0.3 }), { view: "both", ratio: 0.3 });
  assert.deepEqual(p({ view: "file" }), { view: "file", ratio: 0.5 });
  assert.deepEqual(p({ showFile: true, ratio: 9 }), { view: "both", ratio: 0.8 });
  assert.deepEqual(p({ showFile: false }), { view: "diff", ratio: 0.5 });
  assert.deepEqual(p({ view: "sideways", showFile: true }), { view: "both", ratio: 0.5 });
  assert.deepEqual(p({ view: "sideways" }), { view: "diff", ratio: 0.5 });
});
```

- [ ] **Step 2:** rewrite the UI check `changes-split` to assert, in order (keep its `panes()` and Ctrl+A parts):
  - labels of `.fp-view button` are `["Diff", "File", "Both"]`; on first open `diff` is active and the file pane's
    width is 0;
  - `Both`: the file pane shows README.md's text beside the diff; after dragging the divider the stored value is
    `{ view: "both", ratio }` with the dragged ratio, and it is back after closing and reopening;
  - `File`: the diff pane is hidden, the file shows, stored `view` is `file`;
  - with `file` stored, a click on b.txt's commit (unfold first): `diff` is active, the diff shows, stored `view`
    is still `file`; a click on README.md's row: `file` is active again;
  - with `both` stored, the notes.txt link: `file` is active, the diff pane hidden, stored `view` still `both`; a
    click on `Both` then shows notes.txt's all-added diff beside `hello`;
  - `localStorage` set to `{"showFile":true,"ratio":0.3}` and the window reloaded: the browser opens with `both`
    active and the ratio within 0.01 of 0.3;
  - the deleted-file parts stay, driven by the control instead of `Show file` / `Hide file`.
  In `changes-browser`, "no diff pane for a file link" also asserts the active control is `file`.
- [ ] **Step 3:** `node scripts/ui-check/run.mjs changes-split` fails (no `.fp-view`).
- [ ] **Step 4:** implement: the markup and styles, `shown`, the pane rule in place of `setMode`'s split logic and
  of `toggleFile`, the lazy diff, the two keyboard and button rules above.
- [ ] **Step 5:** `npm test` passes; `node scripts/ui-check/run.mjs changes-split changes-browser` exits 0.
- [ ] **Step 6:** commit `feat(desktop): the changes browser shows the diff, the file, or both`.

### Task 5: The Opened files list

**Files:**
- Modify: `electron/renderer/changes-list.js`, `electron/renderer/file-preview.js`,
  `electron/renderer/style.css`
- Test: `electron/test/changes-list.test.mjs`, `scripts/ui-check/checks.mjs` (new check `changes-opened`)

**Interfaces:**
- Consumes: `api.changesOpened`, `api.changesForgetOpened`, `data.opened` (Task 1); `ChangesModel.openedShown`,
  `openedLabel`, `samePath`, `pick` (Task 2); `render`'s `opened` and `on.forget` (Task 3); `shown` (Task 4).
- Produces: `render` draws, after the groups and only when `opened` (an array of `{ path, dir, name }`) is not
  empty, a `.fp-opened` block: `.fp-opened-title` (`Opened files`, with the tooltip) and one `.fp-row` per file
  (empty `.fp-arrow`, `.fp-row-path` of `dir` and `name` as the upper rows, tooltip the full path, `.active` when
  `sel.key` is `key(null, path)`, click `on.select(key(null, path))`) with a `button.fp-forget` reading `✕`, title
  `Remove from the list`, whose click calls `on.forget(path)` and stops the row's click.

- [ ] **Step 1: Write the failing list test**

```js
test("opened files: a block of its own, absent when empty; a row selects, its button forgets", () => {
  assert.equal(all(draw(), "fp-opened").length, 0);
  const calls = [];
  const on = { select: (k) => calls.push(["select", k]), forget: (p) => calls.push(["forget", p]) };
  const KO = ChangesModel.key(null, "/else/c.txt");
  const root = draw({ on, sel: { key: KO, version: "uncommitted" }, opened: [{ path: "/w/docs/b.md", dir: "docs/", name: "b.md" }, { path: "/else/c.txt", dir: "/else/", name: "c.txt" }] });
  const [block] = all(root, "fp-opened");
  assert.equal(text(all(block, "fp-opened-title")[0]), "Opened files");
  assert.deepEqual(all(block, "fp-row-path").map(text), ["docs/b.md", "/else/c.txt"]);
  assert.deepEqual(all(block, "active").map((r) => text(all(r, "fp-row-path")[0])), ["/else/c.txt"]);
  all(block, "fp-row")[0].props.onclick({});
  let stopped = false;
  all(block, "fp-forget")[1].props.onclick({ stopPropagation: () => (stopped = true) });
  assert.equal(stopped, true);
  assert.deepEqual(calls, [["select", ChangesModel.key(null, "/w/docs/b.md")], ["forget", "/else/c.txt"]]);
});
```

- [ ] **Step 2:** it fails; implement the block in `changes-list.js` and its styles; it passes.
- [ ] **Step 3:** write the UI check `changes-opened` (`modes: ["off"]`, `CHANGES_SCENARIO`). Setup:
  `changesRepo`, then `ig.txt` added to `.gitignore` and committed (`ignore`), `ig.txt` written, `notesWritten`,
  and `outside.txt` written in `app.dir` (outside the session folder). Files are opened as a chat link opens them:
  `filePreview.open(${V}, <href>)`. It asserts, in order:
  - `README.md` opened: its text shows, `.fp-opened .fp-row-path` texts are `["README.md"]`, that row is
    `.active`, the control's active view is `file`, the stored `view` is unchanged;
  - the notes.txt link: the rows of `.fp-opened` are still `["README.md"]`, notes.txt's row in the group is
    `.active`, and `api.changesList(id).opened` starts with notes.txt's real path;
  - `outside.txt` opened: the confirmation shows; after `Open` its text shows and it is the first opened row,
    labelled with its absolute path. Close the browser, open it with `Changes`, click that row: its text shows and
    `.fp-confirm` stays hidden;
  - with the control clicked to `Diff` on that row: `.fp-diff .fp-msg` reads `No changes.`, stored `view` is `diff`;
  - README.md changed on disk and `⟳`: README.md is no longer in `.fp-opened` and is a row of the group;
  - `outside.txt` deleted, its row clicked (control back on `File`): the file pane reads `This file is deleted.`
    and the row is still listed;
  - its `✕`: the row is gone and `api.changesList(id).opened` no longer holds the path;
  - not on `win32`: `ig.txt` opened (no confirmation, listed as `ig.txt`), then replaced on disk by a symlink to a
    second outside file; a click on its row shows the confirmation naming that outside file;
  - after `app.reload()` and `Changes`: the opened rows are those from before the reload.
- [ ] **Step 4:** `node scripts/ui-check/run.mjs changes-opened` fails (nothing is listed).
- [ ] **Step 5:** implement in `file-preview.js`:
  - the list is drawn with `opened: openedShown(data, PLATFORM).map((p) => ({ path: p, ...openedLabel(p, view.cwd, PLATFORM) }))`;
    `find(key)` also resolves an opened row (after the loose rows), and `pick` gets `PLATFORM`;
  - a click on an opened row: `shown` for `"nodiff"`, then the read of the spec's Access rule: unconfirmed first;
    on `outside`, repeat as confirmed only when `samePath(r.path, recorded)`, else `askConfirm` as for a link; a
    read that fails shows `readNote`'s text and the row stays;
  - `openTarget`, once the file's text is on show: `await api.changesOpened(v.sessionId, r.path)` (a failure is
    ignored: the file still shows), then the list is read again;
  - after that list: the file's row in the changes list is selected when it is there (`uncommitted`, panes
    untouched), else its opened row;
  - `on.forget(path)`: `api.changesForgetOpened`, then the list is read again; a failure goes to `fail`.
- [ ] **Step 6:** `npm test` passes; `node scripts/ui-check/run.mjs changes-opened changes-browser changes-split
  changes-records` exits 0.
- [ ] **Step 7:** commit `feat(desktop): files opened from links have their own list in the changes browser`.

### Task 6: Backlog, comments, the whole suite

**Files:**
- Modify: `docs/superpowers/backlog/2026-11-22-changes-browser-deferred.md`, the header comments of
  `electron/renderer/file-preview.js` and `changes-list.js`, `README.md` if it describes the changes browser
- Create: `docs/superpowers/backlog/2026-11-23-changes-tree-deferred.md`

- [ ] **Step 1:** read every item of the 2026-11-22 backlog against the new code. An item about the version strip
  or `Show file` that no longer applies gets `Moot since the changes tree (2026-11-23).` appended, not deleted; an
  item that still applies keeps its text with file and symbol names corrected.
- [ ] **Step 2:** create the new backlog file in the layout of the existing ones (A to D, then "Not verified")
  with: the spec's known limit (a loose file reached through a symlink can show in both lists; `repo-track.mjs`
  `handlePaths`, `ChangesModel.openedShown`), a fork starting without its parent's opened files, and under "Not
  verified": Windows (long paths in both lists, the divider in `Both`, a link outside the session folder) and the
  result of Task 0.
- [ ] **Step 3:** the header comments describe the tree, the three views and the opened files, not the strip.
- [ ] **Step 4:** `npm test` passes; `node scripts/ui-check/run.mjs` (all checks) exits 0.
- [ ] **Step 5:** commit `docs: changes tree deferred items`.

Findings of the task reviews and of the whole-branch review that are not fixed go into the new backlog file before
the worktree is removed (repository rule). The release is `v0.21.0`, tagged on the merge commit on `main`.
