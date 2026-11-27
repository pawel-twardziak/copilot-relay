# Copilot Sessions (desktop app)

A small Electron app for GitHub Copilot CLI sessions, built on the CLI's ACP server (`copilot --acp --stdio`).
It runs on Windows, macOS and Linux.

- **Resume** any existing Copilot CLI session, including sessions started in a terminal. The list comes from
  ACP `session/list` and is grouped by folder. Opening a session replays its history.
- **Start** a new session in any folder: use **+ New session**, `Ctrl/Cmd+N`, or the `+` next to a folder in the list;
  the dialog's folder row has **Change…**.
- **Collapse** a folder in the list by clicking its name (▸ / ▾, the number is its session count). **Pin** a session
  with 📌 (on hover): pinned sessions are listed on top, above the folders. Both are remembered. While you filter the
  list every folder is shown expanded.
- Chat with streamed answers, file diffs and permission prompts. Tool calls and thinking collapse into groups, and each
  subagent has its own collapsed group. A work group whose tools ended in different ways shows a count per outcome
  (`✓ 25 · ✗ 1`). In a group's header, ○ means no news (a background subagent sent nothing more
  and no one confirmed it finished, or a tool never ended or was interrupted) and ⊘ means the main turn was stopped
  while a subagent ran: it may still be working, and what it sends later is still shown in its group.
  Press **Stop** (or `Esc`) to cancel a turn.
- **⚙ Settings → Tool and subagent details** puts the content of the groups in an Activity panel beside the chat:
  **In the chat** (the default) keeps every group inline, **Subagents in a side panel** moves the subagent groups,
  **Everything in a side panel** the tool and thinking groups too. Saving applies it to the open sessions, also while
  a turn runs. Each group keeps its one-line header in the chat (mark, ⏸, Fork/Delete); a click on it, or on
  "N subagents running", opens the group in the panel. Permission cards stay in the chat. The panel appears with its
  first group and follows its output while you are at its bottom; opening an entry or scrolling up stops that.
  Drag its left edge to resize it, » hides it and **Activity** in the header brings it back; the width and the hidden
  state are kept for all sessions. In a view narrower than 760 px the panel is a drawer over the chat, opened by
  **Activity** or a header click and closed by ✕, `Esc` inside it, or a permission card. While you edit a message,
  the panel entries of the groups after it are dimmed with them.
- Links are clickable. Web and `mailto:` links open in your browser or mail app. File links and file paths in
  tool calls and diffs open in the app's preview (see "File links and preview" below); a file that is not text goes
  to the default app. Relative paths resolve against the session folder. In the default app `:line` / `#L12`
  suffixes are ignored, and only plain text, Markdown, data files (JSON, YAML, CSV, TOML…), diffs, images and PDF
  are opened, after resolving symlinks. Everything else is only shown in the file manager: source code and scripts (an installed
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
- **Message times**: each of your messages, relay messages and answers shows the time it was sent (`HH:MM`, the full
  date in its tooltip), and a date line separates the days. For a reopened session the times come from Copilot's
  `events.jsonl`; a message that can't be matched there shows none.
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
- The header shows the context window use (`22.9k / 200k · 11%`) and Copilot usage (AI credits) of the session; hover for requests, tokens and changes. The quota line at the bottom of the sidebar is asked live from Copilot (the Settings command, headless). It shows the premium pool, or the chat pool when premium has no entitlement. When the live query fails it shows the last figure with "as of HH:MM" for up to an hour, and it is hidden when there is none. Refresh forces a new query.
- Several sessions can be open at once. Each runs in its own `copilot --acp` process with the session's folder as
  working directory, so the repo's `.github` agents, skills and MCP config apply as in the terminal.

## copilot-relay

Copilot CLI doesn't load extensions in ACP mode, so the copilot-relay extension never runs in sessions opened
here. The app does the extension's job itself. Every open session joins the relay broker under the same
identity it has in a terminal (`cli:<sessionId>`), so it keeps its relay name. It also gets the relay tools
(`relay-list_sessions`, `relay-send_message`, and `relay-create_session` / `relay-report_result` /
`relay-adopt_session` / `relay-release_session`, see [Delegated sessions](#delegated-sessions)) as an MCP server, and
these run without a permission prompt.

- The header shows the session's relay name (e.g. `relay: swift-otter`). Click it to rename the session.
- Messages from other sessions appear as purple "from …" bubbles. By default they are held until you approve
  them (see **Messages wait for you** under [Delegated sessions](#delegated-sessions)); an approved message
  becomes a new turn as soon as the session is idle. The broker's own notices are never held.
- Cache keeper: off by default (**⚙ Settings → Keep idle sessions' prompt cache warm, then compact them**, with the number
  of keep-alive prompts and the minimum context in k tokens). While a session is idle the app sends a few cheap
  keep-alive prompts to keep its prompt cache warm, then compacts it. The header chip shows "♻ Keeping the cache warm (n/N)"
  or "⏳ Compacting in m:ss" with **Not now**; the status-bar switch **Keep cache** opts one session out; the list shows
  ⏳ next to a session about to be compacted. Queued messages or text in the message box hold the keeper back.
- Queue: off by default (**⚙ Settings → Deliver queued messages during a turn**). When on, messages and your own
  prompts sent while the session works are queued and delivered after the current tool step (never while a tool
  runs). This holds for approved messages and, with **My messages while busy** off, for your own prompts; with that
  switch on (the default), a message you send during a turn waits under **Your messages** for Approve instead, and
  relay messages are held too (see **Messages wait for you**). A queued message is answered first (the agent replies and stops); after the last answer the app sends one
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
- **⚙ Settings → Relay broker → Update and restart broker** brings the broker to the latest code without closing
  the app or its sessions. Set the copilot-relay repository folder first (it defaults to the folder of the broker
  the app starts). The button runs six steps and shows each one:
  1. **Check** – the folder is a copilot-relay repository.
  2. **Update** – uncommitted changes go to a stash named `copilot-sessions restart <time>` (only when there
     is something `git stash` can take); then `git checkout main` when another branch is checked out, then
     `git pull --ff-only --no-rebase origin main`. The stash is kept, never applied or dropped, and the result names it.
  3. **Install** – `npm ci`, then the extension installer (`install-extension`).
  4. **Stop** – the old broker is asked to shut down.
  5. **Start** – the new broker starts from the folder.
  6. **Reconnect** – the app's sessions register with the new broker again.

  If a step fails, the later steps are not run and the summary says where it stopped. The app asks first when a
  session is working or when sessions started from the broker's web page would end. Sessions in terminals reconnect
  on their own. A broker started before this version cannot be stopped by the button: stop it by hand once, then
  press the button again (Stop is then skipped and Start runs). To stop it by hand, find the process listening on
  the broker port and end it:
  - Windows: `netstat -ano | findstr :7777`, then `taskkill /PID <pid> /F`
  - Linux: `ss -ltnp | grep :7777`, then `kill <pid>`
  - macOS: `lsof -nP -iTCP:7777 -sTCP:LISTEN`, then `kill <pid>`

## File links and preview

File paths in the chat (`src/app.mjs`, `src/app.mjs:42`, `~/notes.md`, Markdown `file://` links) become links when the file exists.
A click opens a full-screen preview instead of the system app: the changes browser, showing that file alone.

- Text up to 2 MB is shown highlighted, up to 20 MB as plain text, larger files only offer **Open in system app**.
  Markdown can be switched between rendered and source. A `:42` suffix marks that line and scrolls to it.
- **Changes** in the session header opens the browser on the session's changes. Its list is read again each time
  it opens (with a loader) and with ⟳; it does not refresh in the background.
- What starts the tracking: the first file the agent edits in a repository records that repository with a start
  point (its `HEAD` commit and the files that already had uncommitted changes). If the session folder is inside a
  repository, that one is recorded at the agent's first tool call of any kind. Only live tool calls count: an old
  session that you open records nothing until the agent works again.
- What is listed, one group per repository: every file with uncommitted changes now, and every file changed by a
  commit since the start point, whether the agent changed it or not. Files the agent edited outside any repository
  are under **No repository**. Files that git ignores are not listed.
- Each row has git's state letter (`M` modified, `A` added, `D` deleted, `R` renamed, `?` untracked) and marks:
  `●` edited by the agent, `⏱` changed before the session (its uncommitted diff then also holds those earlier
  changes), `✓` committed, with no uncommitted change now.
- Commits: a file that a commit touched has an arrow; the arrow unfolds the file to one row per commit since the
  start point, newest first. The file's own row is its uncommitted diff; while one of its commits is selected, the file's row carries a weaker
  mark. A commit's
  diff is git's own diff: staged and unstaged changes together, a merge commit against its first parent, an untracked
  file as its whole content added. Commits are read when a file is unfolded, not with the list.
- **Diff**, **File** and **Both** (the control above the right side) choose what shows: the diff, the file as it is on
  disk (a deleted file shows a message), or the two side by side. Drag the divider in **Both** to resize the panes.
  The choice and the divider's place are kept for all sessions. A file without a diff (an opened file or a
  **No repository** file) opens in **File**; **Diff** or **Both** can still be chosen there, and the diff pane then
  says `No changes.`.
- **Opened files** is a second list below the repositories: the files you opened from links in the chat that the
  session has not changed. It keeps the 200 newest per session and lists the newest 20; **✕** on a row takes it
  off. A row whose file now leads outside the session folder says so instead of showing it.
- The file on show follows the disk: when it changes, including an atomic save, its content and, with
  **Uncommitted** selected, its diff are read again in place, keeping the scroll positions. The list does not follow.
  When a file opened from a link is in the list, its row is selected and its commits are one click away.
- `+` adds a repository through a folder dialog; its start point is where `HEAD` was when the session was created.
  `✕` on a group removes the repository from the list; one recorded automatically comes back, with a new start
  point, at the agent's next edit there.
- `Esc` closes the browser, `Ctrl/Cmd+A` selects the text of the pane that has the focus.
- Limits: a diff up to 2 MB (a larger one says so; **File** still works) and at most 20000 lines shown, 2000
  files per repository. Git is only read: nothing is written to a repository (not even `index.lock`), and a
  repository's config cannot make the app run an fsmonitor hook, an external diff, a textconv driver or a signature
  check (clean and process filters such as git-lfs still run). In a partial clone a commit's diff may show git's
  error instead of fetching the missing objects.
- A file outside the session's folder is not opened from a link without your confirmation; the files of the list
  are shown without it (the agent edited them, or you added their repository). A binary file inside the
  folder skips the preview and goes straight to the usual open behaviour. A plain-text `file://` URL is not linked. Paths on a network
  location (NFS, SMB, mapped drives) are never checked or read automatically and are not linked; file text from the agent
  never makes the app touch one.

## Delegated sessions

A session can ask for a new session dedicated to one task, a *delegated* (child) session. Unlike a subagent, a child is
an ordinary session: it appears in the list, you can open it, read what it did, keep talking to it, and resume it later.

- **`create_session(name, task, agent?, model?, folder?, prompt?, context?, command?)`** is called by the parent.
  `folder` is an absolute path (default: the parent's folder), `prompt` is the child's own prompt part, `context` is
  `default` (200k) or `long_context` (1M), and `command` may only be `copilot` with plain arguments, which are added
  after the command the parent itself runs; anything else is refused with "Not sent: …". A card appears in the
  parent's view with the name and the full task (read-only) and every other value editable: the folder with a
  **Change…** button (the system folder picker), **Context**, **Agent** and **Model** (the parent's lists), the own
  prompt part and the **Copilot command** (see "A command per session"), with **Approve** and **Reject**. A value the
  parent filled is marked "from <parent>", and a command it wrote says it runs when you approve and lists, in full,
  the arguments it added (the command field is one line and can hide its end). A value that could not be taken (a
  missing or network folder, a bad command, an unknown agent or model) falls back to the default, with a note under
  its field. A folder on a network location (a UNC path, a mapped drive, a network mount) is never looked at before
  you approve, as anywhere else in the app: it gets its own note. When the child runs in another folder, the parent
  is told so.
  **Every creation needs your click**: there is no "always allow", and no model or message can answer the card. The
  parent is marked `!` in the list, and an OS notification fires if the window is not focused. The tool returns at
  once; the outcome arrives later as a message from `relay`, so the parent can keep working. If the child's Copilot
  does not start (a mistyped command, say), the picked folder was removed, or the child's lists refuse the card's agent
  or model, the card says why and stays open: fix the value and **Approve** again, or **Reject**. The parent hears
  nothing until then. The agent and model lists on the card are the parent's; a child in another folder can offer
  other agents, which shows only after **Approve**.
  A parent can propose any `copilot` flag, including ones that widen what the child may do without asking: the
  card's warning and your **Approve** are the guard. An argument already in the parent's command line reaches
  Copilot twice, and which one wins is Copilot's rule. The arguments are appended to the parent's whole command line
  as text, so a line that ends in a pipe or a comment sends them to the last program or into the comment instead of
  Copilot; the card shows the whole line.
  `folder`, `prompt`, `context` and `command` need the broker of this version: use **Update and restart broker** in
  Settings. With an older broker the tool has none of them (only `name`, `task`, `agent` and `model`).
- **The child** gets only its task, not the parent's history, so the parent has to put the context it needs in the
  task. If `model` is left out, the child uses the parent's current model. If `agent` is left out, it uses the
  default Copilot agent; the parent's agent is not inherited. An agent or model the parent's session does not offer
  falls back to the default, with a note on the card. A child appears in the list without taking you away from what is
  on screen. It can create children of its own, to any depth; there is no limit on their number.
- **`report_result(text)`** is called by the child, once, when it is done. It has no recipient: the broker knows
  the parent. The report wakes the parent as a "from …" bubble and is kept on disk until the parent's prompt has
  started, so it survives a parent that is busy or closed, a broker restart and an app restart. A rare duplicate is
  possible; a lost report is not. After the report, `send_message` works between parent and child as with any other
  session; `list_sessions` marks "your parent" and "your child" with their current names.
- **Linking existing sessions.** When you ask a session in the chat to take another open session as its sub-session,
  it calls **`adopt_session(name)`**; to end the link to one of its direct children, **`release_session(name)`**.
  Either shows a card in the parent's view, **Link sessions** or **Unlink sessions**, with the child's name and its
  folder (or its task), with **Approve** and **Reject**; as for a new session, nothing changes without your click.
  Only an open desktop-app session that has no parent (or whose parent was deleted) can be adopted, and never one of the caller's ancestors. An
  adopted child is a sub-session like any other (the tree, closing, reopen cards, the delete dialog, `report_result`),
  except that it was given no task: it still owes its parent a report, so its parent gets the "ended without
  reporting" notice if it ends without one, and the quit question counts it. A released child becomes a top-level session and keeps its own sub-sessions; reports it
  already sent are still delivered. The parent is told the outcome; an open child is told when the link is made or ended. A card whose answer did not reach the
  broker keeps its buttons; one the broker no longer has (after a broker restart, or when one of the two sessions
  went away) says "This request is no longer pending."
- **Messages wait for you.** A message that arrives in the chat of an open session does not start a turn there; it waits
  in a list above the message box, oldest first, each row with the sender's name, the time and the first line (a click
  shows the whole text). There are four kinds, each with its own list:
  **Replies from sub-sessions (N)** (what a direct child sends its parent with `report_result` or `send_message`),
  **Orders from parent (N)** (a `send_message` from the session's parent), **Other sessions (N)** (a `send_message`
  from any other session) and **Your messages (N)** (a message of yours that arrives while a turn is running: typed
  in the chat's own message box, or sent from the relay GUI; a message of yours to an idle session starts a turn as
  before). The broker's own notices and the first task of a new sub-session are never held. **Approve** puts the
  message at the end of the chat's queue, like a message you typed while it was busy: if the session is idle the turn
  starts at once; if it is working, the queue delivers the message at the end of the turn, or during the turn when
  **Deliver queued messages during a turn** is on. **✕** discards it. The list shows `⏸ N` next to the session: for an
  open chat it counts all its lists; for a session without an open view it comes from the broker, counts replies from
  sub-sessions, orders from the parent and messages from other sessions (never your own messages) and ignores the
  switches. Your own messages are held only during a turn, and after it they wait for **Approve** like the rest; the
  ones you typed live only in the window and are lost when it closes. All other messages are kept by the broker until
  the chat takes them (the prompt starts, or ✕), so they survive reloading the window and reopening the session.
  In the status bar, after **Approve:**, four checkboxes switch the kinds on and off: **Sub-session replies**,
  **Parent orders**, **Other sessions** and **My messages while busy**. All are on by default and stored per chat.
  A kind that is switched off is delivered at once, as before (the messages already held move to the queue, in
  order); with a kind switched off, its messages that were still waiting in the queue when the session closed are
  delivered again to the queue, without an approval, when it opens, instead of being lost. Holding the messages of
  other sessions, of the parent and from the relay GUI needs the broker of this version: use **Update and restart
  broker** in Settings. An older broker delivers those messages without holding them; messages typed in the chat's
  own message box are still held, and replies from sub-sessions are held as before. Deleting a session in the app
  also makes the broker forget the messages kept for it; they are not delivered again.
- **Permissions.** A child starts with no automatic approvals beyond the relay tools, and asks like any other session, unless its
  Copilot command allows more (a flag the parent proposed, or the parent's own command, which the child inherits; see
  above).
  While it waits, it has a `!` in the list and an OS notification fires if the window is not focused. Nothing is
  answered for you.
- **Sessions without relay tools.** A session whose custom agent (`.github/agents`, `~/.copilot/agents`, an
  organisation agent) leaves the relay server out of its `tools:` list can read relay messages but cannot answer them.
  The app notices this on a prompt that answers a relay message, and on one you type in a child that has not
  reported yet, and adds a note to that prompt: the session's last message of the turn goes to the sender as its
  answer, so it should end the turn with the result. After such a turn a card under the reply asks
  **This session has no relay tools. Send this reply to "<S>" as its report?** (as a message, for a reply that is
  not a report): **Send** forwards it, to the parent as the child's report the first time and as a message after
  that, to any other session as a message; **Don't send** drops it. Waiting cards come back when the session reopens,
  but are lost when the app quits. The **Forwarded replies** switch after **Approve:** (shown for such a session, and
  while a forward waits) turns the card off for that session, and the reply then goes at once; the default for all
  sessions is **Approve forwarded replies of sessions without relay tools** in Settings → Sessions (on). It needs the
  broker of this version. Sessions with the default agent, or an agent that lists the relay tools, are unchanged.
- **No isolation.** By default a child works in **the parent's folder and on its branch**; the parent can propose
  another folder and you can change it on the card. There is still no worktree or sandbox. Children that edit files can get in each other's way or in the
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
  parent, shows a reopen card in the sender's view. **Approve** resumes the session and delivers every queued message (an order from a parent to its closed child is then
  held in the child's list **Orders from parent** like any other order, so it waits for a second approval there);
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
- `create_session`, `report_result`, `adopt_session` and `release_session` exist only for sessions opened in this app,
  not for terminal sessions or sessions started from the broker's web GUI.

## Session prompts

Every session's Copilot gets a system prompt made of up to three parts, joined by a blank line (empty parts are
left out):

- **Default part** (Settings): for every session. Its built-in text encourages the session to delegate specialised,
  self-contained work (research, spec & plan, implementation, tests, review, Tilt / build) to child sessions with
  `create_session`, with a self-contained task, and to do small things itself. Only sessions with copilot-relay on get
  the built-in text (it names relay tools); a text of your own applies always. Emptying it in Settings means no
  default part; "Restore default" goes back to the built-in text. A "" saved by a version before the built-in text is
  dropped once at start, as those versions saved the empty field on every Settings save.
- **Child part** (Settings): only for child sessions, delegated or adopted. Its built-in text tells the child to
  finish with `report_result`, exactly once, and to use `send_message` only to ask its parent something. Emptying it
  in Settings means no child part; "Restore default" goes back to the built-in text.
  After updating the app, restart the broker (Settings -> "Update and restart broker") so the new adopted-child rule
  and notes apply.
- **Own part**: written per session, in the **Setup** dialog.

**Templates** (Settings) are named texts for the own part. Picking one *copies* its text into the editor: it is not
linked, so editing or deleting a template later changes no session.

**Where you edit the own part:**

- On creation: **New session** opens the editor before Start, with the folder row (**Change…** opens the system
  folder picker; the folder of an existing session cannot be changed); a forked session starts with a copy of its source's
  own part.
- On a child's card: the card that asks you to approve a new child has the editor, so you can add to the child's
  prompt before you click **Approve**. It can start with the parent's proposed prompt, marked "from …".
- In a running session: the **Setup** button. **Save and restart** restarts that session's Copilot with the new
  prompt; the history is kept. It needs no running turn, and the session's subagents and shell commands stop.

Changes in **Settings** (default part, child part, templates) reach a session at its next start; running sessions
are not restarted. A child's part is also taken at the start after it is adopted (and dropped after it is released).

The prompt reaches Copilot as an instructions folder under the app's data folder, named by
`COPILOT_CUSTOM_INSTRUCTIONS_DIRS` for that one process and removed when the process ends; nothing is written to
`~/.copilot`. Your own `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` entries are kept.

**Every child reports.** A delegated child and an adopted child both owe their parent a `report_result`; one that
ends without it gets its parent the "ended without reporting" notice, and the quit question counts it.

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

Checks, from the repo root: `npm test` runs the unit tests. `node scripts/ui-check/run.mjs [name…]` runs the UI checks
(all, or the named ones): it starts the real app under Xvfb (`xvfb-run`, Linux) against a scripted Copilot
(`electron/test/fixtures/acp/`), drives its window in each activity panel mode a check lists and exits with 1 if one
fails. All of them take about 4 minutes.

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
If Copilot still isn't found, open **⚙ Settings** and enter its command. The command is a line that may carry
arguments; the system shell runs it, and the app adds `--acp --stdio` at its end, so it must be one command that
takes them. A path with spaces is quoted (`"C:\Program Files\...\copilot.exe"`) or given alone (an absolute path
to an existing file works unquoted). A wrapper script must pass its arguments on (`exec copilot "$@"`). On Windows
the shell is `cmd`, where only double quotes group an argument: write `--allow-tool "shell(dotnet:*)"`, not
`'shell(dotnet:*)'` (Copilot would get the quotes and refuse the rule). Typical paths:

| OS | find it with | typical path |
|---|---|---|
| Windows | `where copilot` | `C:\Users\you\AppData\Roaming\npm\copilot.cmd` or `...\WinGet\Links\copilot.exe` |
| macOS | `which copilot` | `/opt/homebrew/bin/copilot` |
| Linux | `which copilot` | `~/.local/bin/copilot` |

The `COPILOT_PATH` environment variable works too, and is such a line as well.

**A command per session.** In the dialog of a new session, or later in the session's **Setup**, a session can have its
own Copilot command. It replaces the Settings command for that session; empty means the Settings command. The card
that approves a delegated child has the same field: it starts with the parent's command, and what it holds when you
approve becomes the child's command (cleared: the Settings command). If a session's command is broken, repair it
from **Setup** on the dead view. A start that does not answer within 60 seconds fails; a command that stops by
itself shows its own message, and that is where to look first.

On Linux and macOS, closing or restarting a session ends Copilot's whole process group, so a process one of its tools
left running in that group (a dev server put in the background) stops with the session.

Settings are stored in Electron's `userData` folder:
`%APPDATA%\copilot-relay-desktop` on Windows, `~/Library/Application Support/copilot-relay-desktop` on macOS,
and `~/.config/copilot-relay-desktop` on Linux.

## Notes

- **Don't use the same session in the app and in a terminal at the same time.** Both processes would write to
  the same session state. Close it in one place before resuming it in the other.
- **Close** stops the app's `copilot` process for that session. The session itself stays and can be resumed later,
  from the app or with `copilot --resume <id>`.
- Every prompt uses premium requests, the same as in the terminal.
- ACP support in Copilot CLI is a preview feature. Tested with Copilot CLI 1.0.106.
