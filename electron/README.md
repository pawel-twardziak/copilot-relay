# Copilot Sessions (desktop app)

A small Electron app for GitHub Copilot CLI sessions, built on the CLI's ACP server (`copilot --acp --stdio`).
It runs on Windows, macOS and Linux.

- **Resume** any existing Copilot CLI session, including sessions started in a terminal. The list comes from
  ACP `session/list` and is grouped by folder. Opening a session replays its history.
- **Start** a new session in any folder: use **+ New session**, `Ctrl/Cmd+N`, or the `+` next to a folder in the list.
- **Collapse** a folder in the list by clicking its name (▸ / ▾, the number is its session count). **Pin** a session
  with 📌 (on hover): pinned sessions are listed on top, above the folders. Both are remembered. While you filter the
  list every folder is shown expanded.
- Chat with streamed answers, file diffs and permission prompts. Tool calls and thinking collapse into groups, and each
  subagent has its own collapsed group.
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
- **Images in the chat**: images mentioned with `@path` in prompts and relay messages, and Markdown images in answers,
  are shown as thumbnails. Click one to open the viewer: the wheel zooms around the cursor, drag moves the image,
  double-click switches between fit and 100 %, `+` / `-` / `0`, `F` or ⛶ for full screen, `←` / `→` for the other
  images of the message, `Esc` closes. Local images in the session folder or the paste folder load by themselves;
  any other local file shows **Click to load** and is read only when you click it (a path in a relay message or an
  answer must not make the app read files on its own). Network paths and SVG are never shown.
- **Text size**: **Left Ctrl + mouse wheel** or **Left Ctrl + `+` / `-`** makes the chat text bigger or smaller
  (70–200 %), **Left Ctrl + `0`** resets it. It applies to all sessions and is remembered.
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
- **Edit** one of your messages (hover it): its text goes into the message box, and the message and everything
  after it are dimmed. Nothing changes until you send: then the history is cut before that message, in the same
  session, and the edited text is sent in its place (the previous history is kept as `events.jsonl.bak`, files the
  agent changed are not reverted). **Esc** or **Cancel** brings back what you were typing and changes nothing.
  Commands (`/…`) can't replace a message, and relay messages wait until the edited prompt has started. As with
  Delete, don't edit a session that is also open in a terminal Copilot CLI.
- Switch mode (Agent / Plan / Autopilot), model, reasoning effort and approval settings per session.
  The choices come from the CLI.
- The header shows the context window use (`22.9k / 200k · 11%`) and Copilot usage (AI credits) of the session; hover for requests, tokens and changes. The latest premium quota line is shown at the bottom of the sidebar.
- Several sessions can be open at once. Each runs in its own `copilot --acp` process with the session's folder as
  working directory, so the repo's `.github` agents, skills and MCP config apply as in the terminal.

## copilot-relay

Copilot CLI doesn't load extensions in ACP mode, so the copilot-relay extension never runs in sessions opened
here. The app does the extension's job itself. Every open session joins the relay broker under the same
identity it has in a terminal (`cli:<sessionId>`), so it keeps its relay name. It also gets the relay tools
(`relay-list_sessions`, `relay-send_message`, and `relay-create_session` / `relay-report_result`, see
[Delegated sessions](#delegated-sessions)) as an MCP server, and these run without a permission prompt.

- The header shows the session's relay name (e.g. `relay: swift-otter`). Click it to rename the session.
- Messages from other sessions appear as purple "from …" bubbles. Each becomes a new turn as soon as the
  session is idle.
- Queue: off by default (**⚙ Settings → Deliver queued messages during a turn**). When on, messages and your own
  prompts sent while the session works are queued and delivered after the current tool step (never while a tool
  runs). A queued message is answered first (the agent replies and stops); after the last answer the app sends one
  "↻ continuing the task" prompt, so the agent goes back to its task. Stop with nothing queued cancels that continuation; with items queued it pauses, and ▶ answers them and then continues. The queue
  strip shows them: ✕ removes one, click edits your own, ▶ resumes. Up in the first line of the message box takes
  all your queued messages back into it, one per line in front of what you typed (relay messages stay queued).
  Stop pauses a non-empty queue.
- Your own prompts reset the relay's agent-to-agent message budget, as in a terminal.
- Broker address and autostart are read from the installed extension's `config.json` (`npm run install-extension`).
  Without that file the app uses `http://127.0.0.1:7777`, or `COPILOT_RELAY_URL` / `COPILOT_RELAY_PORT` if set,
  and starts `../server.mjs` itself when run from the repo. If the broker is unreachable, the header shows
  `relay: offline` and the app keeps retrying.
- Turn it off in **⚙ Settings → Connect sessions to copilot-relay**. The change applies to sessions opened afterwards.

## File links and preview

File paths in the chat (`src/app.mjs`, `src/app.mjs:42`, `~/notes.md`, Markdown `file://` links) become links when the file exists.
A click opens a full-screen preview instead of the system app.

- Text up to 2 MB is shown highlighted, up to 20 MB as plain text, larger files only offer **Open in system app**.
  Markdown can be switched between rendered and source. A `:42` suffix marks that line and scrolls to it.
- The files opened in a session stay in a list on the left of the preview (20 per session, kept between runs).
  The **Files (n)** button in the session header reopens it.
- The preview refreshes when the file changes on disk, including an atomic save, and keeps the scroll position. A deleted
  file is marked unavailable and stays in the list until you close it.
- A file outside the session's folder is not opened in the preview without your confirmation. A binary file inside the
  folder skips the preview and goes straight to the usual open behaviour. A plain-text `file://` URL is not linked. Paths on a network
  location (NFS, SMB, mapped drives) are never checked or read automatically and are not linked; file text from the agent
  never makes the app touch one.

## Delegated sessions

A session can ask for a new session dedicated to one task, a *delegated* (child) session. Unlike a subagent, a child is
an ordinary session: it appears in the list, you can open it, read what it did, keep talking to it, and resume it later.

- **`create_session(name, task, agent?, model?)`** is called by the parent. A card appears in the parent's view with
  the name, the full task, the agent, the model (or "inherited") and the folder, with **Approve** and **Reject**.
  **Every creation needs your click**: there is no "always allow", and no model or message can answer the card. The
  parent is marked `!` in the list, and an OS notification fires if the window is not focused. The tool returns at
  once; the outcome arrives later as a message from `relay`, so the parent can keep working.
- **The child** gets only its task, not the parent's history, so the parent has to put the context it needs in the
  task. If `model` is left out, the child uses the parent's current model. If `agent` is left out, it uses the
  default Copilot agent; the parent's agent is not inherited. A model or agent the session doesn't offer creates no
  child, and the parent is told the valid values. A child appears in the list without taking you away from what is
  on screen. It can create children of its own, to any depth; there is no limit on their number.
- **`report_result(text)`** is called by the child, once, when it is done. It has no recipient: the broker knows
  the parent. The report wakes the parent as a "from …" bubble and is kept on disk until the parent's prompt has
  started, so it survives a parent that is busy or closed, a broker restart and an app restart. A rare duplicate is
  possible; a lost report is not. After the report, `send_message` works between parent and child as with any other
  session; `list_sessions` marks "your parent" and "your child" with their current names.
- **Permissions.** A child starts with no automatic approvals beyond the relay tools, and asks like any other session.
  While it waits, it has a `!` in the list and an OS notification fires if the window is not focused. Nothing is
  answered for you.
- **No isolation.** A child works in **the same folder and on the same branch as its parent**. There is no worktree or
  sandbox, and the tool has no folder parameter. Children that edit files can get in each other's way or in the
  parent's.
- **Budget.** Messages between a parent and its child have their own budget of 12, refilled by a human prompt in
  either session; reports and relay notices are charged to nothing. It is `maxAgentMessagesPerPair` in the broker's
  `relay.config.json`.
- **The tree.** In the list, a child sits indented under its parent when both are in the same folder group, otherwise
  it shows "child of …". A session view has a relation bar with its parent and its children (a dot when open, ✓ once
  a child has reported, +N for its own children); a click opens one. Names are unique and permanent:
  `<base>-<6 hex>`, the suffix derived from the session, so an old name never points to another session.
- **Closing.** Closing a session closes its open children with it, at every depth; **Close all sub-sessions** in the
  header closes only the children. They all stay resumable and nothing closes by itself. Reopening a parent does not
  reopen its children. Only a child whose Copilot process dies while it is open (a crash or kill, not a close, a
  reload or quitting the app) and that has not reported sends the parent one "ended without reporting" notice, which
  wakes it. A deliberately closed child sends nothing; the tree shows it closed, and a session whose process died is
  shown with a red ring.
- **Messages to a closed relative.** A `send_message` from a parent to a closed child, or from a child to its closed
  parent, shows a reopen card in the sender's view. **Approve** resumes the session and delivers every queued message;
  **Reject** drops them and tells the sender. The sender is told at once that the message waits. An unanswered card
  comes back after a window reload, a restart or a broker restart; a card whose answer did not reach the broker keeps
  its buttons.
- **Deleting.** A session with sub-sessions is deleted through a dialog that lists them as a tree, each with its own
  **Delete too** box (unchecked by default). The ones you keep are closed and stay resumable; one whose parent was
  deleted shows "parent deleted". Sessions that disappear from disk outside the app (terminal, Copilot's cleanup)
  leave the tree after the next complete refresh of the list.
- **Reloading the window** (**View → Reload**, Ctrl+R) stops delegated sessions, after a confirmation, because a
  reloaded window cannot show their cards. Waiting requests for a new session are dropped too. Stopped children stay
  resumable. With no child open and no waiting request, a reload asks nothing.
- **Quitting** while a child has not reported asks for confirmation; **Cancel** keeps everything running. Children are
  never resumed automatically.
- `create_session` and `report_result` exist only for sessions opened in this app, not for terminal sessions or
  sessions started from the broker's web GUI.

## Schedules

**⏰ Schedules** in the sidebar opens a page where you define jobs: a command line that runs on a schedule. Sessions
keep running while the page is open. Jobs run **only while the app is open**: there is no background service, and
runs that fall in a time the app was closed are skipped, not caught up later.

- **A job** is a name, a schedule, a command line, a folder, environment variables, a timeout and a notify mode.
  The schedule is a preset (every N minutes, every N hours, every day at a time, some weekdays at a time) or a
  custom 5-field cron expression, in your local time zone; the form shows the next three run times. The command is
  one line run by the system shell (`/bin/sh -c` on Linux and macOS, `cmd.exe` on Windows) in the job's folder, so
  `python3 report.py --project X` or `./run.sh a b` both work. The timeout is 10 minutes unless you set it (1 to
  1440); after it the whole process tree is killed and the run is marked `⏱ timeout`. On Linux and macOS, when the
  script exits, anything it left running in the background (e.g. `./server &`) is stopped after 1 second, so a job
  can't start a long-lived process. On Windows the tree is only stopped while the script itself is still running
  (timeout, quit, delete): once it has exited, its process ID could already belong to another program.
- **One run per job at a time.** A due time while the previous run is still going is recorded as `⏭ skipped`.
  **▶ Run now** starts a run at once. Different jobs run in parallel. Quitting the app kills running jobs and
  records them as `aborted`; deleting a job kills its run and removes its history and secrets.
- **The run page** shows the status, trigger, start, duration and exit code, the script's summary and details
  (Markdown), and stdout and stderr (the last 64 KB of each, with **Copy**). Below it is the job's history, the last
  20 runs. Click a job's last run in the list, or a notification, to open it.

### How a script reports its result

A script that knows nothing about the app works unchanged: exit code 0 is a success, anything else a failure, and
the summary is the last line of stdout. To give a run its own summary, write to the file the app passes in. Every
run gets these variables, on top of the app's own environment and the job's variables:

- `JOB_RESULT`: the path of an empty file the script may write its result to;
- `JOB_NAME`: the job's name;
- `JOB_RUN_ID`: this run's id.

The result file can hold:

- **plain text**: the first non-empty line is the summary, the whole text the details;
- **a JSON object** with `summary` (string, shown in the notification), optional `details` (string, Markdown) and
  optional `notify` (`true` or `false`: notify about this run or not). Other keys are ignored.

The exit code still decides success; the result file only provides the text. If the file starts with `{` but isn't
valid JSON, it is used as plain text and the run page shows the parse error. Examples:

```bash
echo "3 new PRs" > "$JOB_RESULT"
```

```powershell
'{"summary":"3 new PRs","notify":true}' | Set-Content $env:JOB_RESULT
```

```python
json.dump({"summary": "3 new PRs", "details": "- #12 …"}, open(os.environ["JOB_RESULT"], "w"))
```

The same help, with copy buttons, is in the job form under **How a script reports its result**.

### Notifications

A finished run shows a desktop notification: `✓ <name>`, `✗ <name>` or `⏱ <name>` with the run's summary.
Skipped runs never notify. Each job picks when:

| Notify | success, no result | success with a result | failed or timeout |
|---|---|---|---|
| **Always** (default) | yes | yes | yes |
| **When there is a result or an error** | no | yes | yes |
| **Failure only** | no | no | yes |
| **Never** | no | no | no |

"With a result" means the script wrote something to `$JOB_RESULT`. On success, a JSON result's `notify` overrides
the table for that run: `true` notifies, `false` stays silent. On failure the job's setting applies. Runs stopped by
quitting the app (`aborted`) never notify, since the app is closing. Every run is in the history either way.

### Files and secrets

Jobs, secrets and history are stored in the `userData` folder (see [Finding the Copilot CLI](#finding-the-copilot-cli)):
`jobs.json`, `job-secrets.json` and `job-runs.json`. The app creates and changes jobs only through this page: there is
no relay, MCP or session path to them. Like any app setting, the files can still be edited by a program running as
your user; a saved job that doesn't have the expected shape is skipped and reported at the top of the page.

Mark a variable **secret** to keep its value out of `jobs.json`. It is encrypted with the system keychain (Electron
`safeStorage`) and stored in `job-secrets.json`. The form never shows it again, only `•••• (set)` and **Replace**.
Secret values must be at least 4 characters, and they are replaced with `••••` in stdout, stderr, the summary, the
details and the notification. Without a keychain (e.g. Linux with no keyring) secrets can't be saved, and the form
says so. Put secrets in variables, never in the command line.

Each run gets a private temp folder (`copilot-sessions-job-<random>`, mode 0700) holding the result file. It is
removed when the run ends.

### Azure DevOps

A script reaches Azure DevOps the way it would from a terminal. The app passes its own environment on, so after
`az login` in a terminal the `az` CLI works from a job too. Or put a personal access token in a secret variable such
as `AZURE_DEVOPS_EXT_PAT`, which `az devops` reads by itself.

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
