# Spec: A system prompt per session (`session-prompts`)

Extends `2026-11-08-delegated-sessions-design.md` (the child's first message), `2026-11-20-context-tier-design.md`
(a setting that restarts a session's Copilot) and `2026-11-23-link-sessions-design.md` (it lifts "an adopted child
owes no report"). Where the documents disagree, this one wins.

Implementation starts from `main` after `feat/held-child-replies` is merged (v0.22.0); this feature ships as v0.23.0.

## Intent

The user wants their own system prompt in every session the desktop app runs, set when the session is created and
changeable at any time. Only in the app: nothing is written to `~/.copilot`, so Copilot run outside the app (terminal,
other tools) does not get it. Every session the app opens gets it, including a session first made in a terminal and
then opened from the app's sidebar (decided with the user).

Children additionally get a fixed part that tells them how to work with their parent, and the user writes the rest
of a delegated child's prompt on the card that approves the child. Every child, delegated or adopted, always ends its
work with a report to its parent. Reusable pieces of prompt live as templates in
Settings, so a prompt is usually "pick a template, add a line".

## Goals

1. Every session whose Copilot the app starts gets a system prompt made of parts (section 1), applied on every start
   of its Copilot process (new, reopened, restarted). This includes sessions made outside the app and opened in it,
   and sessions made before v0.23.0: they get the default part, and their own part is empty until the user sets it.
2. Settings holds: the **default part** (every session), the **child part** (children, delegated or adopted; editable, with
   "Restore default"), and a list of **templates** (name + text).
3. Creating a session (Ctrl+N, the "+" next to a folder, the welcome buttons) opens an editor after the folder is
   picked: template select + text area for the session's **own part**. Start creates the session with it.
4. The card that approves a delegated child (`delegation:request`) carries the same editor. Approve creates the child
   with it. The fixed parts are shown read-only and folded.
5. A running session's own part can be edited at any time from its view. Saving restarts that session's Copilot and
   reloads it (`session/load`), as a Context change does today; the history stays.
6. The full instructions for working with the parent move from the child's first message to the child part. The
   first message keeps the parent header, the task and one short line: "When you are done, always send the result
   (or a short summary) with `report_result`." (author's call: a child part the user cleared or rewrote must not leave a child that is never
   told to report, which would leave the parent waiting and the child counted as unreported).
7. Every child reports: an adopted child (`adopt_session`) owes its parent a report like a delegated one, and is
   told so when it is linked (section 6).

## Non-goals

- Copilot processes the app does not start. Nothing is written to `~/.copilot`.
- Restarting a session when it is adopted or released. The child part follows the link at the next process start;
  until then the broker's note to the adopted child carries the same rule (section 6).
- A prompt for the parent's request in `create_session` (the parent model writing the child's prompt). The user
  writes it on the card.
- Linked templates: a session never follows later edits of a template (Decisions).
- Restarting running sessions when the default or child part changes in Settings.

## Anti-goals

- The prompt reaching Copilot through the chat: no text glued onto user messages, nothing that `/compact` can drop or
  that shows in the history.
- A session that silently runs without the prompt it was given. If the prompt cannot be written, the start fails with
  a readable error (section 2), it does not go ahead without it.
- A browser `alert`/`confirm` dialog anywhere in the new UI.

## Decisions (made with the user)

- Per session, only in the app: every session the app opens, wherever it was made.
- Prompt = default part (Settings) + child part (Settings, children only) + the session's own part.
- The child part is editable in Settings, with "Restore default".
- Every child (delegated or adopted) always ends its work with a report to its parent, even if it is only a summary
  or a note that the work is finished (or could not be finished). The built-in child part says so, and an adopted
  child now owes the report too (section 6). Decided with the user to be part of this spec.
- Templates of the own part are kept in Settings; picking one in the editor puts its text into the own part, which
  the user can then extend.
- The editor opens on creation for every session (root and child), and the child's editor is on its approval card.
- Spec now, plan and implementation after v0.22.0.

## Approaches considered

1. **A per-process instructions directory through `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` (chosen).** Copilot CLI reads
   `<dir>/.github/instructions/*.instructions.md` from every directory in that variable as custom instructions, which
   go into its system prompt. The app already starts one Copilot process per session, so each process gets its own
   directory. Verified on Copilot CLI 1.0.115 (this machine, 2026-11-23):
   - `copilot instruction list` with the variable set lists `<dir>/.github/instructions/x.instructions.md` as
     `[external]`; `AGENTS.md` and `copilot-instructions.md` at the directory root are not read as such.
   - In a running session a changed file has **no effect**: the second turn still followed the old instruction.
   - After killing the process, a new process with the changed file and `session/load` of the same session followed
     the **new** instruction, and the history was kept.
2. **Prepending the prompt to user messages.** Applies at once without a restart, but it is chat text: it shows in
   the history and replays, costs tokens every turn (or, sent once, is lost to `/compact`). Rejected (anti-goals).
3. **A custom Copilot agent per session (`--agent` with a generated agent file).** Takes the agent slot that a child's
   `agent` already uses, and writes into `~/.copilot/agents`. Rejected.

## Design

### 1. The parts and how they are joined (new `electron/session-prompts.mjs`)

| Part | Stored | Who gets it | Edited |
|---|---|---|---|
| Default | `settings.json` `promptDefault` (string, `""` by default) | every session | Settings |
| Child | `settings.json` `promptChild` (string, or absent = built-in default) | children, delegated or adopted (below) | Settings, "Restore default" |
| Own | `session-prompts.json` in `userData`, `{ [sessionId]: string }` | that session | editor on creation, editor in the view |

Templates: `settings.json` `promptTemplates: [{ id, name, text }]` (`id` a random string, so a rename keeps it).

`composePrompt({ default, child, own, isChild })` joins the non-empty parts (trimmed) in that order with a blank line
between them; the child part only when `isChild`. All empty → `""`, and the session starts without the variable.

**Who is a child** (for the child part): a session whose link in the broker's link tree has a parent, delegated or
`adopted`. The app decides this before it starts the process, so it reads the link snapshot it keeps
(`links-cache.mjs`, refreshed through `refreshLinks`; reshaped by `feat/held-child-replies`, so the builder uses the
v0.22.0 shape). A child being created in `createChild` is a child by construction (no lookup). A released child
(`release_session`) has no parent in the tree and gets no child part from its next start on.

Built-in default of the child part (the text that leaves `childPrompt`, written for both kinds of child):

> This session is the child of another session, its parent: it either started you with a task (the `[from …]` line
> of your first message) or the user linked you to it (`list_sessions` shows your parent). The parent cannot see this
> chat and waits for your report. When your work is done (the task you were given, or the work you were doing when
> you were linked), always finish with the `report_result` tool, exactly once: the result, or at least a short
> summary of what you did, or a note that the work is finished. If you could not finish, report that too, with what
> is missing. Use `send_message` only if you must ask the parent something before you can finish.

### 2. Writing the prompt for a process (`connect`, `electron/main.mjs`)

`connect(cwd, deadline, args, prompt)`: when `prompt` is not empty, the app creates a fresh directory
`userData/session-prompts/run/<random>/.github/instructions/` with `session.instructions.md` holding the prompt, and
starts Copilot with `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` set to that directory, **appended** to the value the app
inherited, if any (comma-separated, as Copilot reads it). The directory belongs to that process: it is removed when the
process exits (`AcpConnection` exit, `closeEntry`, a failed start), and leftovers from a crash are removed at app start.

Per process rather than per session because `createSession` only learns the session ID from `session/new`, after the
process started.

A prompt that cannot be written (disk error), or a `userData` path that contains a comma (it would split the list),
fails the start with a readable error; the session is not started without its prompt.

The lister connection (`getLister`, `connect(os.homedir())`) gets no prompt.

### 3. Where the prompt is applied

- `createSession(cwd, link, deadline, tier, own)`: `own` from the editor; saved under the new session ID once
  `session/new` answers. `sessions:new` takes `(cwd, own)`.
- `openSession` (reopen and every restart): own part from the store, child per section 1.
- `createChild(req)`: `own` from the card's answer (`delegation:answer` takes `(requestId, approved, own)`); child
  part always.
- `sessions:fork`: copies the own part next to `tiers.copy`. `sessions:delete`: deletes it next to `tiers.delete`.
  (`feat/held-child-replies` puts `holds.copy` / `holds.delete` at the same two places.)
- v0.22.0 changes, per `held-child-replies`: `links:update` / `links:get` carry `{ links, held }` instead of an array,
  `relay:message` has `fromChild`, new IPC `held:get` / `held:set` and `electron/held-replies.mjs`. UI checks with the
  broker need a fresh relay copy (`npm --prefix electron run copy-relay`).
- The child's first message: `childPrompt({ parentName, task, folder })` keeps the `[from …]` and `[folder …]`
  headers, the task and the one-line `report_result` reminder (Goal 6); the sentence about the parent not seeing the
  chat moves to the child part.
- `promptChild` in Settings: a field saved empty is stored as `""` and means "no child part" (the user's choice;
  the reminder in the first message still tells the child to report). "Restore default" removes the key.

### 4. Changing the own part of a running session

New IPC `sessions:setPrompt(sessionId, own)`, shaped like `sessions:setContextTier`: the same refusals (a turn is
running, deleting, lingering, opening, a history operation), saves the own part, closes the session, and answers
`{ reopen: true }` so the renderer reopens it (Copilot restarts with the new prompt and replays). A failed close
restores the previous text. Saving an unchanged text does nothing (no restart). The two handlers share one
"save, close, reopen" helper (today `switchTier` in `context-tier.mjs`).

Changing the default or child part in Settings writes `settings.json` only; each session picks it up at its next
process start. Settings says so under the fields.

### 5. Renderer

**The prompt editor** (one component, new `electron/renderer/prompt-editor.js`, used in three places):

```
▸ Default (from Settings)                       [folded, read-only]
▸ Working with the parent (from Settings)       [children only, folded, read-only]
Template: [ — none — ▾ ]
┌────────────────────────────────────────────────┐
│ own part (text area)                           │
└────────────────────────────────────────────────┘
```

Picking a template puts its text into the text area. If the text area holds text the user typed (not the untouched
text of the last picked template), the editor asks inline (Replace / Keep), with no browser dialog. The select then
shows "— none —" again only when the text area is emptied; the session stores text, not the template.

1. **New session**: `newSession(cwd)` picks the folder as today, then shows the editor in a `<dialog>` (title "New
   session in <folder>", buttons Cancel / Start, Ctrl+Enter = Start, Esc = Cancel). Start calls
   `api.newSession(cwd, own)`. Cancel starts nothing.
2. **Child approval card** (`SessionView.delegationCard`): the editor between the task and the buttons; Approve sends
   `own`, Reject ignores it.
3. **A running session**: a "Prompt" button in the session's header opens the editor in the dialog, filled with the
   session's own part (`sessions:getPrompt`), buttons Cancel / "Save and restart". It says that saving restarts
   Copilot, and it is disabled while a turn runs (as the Context select).

**Settings** (`#settings` dialog, `openSettings`): a "Prompts" section with the default part, the child part with
"Restore default", and the template list (add, rename, edit text, delete). Saved with the rest of Settings through
`setSettings`.

### 6. Adopted children report (`src/delegation.mjs`, `src/mcp.mjs`, `electron/delegation.mjs`)

v0.20.0 exempts an adopted child from the report in three places; each loses the exemption:

- `Delegation.died(childKey)` (`src/delegation.mjs`): an adopted child that ends without reporting gets the parent the
  same "ended without reporting a result" notice as a delegated one.
- `unreportedChildren(entries)` (`electron/delegation.mjs`): adopted children that have not reported count, so the
  reload warning and the quit/close check name them.
- `list_sessions` (`src/delegation.mjs`, the family block): the "adopted, no task" line keeps saying there is no
  task, and shows the report state as for delegated children.

The broker's note to the child on adoption (`LINK.linkedChild`, sent with `wake: false`) carries the rule, because the
child part only reaches the child at its next process start:

> The user made this session a child of "<parent>". "<parent>" cannot see this chat and waits for your report. When
> the work you are doing is done, always send it the result (or a short summary, or a note that it is finished) with
> the `report_result` tool, exactly once.

`LINK.linkedParent` says the child "will send you its result with report_result" (not "can"). The `report_result` tool
description in `src/mcp.mjs` says "when your work is done" instead of "when the task is done". The release side is
unchanged: a released child owes nothing, and `releasedChild` says so.

The link store and the `adopted` flag stay as they are: the flag still drives "no task" in `list_sessions` and the
tree's labels.

## Constraints

- One Copilot process per session (already so); the prompt reaches Copilot only at process start.
- `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` is comma-separated; the app must keep a value the user set in its environment.
- The user's own instructions (`~/.copilot/copilot-instructions.md`, the repository's `AGENTS.md`, `CLAUDE.md`, …) stay
  in force; the session prompt is added to them, it does not replace them.
- Windows: the directory and file are created with Node paths; the start has to work with the `copilot.cmd` shell
  launch (`shell: true` on win32), so the variable goes through `env`, never the command line.

## Known limitations

- A change takes a restart: a turn cannot be running, and the session's subagents and shell commands stop.
- Settings changes reach a running session only at its next start.
- Whether Copilot reads the file at process start or at `session/new`/`session/load` was not separated; both orders
  are covered because the directory exists before the process starts and lives as long as it.
- A child whose link is not in the app's snapshot when it is reopened (broker down, empty cache) starts without the
  child part; it gets it at the next start that knows the link.
- The variable is in the session's Copilot environment, which Copilot passes to the agent's shell commands: a
  `copilot` started from inside a session's shell reads the same instructions directory while that session's process
  lives. Accepted (author's call): such a run is the session's own tool use, not a session the user started outside
  the app.
- Children adopted before v0.23.0 owe a report from v0.23.0 on: one that ends without reporting gets its parent the
  "ended without reporting" notice, though it was never told to report (only the child part at its next start and no
  adoption note tell it).
- An adopted child learns the rule from the broker's note until its next process start; the note does not wake it, so
  it reads it with the next message it gets.
- Not run on Windows or on the corp PC.

## Left to the builder

- Names of the IPC channels and of the CSS classes; the exact layout of the editor and of the Settings section.
- Whether `session-prompts.json` uses a store shaped like `createTierStore` or shares code with it.
- Tests: unit tests for `composePrompt`, the store and the directory lifecycle; the scripted ACP agent
  (`electron/test/fixtures/acp/scripted-agent.mjs`) can report the instructions file it was started with, so an e2e
  test checks new, reopened, forked and child sessions; UI checks (`scripts/ui-check`) for the dialog, the card and the
  Settings section; one manual check on real Copilot in the app (a rule in the own part is followed, a changed rule
  is followed after "Save and restart").

## Calls made by the author (not decided with the user)

- Templates are copied, not linked (a linked template would restart every session that uses it on each edit).
- The Settings parts apply at the next start, without restarting running sessions.
- A fork copies the own part.
- The own part may be empty; Start / Approve never require it.
- Adopted children get the child part from their next process start, not by a restart at adoption; released
  children lose it at their next start.
- The wording of the adoption notes and of the `report_result` description (section 6).
- The child part's default text (section 1) mentions `send_message` for questions to the parent.
- A per-process directory under `userData`, removed with the process.
- A prompt that cannot be written fails the start instead of starting without it.
