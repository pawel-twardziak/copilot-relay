# Sidebar pin/collapse, chat font zoom, link check, image thumbnails + viewer

Date: 2026-11-04 · Scope: Electron desktop GUI (`electron/`), mainly `renderer/app.js`, `renderer/style.css`,
`renderer/index.html`, with small additions to `main.mjs` / `preload.cjs`.

## Intent

The session list grows long (many projects, many sessions each), and the chat is hard to read on some screens.
Five quality-of-life features make daily use smoother:

1. collapse projects in the session list,
2. pin sessions at the very top of the list,
3. change the chat font size with Left Ctrl + wheel / Left Ctrl + `+`/`-`,
4. verify that links in the chat are clickable (fix if not),
5. image thumbnails in the chat with a large preview (incl. full screen), wheel zoom and mouse-drag panning.

The approved mockup: `.superpowers/brainstorm/*/content/sidebar-and-viewer.html`.

## Goals

### 1. Collapsible projects
- Each project header (`.group-title` for a `cwd`) gets a chevron ▾ (expanded) / ▸ (collapsed). Clicking the
  header (anywhere except the `+` "new session here" button) toggles it. Keyboard-accessible (header is focusable,
  Enter/Space toggles).
- A collapsed project shows its session count in the header (e.g. `▸ angular-shop 12`). The count is visible on
  expanded headers too (the mockup shows it on both).
- Collapse/expand is lightly animated (user request): the group's sessions slide closed/open with a fade
  (~180 ms) and the chevron rotates. Only on a user toggle, never on a background refresh; no animation with
  `prefers-reduced-motion`.
- Collapsed state is remembered per `cwd` and survives an app restart.
- While the search filter is non-empty, all projects are shown expanded (the stored state is not changed), so a
  match is never hidden.
- The "Open in app" section and the "Pinned" section are not collapsible (they are short).

### 2. Pin / unpin sessions
- A 📌 button on each session row (next to the existing 🗑): dimmed, shown on hover/focus for unpinned sessions;
  always visible and highlighted for pinned ones. Click toggles. Tooltip "Pin to top" / "Unpin".
- Pinned sessions are listed in a **"Pinned"** section at the very top of the list, above "Open in app" and above
  all projects. (User decision.)
- A pinned session is shown in "Pinned" **instead of** in its project group (no duplicate in the project). Since
  it loses its project context, the row shows the project's folder name in its meta line
  (e.g. `copilot-relay · 2h ago · 1a2b3c4d`).
- "Open in app" keeps its current behaviour (an open session appears there as well as in its group / Pinned).
- Order inside "Pinned": most recently updated first (same rule as inside projects). No manual reordering.
- Pins survive an app restart. Pins are by `sessionId`.
- Search filter applies to pinned sessions too (a non-matching pinned session is hidden while filtering).
- Deleting a session removes its pin. A pinned id that no longer exists in the session list is simply not shown
  (and may be pruned from storage on the next successful list refresh).

### 3. Chat font zoom
- Applies to the chat area of session views: the message log (user bubbles, agent replies, tool cards, code
  blocks) **and** the prompt input. Sidebar, header bar and dialogs are not scaled. *(My call: "czcionki w
  czacie"; including the input keeps what you type the same size as what you read.)*
- Shortcuts, active only with **Left Ctrl** held (Right Ctrl does nothing, like the existing Left Shift handling
  in `app.js`, which tracks `ShiftLeft` via `e.code`):
  - Left Ctrl + wheel up / down → bigger / smaller,
  - Left Ctrl + `+` (also `=` and numpad `+`) / `-` (also numpad `-`) → bigger / smaller,
  - Left Ctrl + `0` → reset to 100%. *(My call; standard and cheap.)*
- Range **70 % – 200 %**, step 10 %, clamped. *(My call for "w określonych granicach".)*
- One global setting for all sessions (not per session), persisted across restarts.
- A short transient indicator shows the new value (e.g. "Chat text 120 %" in the view's status line or a small
  toast), so the user knows a limit was reached.
- Electron's own page zoom (Ctrl +/-/0 and Ctrl+wheel zooming the whole window) must not fire for these
  combinations; Right Ctrl + those keys should also not zoom the whole page (whole-page zoom is turned off).
- Implementation hint: a CSS custom property (e.g. `--chat-scale`) on the chat container, with chat font sizes
  expressed relative to it (`calc(... * var(--chat-scale))` or `em` from a scaled root), so layout stays crisp.
  Builder decides the exact mechanism.
- When the image viewer (feature 5) is open, Ctrl+wheel over the viewer belongs to the viewer, not to font zoom.

### 4. Links in the chat are clickable — verification
Current code: `linkify()` turns plain URLs into `<a>`; rendered Markdown links via `marked` + DOMPurify; a click /
middle-click handler on the log calls `api.openLink(cwd, href)` (web links → browser, file paths → opened or shown
in the file manager); `[data-path]` elements also open.
- Verify in the running app (not just by reading code) for: plain `https://` URL in a user bubble, in an agent
  reply, inside inline code, Markdown `[text](https://…)`, a relative/absolute file path link, a link in a tool
  card, a link in a relay message, a link in a replayed (resumed) session's history, and middle-click.
- Links must look clickable (link colour, pointer cursor, underline on hover).
- Fix anything that fails. Report what was checked and what was fixed. No new linking rules unless a case above
  is broken.

### 5. Image thumbnails + viewer
**Which images (user decision: both kinds):**
- **In user prompts:** image files mentioned with `@path` / `@"path"` (this includes pasted screenshots, which
  are saved to the paste folder and inserted as `@path`, and dropped image files). Shown as thumbnails under the
  bubble text; the `@path` text stays as it is. Applies to live prompts and to prompts replayed from history.
- **In agent replies:** Markdown images `![alt](src)` where `src` is `https:`, `data:image/…`, an absolute local
  path, a `file:` URL, or a path relative to the session folder.

**Who may trigger a local read (user decision, one rule for every source):**
A path can come from outside this window: relay messages (other sessions, relay web GUI), agent replies that copy
text from relay/tool output, and replayed history (where app-typed and relay prompts can't be told apart). Today
`main.mjs` only reads local files for text typed in this window. So:
- A local image **inside the session folder (`cwd`) or the paste folder** is read and shown as a thumbnail
  automatically, whatever the source (user bubble, relay bubble, agent reply, live or replayed).
- A local image **anywhere else** is shown as a placeholder chip "🖼 Click to load <file name>". The main process
  reads it only after the user clicks it (user-initiated). The click loads it as a normal thumbnail; it does not
  auto-load the same path elsewhere without a click.
- The "inside" check is done in the **main process** on the real path (after resolving symlinks / `..`), not only
  on the text: a symlink inside `cwd` pointing outside it counts as outside. Network paths are always refused, even
  on click.
- `https:` and `data:image/` (non-SVG) images load as today, no rule change.
- Relay bubbles therefore get thumbnails under the same rule (not excluded).

**Loading local files safely (constraint, must hold):**
- The renderer must never load `file:` images directly (see the comment above `DOMPurify.addHook` in `app.js`:
  a `file://host/...` image would open an SMB connection on Windows and leak the NTLM hash; the CSP has no
  `'self'` / `file:` for `img-src`). Keep the CSP as it is.
- Local images are read by the main process through a new IPC call (e.g. `images:thumb(cwd, path)`), which
  enforces the scope rule above (an explicit "user clicked" flag lifts the folder scope, nothing else) and
  reuses the existing safeguards of the image-attach path in `main.mjs` (resolve relative to `cwd`, refuse network
  paths incl. via symlinks, regular files only, size limit, type sniffed from bytes: PNG/JPEG/GIF/WebP) and
  returns a `data:` URL. SVG is not shown (script/privacy risk); unsupported or missing files show nothing (or a
  small "image unavailable" placeholder), never an error dialog.
- Size limit for preview: builder's choice; the existing attach limit is a reasonable default. Thumbnails may use
  the same data as the full preview (no separate down-scaling required).
- `https:` images keep loading the way they do today (CSP already allows `https:`).

**Thumbnails:**
- Max box about 160 × 120 px, aspect ratio kept (`object-fit: contain`), rounded border, `cursor: zoom-in`.
  Several images → a wrapping row of thumbnails.
- Click (or Enter when focused) opens the viewer. Thumbnails do not scale with the chat font zoom.
- Loaded lazily is fine; must not block rendering a long history.

**Viewer:**
- Overlay over the whole app window (dark backdrop), image centred, initially "fit to window" (never upscaled
  above 100 % on open).
- Toolbar: `−`, current zoom %, `+`, `⛶` (toggle real full screen), `✕` (close). Also shows the file name / alt
  text.
- **Wheel (no modifier needed) = zoom in/out around the cursor position.** Zoom range e.g. 10 %–1000 %
  (builder's call).
- **Left-button drag = pan** (cursor `grab` / `grabbing`).
- Double-click toggles fit ↔ 100 %. `+` / `-` / `0` keys zoom / reset. Esc closes the viewer (if in full screen,
  Esc first leaves full screen — builder may do both in one step). Click on the backdrop outside the image closes.
- `⛶` and `F` toggle full screen of the viewer (Fullscreen API on the overlay element, or the window's
  full-screen; builder's call).
- In a message with several images, ← / → in the viewer go to the previous / next image of that message.
  *(My call; nice to have — may be dropped if it complicates things.)*
- While the viewer is open, keyboard shortcuts of the chat (font zoom, Left Shift+↑/↓ recall, etc.) do not fire.

## Non-goals
- No manual drag-and-drop reordering of pins or projects.
- No per-session font size; no zoom of the sidebar or the whole UI.
- No image editing, download/save-as or copy-image actions in the viewer.
- No thumbnails for images produced inside tool calls / ACP image content blocks from the agent (only Markdown
  images in replies and `@path` images in prompts). Can be a follow-up.
- No changes to how links are opened (main-process `open:link` rules stay).

## Anti-goals (would be a failure even if it "works")
- Loading any `file:` URL in the renderer, or weakening the CSP / DOMPurify rules for images.
- The list jumping or re-collapsing on every background refresh (`scheduleRefresh`) — UI state must be stable
  across refreshes.
- A session becoming unreachable: a pinned or collapsed session must always be findable (pinned section or
  search).
- Breaking existing shortcuts (Left Shift+↑/↓ recall, Enter/Shift+Enter in the input) or text selection/copy in
  the chat.
- Thumbnails slowing down opening a session with a long history.

## Constraints
- Plain JS in the renderer (no framework, no bundler); DOM built with the existing `h()` helper.
- Renderer is sandboxed; new main-process capabilities go through `preload.cjs` `call()` channels.
- Persisted UI state (pins, collapsed projects, chat scale): builder's choice between renderer `localStorage`
  and `settings.json` via main. *(My lean: `localStorage` — UI-only state, no IPC needed; but if
  `settings.json` is used, it must not be clobbered by the existing `settings:set` save of the settings dialog.)*
- Tests: `electron/test/*.test.mjs` (node test runner, currently 79 passing). Pure logic (list grouping/pinning
  ordering, zoom clamping, image-ref extraction from prompt text, path safety for the thumb IPC) should be
  testable; extract into small modules if that's what it takes. Existing tests must keep passing.
- Must work on Linux and Windows (paths with `\`, drive letters, `@"C:\path with spaces\a.png"`).

## Left to the builder
Exact markup/CSS, module split, IPC naming, storage mechanism (see above), zoom maths for the viewer, toast vs.
status-line indicator, lazy-loading strategy, and the order of implementing the five features (they are
independent; separate commits per feature are preferred).
