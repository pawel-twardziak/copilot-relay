# Copilot Sessions (desktop app)

A small Electron app for GitHub Copilot CLI sessions, built on the CLI's ACP server (`copilot --acp --stdio`).
It runs on Windows, macOS and Linux.

- **Resume** any existing Copilot CLI session, including sessions started in a terminal. The list comes from
  ACP `session/list` and is grouped by folder. Opening a session replays its history.
- **Start** a new session in any folder: use **+ New session**, `Ctrl/Cmd+N`, or the `+` next to a folder in the list.
- Chat with streamed answers, collapsible thinking and tool calls, file diffs and permission prompts.
  Press **Stop** (or `Esc`) to cancel a turn.
- Links are clickable. Web and `mailto:` links open in your browser or mail app. File links and file paths in
  tool calls and diffs open in the default app. Relative paths resolve against the session folder, and `:line` /
  `#L12` suffixes are ignored. Only plain text, Markdown, data files (JSON, YAML, CSV, TOML…), diffs, images and PDF are opened, after
  resolving symlinks. Everything else is only shown in the file manager: source code and scripts (an installed
  interpreter could run them), files without an extension, installers, shortcuts, app bundles, HTML/SVG/XML,
  Office/RTF documents and unknown types. `~/` paths and `file:line` links such as `main.mjs:42` work. Network paths (`\\server\share`, `file://host/…`)
  are never opened.
- Paste a screenshot or image into the message box and an `@path` mention is inserted. Pasting or dropping files from
  the file manager inserts `@path` mentions for them. When you send a prompt, every `@path` (or `@"path with spaces"`)
  that points to a png, jpg, gif or webp image of up to about 3.7 MB (5 MB once encoded for the API) is attached, so
  the model sees it. A prompt can attach up to 12 MB of images in total. Pasted images in other formats, or larger
  than the limit (e.g. a full-screen Retina/4K screenshot), are scaled down to 2048 px and saved as PNG or JPEG so
  they fit. Other files stay as text mentions, and the agent reads them with its tools. Only prompts
  you type in this app attach images; relay messages never do, whoever sent them. `@~/…` paths work.
- Pasted images are saved in a private folder in the system temp folder (`%TEMP%` on Windows, `$TMPDIR` on macOS,
  `/tmp` on Linux), named `copilot-sessions-<random>`. It is created once, readable only by you (mode 0700), and
  remembered. The app never deletes the images by itself, but the system may clean its temp folder, e.g. `/tmp` on
  reboot; a new folder is then created on the next paste.
  **⚙ Settings → Files** shows the exact folder, the number and size of the files, **Open folder** and
  **Delete pasted images**, plus the location of the settings file.
- Copy anything. Hover a message, code block or tool output to show its **Copy** button; copying a diff gives the
  new file content. **Copy thread** copies the whole conversation as Markdown. Right-click shows Copy / Select All.
- **Rename** a session: click its title in the header, type a name, press Enter (Esc cancels). The app uses Copilot's
  own `/rename` command, so the name is the same in the terminal CLI and in the list; it runs no model turn and is
  not added to the conversation.
- **Delete a whole session**: the **Delete** button in the session header, or 🗑 next to a session in the list (on
  hover). After a confirmation the app closes it and removes `~/.copilot/session-state/<id>/` and the session's rows
  in `~/.copilot/session-store.db`. This cannot be undone; files the agent changed are not reverted.
- **Your earlier messages**: **Left Shift+↑/↓** in the message box walks through the messages you wrote in this
  session; past the newest one you get back what you were typing. Editing a recalled message makes it the new draft.
  Right Shift+arrows still select text.
- **Fork** or **Delete** from any message (hover a prompt, relay message or the start of an answer).
  Fork on a prompt starts a new session with the history before it and puts the prompt in the message box to edit;
  Fork on an answer starts a new session that ends with that answer. Delete removes the message (or answer) and
  everything after it. Copilot's ACP has no API for this, so the app edits Copilot's session files
  (`~/.copilot/session-state/<id>/events.jsonl`): a fork is a copy named `Fork of …`, a delete keeps the previous
  history as `events.jsonl.bak`. Files the agent changed are not reverted, and a session that is also open in a
  terminal Copilot CLI should not be edited. A future Copilot CLI may change the file format; the app then shows an
  error instead of changing anything.
- Switch mode (Agent / Plan / Autopilot), model, reasoning effort and approval settings per session.
  The choices come from the CLI.
- The header shows the context window use (`22.9k / 200k · 11%`) and Copilot usage (AI credits) of the session; hover for requests, tokens and changes. The latest premium quota line is shown at the bottom of the sidebar.
- Several sessions can be open at once. Each runs in its own `copilot --acp` process with the session's folder as
  working directory, so the repo's `.github` agents, skills and MCP config apply as in the terminal.

## copilot-relay

Copilot CLI doesn't load extensions in ACP mode, so the copilot-relay extension never runs in sessions opened
here. The app does the extension's job itself. Every open session joins the relay broker under the same
identity it has in a terminal (`cli:<sessionId>`), so it keeps its relay name. It also gets the relay tools
(`relay-list_sessions`, `relay-send_message`) as an MCP server, and these run without a permission prompt.

- The header shows the session's relay name (e.g. `relay: swift-otter`). Click it to rename the session.
- Messages from other sessions appear as purple "from …" bubbles. Each becomes a new turn as soon as the
  session is idle. Messages that arrive while it is working wait in a queue.
- Your own prompts reset the relay's agent-to-agent message budget, as in a terminal.
- Broker address and autostart are read from the installed extension's `config.json` (`npm run install-extension`).
  Without that file the app uses `http://127.0.0.1:7777`, or `COPILOT_RELAY_URL` / `COPILOT_RELAY_PORT` if set,
  and starts `../server.mjs` itself when run from the repo. If the broker is unreachable, the header shows
  `relay: offline` and the app keeps retrying.
- Turn it off in **⚙ Settings → Connect sessions to copilot-relay**. The change applies to sessions opened afterwards.

## Run

Requires Node.js 18+ and an installed, signed-in Copilot CLI (`copilot --version`, `copilot login`).

```bash
cd electron
npm install
npm start
```

From the repo root, run `npm run app:install` once and then `npm run app`.

The first `npm start` downloads the Electron binary (about 100 MB, from GitHub). Behind a corporate proxy, set
`HTTPS_PROXY`, or point `ELECTRON_MIRROR` at an internal mirror, e.g. `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`.

## Slash commands and agents

Type `/` in the prompt box for a popup of the CLI's commands, your skills and the app's own commands. A command only
counts as the first word of the prompt. If the session has custom agents, an agent picker appears in the composer next to Send;
`/agent [name]` opens it or switches directly. `/rename <name>` renames the session without sending a message.
Commands the CLI handles itself (such as `/context`) are not stored in the session history, so their bubbles get no
Fork/Delete actions and don't count as turns.

## Prebuilt downloads (Windows, Linux)

The [Desktop app workflow](../.github/workflows/desktop.yml) builds:

- Windows: `Copilot-Sessions-Setup-<version>.exe` (installer, per-user, no admin rights needed) and
  `Copilot-Sessions-Portable-<version>.exe` (single file, no install).
- Linux: `Copilot-Sessions-<version>-x86_64.AppImage` (`chmod +x`, then run) and `Copilot-Sessions-<version>-amd64.deb`.

To publish a release, push a tag: `git tag v0.2.0 && git push origin v0.2.0`. The files are attached to the
GitHub Release for that tag. **Run workflow** in the Actions tab builds the same files as workflow artifacts,
without a release.

The builds are **not code-signed**. Windows SmartScreen shows "Windows protected your PC". Click **More info**,
then **Run anyway**. Company policies may block unsigned installers; the portable `.exe` is often easier to run.

To build locally, run `npm run dist:win` on Windows or `npm run dist:linux` on Linux. Output goes to `electron/dist/`.

## Finding the Copilot CLI

The app runs `copilot` from `PATH`. On macOS and Linux it reads `PATH` from your login shell, so Homebrew, npm
global and `~/.local/bin` installs are found even when the app is started from the Dock or a desktop launcher.
If Copilot still isn't found, open **⚙ Settings** and enter the full path:

| OS | find it with | typical path |
|---|---|---|
| Windows | `where copilot` | `C:\Users\you\AppData\Roaming\npm\copilot.cmd` or `...\WinGet\Links\copilot.exe` |
| macOS | `which copilot` | `/opt/homebrew/bin/copilot` |
| Linux | `which copilot` | `~/.local/bin/copilot` |

The `COPILOT_PATH` environment variable works too. Settings are stored in Electron's `userData` folder:
`%APPDATA%\copilot-relay-desktop` on Windows, `~/Library/Application Support/copilot-relay-desktop` on macOS,
and `~/.config/copilot-relay-desktop` on Linux.

## Notes

- **Don't use the same session in the app and in a terminal at the same time.** Both processes would write to
  the same session state. Close it in one place before resuming it in the other.
- **Close** stops the app's `copilot` process for that session. The session itself stays and can be resumed later,
  from the app or with `copilot --resume <id>`.
- Every prompt uses premium requests, the same as in the terminal.
- ACP support in Copilot CLI is a preview feature. Tested with Copilot CLI 1.0.106.
