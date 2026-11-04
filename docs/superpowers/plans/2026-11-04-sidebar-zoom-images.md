# Sidebar pin/collapse, chat font zoom, links, image thumbnails + viewer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapsible projects and pinned sessions in the sidebar, Left-Ctrl chat font zoom, verified clickable links, and image thumbnails with a zoom/pan/full-screen viewer in the Electron GUI.

**Architecture:** Pure, DOM-free logic goes into a new classic-script module `electron/renderer/ui-state.js` (same pattern as `renderer/commands.js`: sets `globalThis.UiState`, `require()`-able in tests). Path-scope logic for local image reads goes into a new ESM module `electron/paths.mjs` imported by `main.mjs`. `app.js` wires DOM/events; `main.mjs` gets one new IPC channel `images:load`; UI state (pins, collapsed projects, chat scale) persists in renderer `localStorage`.

**Tech Stack:** Electron 45, vanilla JS (no bundler), `marked` + DOMPurify, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-04-sidebar-zoom-images-design.md`

## Global Constraints

- Never load a `file:` URL in the renderer; CSP in `renderer/index.html` stays `img-src data: https:` unchanged; DOMPurify `file:` exception stays `<a href>`-only.
- Local images are read only by the main process; auto-load only when the real path (symlinks resolved via `localRealpath`) is inside the session `cwd` or a paste folder; otherwise only after an explicit user click; network paths always refused.
- Image types shown: PNG, JPEG, GIF, WebP (sniffed from bytes by `sniffImage`); SVG never.
- Chat scale: 70 %–200 %, step 10 %, Left Ctrl + `0` = 100 %; global; Left Ctrl only (`e.code === "ControlLeft"`).
- Pinned section is above "Open in app" and above all projects; pinned sessions are not repeated in their project group.
- UI state must not change on background refresh (`refresh` / `scheduleRefresh` / the 60 s `renderList` timer).
- Must work on Linux and Windows paths (`\`, drive letters, `@"C:\a b\x.png"`, case-insensitive compare on win32).
- Existing tests (79) keep passing: `npm test` at repo root.
- Work on branch `feat/sidebar-zoom-images`; one commit per task.

## Review Focus

1. **Background refresh while a project is collapsed / search is active** — collapsed state and pins stay as the user set them; list doesn't jump. (Task 1 test `collapsed state is not changed by query`; Task 2 test `stale pinned ids are ignored`.)
2. **Symlink inside `cwd` pointing outside it** (e.g. `cwd/link.png -> /etc/x.png`) — treated as outside: placeholder, no auto read. (Task 5 test `isInside uses the real path given, not the text` + manual check in Task 5 Step 6.)
3. **Agent reply streaming re-renders `innerHTML` every frame** — thumbnails are built once on the final render only, image reads are cached per `cwd+src`, so a long reply or a long replayed history doesn't fire repeated IPC reads. (Task 6 Step 5 manual check: open a session with images in history, count `images:load` calls in a debug log = one per distinct image.)
4. **Ctrl+wheel / Ctrl+`+` with Right Ctrl, or while the viewer is open** — neither the whole page nor the chat font zooms; inside the viewer the wheel zooms the image. (Task 3 Step 6, Task 7 Step 5.)
5. **Windows paths with spaces / mixed case** — `@"C:\Users\A B\Shot.PNG"` is extracted as one mention, and `C:\users\a b` is inside `C:\Users\A B`. (Task 5 test `win32 compare is case-insensitive`; Task 6 test `quoted mention with spaces`.)

---

### Task 1: List model + collapsible projects

**Files:**
- Create: `electron/renderer/ui-state.js`
- Modify: `electron/renderer/index.html` (add `<script src="ui-state.js"></script>` before `app.js`)
- Modify: `electron/renderer/app.js` — `renderList()` (~line 1361), new `uiState` load/save helpers near the top
- Modify: `electron/renderer/style.css` — `.group-title` rules (~line 49)
- Test: `electron/test/ui-state.test.mjs`

**Interfaces:**
- Produces (in `ui-state.js`, exported via `module.exports` when `module` exists, else `globalThis.UiState`):
  - `listModel(sessions, { pinned = new Set(), collapsed = new Set(), query = "" }) -> { pinned: Session[], groups: Array<{ cwd: string, sessions: Session[], count: number, collapsed: boolean }> }`
    - `query` is lower-cased by the caller; match = current rule `${title ?? ""} ${cwd ?? ""} ${sessionId}` includes query.
    - groups sorted by latest `updatedAt` desc; sessions inside desc; `count` = number of matching sessions in the group; `collapsed` = `collapsed.has(cwd) && !query`.
    - (Task 2 fills `pinned`; in this task return `pinned: []` and do not exclude anything.)
  - In `app.js`: `const ui = loadUi()` → `{ pinned: Set<string>, collapsed: Set<string>, chatScale: number }`; `saveUi()` writes `localStorage["copilot-sessions.ui.v1"]` as JSON arrays. Corrupt/missing JSON → defaults (`chatScale: 1`).

- [ ] **Step 1: Write failing tests** in `electron/test/ui-state.test.mjs` (load with `createRequire(import.meta.url)("../renderer/ui-state.js")`, like `commands.test.mjs`):
  - `groups by cwd, newest group and session first` — 3 sessions in 2 cwds → `groups.map(g=>g.cwd)` order and inner order by `updatedAt`.
  - `collapsed group keeps its count` — `collapsed: new Set(["/a"])` → group `/a` has `collapsed: true`, `count: 2`, `sessions.length: 2`.
  - `query expands collapsed groups and filters` — `query: "foo"` → `collapsed: false`, only matching sessions, groups with no match omitted.
  - `collapsed state is not changed by query` — the passed `collapsed` Set still has `/a` after the call.
- [ ] **Step 2:** `npm test` → new tests FAIL (module not found).
- [ ] **Step 3: Implement `listModel`** in `ui-state.js` (header comment and `"use strict"` like `commands.js`).
- [ ] **Step 4:** `npm test` → all PASS.
- [ ] **Step 5: Wire it in `renderList()`**: replace the inline grouping with `UiState.listModel(...)`. Group header: `<div class="group-title" role="button" tabindex="0" aria-expanded>` with `▾`/`▸`, `baseName(cwd)`, a `.count` badge, and the existing `+` button (its click must `stopPropagation()`). A group's items go inside `<div class="group-items"><div>…items…</div></div>`. Click / Enter / Space toggles `ui.collapsed` for that cwd and `saveUi()`, then toggles the `collapsed` class on the **existing** header + `.group-items` in place (no `renderList()`, so the CSS transition can run; the next `renderList()` builds it already in the right state, without animating).
  - Animation (~180 ms, ease-out): `.group-items { display:grid; grid-template-rows:1fr; transition:grid-template-rows .18s ease-out, opacity .18s }`, `.group-items > div { overflow:hidden; min-height:0 }`, `.group-items.collapsed { grid-template-rows:0fr; opacity:0 }`; chevron is one `▸` glyph with `transform: rotate(90deg)` when expanded, `transition: transform .18s`. Collapsed items get `inert` so Tab skips them. `@media (prefers-reduced-motion: reduce)` → no transitions. "Open in app" header unchanged (no chevron).
- [ ] **Step 6: CSS**: `.group-title.toggle { cursor: pointer; }`, `.group-title .count` (muted pill, `margin-left: auto` before `+`), focus outline for keyboard.
- [ ] **Step 7: Verify in the app** (`run` skill / `cd electron && npm start`): toggling slides smoothly with the chevron rotating, and a background refresh right after doesn't replay the animation; collapse a project, press ↻ and wait > 60 s → still collapsed; restart app → still collapsed; type in search → matching sessions visible in collapsed project; clear search → collapsed again.
- [ ] **Step 8: Commit** `feat(desktop): collapsible projects in the session list`.

### Task 2: Pin / unpin sessions

**Files:**
- Modify: `electron/renderer/ui-state.js` (`listModel`), `electron/renderer/app.js` (`item()` ~line 1271, `renderList()`, `deleteSessionFlow()` success path ~line 1334, `refresh()`), `electron/renderer/style.css` (`.item-row`, new `.item-pin`)
- Test: `electron/test/ui-state.test.mjs`

**Interfaces:**
- Consumes: `listModel`, `ui`, `saveUi()` from Task 1.
- Produces: `listModel(...).pinned` = matching sessions whose `sessionId` is in `pinned`, newest first; those sessions are excluded from `groups` (and from `count`). Groups left empty are omitted.

- [ ] **Step 1: Failing tests**:
  - `pinned sessions are listed first and removed from their group` — `pinned: new Set(["s2"])` → `pinned.map(s=>s.sessionId)` = `["s2"]`, no group contains `s2`, its group `count` decreased.
  - `pinned are filtered by query` — pinned `s2` not matching `query` → `pinned` empty.
  - `stale pinned ids are ignored` — `pinned: new Set(["gone"])` → `pinned` empty, no throw.
  - `group whose sessions are all pinned is omitted`.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3: Implement** in `listModel`.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5: UI**: `renderList()` order = `📌 Pinned` header (only if non-empty) → "Open in app" → groups. `item(s, v, { showProject })`: meta line prefixed with `baseName(s.cwd)` when `showProject` (used in Pinned). New `.item-pin` button between `.item` and `.item-del`: text `📌`, `title` "Pin to top" / "Unpin", class `pinned` when pinned; click toggles `ui.pinned`, `saveUi()`, `renderList()`. CSS: unpinned pin button `opacity: .35`, hidden until `.item-row:hover` / `:focus-within`; `.pinned` always visible, `opacity: 1`.
- [ ] **Step 6: Unpin on delete**: in `deleteSessionFlow` after `deletedIds.add(...)`: `ui.pinned.delete(id); saveUi()`. In `refresh()` after a successful list load: drop pinned ids not in `sessions` and not in `views`, `saveUi()` if changed.
- [ ] **Step 7: Verify in the app**: pin 2 sessions from different projects → appear at top, not in their projects, meta shows project name; restart → still pinned; unpin → back in project; delete a pinned (throwaway) session → pin gone.
- [ ] **Step 8: Commit** `feat(desktop): pin sessions to the top of the list`.

### Task 3: Chat font zoom (Left Ctrl + wheel / + / - / 0)

**Files:**
- Modify: `electron/renderer/ui-state.js`, `electron/renderer/app.js` (key tracking block ~line 1499, `SessionView` status line), `electron/renderer/style.css`, `electron/main.mjs` (`createWindow()` ~line 905)
- Test: `electron/test/ui-state.test.mjs`

**Interfaces:**
- Produces: `UiState.CHAT_SCALE = { min: 0.7, max: 2, step: 0.1 }`; `stepScale(current: number, dir: -1|0|1) -> number` (dir 0 = reset to 1; result rounded to 1 decimal, clamped); `applyChatScale(scale)` in `app.js` sets `document.documentElement.style.setProperty("--chat-scale", scale)`.
- Produces: `leftCtrl = { down: boolean }` tracked like `leftShift` (same capture listeners, `ControlLeft`, reset on blur / when `!e.ctrlKey` / on `ControlRight` keydown). Task 7 checks `viewer.open` to suppress.

- [ ] **Step 1: Failing tests**: `stepScale(1, 1) === 1.1`; `stepScale(2, 1) === 2`; `stepScale(0.7, -1) === 0.7`; `stepScale(1.3, 0) === 1`; `stepScale(0.8999999, 1) === 1` (rounding).
- [ ] **Step 2:** `npm test` → FAIL. **Step 3:** implement. **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Wire**:
  - CSS: `:root { --chat-scale: 1 }`, `.log, .composer textarea { zoom: var(--chat-scale); }` (CSS `zoom` keeps layout crisp; thumbnails from Task 6 counter it with `zoom: calc(1 / var(--chat-scale))`).
  - `document.addEventListener("wheel", ..., { passive: false, capture: true })`: if `e.ctrlKey` → always `preventDefault()` (no page zoom); if `leftCtrl.down` and not `viewer.open` → `stepScale` by `-Math.sign(e.deltaY)`.
  - keydown (capture): if `e.ctrlKey` and key in `+ = - 0` (also `NumpadAdd`, `NumpadSubtract`, `Numpad0` via `e.code`) → `preventDefault()`; act only when `leftCtrl.down` and not `viewer.open`.
  - After a change: `ui.chatScale = …; saveUi(); applyChatScale(); ` show `Chat text 120 %` (add "(max)"/"(min)" at a limit) in the active view's `statusEl` for 1.5 s, then restore the previous text. Apply saved scale at startup.
  - `main.mjs`: whole-page zoom off — `win.webContents.setVisualZoomLevelLimits(1, 1)` and `Menu.setApplicationMenu()` with a template that keeps the default `editMenu` / `windowMenu` (and `viewMenu` items `reload`, `toggleDevTools` only), i.e. without `zoomIn`/`zoomOut`/`resetZoom` accelerators. Also `win.webContents.on("zoom-changed", () => win.webContents.setZoomFactor(1))` as a backstop.
- [ ] **Step 6: Verify in the app**: Left Ctrl + wheel / `+` / `-` / `0` scale log + input, stop at 70 % and 200 %; Right Ctrl + same → nothing changes (neither chat nor page); sidebar never scales; restart → scale kept; Ctrl+N still opens a new session; Left Shift+↑ recall still works.
- [ ] **Step 7: Commit** `feat(desktop): Left Ctrl chat font zoom`.

### Task 4: Verify links in the chat are clickable

**Files:**
- Modify (only if a check fails): `electron/renderer/app.js` (`linkify`, `onLink` ~line 302, `renderRun`), `electron/renderer/style.css` (~line 98)

- [ ] **Step 1: Check each case in the running app** with a scratch session (ask the agent to echo the texts): plain `https://example.com` in a user bubble; same in an agent reply; `` `https://example.com` `` inline code; `[text](https://example.com)`; `README.md` and an absolute file path as a Markdown link; a link inside a tool card; a link in a relay message; links after resuming the session (replayed history); middle-click. Expected: each opens in the browser / file opens or is revealed; no navigation of the app window.
- [ ] **Step 2: Style**: links look clickable everywhere, not only in `.msg.agent`: `.log a { color: var(--accent); cursor: pointer; text-decoration: none } .log a:hover { text-decoration: underline }` (replace the `.msg.agent a` rule).
- [ ] **Step 3: Fix any failing case** found in Step 1 at its cause; note each case + result in the commit body.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Commit** `fix(desktop): make chat links look and act clickable` (body lists the checked cases).

### Task 5: Main process — `images:load` with folder scope

**Files:**
- Create: `electron/paths.mjs`
- Modify: `electron/main.mjs` (new handler next to `images:config` ~line 868; import from `./paths.mjs`), `electron/preload.cjs` (`loadImage`)
- Test: `electron/test/paths.test.mjs`

**Interfaces:**
- Produces (`paths.mjs`): `isInside(child: string, parent: string, platform = process.platform) -> boolean` — both already absolute real paths; true for equal or descendant; uses `path.win32`/`path.posix` per `platform`; win32 compare case-insensitive; `"/a/bc"` is not inside `"/a/b"`.
- Produces (IPC): `api.loadImage(cwd: string, src: string, { clicked = false } = {}) -> Promise<{ dataUrl: string, name: string } | { outside: true, name: string } | { problem: string, name: string }>`.
  - `name` = `path.basename` of the resolved path (or of `src` if unresolved).
  - Steps in main: `resolveTarget(cwd, src)` (already refuses remote, resolves `file:`, `~`, relative, symlinks via `localRealpath`) → roots = `[await localRealpath(cwd), ...(await pasteFolders()) current + older, each through localRealpath, nulls dropped]` → if `!clicked && !roots.some(r => isInside(real, r))` → `{ outside: true }` → else `readImage(real, MAX_IMAGE_BYTES)` → `{ problem }` / `tooBig` → `{ problem: "is too large to preview" }` / block → `dataUrl = \`data:${block.mimeType};base64,${block.data}\``.
  - Any thrown error (not found, network) → `{ problem: e.message }`, never a rejected promise for those.
  - `src` that is `https:` / `data:` is never sent here (renderer handles them).

- [ ] **Step 1: Failing tests** in `electron/test/paths.test.mjs`:
  - `descendant is inside` — `isInside("/p/a/b.png", "/p/a", "linux") === true`; equal path → true.
  - `sibling prefix is not inside` — `isInside("/p/ab/x.png", "/p/a", "linux") === false`; `"/p/a/../b.png"` (unnormalised `..`) → false.
  - `win32 compare is case-insensitive` — `isInside("C:\\users\\a b\\x.png", "C:\\Users\\A B", "win32") === true`; other drive → false.
  - `isInside uses the real path given, not the text` — documents that the caller passes realpaths: `isInside("/etc/x.png", "/p/a", "linux") === false`.
- [ ] **Step 2:** `npm test` → FAIL. **Step 3:** implement `isInside`. **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Implement the `images:load` handler** and `preload.cjs` entry `loadImage: (cwd, src, opts) => call("images:load", cwd, src, opts)`. Check `pasteFolders()`'s return shape in `main.mjs` (~line 373) and pass all folders it lists.
- [ ] **Step 6: Verify from DevTools** in the running app: `await api.loadImage(<cwd>, "some.png")` inside cwd → `dataUrl`; `/usr/share/pixmaps/<x>.png` → `{outside:true}`, with `{clicked:true}` → `dataUrl`; `ln -s /usr/share/pixmaps/<x>.png <cwd>/link.png` → `{outside:true}`; `//server/x.png` with `clicked:true` → `problem`; an `.svg` → `problem`.
- [ ] **Step 7: Commit** `feat(desktop): main-process image loading scoped to session and paste folders`.

### Task 6: Thumbnails in the chat

**Files:**
- Modify: `electron/renderer/ui-state.js`, `electron/renderer/app.js` (`marked.use` / `md` ~line 104, `bubble()` ~line 96 call sites 757/1063, `SessionView.flush()` ~line 795, new `SessionView.decorateImages(el, text, kind)`), `electron/renderer/style.css`
- Test: `electron/test/ui-state.test.mjs`

**Interfaces:**
- Consumes: `api.loadImage` (Task 5).
- Produces (`ui-state.js`): `imageMentions(text: string) -> string[]` — same mention syntax as `MENTION_RE` in `main.mjs` (`(?:^|\s)@(?:"([^"]+)"|(\S+))`, unquoted form drops trailing `[.,;:!?)]+`), only extensions `png jpg jpeg gif webp` (case-insensitive), de-duplicated, in order.
- Produces (`app.js`): `thumb({ src, name, cwd, local })` → `<button class="thumb">` element; on click opens `viewer.open(images, index)` (Task 7; until then a no-op). `images` = array of `{ src: dataUrl|https url, name }` of that message.
- Markdown images: `marked.use({ renderer: { image({ href, title, text }) {...} } })` outputs `<span class="img-ref" data-src="…" data-alt="…"></span>` for every image (escape attributes), so no `<img>` with a local `src` is ever created by `md()`. DOMPurify keeps `data-*`.

- [ ] **Step 1: Failing tests**: `imageMentions("see @a.png and @b.txt") → ["a.png"]`; `quoted mention with spaces` — `'@"C:\\A B\\Shot.PNG"'` → `["C:\\A B\\Shot.PNG"]`; `"@x.png, @x.png."` → `["x.png"]`; `"mail me@x.png"` → `[]` (needs whitespace/start before `@`).
- [ ] **Step 2:** `npm test` → FAIL. **Step 3:** implement. **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Wire `decorateImages`** (called once per finished message, never per streaming frame):
  - user / relay bubbles (live: after `bubble()`; replayed: in `flush()` when `r.type === "user"`): `imageMentions(text)` → a `.thumbs` row appended to the bubble.
  - agent replies: in `flush()` / final `renderRun` for `r.type === "agent"`, replace each `.img-ref` by a thumbnail in place.
  - Source handling: `https:` → `<img src>` directly; `data:image/(png|jpeg|gif|webp)` → directly; anything else → `api.loadImage(this.cwd, src)`; cache promises in a view-level `Map` keyed by `src` (so re-renders and repeats don't re-read).
  - `{ outside }` → chip `🖼 Click to load <name>`; click → `api.loadImage(cwd, src, { clicked: true })` → becomes a thumbnail for that chip only (do not put the clicked result into the shared cache: the same outside path elsewhere still needs its own click, per spec).
  - `{ problem }` → small muted chip `🖼 <name> unavailable` with the problem as `title`; no status-line error.
  - Thumbnail CSS: `.thumbs { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; zoom: calc(1 / var(--chat-scale)); white-space: normal }`, `.thumb img { max-width:160px; max-height:120px; object-fit:contain; border-radius:6px; border:1px solid var(--border); cursor: zoom-in; display:block }`, `img loading="lazy"`.
  - Temporary debug: `console.debug("[thumbs] load", src)` in the IPC path for the Review Focus #3 check; remove before commit.
- [ ] **Step 6: Verify in the app**: paste a screenshot → thumbnail under the sent bubble; ask the agent to reply with `![x](<pasted path>)`, `![x](relative.png)` (in cwd), `![x](/usr/share/pixmaps/<x>.png)` → first two thumbnails, third a "Click to load" chip that loads on click; `![x](https://…png)` → thumbnail; resume the session → same thumbnails from history; DevTools console shows one `[thumbs] load` per distinct image; selection/copy of message text still works; chat zoom doesn't change thumbnail size.
- [ ] **Step 7: Commit** `feat(desktop): image thumbnails in chat messages`.

### Task 7: Image viewer (overlay, wheel zoom, drag pan, full screen)

**Files:**
- Modify: `electron/renderer/ui-state.js`, `electron/renderer/app.js` (new `viewer` object; hook in `thumb()` click), `electron/renderer/index.html` (overlay markup), `electron/renderer/style.css`
- Test: `electron/test/ui-state.test.mjs`

**Interfaces:**
- Consumes: `thumb()` click → `viewer.open(images, index)` (Task 6); `leftCtrl` / key handlers (Task 3) check `viewer.isOpen`.
- Produces (`ui-state.js`):
  - `VIEWER_ZOOM = { min: 0.1, max: 10 }`
  - `fitScale(iw, ih, vw, vh) -> number` = `Math.min(1, vw / iw, vh / ih)`.
  - `zoomAt(state: { scale, x, y }, factor: number, cx: number, cy: number) -> { scale, x, y }` — new scale = clamp(`scale * factor`); the image point under (`cx`,`cy`) (viewport coords, `x`/`y` = image top-left translation) stays under it: `x' = cx - (cx - x) * s'/s`, same for y.
- Produces (`app.js`): `viewer = { isOpen: boolean, open(images, index), close() }`.

- [ ] **Step 1: Failing tests**: `fitScale(4000, 2000, 1000, 800) === 0.25`; `fitScale(100, 100, 1000, 800) === 1`; `zoomAt({scale:1,x:0,y:0}, 2, 100, 50)` → `{scale:2, x:-100, y:-50}`; `zoomAt({scale:10,x:0,y:0}, 2, 0, 0).scale === 10` (clamped, x/y unchanged).
- [ ] **Step 2:** `npm test` → FAIL. **Step 3:** implement. **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Overlay UI**:
  - Markup: `<div id="viewer" hidden>` with `.viewer-stage` (the `<img>` positioned with `transform: translate(x,y) scale(s)`, `transform-origin: 0 0`), toolbar `− [100%] + ⛶ ✕`, caption (name / alt, `i / n` when several).
  - Open: fit to stage, centred; focus the overlay.
  - Wheel (no modifier needed, `passive:false`, `preventDefault`): `zoomAt(state, deltaY < 0 ? 1.15 : 1/1.15, cx, cy)`.
  - Pointer drag with left button on the stage: pan (`setPointerCapture`, cursor `grab`/`grabbing`).
  - Double-click: toggle fit ↔ 100 % (100 % centred on the click point via `zoomAt`).
  - Keys while open (capture, `stopPropagation` so chat shortcuts don't fire): `+`/`=`/`-`/`0` zoom/fit, `F` toggles full screen, `←`/`→` previous/next image in the message, `Esc` exits full screen if active, otherwise closes.
  - `⛶`: `overlay.requestFullscreen()` / `document.exitFullscreen()`; refit on `fullscreenchange` and window `resize`.
  - Click on stage background (not the image, and not the end of a drag) closes. `✕` closes.
  - On close: clear `img.src`, return focus to the thumbnail that opened it.
- [ ] **Step 6: Verify in the app**: large screenshot opens fitted; wheel zooms around the cursor; drag pans; double-click toggles; ⛶ / F full screen and Esc out; Esc closes; ←/→ between two images in one message; Left Ctrl + wheel over the viewer zooms the image, not the chat font; Left Shift+↑ while open does not recall a message.
- [ ] **Step 7: Commit** `feat(desktop): image viewer with zoom, pan and full screen`.

### Task 8: Final check

- [ ] **Step 1:** `npm test` → all PASS (79 + new).
- [ ] **Step 2:** In the app, run once through all Task 1–7 "Verify" steps together (one session with images, pinned, in a collapsed project's neighbour, at 150 % chat scale).
- [ ] **Step 3:** Update `electron/README.md` feature list (pins, collapse, Left Ctrl zoom, thumbnails/viewer, image scope rule) in the same style as existing entries; commit `docs(desktop): document sidebar, zoom and image features`.
