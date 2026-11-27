# Content Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** search message text of all sidebar sessions (results with snippets under the sidebar list, click jumps to
the hit) and inside one open session (`Ctrl+F` find bar with ↑↓ navigation and highlights).

**Architecture:** one shared pure matcher (`find-text.js`) and one shared user-text rule set (`message-text.js`),
both UMD files in `electron/renderer/`, used by the renderer and (via `createRequire`) by a `worker_thread` that
scans `events.jsonl` with an in-memory cache. The renderer adds a content section to `renderList` and a per-view
`FindBar` that highlights with the CSS Custom Highlight API.

**Tech Stack:** Electron 45 (Chromium `CSS.highlights`), Node `worker_threads`, `node:test`, the UI check harness
in `scripts/ui-check/` (xvfb + scripted ACP agent).

**Spec:** `docs/superpowers/specs/2026-11-27-content-search-design.md`

## Global Constraints

- Unit tests: `npm test` from the repo root (`node --test "electron/test/*.test.mjs"`). UI checks:
  `node scripts/ui-check/run.mjs <name…>`; run `npm --prefix electron run copy-relay` first.
- Every new module main loads must be in `electron/package.json` `build.files` (`packaging.test.mjs` enforces it;
  `renderer/**` is already covered).
- Renderer modules are classic scripts: `globalThis.X = X; if (typeof module !== "undefined") module.exports = X;`,
  added to `electron/renderer/index.html` before `app.js`, in dependency order.
- Snippets and session titles are put in the DOM with `textContent` / `h()` children only, never `innerHTML`.
- Matching (both sides): case-insensitive substring of the trimmed query, whitespace runs collapsed to one space in
  both the query and the text. Global search starts at 2 characters, the find bar at 1.
- Values: sidebar debounce 250 ms, find bar debounce 100 ms; snippet 40 characters each side; 3 hits shown per
  session; at most 50 sessions with hits (then the header reads `50+ sessions`).
- Copy (exact): placeholder `Filter by title, folder or message…`; header `In messages (N in M sessions)` /
  `In messages (N in 50+ sessions)`; `Searching messages…`; `+N more`; `This hit was not found in the loaded view`;
  counter `i/N`, `0/0`.
- Relay sender headers (`[from <name>]`, `[folder "…"]`) are never searchable.

## Review Focus

1. A query with characters special to regex or HTML (`(a+`, `<b>`, `$&`) matches literally and shows as text in
   snippets and the find bar (Task 2 test `literal special characters`; Task 5 UI check types `<b>`).
2. Case folding that changes length (`"İ".toLowerCase()` is 2 code units): offsets still map to the original text
   (Task 2 test `length-changing case fold keeps offsets`).
3. `events.jsonl` being appended while it is scanned (a half-written last line), or not JSON at all: that line is
   skipped, the session still answers (Task 3 test `partial last line`).
4. A very common word in long sessions: caps keep the payload bounded and the sidebar responsive (Task 3 test
   `caps`; Task 4 test `newer query cancels`).
5. The view changes under the find bar: switching sessions, closing the view, or the open failing during a jump
   leaves no stale highlights and throws nothing (Task 6 UI check `find-bar-switch`; Task 7 UI check
   `content-jump-dead`).

---

### Task 1: Probe — replay versus file

**Files:**
- Create: `scripts/sdk-probe/replay-vs-file.mjs`
- Modify: `scripts/sdk-probe/README.md` (a short section on this script)
- Modify: `docs/superpowers/specs/2026-11-27-content-search-design.md` (append `## Probe result`)

**Interfaces:**
- Produces: two decisions written into the spec and used by Task 3 as constants in `electron/history.mjs`:
  `SEARCH_COMMENTARY` (boolean) and `REPLAY_HAS_PRE_COMPACTION` (boolean).

- [ ] **Step 1: Write the probe.** `node replay-vs-file.mjs [<id>…] [--sessions <n>] [--make-compacted]`.
  For each session (default: the newest 20 in `$COPILOT_HOME/session-state` with an `events.jsonl`): open it over
  ACP with `AcpConnection` from `electron/acp.mjs` (command as `copilot-command.mjs` resolves it, `--acp --stdio`),
  `session/load`, collect the replayed `user_message_chunk` / `agent_message_chunk` text grouped into messages, then
  close. From the file, list `user.message` and `assistant.message` without `agentId`, keep-alive prompts skipped,
  each tagged `phase` and whether it lies before the last `session.compaction_complete`. Report per session: counts
  of file messages found / not found in the replay (normalized-whitespace containment), split by `phase` and by
  before/after compaction. `--make-compacted` first creates a session in a temp folder, sends two short prompts,
  sends `/compact`, waits for `session.compaction_complete` in the file, and includes that session. The report
  goes to `results/replay-vs-file-<time>.md` and holds counts and event types only, no message text.
- [ ] **Step 2: Run it.** `cd scripts/sdk-probe && node replay-vs-file.mjs --make-compacted`.
  Expected: ends with `Done:` and the report path; the compacted session is in the report.
- [ ] **Step 3: Record the result** in the spec (`## Probe result`: date, CLI version, the two decisions with the
  counts that support them). If `--make-compacted` cannot run here (no quota, CLI error), record that, set
  `REPLAY_HAS_PRE_COMPACTION = false` (the safe side: Task 8 runs) and note the corp-PC run for the backlog.
- [ ] **Step 4: Commit.** `git add scripts/sdk-probe/replay-vs-file.mjs scripts/sdk-probe/README.md docs/superpowers/specs/2026-11-27-content-search-design.md && git commit -m "probe: replay versus events.jsonl for content search"`

### Task 2: Shared text rules and matcher

**Files:**
- Create: `electron/renderer/message-text.js`, `electron/renderer/find-text.js`
- Modify: `electron/renderer/app.js:274-278` (`shownUserText`, `ownUserText` use `MessageText`),
  `electron/renderer/index.html` (scripts after `message-queue.js` and `file-links.js`)
- Test: `electron/test/message-text.test.mjs`, `electron/test/find-text.test.mjs`

**Interfaces:**
- Produces `MessageText` (requires `MessageQueue` and `FileLinks` via `require` in Node, globals in the renderer):
  - `shownUserText(raw: string): string` — moved from `app.js` unchanged (continue prompt → `CONTINUE_LABEL`,
    queued wrap unwrapped).
  - `relayBody(text: string): string` — the text without a leading `[from <name>]` line and, when present, the
    `[folder "…"]` line after it (same line patterns as `FileLinks.parseRelayHeader`); other text unchanged.
  - `searchableUserText(raw: string): string` — `relayBody(shownUserText(raw))`.
- Produces `FindText`:
  - `findMatches(text: string, query: string): { start: number, end: number }[]` — offsets in the original `text`,
    non-overlapping, left to right; `[]` for an empty (after trim) query.
  - `makeSnippet(text: string, start: number, end: number, width = 40): { before: string, match: string, after: string }`
    — `before`/`after` up to `width` characters, cut at whitespace where one lies in the outer half, newlines as
    spaces, `…` prefixed/suffixed where cut.
  - `pickTarget(snippets: {before, after}[], wanted: {k: number, before: string, after: string}): { index: number, exact: boolean }`
    — among the view's matches (their snippets, same order), the ones whose normalized `before`/`after` agree with
    `wanted` on their shorter common length (suffix of `before`, prefix of `after`); of those, the one nearest to
    `k` (`exact: true`). None agree: the index nearest to `k` within range (`exact: false`); no matches: `{ index: -1, exact: false }`.

Matching algorithm (both sides share it, so it is fixed here): build a folded copy of `text` character by character,
collapsing each whitespace run to one space and lower-casing each code point, while keeping for every folded code
unit the index of the original character it came from; fold the query the same way; `indexOf` repeatedly on the
folded text; map each hit back through the index array (`end` = original index after the last mapped character).

- [ ] **Step 1: Write the failing tests.**
  - `relayBody strips from and folder lines`: `relayBody('[from api-1]\n[folder "/x"]\nhello')` → `"hello"`;
    `relayBody("[from api-1]\nhello")` → `"hello"`; `relayBody("plain [from x]")` unchanged.
  - `searchableUserText of a queued relay message`: `searchableUserText(MessageQueue.wrap('[from a]\nhi'))` → `"hi"`;
    of `MessageQueue.CONTINUE_PROMPT` → `MessageQueue.CONTINUE_LABEL`.
  - `findMatches basic`: `findMatches("Cache keeper and cache", "CACHE")` → `[{start:0,end:5},{start:17,end:22}]`.
  - `whitespace collapsed`: `findMatches("a\n\n  b", "a b")` → `[{start:0,end:6}]`; query `"  "` → `[]`.
  - `literal special characters`: `findMatches("x (a+ <b> $& y", "(a+ <b> $&")` → `[{start:2,end:12}]`.
  - `length-changing case fold keeps offsets`: `findMatches("İİ ab", "AB")` → `[{start:3,end:5}]` (each `İ` folds
    to two code units).
  - `Polish letters`: `findMatches("Łódź", "łÓDŹ")` → `[{start:0,end:4}]`.
  - `makeSnippet cuts at whitespace`: on a 200-char text the result has `before.length ≤ 41`, starts with `…`,
    `match` equals the original slice, no `\n` anywhere.
  - `pickTarget`: exact agreement chosen over a closer `k`; ties broken by distance to `k`; no agreement →
    `exact: false` with index `min(k, n-1)`; empty → `-1`.
- [ ] **Step 2: Run** `node --test electron/test/message-text.test.mjs electron/test/find-text.test.mjs` — FAIL
  (modules missing).
- [ ] **Step 3: Implement** both modules; switch `app.js` `shownUserText`/`ownUserText` to `MessageText`.
- [ ] **Step 4: Run** the two tests, then `npm test` — PASS (no regressions in `message-queue`, `edit-message`).
- [ ] **Step 5: Commit** `feat(search): shared text rules and matcher`.

### Task 3: Extraction and search over one history

**Files:**
- Modify: `electron/history.mjs` (new exports next to `messageTimes`)
- Test: `electron/test/content-search.test.mjs`

**Interfaces:**
- Consumes: `MessageText.searchableUserText`, `FindText.findMatches`, `FindText.makeSnippet` (via
  `createRequire(import.meta.url)("./renderer/…")`), `isKeepAlive`.
- Produces:
  - `const SEARCH_COMMENTARY`, `const REPLAY_HAS_PRE_COMPACTION` (values from Task 1).
  - `extractMessages(text: string): Message[]`, `Message = { kind: "user"|"agent", text: string, at: number|null, beforeCompaction: boolean }`
    — file order; user text through `searchableUserText`; agent `data.content`; events with `agentId` skipped;
    keep-alive skipped; `phase: "commentary"` kept only if `SEARCH_COMMENTARY`; empty texts skipped;
    `beforeCompaction` true for messages before the last `session.compaction_complete` (always computed).
  - `searchMessages(messages: Message[], query: string, { shown = 3 } = {}): { count: number, latest: number|null, hits: Hit[] }`,
    `Hit = { k: number, kind, snippet: {before, match, after}, at: number|null, beforeCompaction: boolean }` —
    `k` counts every occurrence in file order; if `!REPLAY_HAS_PRE_COMPACTION`, pre-compaction hits get `k: -1` and
    the post-compaction hits are numbered from 0; `hits` = the first `shown` hits; `latest` = newest `at` of any hit.

- [ ] **Step 1: Write the failing tests** (events built as objects, joined with `\n`):
  - `extract skips sub-agents, keep-alive and bad lines`: an `agentId` event, a keep-alive prompt (built with the
    marker from `cache-keeper.mjs`), a non-JSON line → only the two real messages come out.
  - `partial last line`: file text ending in `{"type":"user.mess` → no throw, earlier messages returned.
  - `relay header not searchable`: a user message `[from api-1]\n[folder "/x"]\nhello` → `searchMessages(m, "api-1").count === 0`, `"hello"` → 1.
  - `k counts occurrences`: two messages, the first with "foo foo" → hits `k` 0,1,2.
  - `caps`: 10 hits → `count: 10`, `hits.length: 3`.
  - `compaction marks`: a `session.compaction_complete` between two messages → first `beforeCompaction: true`;
    with `REPLAY_HAS_PRE_COMPACTION` false its `k` is `-1` and the second hit's `k` is `0` (assert by the value
    the module exports, so the test holds for either probe outcome).
- [ ] **Step 2: Run** `node --test electron/test/content-search.test.mjs` — FAIL.
- [ ] **Step 3: Implement** in `history.mjs`.
- [ ] **Step 4: Run** the test and `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(search): extract and search a session history`.

### Task 4: Scan worker, service and IPC

**Files:**
- Create: `electron/search-worker.mjs`, `electron/content-search.mjs`
- Modify: `electron/main.mjs` (create the service, `handle("sessions:search", …)`, terminate on quit),
  `electron/preload.cjs` (`searchSessions`), `electron/package.json` `build.files` (both new files)
- Test: `electron/test/content-search.test.mjs` (service part)

**Interfaces:**
- Consumes: `extractMessages`, `searchMessages`, `sessionDir`, `isSessionId` from Task 3 / `history.mjs`.
- Produces:
  - `createContentSearch({ workerUrl = new URL("./search-worker.mjs", import.meta.url), env = process.env } = {}): { search(query: string, ids: string[]): Promise<SearchResult>, close(): Promise<void> }`
  - `SearchResult = { cancelled: true } | { cancelled: false, sessions: { sessionId, count, latest, hits: Hit[] }[], more: boolean }`
    — sessions with ≥ 1 hit, newest `latest` first, at most 50 (`more: true` when cut).
  - IPC `sessions:search` → `api.searchSessions(query, ids)` returning `SearchResult`.
- Worker protocol: main posts `{ seq, query, ids, copilotHome }`; worker answers `{ seq, result }` or
  `{ seq, cancelled: true }`; a message with a higher `seq` makes the running scan stop at the next file boundary
  and answer `cancelled`. Cache: `Map<sessionId, { size, mtimeMs, messages }>`; re-read when size or mtime differ
  (incremental read of a grown file is optional, not required). Files are read with `fs.promises.readFile`; an id
  that is not a UUID or has no file is skipped. The worker is started lazily on the first query and restarted once
  if it exits with an error.

- [ ] **Step 1: Write the failing tests** (temp `COPILOT_HOME` with two sessions):
  - `service finds hits across sessions` — both sessions, newest first, counts right.
  - `ids limit the scan` — an id not passed is not in the result; a non-UUID id is ignored.
  - `cache follows the file` — search, append a message with a new word, search again → found.
  - `newer query cancels` — start a search over 300 generated sessions, immediately start another; the first
    resolves `{ cancelled: true }`, the second with results.
  - `50+ sessions` — 60 sessions with a hit → `sessions.length === 50`, `more: true`.
- [ ] **Step 2: Run** `node --test electron/test/content-search.test.mjs` — FAIL.
- [ ] **Step 3: Implement** worker, service, IPC, preload, `build.files`.
- [ ] **Step 4: Run** the test, `node --test electron/test/packaging.test.mjs`, then `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(search): scan worker and sessions:search`.

### Task 5: Sidebar section

**Files:**
- Modify: `electron/renderer/app.js` (`renderList` and a new `renderContentResults`), `electron/renderer/index.html`
  (placeholder), `electron/renderer/style.css`
- Test: `scripts/ui-check/checks.mjs` (new check `content-search-sidebar`)

**Interfaces:**
- Consumes: `api.searchSessions` (Task 4). Produces for Task 7: each snippet element carries
  `{ sessionId, k, before, after }` (as element properties) and calls `jumpToHit(sessionId, hit)` on click;
  the session row and `+N more` call `jumpToHit(sessionId, null)` (first hit). Task 5 defines `jumpToHit` as: open/activate the
  session only; Task 7 extends it.

Behaviour: `renderList` stays synchronous and renders the title/folder model as today, then the content section
from the latest applied result. The `input` listener also schedules (250 ms) a content search when the trimmed
query has ≥ 2 characters, with a sequence number; an older or `cancelled` answer is dropped; a shorter query
clears the section. Until the first answer for the current query the section shows only `Searching messages…`.
An error shows one line `Message search failed: <message>`. No section when the answer has no sessions; the
`No matches` line only when the list model is empty and the content answer (once in) has no sessions. Rows: the
session title (or its folder name when the title is empty) and the count; under it the hits' snippets (match in
`<mark>`, pre-compaction hits styled `.before-compaction` with title `Before a compaction: may not be in the view`);
`+N more` when `count > hits.length`.

- [ ] **Step 1: Write the failing UI check** `content-search-sidebar` (`sessionId: HISTORY_ID`, `modes: ["off"]`):
  play the scenario, write an `events.jsonl` for `HISTORY_ID` with user messages `"alpha <b> one"` and
  `"[from api-1]\nalpha two"` and an agent message `"Alpha three"`; type `alpha` into `#search`; until the section
  exists assert the header text `In messages (3 in 1 sessions)`, three snippets whose `<mark>` texts are `alpha`,
  `alpha`, `Alpha`, and that the first snippet's text contains `<b>` literally (no `<b>` element). Type `api-1` →
  no content section. Type `a` → no content section.
- [ ] **Step 2: Run** `node scripts/ui-check/run.mjs content-search-sidebar` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the check, then the full UI run (`node scripts/ui-check/run.mjs`) — PASS; the sidebar order
  and filter checks keep passing.
- [ ] **Step 5: Commit** `feat(search): message hits in the sidebar`.

### Task 6: In-session find bar

**Files:**
- Create: `electron/renderer/find-bar.js`
- Modify: `electron/renderer/app.js` (`SessionView` constructor: the bar above `this.log`; live updates;
  `activate` clears/reapplies highlights; global `Ctrl+F`/`Cmd+F`), `electron/renderer/index.html`,
  `electron/renderer/style.css` (`::highlight(find-match)`, `::highlight(find-current)` for both themes)
- Test: `scripts/ui-check/checks.mjs` (checks `find-bar` and `find-bar-switch`)

**Interfaces:**
- Consumes: `FindText.findMatches`, `FindText.makeSnippet`, `FindText.pickTarget`.
- Produces `FindBar`:
  - `new FindBar(log: HTMLElement): { el: HTMLElement, open(query?: string): void, close(): void, isOpen: boolean, refresh(): void, goTo(target: {k, before, after} | null): { exact: boolean }, show(): void, hide(): void }`
  - `refresh()` re-runs the search keeping the current match when it still exists; `show()`/`hide()` apply/remove
    this bar's ranges in the global `CSS.highlights` (only the active view's bar is shown).

Behaviour: searched elements are `log` children matching `:scope > .msg.user, :scope > .msg.relay, :scope > .msg.agent`;
their text is collected from text nodes with a `TreeWalker`, skipping subtrees of `.copy`, `.from`, `.time` and
`details.thought`; a leading relay header in a `.msg.user` body is skipped with `MessageText.relayBody` (offset =
length difference). Match offsets map to `Range`s over the walked text nodes. The current match is scrolled with
`scrollIntoView({ block: "center" })` and any closed `<details>` ancestor inside the bubble is opened. Enter / ↓
next, Shift+Enter / ↑ previous, wrapping; Esc closes and clears. `Ctrl+F` (`Cmd+F` on macOS) opens the active
view's bar and selects its input; ignored while `document.querySelector("dialog[open]")` exists (the image viewer
already swallows keys). Live: the view calls `findBar.refresh()` (debounced 100 ms) after appending or growing a
main-thread bubble while the bar is open.

- [ ] **Step 1: Write the failing UI checks.**
  - `find-bar`: play the scenario; press `Ctrl+F`; type a word that occurs in the scenario's answers (pick one from
    `panel-scenario.mjs` that appears ≥ 2 times); assert counter `1/N` with N equal to the occurrences counted in
    the DOM text of the main-thread bubbles; `CSS.highlights.get("find-match").size === N`; Enter → `2/N`;
    Shift+Enter twice → `N/N`; Esc → bar hidden, `CSS.highlights.get("find-match")` empty or absent; a word only
    inside a tool group → `0/0`.
  - `find-bar-switch`: open the bar in one view with hits, create a second session and activate it → no
    `find-match` ranges inside the second view's log; switch back → ranges back; close the first view → no
    exception in the console, highlights empty.
- [ ] **Step 2: Run** `node scripts/ui-check/run.mjs find-bar find-bar-switch` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both checks and the baseline checks (`node scripts/ui-check/run.mjs` with no names, full run)
  — PASS; the baselines must not change (the bar is hidden by default).
- [ ] **Step 5: Commit** `feat(search): find bar in a session`.

### Task 7: Jump from a sidebar hit

**Files:**
- Modify: `electron/renderer/app.js` (`jumpToHit`), `electron/README.md` (a short "Search" section)
- Test: `scripts/ui-check/checks.mjs` (checks `content-jump` and `content-jump-dead`)

**Interfaces:**
- Consumes: Task 5's snippet data and `jumpToHit` stub, Task 6's `FindBar.open`/`goTo`.
- Produces: `async function jumpToHit(sessionId: string, hit: {k, before, after} | null): Promise<void>`.

Behaviour: find the session object (from `sessions` or an open view); `await openSession(s)` (which returns after
the replay and `toBottom`) or `activate` an open live view; then `view.findBar.open(query)` with the current
`#search` text and `goTo(hit)`. A `goTo` result with `exact: false` (and a hit was given) shows the note
`This hit was not found in the loaded view` in the bar. A pre-compaction hit (`k === -1`) skips `goTo` and shows the
note. If the open fails (dead view), the bar still opens over what was replayed; no unhandled rejection.

- [ ] **Step 1: Write the failing UI checks.**
  - `content-jump`: `events.jsonl` for `HISTORY_ID` built from the played scenario's real texts (as
    `message-times-history` builds it, but with real `content`), reload, type a word with ≥ 2 hits, click the
    second snippet → the bar is open with the query, counter `2/N`, the current range's text equals the word and
    its bubble is in the viewport.
  - `content-jump-dead`: same, but the snippet's `before` changed in the DOM data so nothing agrees → note
    `This hit was not found in the loaded view` shown; and a jump to a session whose open fails (scripted agent
    refusing `session/load`, as existing dead-view checks do) → no unhandled rejection, bar open.
- [ ] **Step 2: Run** `node scripts/ui-check/run.mjs content-jump content-jump-dead` — FAIL.
- [ ] **Step 3: Implement** `jumpToHit` and the README section (what is searched, what is not, `Ctrl+F`).
- [ ] **Step 4: Run** both checks, `npm test`, and the full UI run — PASS.
- [ ] **Step 5: Commit** `feat(search): jump from a sidebar hit to the message`.

### Task 8: Pre-compaction hits (only if the probe set `REPLAY_HAS_PRE_COMPACTION = false`)

**Files:**
- Modify: `electron/renderer/app.js`, `electron/renderer/style.css`
- Test: `scripts/ui-check/checks.mjs` (check `content-jump-compacted`)

Task 3 already numbers and marks the hits, Task 5 styles them, and Task 7 shows the note for `k === -1`. This task
only adds the check that runs the whole path: an `events.jsonl` with a `session.compaction_complete` between two
user messages containing the word; the earlier hit is shown `.before-compaction` with its tooltip, and clicking it
opens the session with the note and no jump. Skip this task (and say so in the final report) if the probe set the
constant `true`.

- [ ] **Step 1: Write the check**, **Step 2: run (FAIL)**, **Step 3: fix what fails**, **Step 4: run (PASS)**,
  **Step 5: commit** `test(search): hits before a compaction`.
