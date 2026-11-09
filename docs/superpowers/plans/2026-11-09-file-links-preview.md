# File Links and File Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make real files named anywhere in the desktop chat clickable and readable in a full-screen, per-session preview.

**Architecture:** Pure text logic lives in a new classic script (`renderer/file-links.js`). Disk and network rules live in a new testable main-process module (`file-access.mjs`), reached through three IPC calls. The broker writes the sender's folder into relay prompts, and the preview is a self-contained overlay (`renderer/file-preview.js`).

**Tech Stack:** Electron 45, plain JS without a bundler, `node --test`, `@highlightjs/cdn-assets`.

**Spec:** `docs/superpowers/specs/2026-11-09-file-links-preview-design.md`

## Global Constraints

- Work on branch `feat/file-links-preview`. Run all tests with `npm test` from the repo root; 165 pass before this work.
- Size tiers: up to 2 MB highlighted, 2-20 MB plain text, above 20 MB a message and "Open in system app".
- Binary means a NUL byte in the first 64 KB. Invalid UTF-8 is replaced, not rejected.
- Caps: 500 unique candidates per message, 20 recent files per session.
- Agent or relay text must never read file contents or touch a network location without a click.
- The no-confirmation root is always the viewing session's folder, compared by real paths.
- File content never reaches `innerHTML` raw: only escaped highlight.js output or the `md()` pipeline.
- The CSP in `renderer/index.html` does not change.
- Every new main-process file must be added to `build.files` in `electron/package.json`.

## Review Focus

- Grep-style output `src/a.js:12:const x`: only `src/a.js:12` becomes the link, on line 12.
- An inline-code path containing spaces: linked as one path when the span is entirely that path.
- A file deleted after its link appeared: the click shows "File not found" in the status line, nothing crashes.
- Empty files and files with a UTF-8 BOM: shown normally, with no stray character on line 1.
- Corrupted or foreign data in the recent-list storage: treated as an empty list.

---

### Task 1: Pure link and list logic

**Files:**
- Create: `electron/renderer/file-links.js`, `electron/test/file-links.test.mjs`
- Modify: `electron/renderer/index.html` (script tag before `app.js`)

**Interfaces:**
- Produces, on `globalThis.FileLinks` and through `require()`, following the `ui-state.js` pattern:
  - `pathCandidates(text: string, { whole?: boolean, max?: number = 500 }) -> Array<{ start: number, end: number, raw: string, path: string, line: number | null }>`. `raw` includes the line suffix, `path` does not. `max` counts unique `path` values. `whole: true` treats all of the trimmed text as one path.
  - `splitPathSuffix(href: string) -> { path: string, line: number | null }`
  - `parseRelayHeader(text: string) -> { from: string | null, folder: string | null, display: string }`. `display` is `text` without the folder line.
  - `parseRecent(json: string | null) -> Record<sessionId, Array<{ path: string, line: number | null }>>`
  - `recentAdd(list, entry, max = 20) -> list`, `recentRemove(list, path) -> list`
  - `previewLanguage(fileName: string) -> string | null`, a highlight.js language name
  - `WELL_KNOWN_NAMES: Set<string>`, at least `Makefile`, `LICENSE`, `Dockerfile`, `README`, `CHANGELOG`, `NOTICE`, `Gemfile`, `Rakefile`, `Procfile`, `Jenkinsfile`, `Vagrantfile`, `Containerfile`, `.gitignore`, `.dockerignore`, `.editorconfig`, `.env`

- [ ] **Step 1: Write the failing tests** in `electron/test/file-links.test.mjs`, loading the module with `createRequire` as `ui-state.test.mjs` does

```js
const one = (t, o) => pathCandidates(t, o).map(({ raw, path, line }) => ({ raw, path, line }));
test("relative path with line", () => assert.deepEqual(one("see src/app.js:42, ok"), [{ raw: "src/app.js:42", path: "src/app.js", line: 42 }]));
test("column and #L suffixes", () => {
  assert.equal(one("a/b.js:4:7")[0].line, 4);
  assert.equal(one("a/b.js#L42-L50")[0].line, 42);
});
test("grep output links only path and line", () => assert.deepEqual(one("src/a.js:12:const x = 1")[0], { raw: "src/a.js:12", path: "src/a.js", line: 12 }));
test("urls are not candidates", () => assert.deepEqual(one("https://x.dev/a.js"), []));
test("ordinary words are not candidates", () => assert.deepEqual(one("build the test data"), []));
test("well-known names are case-sensitive", () => {
  assert.equal(one("Makefile").length, 1);
  assert.equal(one("makefile").length, 0);
});
test("punctuation and brackets are trimmed", () => {
  assert.equal(one("README.md.")[0].path, "README.md");
  assert.equal(one("(see ./x/y.ts)")[0].path, "./x/y.ts");
});
test("version numbers are not file names", () => assert.deepEqual(one("v 1.2.3"), []));
test("home and windows paths", () => {
  assert.equal(one("~/a.txt")[0].path, "~/a.txt");
  assert.equal(one("C:\\a\\b.txt")[0].path, "C:\\a\\b.txt");
});
test("whole span keeps spaces", () => assert.equal(one("my dir/a b.txt", { whole: true })[0].path, "my dir/a b.txt"));
test("cap counts unique paths", () => {
  const text = Array.from({ length: 600 }, (_, i) => `f${i}.js`).join(" ");
  assert.equal(new Set(pathCandidates(text).map((c) => c.path)).size, 500);
});
test("repeated path keeps every occurrence", () => assert.equal(one("a.js a.js").length, 2));
test("relay header with folder", () => assert.deepEqual(parseRelayHeader('[from a]\n[folder "/x]y"]\nhello'), { from: "a", folder: "/x]y", display: "[from a]\nhello" }));
test("relay header without folder", () => assert.deepEqual(parseRelayHeader("[from a]\nhello"), { from: "a", folder: null, display: "[from a]\nhello" }));
test("not a relay message", () => assert.deepEqual(parseRelayHeader("hello"), { from: null, folder: null, display: "hello" }));
test("corrupted recent data is empty", () => {
  for (const bad of [null, "{", "[]", '{"s":"x"}', '{"s":[1,{"path":5}]}']) assert.deepEqual(Object.values(parseRecent(bad)).flat(), []);
});
test("recentAdd moves to the top and caps", () => {
  let l = [];
  for (let i = 0; i < 25; i++) l = recentAdd(l, { path: `/f${i}`, line: null });
  assert.equal(l.length, 20);
  l = recentAdd(l, { path: "/f10", line: 3 });
  assert.deepEqual(l[0], { path: "/f10", line: 3 });
  assert.equal(l.filter((e) => e.path === "/f10").length, 1);
});
test("recentRemove", () => assert.deepEqual(recentRemove([{ path: "/a", line: null }], "/a"), []));
test("language by name", () => {
  assert.equal(previewLanguage("a.ts"), "typescript");
  assert.equal(previewLanguage("Makefile"), "makefile");
  assert.equal(previewLanguage("a.unknownext"), null);
});
```

- [ ] **Step 2: Run** `npm test`. Expected: the new file fails with a module-not-found error.
- [ ] **Step 3: Implement `electron/renderer/file-links.js`** with the interfaces above. A token is a candidate when it has a separator, matches a name with an extension of 1-10 alphanumerics that is not all-numeric, or is in `WELL_KNOWN_NAMES`. The relay folder line is exactly `[folder <JSON string>]` immediately after the `[from <name>]` line.
- [ ] **Step 4: Add `<script src="file-links.js"></script>`** before `ui-state.js` in `index.html`.
- [ ] **Step 5: Run** `npm test`. Expected: all pass.
- [ ] **Step 6: Commit** with message `feat(desktop): add pure file link and recent list helpers`.

### Task 2: Network-location rules and safe path resolution

**Files:**
- Create: `electron/file-access.mjs`, `electron/test/file-access.test.mjs`
- Modify: `electron/main.mjs` (remove `localRealpath`, `resolveTarget`, `isRemote`, import them; lines 923-989), `electron/package.json` (`build.files`)

**Interfaces:**
- Produces:
  - `parseLinuxMounts(text: string) -> string[]`, network mount points from `/proc/self/mountinfo`. Network types: `nfs`, `nfs4`, `cifs`, `smb3`, `smbfs`, `ncpfs`, `9p`, `ceph`, `glusterfs`, `lustre`, `afs`, `autofs`, and `fuse.*` for `sshfs`, `rclone`, `s3fs`, `smbnetfs`, `davfs`.
  - `parseMacMounts(text: string) -> string[]`, from `mount` output. Network types: `nfs`, `smbfs`, `afpfs`, `webdav`, `autofs`.
  - `parseWinDrives(json: string) -> string[]`, uppercase letters such as `"C:"` where `DriveType` is 3, from `Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,DriveType | ConvertTo-Json`. A single object or an array are both accepted.
  - `isNetworkLocation(abs: string, table: { mounts: string[] } | { fixedDrives: string[] }, platform: string) -> boolean`
  - `allowsAutomaticCheck(abs: string, { table, trustedRoots: string[], platform }) -> boolean`. A `null` table allows only paths inside `trustedRoots` (fail closed), compared by text with `isInside`.
  - `createLocationTable({ platform, readFile, exec, ttlMs = 30000, now }) -> { get(): Promise<table | null> }`
  - `localRealpath(p: string, { allow = () => true }) -> Promise<string | null>`. Throws "Network paths are not opened" when `allow(path)` is false for the starting path or any symlink target, before it is touched.
  - `resolveTarget(cwd: string, target: string) -> Promise<string>`, moved unchanged in behaviour, together with `expandHome`.
  - `isRemote(p: string) -> boolean`

- [ ] **Step 1: Write failing tests** in `electron/test/file-access.test.mjs`

```js
test("linux table keeps only network mounts", () => {
  const t = "36 25 0:32 / /mnt/nfs rw - nfs4 srv:/x rw\n37 25 8:1 / / rw - ext4 /dev/sda1 rw\n38 25 0:40 / /net rw - autofs auto rw\n39 25 0:41 / /mnt/s rw - fuse.sshfs h:/ rw\n";
  assert.deepEqual(parseLinuxMounts(t), ["/mnt/nfs", "/net", "/mnt/s"]);
});
test("mac table", () => assert.deepEqual(parseMacMounts("/dev/disk1 on / (apfs, local)\n//u@h/s on /Volumes/s (smbfs, nodev)\n"), ["/Volumes/s"]));
test("windows drives accept object and array", () => {
  assert.deepEqual(parseWinDrives('{"DeviceID":"C:","DriveType":3}'), ["C:"]);
  assert.deepEqual(parseWinDrives('[{"DeviceID":"c:","DriveType":3},{"DeviceID":"Z:","DriveType":4}]'), ["C:"]);
});
test("network location is a path boundary match", () => {
  const t = { mounts: ["/mnt/nfs"] };
  assert.equal(isNetworkLocation("/mnt/nfs/a", t, "linux"), true);
  assert.equal(isNetworkLocation("/mnt/nfsx/a", t, "linux"), false);
});
test("windows counts only fixed drives", () => {
  const t = { fixedDrives: ["C:"] };
  assert.equal(isNetworkLocation("c:\\a", t, "win32"), false);
  assert.equal(isNetworkLocation("Z:\\a", t, "win32"), true);
});
test("no table fails closed", () => {
  const o = { table: null, trustedRoots: ["/home/u", "/p"], platform: "linux" };
  assert.equal(allowsAutomaticCheck("/p/a", o), true);
  assert.equal(allowsAutomaticCheck("/etc/hosts", o), false);
});
test("table is cached until ttl", async () => { /* exec counted with an injected now: one call within ttlMs, a second after it */ });
test("a failing table source gives null", async () => { /* readFile rejects -> get() resolves null */ });
test("guard refuses before lstat of the starting path", async () => { /* allow: () => false on a missing path -> rejects /Network paths/ */ });
test("guard refuses a symlink into a network location", async () => { /* temp dir link -> target; allow false for target -> rejects */ });
test("resolveTarget still finds relative, :line and #L targets", async () => { /* temp dir */ });
```

- [ ] **Step 2: Run** `npm test`. Expected: the new file fails.
- [ ] **Step 3: Implement `electron/file-access.mjs`**, move the three functions from `main.mjs`, and add `"file-access.mjs"` to `build.files`.
- [ ] **Step 4: Run** `npm test`. Expected: all pass, including the 165 existing tests.
- [ ] **Step 5: Commit** with message `feat(desktop): detect network locations before touching paths`.

### Task 3: Existence check and preview reading over IPC

**Files:**
- Modify: `electron/file-access.mjs`, `electron/test/file-access.test.mjs`, `electron/main.mjs`, `electron/preload.cjs`

**Interfaces:**
- Consumes: everything from Task 2.
- Produces:
  - `checkCandidates(candidates: string[], { base: string | null, home: string, allow, platform }) -> Promise<string[]>`, the candidates that are existing regular files. Resolves with `lexicalPath(c, base, home, platform, { decode: false })`, so relative candidates with `base: null` are dropped, and checks `allow` first. At most 16 disk lookups run at once.
  - `readPreview(realPath: string) -> Promise<{ tier: "highlight" | "plain" | "too-large" | "binary", text?: string, size: number, mtimeMs: number }>`
  - `resolvePreview({ baseCwd, target, viewingCwd, confirmed }, { isNetwork: (real) => Promise<boolean> }) -> Promise<{ notText: true } | { outside: true, path: string } | { path, name, text, tier, size, mtimeMs }>`
  - `api.checkFiles(base, candidates) -> Promise<string[]>` on channel `files:check`
  - `api.readFile(baseCwd, target, { viewingCwd, confirmed }) -> same as resolvePreview`, channel `files:read`
  - Main keeps a `knownFolders` Set filled by `sessions:list` and `attach`, used with the home folder as `trustedRoots`.

- [ ] **Step 1: Write failing tests** using a temp directory

```js
test("only existing files are returned", async () => { /* a.txt, dir/, missing.txt -> ["a.txt"] */ });
test("relative candidates need a base", async () => { /* base null: "a.txt" dropped, absolute kept */ });
test("allow is consulted before the disk", async () => { /* allow false -> [] with an absolute existing path */ });
test("preview tiers", async () => { /* sparse files of 2 MB, 2 MB + 1, 20 MB, 20 MB + 1 -> highlight, plain, plain, too-large */ });
test("NUL in the first 64 KB is binary", async () => { /* beyond 64 KB is still text */ });
test("BOM is removed and an empty file is text", async () => { /* "\uFEFFabc" -> "abc"; "" -> tier highlight, text "" */ });
test("invalid UTF-8 is replaced", async () => { /* Buffer [0xff, 0x41] -> contains "A" */ });
test("inside the viewing folder opens without confirmation", async () => {});
test("outside needs confirmation", async () => { /* { outside: true, path }; with confirmed: true -> text */ });
test("symlink pointing outside needs confirmation", async () => {});
test("relay base does not lift confirmation", async () => { /* baseCwd elsewhere, viewingCwd temp -> outside */ });
test("directory, binary and network targets are not text", async () => { /* notText */ });
test("web links are not text", async () => { /* https://x -> notText, nothing read */ });
test("a deleted file rejects with File not found", async () => { await assert.rejects(resolvePreview(/* ... */), /File not found/); });
```

- [ ] **Step 2: Run** `npm test`. Expected: the new tests fail.
- [ ] **Step 3: Implement the three functions** and register `files:check` and `files:read` in `main.mjs` with a `createLocationTable` instance. Expose both through `preload.cjs`.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** with message `feat(desktop): add file check and preview read over IPC`.

### Task 4: Sender folder in relay messages

**Files:**
- Modify: `src/registry.mjs:185-194,233-241`, `src/delegation.mjs:39-48,111-120`, `electron/delegation.mjs:53`, `electron/main.mjs:123,701`, `electron/history.mjs:177`
- Test: `electron/test/registry-links.test.mjs`, `electron/test/delegation-broker.test.mjs`, `electron/test/delegation-main.test.mjs`, `electron/test/history.test.mjs`

**Interfaces:**
- Produces: delivered messages gain `fromCwd?: string`. Prompts become `[from <name>]\n[folder <JSON string>]\n<text>…` when the sender has a folder, and are unchanged when it does not.
- Consumes: Task 1's folder-line format.

- [ ] **Step 1: Write failing tests**

```js
// registry: a sender with cwd "/a b" -> push has fromCwd "/a b" and prompt matches /^\[from x\]\n\[folder "\/a b"\]\nhello/
// registry: a sender without cwd -> no fromCwd, prompt matches /^\[from x\]\nhello/
// registry: a message queued while offline keeps fromCwd in the inbox
// delegation broker: a report from a child with a cwd carries fromCwd and survives the on-disk queue
// childPrompt({ parentName: "glowna", task: "t", folder: "/p" }) matches /^\[from glowna\]\n\[folder "\/p"\]\n/
// history: forkSession prefill omits the folder line and keeps [from x]
// history: cutIndex still matches bubble text "hello" against a user.message with a folder line
```

- [ ] **Step 2: Run** `npm test`. Expected: the new tests fail.
- [ ] **Step 3: Implement.** Add a `relayPrefix(name, cwd)` helper exported from `src/registry.mjs` and used by `src/delegation.mjs`. `electron/delegation.mjs` keeps its own one-line equivalent, because `src/` is not packaged with the app. Store `fromCwd` on queued delegation items. Forward `fromCwd` at `electron/main.mjs:123`, and pass the parent's `cwd` at `:701`.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** with message `feat(relay): carry the sender folder in relay messages`.

### Task 5: Link paths in the chat

**Files:**
- Modify: `electron/renderer/app.js:336-345,403-411,858,903-906,976,1226,1315-1318`, `electron/renderer/style.css`

**Interfaces:**
- Consumes: `FileLinks.pathCandidates`, `FileLinks.parseRelayHeader`, `api.checkFiles`.
- Produces: `SessionView.linkPaths(root: Element, base: string | null) -> Promise<void>`. Created links store the base on the property `a._base`, never as a DOM attribute, because sanitised agent HTML may contain `data-*`.

- [ ] **Step 1: Implement `linkPaths`.** Walk text nodes, skipping `a` and `button` and including `pre` and `code`. Use `{ whole: true }` for a `code` element not inside `pre`. Check unique paths in one batch per `root`. Before replacing a node, confirm it `isConnected` and its text is unchanged, because tool cards re-render.
- [ ] **Step 2: Call it** after URL linkification: finished agent replies and live user bubbles with `this.cwd`; relay bubbles with `m.fromCwd ?? null`; tool cards only when `status` is `completed` or `failed`; replayed user messages with `parseRelayHeader(r.text)`, using `folder` when `from` is set and `this.cwd` otherwise.
- [ ] **Step 3: Show `parseRelayHeader(r.text).display`** in `renderRun` for type `user`. Leave `r.text` raw so `_matchText` still matches history.
- [ ] **Step 4: Pass `a._base ?? this.cwd`** from `onLink` to `openLink(href, base)`.
- [ ] **Step 5: Run** `npm test`, then the app with `npm --prefix electron start`. Expected: tests pass. `src/x.js:3`, `/etc/hosts`, `Makefile` and a code-block path are links; `makefile`, a missing file and a folder are not; a relay message from another folder links its relative paths; copying a code block gives unchanged text.
- [ ] **Step 6: Commit** with message `feat(desktop): link file paths in the chat`.

### Task 6: Full-screen preview with recent list

**Files:**
- Create: `electron/renderer/file-preview.js`
- Modify: `electron/renderer/index.html`, `electron/renderer/style.css`, `electron/renderer/app.js:282-289,403-411,1326,1550,1987,1999`, `electron/package.json`, `electron/package-lock.json`

**Interfaces:**
- Consumes: `api.readFile`, `api.openLink`, `FileLinks.recent*`, `FileLinks.previewLanguage`, `FileLinks.splitPathSuffix`, `md`, `h`.
- Produces: `createFilePreview({ api, h, md, onStatus }) -> { open(view, href, base): Promise<boolean>, show(view), close(), forget(sessionId), isOpen: boolean }`. `open` resolves false when the target is not text, and `openLink` then falls back to `api.openLink`. Storage key: `copilot-sessions.files.v1`.

- [ ] **Step 1: Add the dependency:** `npm --prefix electron install @highlightjs/cdn-assets@^11.12.0`. Load `../node_modules/@highlightjs/cdn-assets/highlight.min.js` and `styles/github-dark.min.css` from `index.html`, and `file-preview.js` before `app.js`.
- [ ] **Step 2: Add a `#file-preview` overlay** next to `#viewer`, with the panel, header, content and the confirmation prompt inside the overlay. It takes the keyboard with the same capture-phase handler as the viewer. Esc closes.
- [ ] **Step 3: Implement `createFilePreview`** per the spec's "Preview UI", "Recent list" and designer calls: line numbers, scroll to and mark the target line, Markdown rendered with a source toggle (`line` forces source), relative links in rendered Markdown resolved against the file's folder, Markdown images shown as alt text, unavailable files kept in the list until closed. The too-large tier shows the message and "Open in system app".
- [ ] **Step 4: Wire `app.js`:** `openLink` tries the preview first; add the "Files (n)" header button; call `close()` in `activate`; call `forget(sessionId)` after a successful delete (line 1550, not on the failure path); add `filePreview.isOpen` to the zoom guards at lines 1987 and 1999.
- [ ] **Step 5: Run** `npm test`, then the app. Expected: clicking a file opens the overlay and the list; a file outside the folder asks for confirmation; `:42` scrolls and marks the line; `.md` renders and toggles; a 3 MB file is plain; a binary opens as before; the list survives a restart; session delete clears it; switching sessions closes the overlay.
- [ ] **Step 6: Run** `npm --prefix electron run dist:linux`. Expected: the packaged app shows highlighted code, confirming the dependency and `file-access.mjs` are bundled.
- [ ] **Step 7: Commit** with message `feat(desktop): add full-screen file preview with per-session list`.

### Task 7: Auto-refresh and documentation

**Files:**
- Modify: `electron/file-access.mjs`, `electron/test/file-access.test.mjs`, `electron/main.mjs`, `electron/preload.cjs`, `electron/renderer/file-preview.js`, `electron/README.md`

**Interfaces:**
- Produces:
  - `createFileWatcher({ onChange: (path) => void, debounceMs = 150, watch = fs.watch }) -> { set(path: string | null): void }`. Watches the parent folder and filters by base name, which survives atomic-save renames. A `null` file name from the OS counts as a change.
  - `api.watchFile(path | null)` on channel `files:watch`; refused for a path not returned by `files:read` in this run.
  - `api.onFileChanged(fn)` on event `files:changed`.

- [ ] **Step 1: Write failing tests** with an injected fake `watch`

```js
test("events for the file are debounced into one change", async () => {});
test("events for other files are ignored", async () => {});
test("a null file name counts as a change", async () => {});
test("set replaces the watcher and closes the old one", () => {});
test("set(null) closes the watcher", () => {});
```

- [ ] **Step 2: Run** `npm test`. Expected: the new tests fail.
- [ ] **Step 3: Implement the watcher and IPC.** The preview calls `watchFile` for the displayed file, re-reads on change while preserving scroll position, shows a deleted file as unavailable, and calls `watchFile(null)` on close.
- [ ] **Step 4: Document** the links and the preview in `electron/README.md`.
- [ ] **Step 5: Run** `npm test`, then the app. Expected: tests pass; a file edited from outside refreshes without losing scroll position; an atomic save (`mv tmp file`) refreshes; deleting the file marks it unavailable.
- [ ] **Step 6: Verify the spec's manual list** on Linux, including an absolute path on a real network mount that is not linked or touched. Report Windows and macOS as not verified unless they were run.
- [ ] **Step 7: Commit** with message `feat(desktop): refresh the previewed file when it changes`.
