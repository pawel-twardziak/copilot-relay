# File links and full-screen file preview: design

Date: 2026-11-09. Status: awaiting approval. Applies to the desktop app (`electron/`); the broker changes only to carry a sender's folder.

## Intent

Agents name files all the time, but today only Markdown links and tool-card paths are clickable, and they leave the app (system handler or file manager). The goal is to make every real file named in the chat clickable and readable inside the app, with quick switching between the files opened in that session.

## Goals

- File paths in chat text, inline code, code blocks and tool output become links, including relative paths and bare names.
- A relative path resolves against the folder of the session that wrote it (agent or delegated child), or the sender's folder for a relay message.
- Clicking a text file opens a full-screen preview with a side panel of that session's recently opened files, where files can be switched and closed.

## Non-goals

- Previewing images, PDFs or other binary files. They keep today's behaviour.
- Editing files.
- Search inside the preview, code folding, or a code-editor component.
- The relay web panel (`public/index.html`).

## Anti-goals

- A link that points at something that is not an existing file. Folders never become links from plain-text detection.
- Text from an agent or relay message causing file contents to be read, or a network connection to be opened, without a click.
- Chat copy and Markdown export changing because of link markup.
- A long tool output noticeably freezing the UI.

## Decisions made with the user

| Topic | Decision |
|---|---|
| Access | Files in the viewing session's folder open directly. Files outside need a confirmation showing the path. Network paths stay refused. |
| File types | Text only. |
| Code display | highlight.js, loaded as a browser script like `marked` and `DOMPurify`, with line numbers and scroll to `:42`. |
| Recent list | One list per session, kept across restarts. Content is always read fresh. |
| Path forms | Paths with a separator, names with an extension, and only well-known names without one (`Makefile`, `LICENSE`, `Dockerfile` and similar). Ordinary words are never candidates. Linked only when the target exists and is a file. |
| Where detected | Messages, agent replies, inline code, tool cards, code blocks and tool output. |
| Absolute paths | Every local file is eligible, including outside the session folder (`/etc/hosts`). Network mounts and mapped drives are excluded from automatic checks. |
| Relay messages | Relative paths resolve against the sender's folder, which is written into the relay message text so it survives in history. |
| File changes | The displayed file refreshes automatically, keeping the scroll position. Other files are read when switched to. |
| Markdown | Rendered by default through the chat's `marked` + `DOMPurify` pipeline, with a toggle to source. A link with a line number opens source. |
| Large files | Up to 2 MB: highlighted. 2-20 MB: plain text. Above 20 MB: a message and a button to open in the system app. |

## How it works

### Path detection (renderer)

Runs once text is final: a finished agent reply, a finished tool card, a user or relay bubble, a replayed message. Not during streaming.

1. Walk text nodes under the message, skipping existing links and buttons. Unlike `linkify`, `pre` and `code` are included.
2. Tokenize into candidates, trim surrounding punctuation and brackets, and exclude URLs. Recognise the suffixes `:42`, `:42:7`, `#L42` and `#L42-L50`.
3. Deduplicate and send one batch per message to the main process, which answers per candidate whether it is an existing file.
4. Wrap only confirmed tokens in `<a href>`. `onLink` (`electron/renderer/app.js:336`) already routes clicks.

The tokenizer belongs in a pure module with unit tests (`ui-state.js` style). Link markup must not change `pre._copy`, `textContent`-based copy or `_md` exports.

### Existence check (main, new `files:check`)

- Uses `localRealpath` (`electron/main.mjs:964`) so links and junctions pointing to network paths are refused before anything follows them. Only metadata is read.
- Bare names resolve only directly against the base folder. There is no recursive search.
- Follows the `isRemote` rules. UNC and `file://host` candidates are rejected on their text alone, before any disk access.
- A candidate is compared by its text with a table of network locations **before** its first `lstat`, and so is every symlink target met during resolution. Sources: `/proc/self/mountinfo` on Linux (network filesystems, FUSE network filesystems and autofs, including `/net`), `mount` output on macOS, and the drive type of each letter on Windows, where only fixed local drives count. The table is cached briefly and rebuilt when it expires.
- If the table cannot be obtained, the check fails closed: only the folders of sessions on the local session list and the home folder are checked.
- A relay sender's folder gets no exception. It is only a base for resolving a relative path, and the same table applies.

### Opening

`openLink` first asks the main process to read the target for preview:

- Text file: open it in the preview.
- Web link, folder, binary or anything else: unchanged `open:link` behaviour.

`files:read(baseCwd, target, { viewingCwd, confirmed })`:

- Resolves through `resolveTarget`, so it inherits the percent-decoding, line-suffix and network rules.
- Compares the **real** path with the **real** `viewingCwd`, so a symlink inside the session folder that points elsewhere requires confirmation. Returns `{ outside: true, path }` until `confirmed` is true, mirroring the `clicked` rule in `images:load`.
- The no-confirmation root is always the viewing session's folder, never a relay sender's folder, because a peer reports its own folder and could otherwise name any directory.
- Treats a file as binary when its first 64 KB contains a NUL byte. Otherwise decodes as UTF-8, replacing invalid sequences.
- Applies the size tiers and returns `{ path, name, text, tier, size, mtime }`. Never passes raw file content to `innerHTML`.

### Sender folder for relay messages

- Peers report their `cwd` at registration. Both the desktop app and the CLI extension report it.
- The broker writes the sender's folder into the `prompt` text next to the `[from <name>]` prefix (`src/registry.mjs`, `src/delegation.mjs`), and also delivers it as a `fromCwd` field that `electron/main.mjs:123` forwards.
- The agent receives this text too, so it can resolve the sender's relative paths itself.
- Replay reads the folder from the text. `RELAY_PREFIX` (`electron/renderer/app.js:226`) is extended so the folder is not shown in the chat, and fork and delete matching against history keep working for messages with and without it.
- A peer that reports no folder, a message from `user` or `relay`, and messages recorded before this change: relative paths are not linked. Absolute paths still are. Names are never used to look up a folder.

### Preview UI

A full-screen overlay beside the existing `#viewer`, owned by the active `SessionView`:

- Left panel: the session's files, most recent first, with switch and close per entry.
- Main area: file name and full path, line numbers, highlighted content, scroll and highlight of the target line, Markdown toggle, "Open in system app", close.
- Takes the keyboard while open like `viewer.isOpen` does, so chat shortcuts do not fire underneath. Esc closes.
- Language comes from the extension or well-known file name, and falls back to plain text.

### Recent list

A new `localStorage` key holds, per session id, an ordered list of `{ path, line }` using real absolute paths. It is removed on successful session delete.

### Auto-refresh (main)

One `fs.watch` for the displayed file, replaced on switch and closed with the overlay. It is debounced and survives atomic-save rename by re-attaching. A deleted file shows as unavailable and stays in the list until closed. Only a path that has already passed `files:read` may be watched.

## Calls made by the designer (not discussed with the user)

- Candidate cap: 500 unique candidates per message. The rest stays unlinked.
- Well-known names match case-sensitively, so the word "license" in prose does not link to `LICENSE`.
- Recent list cap: 20 per session, oldest dropped.
- Forked sessions start with an empty list.
- Files opened from the recent list do not ask for confirmation again.
- A session header button "Files (n)" reopens the preview after it is closed. Without it the list is reachable only through another link.
- In rendered Markdown, relative links resolve against that file's own folder and open in the same preview. Images are not loaded there; their alt text is shown.
- The overlay closes when the active session changes.
- Closing a file removes it from the list. Closing the last one closes the overlay.

## Left to the builder

- Module layout and exact IPC payloads.
- Which npm package supplies the highlight.js browser bundle and theme, and which languages are included, provided packaged builds contain them and the existing CSP stays unchanged.
- How to keep large plain-text files and long history replays responsive (for example virtualised lines, deferred checks for off-screen messages, a concurrency limit on `files:check`).
- Visual details, consistent with the current theme and the chat text scale.

## Verification

- Unit tests (`npm test`) for tokenizer, suffix parsing, the inside-folder and confirmation rules (including symlinks and traversal), size tiers, binary detection and recent-list operations.
- Manual run of the app: relative, absolute, bare and `:42` links; a relay message from a session in another folder; a symlink leading outside the folder; a large tool output; file changed by an agent while previewed; restart keeps the list; session delete clears it.
- Unit tests for parsing each platform's network-location table, matching before disk access, symlinks leading to a network location, the fail-closed case, and relay prefixes with and without a folder.
- Manual check that an absolute path on a real network mount is not touched and not linked.
- Windows and macOS behaviour needs a run on those systems; UNC and drive rules are also covered by unit tests.
