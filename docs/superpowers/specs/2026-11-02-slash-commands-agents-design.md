# Spec: Slash commands and agent picker (desktop app)

## Objective

In the Electron app (`electron/`), a user can, like in VS Code Copilot Chat:

- **pick a custom agent** for an open session (company agents, repo `.github/agents/`, `~/.copilot/agents/`)
  from a picker next to the message box, and switch it at any point of the session;
- **type `/`** in the message box and get a list of Copilot's slash commands (incl. skills) with descriptions
  and argument hints, filter it by typing, and insert one with the keyboard or mouse;
- **type `/agent`** (as in Copilot CLI's terminal UI) to pick an agent from the same list, or `/agent <name>`
  to switch directly.

Why: the user codes in company repos with company agents (Microsoft infra). In Copilot CLI they switch agents
mid-session with `/agent`; in the app today the agent list is an unlabeled dropdown among the header selects,
`/agent` typed in the app goes to the model as plain text, and there is no hint of which slash commands exist.

## What Copilot gives us over ACP (verified 2026-11-02, Copilot CLI 1.0.106-3)

- **Commands.** `session/update` → `sessionUpdate: "available_commands_update"` with
  `availableCommands: [{ name, description, input?: { hint } }]`. Sent several times (4–5) after `session/new`
  and after `session/load`; each one replaces the previous list. ~35 built-in commands (`compact`, `context`,
  `plan`, `review`, `research`, `fleet`, `usage`, `mcp`, `skills`, `memory`, `rename`, `init`, …) plus every
  skill, some namespaced (`superpowers:brainstorming`). Names come without the leading `/`.
- **Running a command** = sending the prompt text `/<name> <args>` as an ordinary `session/prompt`. Copilot runs
  it itself (e.g. `/context` answered with CLI text, not a model reply). The app already sends text unchanged.
- **`/agent` is not in the list.** Sent as a prompt it reaches the model ("This looks like a CLI slash command…").
- **Agent = session config option** `id: "agent"`, `category: "_agent"`, `type: "select"`,
  `name: "Agent"`, options `[{ value: "", name: "Copilot", description: "Default Copilot agent" },
  { value: "<agent name>", name, description }, …]`. Set with
  `session/set_config_option { sessionId, configId: "agent", value }` (the app's existing `sessions:setConfig`
  IPC); takes effect from the next prompt, works mid-session, and **persists**: after `session/load` in a new
  process `currentValue` is still the chosen agent. Changes also arrive as `config_option_update`.
- The user confirmed the company agents appear in that option inside a company repo.
- **No custom agents → no `agent` option at all.** A session that used `pirate`, resumed after the agent file was
  removed, came back with no `agent` config option and the model answered as the default Copilot.
- **CLI commands don't create a `user.message`.** A session whose only prompt was `/context` has no
  `events.jsonl` at all, while `/agent` (which went to the model) was stored as a `user.message`. The app's
  fork/delete turn numbering (`markTurn`, `history.mjs` `userIndex`) assumes one user bubble = one
  `user.message`, so command prompts must not count as turns (see 2a).
- `mode` (Agent / Plan / Autopilot) is a separate config option; it stays a separate control.

## Current state in the app

- `renderer/app.js` `setConfig()` renders every `select` config option as an unlabeled `<select>` in the header
  (`this.selects`), deduping option values; change → `api.setConfig`.
- `available_commands_update` is ignored (`default:` branch of the update switch).
- Composer: `<textarea>`; Enter sends, Shift+Enter newline, Esc stops a running turn.

## Design

### 1. Agent picker

- The `agent` config option is **not** rendered among the header selects. It gets its own picker in the
  composer, left of Send/Stop (VS Code places the agent picker in the chat input bar).
- The picker shows the current agent's name (`Copilot` for the default), with the agent's description as its
  tooltip; opening it lists all agents with name + description. Built as a `<select>` or a small custom
  dropdown – builder's call; it must work with keyboard only.
- Shown only when the option exists and has more than one entry (i.e. there is at least one custom agent).
- The picker always displays Copilot's `currentValue`. If that value isn't among the options, it is shown as an
  extra entry `<value> (not found)` instead of letting a native `<select>` fall back to `Copilot`. *My call* –
  keeps the picker truthful; when no custom agents exist Copilot drops the option and uses the default (verified),
  so a hidden picker is truthful too.
- Choosing an agent calls `api.setConfig(sessionId, "agent", value)`; the result's `configOptions` (and any
  later `config_option_update`) refresh the picker and the header selects as today. On failure: revert the
  picker to the previous value and show the error in the status line.
- After a successful change a system line is added to the log: `Agent: <name>` (`Agent: Copilot` for the
  default). Not replayed on resume (it is app-only, not in Copilot's history) – acceptable.
- Changing the agent is disabled while a turn is running (picker disabled, `/agent` refused with a status-line
  note). *My call:* Copilot applies it from the next prompt anyway, and this avoids racing a running turn.
- The other header selects (Mode, Model, reasoning effort, allow_all…) are unchanged.

### Rule: a command is only the first word of the message

Copilot treats a prompt as a command only when the message **starts** with `/name` (stated by the user). `/x` in
the middle of a sentence, or after other text, is plain text. Everything below follows that rule: the popup only
for the first word, `/agent` and `/rename` only when they are the first word, the 2a check only for prompts whose
first character (after trimming leading whitespace) is `/`. Text after the command word is the command's
argument, never a second command.

### 2. Slash command list (popup)

- **Opens** when the message box text starts with `/` and the caret is inside that first token (no whitespace
  between position 0 and the caret). Closes when that stops being true, on Esc, on blur, or after inserting.
- **Entries:** Copilot's latest `availableCommands` for this session, in the order Copilot sent them, plus the
  app's own `/agent` (shown only when the agent picker is shown), listed first. Each row: `/name`, the argument
  hint (muted, if any), and the description (one line, ellipsized; full text as tooltip).
- **Filter:** the typed token after `/`, case-insensitive. Prefix matches on the name first, then names
  containing it elsewhere (so `brain` finds `superpowers:brainstorming`). No matches → popup hidden.
- **Keys while open:** Up/Down move the highlight (wraps); Tab or Enter inserts the highlighted command as
  `/name ` (trailing space) replacing the first token and keeps the rest of the text; Esc closes the popup
  (and only the popup – it does not stop a turn). Mouse click on a row inserts it. Enter with the popup closed
  sends as today. *My call:* Enter inserts rather than sends, so a command with arguments never fires half-typed;
  a second Enter sends.
- The list is stored per session view and replaced on every `available_commands_update` (also those replayed on
  `session/load`). Before the first update only `/agent` is listed (if available).
- Positioned above the composer, not covering the text being typed; scrolls when long (max ~8 rows visible).
- Slash commands other than `/agent` (and `/rename`, below) are **not** interpreted by the app: the text is sent
  to Copilot unchanged and Copilot runs the command, exactly as today.
- The list is populated even for a brand-new session: if Copilot sends `available_commands_update` before
  `api.newSession` returns (updates for a session without a view are dropped today), buffer them in the main
  process or renderer. Touching IPC for this is fine.

### 2a. Command prompts and fork/delete turn numbers (my call)

- `/rename <name>` typed in the composer goes through the existing `sessions:rename` path (no bubble, no turn),
  same as the app's rename UI.
- Any other prompt starting with `/`: after the turn ends, the app checks whether Copilot recorded a new
  `user.message` for it (e.g. a main-process IPC that counts `user.message` events in `events.jsonl`, reusing
  `history.mjs` helpers). If none was recorded, the bubble is not a turn: it gets no Fork/Delete actions and the
  turn counter is rolled back. No hard-coded list of command behaviours. Skill commands and anything that reaches
  the model are recorded and stay ordinary turns.
- On resume, history replay comes from Copilot, so only recorded messages appear; nothing extra is needed there.
- `/compact` rewriting history is out of scope beyond this rule; if fork/delete then can't find a message, the
  existing "can't find message" error is acceptable.

### 3. `/agent` command (app-local)

When the user sends (Enter / Send) a message whose trimmed text is `/agent` or `/agent <name>`:

- The text is **not** sent to Copilot and no user bubble is added; the message box is cleared.
- `/agent` alone → opens the agent picker (as if clicked), so the user picks with keyboard/mouse.
  *Builder's alternative:* show the agents in the slash popup instead – either is fine if it is keyboard-usable.
- `/agent <name>` → match `<name>` case-insensitively against agent `value` and `name`; `/agent copilot` or
  `/agent default` selects the default. Match → same path as choosing in the picker. No match → status-line
  error `Unknown agent "<name>". Available: a, b, c` and the text is put back in the message box.
- In the slash popup, inserting `/agent` and then typing a space lists the agents as the next set of entries
  (name + description, same filter/keys); choosing one fills `/agent <value>`. *Nice-to-have*, may be dropped if
  it complicates the popup.
- If the session has no agent option (or only the default), `/agent` falls through and is sent to Copilot as
  plain text, as today. *My call:* better than silently swallowing it.
- Relay messages and messages from the relay broker's human client are never interpreted as `/agent`; only
  text typed in the app's composer is.

## Non-goals

- Creating, editing or browsing agent files; VS Code's "handoff" buttons between agents.
- Merging Mode (Agent/Plan/Autopilot) and custom agents into one picker (VS Code does; in Copilot CLI they are
  independent settings, so they stay separate).
- App-side implementations of other terminal-only commands that Copilot doesn't advertise over ACP.
- Autocomplete for command arguments (other than agent names), `@file` mentions, or anything mid-text.
- Showing which agent produced each past reply.

## Anti-goals (would make this a failure even if it works)

- `/agent …` reaching the model when the session has custom agents.
- The popup grabbing Enter while the user is writing a normal message (it must only exist while the text starts
  with `/` and the caret is in that first token).
- Esc no longer stopping a running turn when the popup is closed.
- Changing the agent silently failing (picker shows one agent while Copilot uses another).

## Constraints

- Keep the existing structure: logic in `renderer/app.js` (or a small new renderer module), styles in
  `renderer/style.css`; no new dependencies, no framework. Main process/IPC unchanged unless needed
  (`sessions:setConfig` already exists).
- Pure logic (filtering/ordering entries, parsing `/agent <name>`, matching an agent) in functions that can be
  unit-tested with the project's `node --test` setup (`electron/test/`).
- Works on Linux and Windows; Copilot CLI ≥ 1.0.106.
- Note: at the time of writing `main` has an in-progress merge (session usage work) touching `main.mjs` and
  `style.css`; build on top of it once resolved.

## Testing

- Unit: filter/order (prefix before substring, case, namespaced names, empty token lists all), `/agent`
  parsing (`/agent`, `/agent  X `, `/agent copilot`, unknown name), agent matching by value/name.
- Manual in the app with a scratch repo containing `.github/agents/pirate.agent.md` (description "talks like a
  pirate", body "Start every reply with ARR"):
  1. Picker shows `Copilot`; switch to `pirate`; next reply starts with "ARR"; log shows `Agent: pirate`.
  2. Close and resume the session → picker shows `pirate`.
  3. `/agent copilot` → switches back, nothing sent to the model; `/agent nobody` → status-line error.
  4. Type `/` → list with descriptions; `/co` → `compact`, `context` first; Tab inserts `/compact `;
     Enter then sends and Copilot runs it.
  5. Type `/brain` → finds `superpowers:brainstorming`.
  6. Normal message starting with text, and a message like `a /b` → no popup, Enter sends.
  7. Esc with popup open closes it; Esc with popup closed during a turn stops the turn.
  8. A repo without custom agents → no agent picker, `/agent` not in the list.
  9. Send `/context`, then a normal message, then Fork/Delete from that normal message → cuts at the right place;
     the `/context` bubble has no Fork/Delete actions. `/rename X` renames without a bubble.
  10. New session → `/` lists Copilot's commands immediately (no resume needed).
- Company repo check (user): company agents listed in the picker and switchable.
