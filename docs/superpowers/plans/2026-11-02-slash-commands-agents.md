# Slash commands and agent picker – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** VS Code-like agent picker in the composer, a `/` command popup fed by Copilot's
`available_commands_update`, app-handled `/agent` and `/rename`, and command prompts that don't break
fork/delete turn numbers.

**Architecture:** Pure, unit-tested logic in a new classic renderer script `electron/renderer/commands.js`
(exposed as `globalThis.SlashCommands` and `module.exports`). UI wiring in `SessionView`
(`electron/renderer/app.js`). One new IPC (`sessions:userMessages`) backed by a tested helper in
`electron/history.mjs`. Agent switching reuses the existing `sessions:setConfig` IPC.

**Tech Stack:** Electron, vanilla JS (no framework, no new deps), `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-02-slash-commands-agents-design.md` – read it first; it holds the ACP
facts (verified on Copilot CLI 1.0.106-3) and every behaviour rule referenced below.

## Global Constraints

- No new dependencies; logic in `renderer/app.js` + `renderer/commands.js`, styles in `renderer/style.css`.
- Renderer CSP is `script-src 'self'`: `commands.js` is loaded with a plain `<script src="commands.js">` before `app.js`.
- A command is only the **first word** of the message: popup only when the text starts with `/` at position 0 and
  the caret is in that first token; `/agent` / `/rename` only as the first word; 2a check only when
  `text.trimStart()[0] === "/"`.
- Agent config option: `id: "agent"`, default option `value: ""` named `Copilot`; set with
  `api.setConfig(sessionId, "agent", value)`.
- Works on Linux and Windows; Copilot CLI ≥ 1.0.106.
- Tests: `npm test` at repo root (`node --test "electron/test/*.test.mjs"`).
- Commit messages follow the repo style: `feat(desktop): …` / `fix(desktop): …`.

## Review Focus

1. **Esc during a running turn with the popup closed** must still stop the turn (popup keydown handling runs first
   and only consumes keys while the popup is visible) – covered by manual check 7 in Task 6.
2. **`events.jsonl` not yet flushed when `session/prompt` returns** – the 2a check could then wrongly drop a real
   turn. Task 5 reads the count only after the prompt resolves and treats a read error as "recorded" (keep the
   turn); Task 6 manual check 9 verifies with a skill command that does reach the model.
3. **Agent `currentValue` not among options** (company agent missing outside the company repo) must show
   `<value> (not found)`, never silently `Copilot` – `agentPickerModel` tests in Task 1.
4. **Multi-line text starting with `/`** (`/compact focus\non tests`) – popup only while the caret is in the first
   token; `parseAgentCommand` must not match `/agentx`; tests in Task 1.
5. **Duplicate option values from Copilot** (the model list really contains `auto` twice) – `agentPickerModel`
   dedupes like `setConfig` does; test in Task 1.

---

### Task 1: Pure command/agent logic

**Files:**
- Create: `electron/renderer/commands.js`
- Modify: `electron/renderer/index.html` (add `<script src="commands.js"></script>` right before `app.js`)
- Test: `electron/test/commands.test.mjs` (load with `createRequire(import.meta.url)("../renderer/commands.js")`)

**Interfaces:**
- Produces (all pure, no DOM):
  - `commandToken(text: string, caret: number) -> string | null` – the text after `/` up to the caret when
    `text[0] === "/"` and `text.slice(0, caret)` has no whitespace; else `null`. (`"/co"`,3 → `"co"`; `"/"`,1 → `""`.)
  - `filterCommands(commands: {name, description?, input?}[], token: string) -> same[]` – case-insensitive;
    names starting with `token` first, then names containing it elsewhere; original order kept inside each group;
    `""` → all.
  - `insertCommand(text: string, name: string) -> { text: string, caret: number }` – replaces the first token
    with `/<name> `, keeps the rest with its leading whitespace stripped; caret right after the inserted space.
  - `parseAgentCommand(text: string) -> null | { arg: string }` – on `text.trim()`, matches `/agent` alone or
    followed by whitespace; `arg` is the trimmed rest (`""` when none).
  - `parseRenameCommand(text: string) -> null | { name: string }` – same shape for `/rename`; returns `null` when
    the name is empty (bare `/rename` is sent to Copilot unchanged – my call).
  - `isCommandPrompt(text: string) -> boolean` – `text.trimStart().startsWith("/")`.
  - `matchAgent(options: {value, name}[], arg: string) -> option | null` – case-insensitive equality with `value`
    or `name`; `copilot` and `default` also match the option whose `value === ""`.
  - *(The spec's nice-to-have "agent list after `/agent `" in the popup is dropped: `/agent` alone opens the picker.)*
  - `agentPickerModel(option) -> { show: boolean, entries: {value, name, description, missing?: true}[], current: string }`
    – `option` is the ACP config option or `undefined`. Entries deduped by `value` (first wins). If `currentValue`
    isn't among them, append `{ value: currentValue, name: currentValue + " (not found)", missing: true }`.
    `show` = entries.length > 1. `current` = `currentValue ?? ""`.

- [ ] **Step 1: Write the failing tests** – one `test()` per function, with at least these assertions:

```js
assert.equal(commandToken("/co", 3), "co");
assert.equal(commandToken("/compact x", 10), null);         // caret past the first token
assert.equal(commandToken("a /b", 4), null);                 // not first word
assert.equal(commandToken(" /b", 3), null);                  // not at position 0
assert.equal(commandToken("/compact\nfoo", 4), "com");
const cmds = [{ name: "compact" }, { name: "context" }, { name: "superpowers:brainstorming" }, { name: "reco" }];
assert.deepEqual(filterCommands(cmds, "co").map((c) => c.name), ["compact", "context", "reco"]);
assert.deepEqual(filterCommands(cmds, "BRAIN").map((c) => c.name), ["superpowers:brainstorming"]);
assert.equal(filterCommands(cmds, "").length, 4);
assert.deepEqual(insertCommand("/co  focus on tests", "compact"), { text: "/compact focus on tests", caret: 9 });
assert.deepEqual(insertCommand("/co", "compact"), { text: "/compact ", caret: 9 });
assert.deepEqual(parseAgentCommand("  /agent  Pirate "), { arg: "Pirate" });
assert.deepEqual(parseAgentCommand("/agent"), { arg: "" });
assert.equal(parseAgentCommand("/agentx"), null);
assert.equal(parseAgentCommand("use /agent pirate"), null);
assert.deepEqual(parseRenameCommand("/rename  My  name"), { name: "My  name" });
assert.equal(parseRenameCommand("/rename"), null);
assert.equal(isCommandPrompt("  /context"), true);
assert.equal(isCommandPrompt("hi /context"), false);
const opts = [{ value: "", name: "Copilot" }, { value: "pirate", name: "pirate" }, { value: "az-infra", name: "Azure Infra" }];
assert.equal(matchAgent(opts, "PIRATE").value, "pirate");
assert.equal(matchAgent(opts, "azure infra").value, "az-infra");
assert.equal(matchAgent(opts, "default").value, "");
assert.equal(matchAgent(opts, "copilot").value, "");
assert.equal(matchAgent(opts, "nobody"), null);
const m = agentPickerModel({ id: "agent", currentValue: "gone", options: [...opts, { value: "pirate", name: "dup" }] });
assert.deepEqual(m.entries.map((e) => e.value), ["", "pirate", "az-infra", "gone"]);
assert.equal(m.entries.at(-1).name, "gone (not found)");
assert.equal(m.show, true);
assert.equal(agentPickerModel(undefined).show, false);
assert.equal(agentPickerModel({ id: "agent", currentValue: "", options: [opts[0]] }).show, false);
```

- [ ] **Step 2: Run** `npm test` – Expected: FAIL (`Cannot find module '../renderer/commands.js'`).
- [ ] **Step 3: Implement** `electron/renderer/commands.js` – `"use strict"`, functions as above, then
  `const SlashCommands = { … }; globalThis.SlashCommands = SlashCommands; if (typeof module !== "undefined") module.exports = SlashCommands;`
  Add the `<script>` tag to `index.html`.
- [ ] **Step 4: Run** `npm test` – Expected: all tests PASS (existing history/usage tests included).
- [ ] **Step 5: Commit** – `git add electron/renderer/commands.js electron/renderer/index.html electron/test/commands.test.mjs && git commit -m "feat(desktop): slash command and agent parsing helpers"`

### Task 2: Count recorded user messages (IPC)

**Files:**
- Modify: `electron/history.mjs` (new export), `electron/main.mjs` (new `handle`), `electron/preload.cjs` (new API)
- Test: `electron/test/history.test.mjs`

**Interfaces:**
- Produces:
  - `history.mjs`: `countUserMessages(id: string) -> number` – number of `user.message` events in
    `sessionDir(id)/events.jsonl`; `0` when the file doesn't exist (ENOENT); other errors throw. Uses `sessionDir`
    (id validation) and `readEvents`.
  - IPC `sessions:userMessages` (sessionId) → `countUserMessages(sessionId)`.
  - preload: `api.userMessages(sessionId) -> Promise<number>`.

- [ ] **Step 1: Write the failing tests** in `history.test.mjs`, using the file's existing temp-`COPILOT_HOME`
  fixture setup (`makeSession({ events })`): `countUserMessages counts user.message events` (fixture with 2 user messages → `2`) and
  `countUserMessages is 0 without events.jsonl` (session dir with only `workspace.yaml` → `0`).
- [ ] **Step 2: Run** `npm test` – Expected: FAIL (`countUserMessages is not a function` / not exported).
- [ ] **Step 3: Implement** `countUserMessages`, the `handle("sessions:userMessages", …)` next to
  `sessions:rename` in `main.mjs`, and `userMessages` in `preload.cjs` next to `renameSession`.
- [ ] **Step 4: Run** `npm test` – Expected: PASS.
- [ ] **Step 5: Commit** – `feat(desktop): IPC to count recorded user messages`

### Task 3: Agent picker in the composer + `/agent`

**Files:**
- Modify: `electron/renderer/app.js` (`SessionView` constructor, `setConfig`, `setBusy`, `send`), `electron/renderer/style.css`

**Interfaces:**
- Consumes: `SlashCommands.agentPickerModel`, `matchAgent`, `parseAgentCommand` (Task 1); `api.setConfig` (exists).
- Produces on `SessionView`:
  - `this.agentOption` – latest ACP `agent` config option or `undefined`.
  - `this.agentPicker` – `<select class="agent-picker">` placed in `.composer` before `.btns`; hidden when
    `!model.show`.
  - `setAgent(option) -> void` – stores option, rebuilds picker from `agentPickerModel`, selects `current`, title =
    current entry's description.
  - `async chooseAgent(value: string) -> boolean` – refuses while `this.busy` (status line
    `Wait until Copilot finishes this turn.` → `false`); else `api.setConfig(sessionId, "agent", value)`, then
    `this.setConfig(result)` and `this.system("Agent: " + name)`; on error: re-render picker from the previous
    `agentOption`, `this.statusEl.textContent = "Agent change failed: " + message`, return `false`.
  - `agentAvailable() -> boolean` – `agentPickerModel(this.agentOption).show`.

- [ ] **Step 1: `setConfig`** – skip `c.id === "agent"` when building header selects and call
  `this.setAgent(configOptions.find((c) => c.id === "agent"))` (also when it is absent, to hide the picker).
- [ ] **Step 2: Picker** – build/insert `this.agentPicker`; `change` → `chooseAgent(sel.value)`; missing entry
  rendered `disabled`; disable it in `setBusy` when `b || this.dead`. Style: compact, same look as `.head select`,
  aligned to the bottom of the composer.
- [ ] **Step 3: `/agent` in `send()`** – before `runPrompt`: if `this.agentAvailable()` and
  `parseAgentCommand(text)` matches → clear input, no bubble; `arg === ""` → `this.agentPicker.focus()` and
  `showPicker?.()` (Chromium `HTMLSelectElement.showPicker`); else `matchAgent(model.entries.filter(e => !e.missing), arg)`
  → `chooseAgent(value)`; no match → put the text back in the input and status line
  `Unknown agent "<arg>". Available: <names joined by ", ">`. When the picker isn't available, fall through (sent as today).
- [ ] **Step 4: Verify** – `npm test` passes; `cd electron && npm start`, open a session in the scratch repo from
  Task 6 (`.github/agents/pirate.agent.md`): picker shows `Copilot`, switching to `pirate` logs `Agent: pirate`
  and the next reply starts with "ARR"; `/agent copilot` switches back without a bubble; `/agent nobody` shows the
  error and keeps the text.
- [ ] **Step 5: Commit** – `feat(desktop): agent picker and /agent command`

### Task 4: `/` command popup

**Files:**
- Modify: `electron/renderer/app.js` (`SessionView`, `onUpdate`, global `api.onUpdate` handler, `flushEarly`), `electron/renderer/style.css`

**Interfaces:**
- Consumes: `commandToken`, `filterCommands`, `insertCommand` (Task 1); `agentAvailable()` (Task 3).
- Produces:
  - `SessionView.commands` – latest `availableCommands` array; `setCommands(list) -> void` (replaces, re-renders an
    open popup).
  - Global `lastCommands: Map<sessionId, Command[]>` filled in the `api.onUpdate` handler for every
    `available_commands_update` (before dispatching to the view); `flushEarly(v)` calls
    `v.setCommands(lastCommands.get(v.sessionId))` when present. Fixes updates dropped before the view exists.
  - Popup: `this.cmdPopup` (`div.cmd-popup`, `role="listbox"`) inside `.composer` (which gets `position: relative`),
    absolutely positioned above it, max ~8 rows then scroll. Rows: `/name`, muted hint (`input.hint`),
    one-line ellipsized description, full description as `title`. App's own entry
    `{ name: "agent", description: "Choose the custom agent for this session", input: { hint: "name" } }` listed
    first while `agentAvailable()`.
  - `updatePopup() -> void` – called on `input`, `click`, `keyup` of arrow/Home/End keys, and after insert:
    token = `commandToken(value, selectionStart)`; `null` or no matches → hide; else render, highlight index
    clamped (reset to 0 when the token changes).
  - Keys (registered **before** the existing Enter/Esc handler; when the popup is visible they
    `preventDefault()` + `stopImmediatePropagation()`): ArrowDown/ArrowUp move (wrap); Tab/Enter insert highlighted
    via `insertCommand`, set `value` and caret, `autosize()`, hide; Escape hides only. Popup hidden → nothing changes.
  - Row `mousedown` → `preventDefault()` (keeps focus) and insert. Textarea `blur` → hide.

- [ ] **Step 1:** `onUpdate` case `"available_commands_update"` → `this.setCommands(u.availableCommands ?? [])`;
  add `lastCommands` + `flushEarly` wiring.
- [ ] **Step 2:** popup DOM, rendering, `updatePopup`, mouse handling, CSS (dark theme vars already used in
  `style.css`; highlighted row uses the existing accent).
- [ ] **Step 3:** keyboard handling as specified.
- [ ] **Step 4: Verify** – `npm test` passes; in the app: new session → `/` lists commands at once; `/co` →
  `compact`, `context` first; Tab inserts `/compact `; second Enter sends and Copilot runs it; `/brain` →
  `superpowers:brainstorming`; `a /b` → no popup, Enter sends; Esc with popup open only closes it.
- [ ] **Step 5: Commit** – `feat(desktop): slash command popup`

### Task 5: `/rename` via the rename path + command prompts aren't turns

**Files:**
- Modify: `electron/renderer/app.js` (`renameSession`, `send`, `runPrompt`, `markTurn`), `electron/README.md`

**Interfaces:**
- Consumes: `parseRenameCommand`, `isCommandPrompt` (Task 1); `api.userMessages` (Task 2).
- Produces:
  - `async applyRename(name: string) -> void` – the body of `renameSession`'s save path extracted (busy guard,
    `api.renameSession`, `setTitle`, error `Rename failed: …`, `scheduleRefresh`); `renameSession` uses it.
  - `markTurn` also stores `this.turnReplyEl = el` when it marks a reply (reset to `null` on a new user message).
  - `dropTurn(userEl) -> void` – only if `userEl._turn === this.turn`: remove the `.acts` bars from `userEl` and
    `this.turnReplyEl`, delete their `_turn`/`_kind`, `this.turn--`, `this.turnReplied = true` (later blocks of this
    turn get no actions), `this.turnReplyEl = null`.

- [ ] **Step 1:** in `send()`, after the `/agent` branch: `parseRenameCommand(text)` → clear input, no bubble,
  `applyRename(name)`.
- [ ] **Step 2:** in `runPrompt`, when `isCommandPrompt(text)`: `before = await api.userMessages(id).catch(() => null)`
  before sending; after the prompt settles (in `finally`, before `setBusy(false)`), if `before !== null`:
  `after = await api.userMessages(id).catch(() => null)`; `after === before` → `this.dropTurn(bubble)`.
  Any `null` → keep the turn.
- [ ] **Step 3:** README (`electron/README.md`): short "Slash commands and agents" section – `/` popup, agent picker,
  `/agent [name]`, commands only as the first word, CLI commands don't get Fork/Delete.
- [ ] **Step 4: Verify** – `npm test` passes; in the app: `/context`, then `hello`, then Delete from `hello` → the
  confirm dialog says 1 message removed and the cut is right; `/context` bubble has no Fork/Delete; `/rename X`
  renames with no bubble; a skill command (`/superpowers:brainstorming hi`) keeps its Fork/Delete actions.
- [ ] **Step 5: Commit** – `feat(desktop): /rename and command prompts keep fork/delete turns right`

### Task 6: End-to-end check in the app

**Files:** none (scratch repo outside the project).

- [ ] **Step 1:** create a scratch git repo with `.github/agents/pirate.agent.md`:

```markdown
---
name: pirate
description: Test agent that talks like a pirate
---
Always answer like a pirate. Start every reply with "ARR".
```

- [ ] **Step 2:** run all 10 manual checks from the spec's Testing section (`cd electron && npm start`), noting
  pass/fail for each. Also a repo without agents (check 8). Report any failure with what was seen.
- [ ] **Step 3:** ask the user to check company agents in a company repo (picker lists and switches them).
