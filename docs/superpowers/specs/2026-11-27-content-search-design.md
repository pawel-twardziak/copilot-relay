# Content search — design

Date: 2026-11-27. Branch: `feat/content-search`.

## Intent

Today the sidebar filter (`#search`, `UiState.listModel` in `electron/renderer/ui-state.js`) matches only a session's
title, folder and id. The owner wants to find sessions by what was said in them, see where the match is, and jump to
it with navigation; and to search inside one open session.

## Goals

1. **Global content search.** The existing sidebar field also searches message text of every listed session. Below the
   usual (title/folder) list a section shows content hits grouped by session, with snippets.
2. **Jump to a hit.** Clicking a snippet opens (or activates) the session, opens the in-session find bar with the same
   query, and scrolls to that hit.
3. **In-session find.** `Ctrl+F` in the active session opens a find bar over its log: input, counter `3/17`, ↑ ↓
   buttons, Enter / Shift+Enter for next / previous, Esc closes. Matches are highlighted, the current one distinctly.

## Non-goals

- Tool call output, "Thinking" blocks, sub-agent internals (activity groups), system/error lines.
- Regex, word boundaries, fuzzy matching, ranking.
- Searching sessions that the sidebar does not list (deleted, other Copilot homes).
- A persistent index (no FTS of our own on disk, no reliance on Copilot's `session-store.db` `search_index`: on this
  machine (2026-11-27) only 10 of the 13 sessions with an `events.jsonl` are in it, while it still holds 14 sessions
  whose history is gone, and it indexes whole turns, not the messages the view renders). An in-memory cache in the scan worker (below)
  is allowed: it is lost on restart.
- Relay sender names: the `[from <name>]` header is not searchable (on either side), only the message text.

## Anti-goals

- Typing in the field must not stall the UI or the main process (main relays the ACP streams of every open session):
  the scan runs off the main thread, debounced, a scan replaced by a newer query is cancelled, and a stale answer never
  overwrites a newer one.
- The find bar must not mutate the rendered message DOM (Markdown, links, image thumbnails, copy buttons, the
  `_matchText`/`_ownText` element properties stay intact).

## What is searched

- **Global (main):** `user.message` (`data.content`) and `assistant.message` (`data.content`) events in
  `$COPILOT_HOME/session-state/<id>/events.jsonl`, skipping events with `agentId` on the envelope (sub-agents, as
  `usage.mjs` does) and the cache keeper's keep-alive prompts (`isKeepAlive`, as `history.mjs` `isUser` does).
  User text is searched and shown as the user sees it: a queued message unwrapped (`MessageQueue.unwrap`), the
  continue prompt as its label, a relay message without its `[from <name>]` and `[folder "…"]` header lines. The
  unwrap rules live in the renderer today; the scan needs the same transformation before matching, so they move into
  a shared pure module both sides import (builder's choice of module and of how main imports it).
- **In-session (renderer):** the `textContent` of the main-thread message bubbles in the active view's log:
  `.msg.user`, `.msg.relay`, `.msg.agent` that are not inside an activity group or a `details.thought`, excluding the
  copy button and the `.from` label. A replayed relay message is a `.msg.user` whose body still starts with the
  `[from <name>]` line (`FileLinks.parseRelayHeader(...).display`): that leading header is skipped too, so live and
  replayed relay messages count the same and match the global side.

Matching on both sides: case-insensitive substring of the trimmed query; whitespace runs collapsed to one space on both
the query and the text.

## Approaches

Result presentation (owner's pick: a section under the sidebar list). Rejected: a sidebar filter that only keeps
matching sessions (no way to see where the hit is); a full-window search page like Settings (an extra step, hides the
session); a "Titles / Content" toggle by the field (easy to forget which mode is on).

Hit-to-view mapping (owner's pick: 1):

1. **DOM text find in the view + jump to the k-th hit (chosen).** The find bar searches what is rendered, highlights
   with the CSS Custom Highlight API (`CSS.highlights`, `Range` objects, no DOM changes). A global hit carries its
   ordinal k within the session and a snippet; after the replay the bar picks the DOM hit whose surrounding text
   matches the snippet, else the k-th.
   Trade-off: raw Markdown differs from rendered text, so a query with `**` or a link URL can hit globally and not in
   the view (shown as `0/0` and a note).
2. Map by message ordinal (as `el._turn` for fork/edit). Rejected: the replay merges a turn's `assistant.message`
   events into one bubble, so ordinals drift, and word highlight still needs a DOM search.
3. Search the raw `_matchText` in the view. Rejected: raw Markdown offsets cannot be mapped onto the rendered DOM, so
   only whole bubbles could be highlighted.

## Design

### Main: `searchSessions(query, ids)`

- New pure-Node function next to `messageTimes` in `electron/history.mjs` (it is the module that knows the on-disk
  format), exposed as IPC `sessions:search` and `api.searchSessions(query, ids)` in `preload.cjs`.
- It runs in a `worker_thread` owned by main, not on the main thread: corp-PC histories (≈130 sessions, tool output
  in the files) may be tens of MB in total, and main also relays every open session's ACP stream. Main posts each
  query with a sequence number; a newer query cancels the running scan (the worker checks between files).
- The worker keeps an in-memory cache per session: the extracted main-thread messages (`kind`, shown text, time),
  keyed by the file's size and mtime. An unchanged file is not re-read; a grown file (same start) may be read from the
  old size on (builder's call), any other change re-reads it. Queries then run over the cached texts.
- Input: the query and the session ids the sidebar lists (sessions plus open views). Only those are scanned; an id
  that is not a UUID or has no `events.jsonl` is skipped silently.
- Extraction pre-filters lines with a cheap `includes('"user.message"' | '"assistant.message"')` like
  `messageTimes` before `JSON.parse`; a line that is not JSON is skipped, not an error.
- `assistant.message` events with `phase: "commentary"` (text the agent writes alongside tool requests) are included
  only if the replay renders them as main-thread agent text; the probe below settles it.
- Output per session: `{ sessionId, count, hits: [{ k, kind: "user"|"agent", snippet: { before, match, after }, at }] }`,
  `hits` capped (builder's call, ~3 per session for the sidebar, the `count` is the full number), sessions ordered by
  their newest hit time. `k` is the 0-based ordinal of the hit among all hits in that session in file order, counted
  per occurrence (two occurrences in one message are two hits).
- Snippet: about 40 characters either side, cut at whitespace where possible, newlines shown as spaces, `…` where cut.
- Total budget: a cap on sessions with hits or on total hits (builder's call) so a very common word cannot produce a
  huge payload; the header then says "50+ …".

### Renderer: sidebar section

- `renderList` keeps its title/folder model unchanged. When the trimmed query has ≥ 2 characters, a debounced
  (~250 ms) call to `api.searchSessions` runs; each call has a sequence number and only the latest answer is applied.
- The section is appended after the groups: a header `In messages (12 in 4 sessions)`, then per session a row with
  the session title and the hit count, under it the snippets (match in `<mark>`), then `+N more` when `count` exceeds
  the shown hits. Clicking the session row opens it and the find bar with the query at the first hit; clicking a
  snippet, at that hit; `+N more` behaves like the session row.
- While the search is running the header says `Searching messages…`; no hits: the section is not shown (the "No
  matches" line only when both the list and the content search are empty). A failure shows a one-line note in the
  section, not an alert.
- A session listed in both the title/folder list and the content section appears in both.
- The placeholder becomes `Filter by title, folder or message…`.

### Renderer: in-session find bar

- One bar per `SessionView`, hidden by default, placed above the log. `Ctrl+F` (Cmd+F on macOS) when a session view is
  active opens it and focuses the input with its text selected; it must not fire while a modal dialog (Settings,
  Schedules, image viewer) is open.
- Typing re-runs the search (debounced lightly) over the bubbles listed above; the counter shows `i/N`, `0/0` when
  none. Enter / ↓ next, Shift+Enter / ↑ previous, both wrap around. Esc closes and clears the highlights.
- Highlights: two named highlights (`find-match`, `find-current`) styled in `style.css` for both themes. The current
  match is scrolled into view (`block: "center"`).
- A match inside a collapsed element of a main-thread bubble (a `<details>` in the rendered Markdown) opens it.
- Live updates: while the bar is open, new or growing messages (streaming) re-run the search without moving the
  current position; the counter updates.
- Opening from a global hit: `openSession` is awaited (it returns after the replay, `applyTimes` and `toBottom`), then
  the bar opens with the query and selects the target. Target choice: the DOM hit whose text around the match equals
  the snippet's `before`/`after` (normalized, compared on the shorter common length), nearest to index k. When no
  snippet matches, the bar goes to the hit nearest to k (or stays at `0/0`) and shows a note `This hit was not found
  in the loaded view` — never a silent landing on a different hit. An already open view goes straight to the find
  step.

### Probe first: replay versus the file

Before the UI work, a probe (a script under `scripts/sdk-probe/`, like the earlier probes) compares, for a few
sessions including one after `/compact` and one with `phase: "commentary"` messages, the main-thread messages the
`session/load` replay renders with the ones the extraction takes from `events.jsonl`. Its result decides:

- whether commentary messages are searched (above);
- whether messages from before a compaction are in the replay. If they are not, the scan marks hits from before the
  last `session.compaction_complete` (`beforeCompaction: true`), the sidebar shows them dimmed with a tooltip, and a
  click on one opens the session with the note instead of a jump; `k` then counts only the hits after the compaction.
  If they are, nothing changes.

The probe runs on this Linux machine; the corp-PC check of the same script goes to the backlog.

## Constraints

- The relay client copy must be fresh for UI checks (`npm --prefix electron run copy-relay`).
- Tests: unit tests for `searchSessions` (format edge cases: bad lines, sub-agent events, keep-alive prompts, queued
  and relay wrapping, case and whitespace, caps, `k` ordering) and for the pure find/target-choice logic, extracted
  into a renderer module with no DOM dependency where possible; UI tests for the sidebar section and the find bar in
  the existing UI test harness.

## Left to the builder

- Exact caps (hits per session, total), debounce times, snippet length.
- Where the user-text unwrap rules live (shared module or renderer-side).
- Module split for the find bar (a new `electron/renderer/find-bar.js` is the expected shape).
