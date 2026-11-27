# Content search: deferred findings

**Sources:** the per-task reviews (Opus 5.5, high) and the final whole-branch review (Fable 5.2, medium) of
`feat/content-search`. Execution was subagent-driven.

Spec: `docs/superpowers/specs/2026-11-27-content-search-design.md`. Plan: `docs/superpowers/plans/2026-11-27-content-search.md`.

None of these blocked the merge. Line numbers were taken at the reviews and may drift.

**Fixed on the branch, so not listed below:**
- `pickTarget` compared raw-Markdown snippets from the history with rendered text, so a jump to an agent hit near inline
  code, bold, lists or links showed a false "This hit was not found in the loaded view".
- `jumpToHit` turned off follow-bottom even when the jump did not move the log.
- Keep-alive replies and the "Compacted conversation history…" reply were searched but are never shown.
- The README's "Search" section now names the limits. The `searchMessages` doc comment was rewritten.

## A. Worth doing first

1. **The find bar is expensive while a session streams** (`electron/renderer/find-bar.js`: `search`, `run`, the
   MutationObserver; `app.js` `renderRun` ~3034).
   - Every throttled refresh (≤ 100 ms) re-walks the text nodes of every searched bubble and rebuilds every `Range`.
     `renderRun` replaces `r.body.innerHTML` on each frame with new chunks, so the ranges in the streaming bubble
     collapse and come back up to 100 ms later: matches there flicker.
   - The observer keeps running for an open bar in a background view. A 1-character query (allowed) can give
     thousands of live ranges, and every DOM mutation in the document then pays to keep them updated.
   - Proposal: refresh only while the bar is shown (dirty flag, refresh in `show()`); rebuild only the bubbles named
     in the mutation records; rebuild the streaming bubble's ranges in a rAF before paint; consider a delay or cap for
     1-character queries.
2. **`fold` is slow on large histories** (`electron/renderer/find-text.js` `fold`, `foldText`).
   - Measured about 2 s per 20 MB for both `foldText` and `findMatches` (a regex test, `fromCodePoint` and a string
     `+=` per code point; the index map is a plain array). It runs in the worker, so nothing stalls, but the first scan
     and a common-word query on a corp-size history take about a second, and cancellation acts only between files (one
     huge session cannot be interrupted).
   - Proposal: an ASCII fast path with char codes, an `Int32Array` map, and folding in chunks.
3. **Worker errors are silent and can loop** (`electron/content-search.mjs` ~48; `electron/search-worker.mjs` ~362).
   - `w.on("error", () => {})` drops the cause; nothing is logged. `scan(msg).then(…)` has no `.catch`: a throw from
     `extractMessages`/`searchMessages` crashes the worker, the whole cache is lost, and the restart resends the same
     query, which probably crashes again (then the sidebar shows "Message search failed").
   - A synchronous `new Worker` throw inside `search()` rejects but leaves its `pending` entry; in the restart path
     (inside the `exit` handler) it is an uncaught exception in main.
   - Proposal: catch in the worker and answer `{ seq, error }`; log the `error` event in main; wrap `post()` in
     try/catch and delete the entry.
4. **The "In messages" rows are a snapshot** (`app.js` `renderContentResults`, the `#search` input handler).
   - The search re-runs only when the query changes. A session deleted afterwards keeps its row (its name falls back to
     the raw id and a click only sets a status line); a new session or new messages are not searched until the next
     keystroke.
   - Proposal: drop rows whose session no longer exists when rendering; re-run the search from the session-list refresh
     while a query is active.
5. **A link URL or an ordered-list number near the hit still gives a false "not found" note**
   (`electron/renderer/find-text.js` `pickTarget`, `NEAR_CHARS` ~76-82).
   - The fix wave reduces both sides to letters and digits and compares the 16 nearest characters. A Markdown link's
     URL (`[app.js](electron/renderer/app.js)`) and an ordered-list number (`1. `, a CSS marker in the view) are in the
     raw history but not in the rendered text, so a hit within ~16 letters of one disagrees: the right match is selected
     but the note shows. File links are common in agent replies. The code comment claims they "rarely fall inside";
     that is wrong for list numbers.
   - Probes: raw `"1. needle one\n2. needle two"` vs the rendered items, k=1 → `{ index: 1, exact: false }`;
     `See [app.js](electron/renderer/app.js) for needle` → `exact: false`.
   - Proposal: strip `\]\([^)]*\)` and ordered-list markers (`(^|\s)\d+[.)]\s`) from both sides before the
     letters-only reduction; fix the comment; add both cases to the unit test.

## B. Window and wording

6. **Header wording** (`app.js` `renderContentResults`): "(1 in 1 sessions)" is ungrammatical; with `more` the total N
   is the sum over the 50 returned sessions only but reads as the full total (show `N+`). The spec fixed the copy, so a
   change needs the owner's OK.
7. **The note stays while stepping** (`find-bar.js` `setNote`, `step`): "This hit was not found…" stays when the user
   moves on with Enter or the arrows, and can be read as describing the current match. Proposal: clear it on the first
   step.
8. **The note has no `role="status"` / `aria-live`**, so screen readers do not announce it.
9. **A row's name ignores the live view's title** (`renderContentResults`): it prefers `sessions[].title`, while the
   sidebar row uses `v?.title || s.title` and `shortTitle(…)`; a renamed live view shows its old title.

## C. Small behaviour

10. **A `<br>` hard break joins words in the bar** (`find-bar.js` `bubbleText`): `line␣␣\nnext` renders `line<br>next`
   with no whitespace node, so the bar sees "linenext" while the history folds to "line next". The `pickTarget` fix
   absorbs the jump side; counts still differ for a query spanning the break. Same for raw-HTML
   `<details><summary>` in Markdown. Proposal: a virtual "\n" for `BR` (and block elements with no whitespace sibling)
   in `bubbleText`, offsets clamped in `locate`.
11. **`reveal` does not scroll horizontally** inside `pre` or tables (`overflow-x: auto`): a match far along a long code
    line stays out of view.
12. **`Ctrl+F` is matched on `e.key`** (`app.js`, the document keydown): on non-Latin layouts it does nothing (`e.code ===
    "KeyF"` would work; the Ctrl+N handler has the same limit). It also ignores `isComposing` and `defaultPrevented`.
13. **Close and reopen during a jump's wait** (`jumpToHit`): if a resuming view is closed and the session reopened before
    the old `opening` settles, the jump takes the new view without awaiting its `opening`. Very unlikely.
14. **`+N more` is not usable from the keyboard** (`renderContentResults`): `role="button" tabindex="0"` but no
    `onkeydown`; the key handler of the row and the snippets is duplicated.
15. **A trailing space restarts the same search** (the `#search` input handler): `contentState` resets and the hits
    flash to "Searching messages…". Proposal: return early when the trimmed query equals the current one.
16. **The worker builds the events path itself** (`search-worker.mjs` ~323): it repeats the on-disk layout and skips
    `sessionDir`'s realpath / not-a-directory guard (a symlinked session dir is searched here but rejected elsewhere).
    Read-only and UUID-validated, so low risk. Proposal: `sessionEventsPath(home, id)` in `history.mjs`.
17. **`createContentSearch({ env })` ignores `env` for the home** (`content-search.mjs` ~32): the home always comes from
    main's `process.env`; the tests set the global `COPILOT_HOME` instead. Compute it from `env` or drop the option.
18. **The worker cache never shrinks** (`search-worker.mjs` ~318): ids no longer passed stay forever, and each message
    also keeps its `folded` copy (about twice the text). A changed file is re-read whole. Proposal: drop ids not seen
    for N scans or cap the total characters; read a grown file from its old size.
19. **A blank query still reads and parses every file** (`content-search.mjs` / `search-worker.mjs`): return early when
    `query.trim()` is empty. (The sidebar never sends one under 2 characters.)
20. **A failed compaction moves the before/after boundary** (`history.mjs` `extractMessages`): any
    `session.compaction_complete` counts, while `usage.mjs` ~176 checks `data.success === true`. Dead while
    `REPLAY_HAS_PRE_COMPACTION` is true; fix it if the corp-PC probe ever flips the constant.
21. **`find-text.js` edge cases:** `flat()` handles only `\r`/`\n` (tabs stay, `\r\n` gives two spaces); `before` can
    start with whitespace after runs like `"\n\n"`; the cut can split a surrogate pair; a missing or non-numeric
    `wanted.k` gives `index: NaN`; the query `"i"` matches the first unit of `İ`'s fold (undocumented).
22. **`pickTarget` strips a real `…`** at the very start of an uncut `before` or the end of an uncut `after` (harmless:
    the compared length drops by one).

23. **A non-string `user.message` content keeps a keep-alive turn open** (`history.mjs` `extractMessages` ~170-173):
    it `continue`s before `keepAliveTurn` is reset, so the replies after it would be skipped. Theoretical: every observed
    user message has string content.

## D. Tests and housekeeping

24. **Probe script `scripts/sdk-probe/replay-vs-file.mjs`** (before the corp-PC repeat):
    - matching tests each file message for containment in the whole replayed text of its kind, so short messages ("ok")
      give false "found" and a match can span two messages; report replayed message counts and match per message;
    - the README should say each load appends `session.resume`/`session.shutdown` to the session's `events.jsonl` and
      bumps its mtime (which reshuffles "newest N");
    - the spec says "Of the newest 20 sessions, 7 were skipped"; the run had 14 sessions with an `events.jsonl`;
    - "after" mixes never-compacted sessions (add `none`);
    - `--make-compacted`: no try/finally (a failed prompt leaves Copilot running), a silent 60 s timeout, `readFileSync`
      before the file exists; never run;
    - a sub-agent `session.compaction_complete` moves the boundary (checked before the `agentId` skip);
    - an explicit id without `events.jsonl` aborts the run; an id right after a boolean flag is dropped;
      `--sessions abc` gives zero sessions; the CLI version is not recorded in the report.
25. **Shared-scope guards:** the vm guard test cannot see a leaked top-level `const`/`let` (only the copied
    `shownUserText` line guards); `message-queue.js` and `file-links.js` still declare many top-level globals
    (`MARKER`, `wrap`, `FROM_LINE`, …), the same clash risk as the Task 2 bug.
26. **Missing tests:** `relayBody` with `[folder …]` but no `[from …]`, and `[from x]` alone; `extractMessages` with a
    realistic half-written last line (`{"type":"user.message","data":{"content":"hel`), `latest`/`at: null`, a user
    message empty after unwrapping; that an unchanged file is not re-read (same size, `utimesSync`); the worker
    crash/restart path; the sidebar title-or-folder fallback, `+N more`, the failure line, the `No matches` rule,
    `_hit.k/before/after`; a bubble growing while streaming, `Ctrl+F` with a `<dialog>` open, a hidden bar refreshed on
    show; the note cleared by `close()` and by a later exact jump; `content-jump-dead` landing at `N/N`.
    Not run red first: the `foldText`/`folded`-skip tests (Task 4) and the keep-alive-reply test (final fix wave).
27. **Test robustness:** fixed 800 ms sleeps in `content-search-sidebar`; `content-jump` measures `inView` without
    `frames()`; `closeAndList` can be undone by a pending `scheduleRefresh` (1.5 s), a rare flake.
28. **Housekeeping:** a misleading test name ("a query too short for the trimmed text finds nothing" tests a blank
    query); `reopened` in `FindBar.open` means "was closed"; a dead branch in the `No matches` condition.

## Not verified

- **Packaged Windows build:** the worker loading from `app.asar` was verified on Linux with Electron 45 (a scratch asar
  probe), not in an electron-builder build on Windows. Do one message search in the packaged Windows app.
- **Corp-PC repeat of the probe** (Windows, Claude models): compaction replay and `phase: "commentary"` (the local
  sample had one commentary message). Run `node scripts/sdk-probe/replay-vs-file.mjs` there (free, no prompts).
- **Visual check:** highlight and note colours, the "In messages" section, on a real screen (only xvfb ran).
- **macOS:** `Cmd+F` not run on a Mac.
