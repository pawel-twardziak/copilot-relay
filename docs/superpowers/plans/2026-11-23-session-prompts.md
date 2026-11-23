# Session Prompts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every session the desktop app runs gets its own system prompt (default part + child part + own part),
set in an editor when the session is created and changeable later. Templates are kept in Settings, and every child
(delegated or adopted) always reports to its parent.

**Architecture:** Before each start of a session's `copilot --acp` process, the app writes the composed prompt to a
fresh per-process directory `userData/session-prompts/run/<random>/.github/instructions/session.instructions.md` and
adds it to `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` in that process's environment. The directory is removed when the process
exits. A change restarts the session's Copilot and reloads it, the same way a Context change does.

**Tech Stack:** Node.js (ESM), Electron, vanilla JS renderer, `node:test`, the UI checks in `scripts/ui-check` (Xvfb,
scripted ACP agent).

**Spec:** `docs/superpowers/specs/2026-11-23-session-prompts-design.md`

## Global Constraints

- Starts only after `feat/held-child-replies` is merged to `main` as v0.22.0. Branch `feat/session-prompts`, cut
  from that `main`, in a worktree (`.claude/worktrees/feat+session-prompts`). The spec is already on `main`.
- Ships as v0.23.0. The tag goes on `main`'s `--no-ff` merge commit, never on a branch commit (CLAUDE.md).
- No new dependencies. Every new module `main.mjs` loads goes into `electron/package.json` `build.files`
  (`packaging.test.mjs` fails otherwise).
- Nothing is written to `~/.copilot`. The variable reaches Copilot through `env` only, never the command line.
- An existing `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` in the app's environment is kept; the session's directory is
  appended after a comma.
- Settings keys: `promptDefault` (string, default `""`), `promptChild` (string; absent = built-in default; `""` = no
  child part), `promptTemplates` (`[{ id, name, text }]`). Own parts: `userData/session-prompts.json`,
  `{ [sessionId]: string }`.
- No `alert`/`confirm`/`prompt` browser dialogs.
- Tests: `npm test` from the repo root. UI checks: `npm --prefix electron run copy-relay` once, then
  `node scripts/ui-check/run.mjs <name…>`.
- Commits: `feat(desktop): …` for `electron/`, `feat(relay): …` for `src/`, `server.mjs`, `extension/`;
  `test(…)`, `docs: …`. Each ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Exact texts:

| Id | Text |
|---|---|
| `CHILD_PART` | the block quote in spec section 1 ("This session is the child of another session, …"), verbatim |
| `REMINDER` | `When you are done, always send the result (or a short summary) with report_result.` |
| `LINKED_CHILD` | `The user made this session a child of "<parent>". "<parent>" cannot see this chat and waits for your report. When the work you are doing is done, always send it the result (or a short summary, or a note that it is finished) with the report_result tool, exactly once.` |
| `LINKED_PARENT` | `Session "<child>" is now your child. It will send you its result with report_result.` |
| `COMMA_PATH` | `The app's data folder contains a comma, so Copilot cannot be given this session's prompt: <path>` |
| `RESTART_NOTE` | `Saving restarts this session's Copilot. The history stays.` |
| `SETTINGS_NOTE` | `Changes here reach a running session the next time its Copilot starts.` |

## Review Focus

1. A template picked over text the user typed: the typed text must not be lost without the inline Replace/Keep
   question (Task 5).
2. A child reopened while the broker is down or the links cache is empty: it starts without the child part, with no
   error and no hang (Task 2).
3. A process that crashes, lingers after close, or fails to start: its prompt directory is removed only when that
   process has exited, and leftovers are removed at the next app start (Tasks 1, 2).
4. A user who set `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` themselves: their directories still reach every session (Task 1).
5. "Save and restart" with an unchanged text, or while a turn runs: no restart, a refusal that leaves the dialog
   open with the text kept (Tasks 2, 6).

---

### Task 0: Start from v0.22.0

**Files:** none (worktree and checks only)

- [ ] **Step 1:** Confirm `held-child-replies` reported the merge, then `git fetch && git log --oneline -1 v0.22.0`.
  Expected: the tag exists and `main` contains it.
- [ ] **Step 2:** Create the worktree `.claude/worktrees/feat+session-prompts` on a new branch `feat/session-prompts`
  from `main`.
- [ ] **Step 3:** `npm ci && npm --prefix electron ci && npm --prefix electron run copy-relay && npm test`.
  Expected: all pass. Write down the count.
- [ ] **Step 4:** Read the v0.22.0 shape of the link data: what `writeLinksCache` stores in `links-cache.json` and the
  fields of one link (`key`, `parent`, `adopted`). Task 2's `childLinkOf` reads that shape. If the cache no longer
  holds a plain links array, note the exact path to the array in Task 2 before starting it.

### Task 1: The prompt module

**Files:**
- Create: `electron/session-prompts.mjs`
- Create: `electron/test/session-prompts.test.mjs`
- Modify: `electron/package.json` (`build.files`)

**Interfaces:**
- Produces:
  - `CHILD_PART: string` (the `CHILD_PART` text)
  - `composePrompt({ defaultPart, childPart, own, isChild }: { defaultPart?: string, childPart?: string, own?: string, isChild: boolean }) -> string`
  - `effectiveChildPart(promptChild: unknown) -> string`: `CHILD_PART` when not a string, else the string
  - `normalizeTemplates(value: unknown) -> Array<{ id: string, name: string, text: string }>`
  - `createPromptStore(file: string) -> { get(id): string, set(id, text): void, delete(id): void, copy(fromId, toId): void }`
  - `writePromptDir(root: string, prompt: string) -> { dir: string, remove(): void }`
  - `clearPromptDirs(root: string) -> void`
  - `instructionsEnv(env: object, dir: string | null) -> object`

- [ ] **Step 1: Write the failing tests** in `electron/test/session-prompts.test.mjs`:
  - `composePrompt joins the non-empty parts in order`: `composePrompt({ defaultPart: " A ", childPart: "B", own: "C", isChild: true })`
    → `"A\n\nB\n\nC"`. With `isChild: false` → `"A\n\nC"`. All empty or whitespace → `""`.
  - `effectiveChildPart: absent means the built-in text, "" means none`: `effectiveChildPart(undefined) === CHILD_PART`,
    `effectiveChildPart("") === ""`, `effectiveChildPart("X") === "X"`.
  - `normalizeTemplates keeps well-formed entries only`: drops non-objects, entries without a string `id`, and
    duplicates of an id; `name`/`text` become strings (`""` if missing); a non-array → `[]`.
  - `the prompt store`: `set("s1", "x")` then `get("s1") === "x"`; `set("s1", "")` removes the entry (file has no
    `s1`); `copy("s1", "s2")`; `delete("s1")`; `get` of an unknown id → `""`; a corrupt file reads as empty.
  - `writePromptDir writes the instructions file and remove() deletes the directory`: the file is
    `<dir>/.github/instructions/session.instructions.md` with the prompt plus a trailing newline; `dir` is under
    `<root>/run/`; two calls give two directories; after `remove()` the directory is gone and a second `remove()`
    does not throw.
  - `clearPromptDirs removes everything under run/`.
  - `instructionsEnv appends to the user's directories`: `{ COPILOT_CUSTOM_INSTRUCTIONS_DIRS: "/u" }` and `"/d"` →
    `"/u,/d"`; without the variable → `"/d"`; `dir` null → the env unchanged (the same keys and values); the input
    object is not mutated.
  - `instructionsEnv refuses a directory with a comma`: throws with a message matching `/contains a comma/`.

- [ ] **Step 2:** `node --test electron/test/session-prompts.test.mjs`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `electron/session-prompts.mjs`. The store has the shape of `createTierStore`
  (`electron/context-tier.mjs`): atomic write through `<file>.tmp` + rename; `set` throws when the file cannot be
  written, `delete`/`copy` only log. `writePromptDir` uses `mkdtempSync(path.join(root, "run", "p-"))`.
  `instructionsEnv` throws `new Error(COMMA_PATH text)` when `dir` contains `,`.
- [ ] **Step 4:** Add `session-prompts.mjs` to `build.files`. `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): the session prompt parts, their store and the per-process instructions folder`.

### Task 2: The main process applies the prompt

**Files:**
- Modify: `electron/main.mjs` (`connect`, `createSession`, `sessions:new`, `openSession`, `sessions:fork`,
  `sessions:delete`, `settings:get`, `settings:set`, app start, new `sessions:getPrompt` / `sessions:setPrompt`)
- Modify: `electron/context-tier.mjs` (`switchTier` → shared helper)
- Modify: `electron/preload.cjs`
- Modify: `electron/test/fixtures/acp/scripted-agent.mjs` (records the instructions it was started with)
- Modify: `electron/test/context-tier.test.mjs`
- Modify: `scripts/ui-check/checks.mjs` (new check `prompt-applied`)

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - IPC `sessions:new(cwd: string, own?: string)`, `sessions:getPrompt(sessionId) -> { own: string, defaultPart: string, childPart: string, isChild: boolean }`,
    `sessions:setPrompt(sessionId, own: string) -> { refused?: string, reopen?: true, unchanged?: true }`.
  - preload: `api.newSession(cwd, own)`, `api.getPrompt(sessionId)`, `api.setPrompt(sessionId, own)`.
  - `settings:get` adds `promptDefault`, `promptChild` (`null` when absent), `promptTemplates`, `childPartDefault`
    (`CHILD_PART`); `settings:set` takes `promptDefault`, `promptChild` (`null` removes the key), `promptTemplates`
    (through `normalizeTemplates`).
  - main-internal: `promptFor(sessionId: string, { own?: string, isChild?: boolean }) -> string`,
    `childLinkOf(sessionId) -> { parent: string, adopted: boolean } | null`: the link with `key === "cli:<sessionId>"`
    and a `parent` in `readLinksCache(linksCacheFile()).links` (v0.22.0 shape `{ links, held }`, checked in Task 0).
  - `context-tier.mjs`: `saveAndReopen({ prev, save, restore, refusal, close }) -> Promise<{ refused } | { reopen: true }>`;
    `switchTier` keeps its signature and uses it.
  - scripted agent: on start it appends `{ instructions: string[] }` (the text of every
    `*.instructions.md` under `.github/instructions/` of each directory in `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`) to a
    `starts` array in `<cwd>/.scripted-agent.json`, which `open()` keeps across saves.

- [ ] **Step 1: Write the failing tests.**
  - `context-tier.test.mjs`: the existing `switchTier` tests stay green; add `saveAndReopen restores on a failed close`
    (save called, close rejects, restore called with `prev`, the error rethrown) and `saveAndReopen refuses before
    saving` (refusal returns a text → `{ refused }`, save not called).
  - `scripted-agent.test.mjs`: `the agent records the instructions it was started with` (start it with the variable
    pointing at a folder holding `.github/instructions/a.instructions.md` = `"R1"`; `.scripted-agent.json` `starts`
    ends with `{ instructions: ["R1"] }`; a session/load in a second process appends a second entry).
  - UI check `prompt-applied` (mode `off`), launched with settings `{ promptDefault: "D" }`:
    1. `app.newSession()` with own part `"O1"` (Task 5 adds the dialog; until then the driver calls
       `api.newSession(work, "O1")` directly) → the last `starts` entry is `["D\n\nO1"]`.
    2. `api.setPrompt("scripted-work", "O1")` → `{ unchanged: true }`, and no new `starts` entry.
    3. `api.setPrompt("scripted-work", "O2")` → `{ reopen: true }`; reopen the view; the last `starts` entry is
       `["D\n\nO2"]`, and the chat still shows the earlier turns.
    4. Fork the session (`api.forkSession("scripted-work", target)`, with a target taken as the existing fork checks
       take it) and open the fork → its first `starts` entry is `["D\n\nO2"]`.
    5. Delete the fork → `session-prompts.json` has no entry for it.
    6. No directory is left under `userData/session-prompts/run/` once every process has exited (`app.close()`, then
       read the launch folder).
- [ ] **Step 2:** Run the new unit tests and `node scripts/ui-check/run.mjs prompt-applied`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `connect(cwd, deadline, args = [], prompt = "")`: `prompt` empty → no directory and the env unchanged. Otherwise
    `writePromptDir(promptRoot, prompt)` and `new AcpConnection({ …, env: instructionsEnv(process.env, dir) })`; the
    directory is removed on the connection's `"exit"` event and when `conn.start()` fails. `promptRoot` =
    `path.join(app.getPath("userData"), "session-prompts")`; `clearPromptDirs(promptRoot)` once at app start, before
    any `connect`. The lister (`getLister`) passes no prompt.
  - `promptFor(sessionId, { own, isChild })`: `own` defaults to the store's text, `isChild` defaults to
    `childLinkOf(sessionId) !== null`; the parts come from `loadSettings()` through `effectiveChildPart`.
    A missing or unreadable cache gives `null` (no child part).
  - `createSession(cwd, link = {}, deadline, tier = null, own = "")`: `connect(…, promptFor(null, { own, isChild: Boolean(link.parentKey) }))`;
    after `session/new` answers, `prompts.set(res.sessionId, own)`.
  - `openSession`: `connect(…, promptFor(sessionId))`.
  - `sessions:fork`: `prompts.copy(sessionId, res.sessionId)` next to `tiers.copy`. `sessions:delete`:
    `prompts.delete(sessionId)` next to `tiers.delete`.
  - `sessions:setPrompt`: the same refusals as `sessions:setContextTier`, in the same order; the same text as stored
    → `{ unchanged: true }` without closing; otherwise `saveAndReopen` with save/restore on the store and the same
    `close` as `setContextTier`.
- [ ] **Step 4:** `npm test` and `node scripts/ui-check/run.mjs prompt-applied`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): each session's Copilot starts with its prompt, and a changed prompt restarts it`.

### Task 3: Children get the child part, the reminder and the card's own part

**Files:**
- Modify: `electron/delegation.mjs` (`childPrompt`)
- Modify: `electron/main.mjs` (`createChild`, `delegation:answer`)
- Modify: `electron/preload.cjs` (`answerDelegation`)
- Modify: `electron/test/delegation-main.test.mjs`
- Modify: `electron/test/fixtures/acp/scripted-agent.mjs` (the `relay` step also runs `create_session <name> <task>`)
- Modify: `scripts/ui-check/checks.mjs` (new check `child-prompt`, broker mode)

**Interfaces:**
- Consumes: Task 2 (`createSession(…, own)`, `promptFor`, scripted agent `starts`).
- Produces: IPC `delegation:answer(requestId, approved: boolean, own?: string)`; preload
  `api.answerDelegation(requestId, approved, own)`.

- [ ] **Step 1: Write the failing tests.**
  - `delegation-main.test.mjs`: `childPrompt keeps the headers, the task and the reminder`:
    `childPrompt({ parentName: "p", task: "T", folder: "/f" })` starts with `[from p]\n[folder "/f"]\n`, contains
    `REMINDER` and ends with `T`; it no longer contains `cannot see this session's chat`.
  - UI check `child-prompt` (broker): the parent's scripted prompt calls `create_session kid Do-it`; the card shows;
    the check answers `api.answerDelegation(id, true, "K")`; the child's first `starts` entry is
    `[promptDefault + "\n\n" + CHILD_PART + "\n\nK"]` (settings `{ promptDefault: "D" }`); the child's first
    message contains `REMINDER`. With settings `promptChild: ""`, the entry is `["D\n\nK"]`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: Implement.** `createChild(req, own)` passes `own` to `createSession` (the link makes it a child).
  `delegation:answer` passes `String(own ?? "")` through; Reject ignores it. `childPrompt` builds
  `[from …]`, `[folder …]`, a line `You were started by the session "<parent>" to do the task below. ` + `REMINDER`,
  a blank line, the task.
- [ ] **Step 4:** `npm test`, `node scripts/ui-check/run.mjs child-prompt`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): a delegated child starts with the child part and the prompt written on its card`.

### Task 4: Adopted children report

**Files:**
- Modify: `src/delegation.mjs` (`LINK.linkedChild`, `LINK.linkedParent`, `died`)
- Modify: `src/mcp.mjs` (`report_result` description)
- Modify: `electron/delegation.mjs` (`unreportedChildren`)
- Modify: `electron/test/delegation-broker.test.mjs`, `electron/test/link-sessions-e2e.test.mjs`,
  `electron/test/delegation-main.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks (independent of 1–3).
- Produces: `LINK.linkedChild(parent)` = `LINKED_CHILD`, `LINK.linkedParent(child)` = `LINKED_PARENT`.

- [ ] **Step 1: Write the failing tests.**
  - `delegation-broker.test.mjs`: `an adopted child that ends without reporting gets its parent the notice` (adopt,
    then `died(childKey)` → the parent gets `Session "<child>" ended without reporting a result.`); an adopted child
    that reported → no notice.
  - `delegation-main.test.mjs`: `unreportedChildren counts adopted children` (an entry `{ parentSessionId: "p", adopted: true, reported: false }`
    is listed; with `reported: true` it is not).
  - `link-sessions-e2e.test.mjs`: the existing notice regexes follow the new texts: the child's note matches
    `/waits for your report/`, the parent's `/will send you its result/`.
- [ ] **Step 2:** `npm test`. Expected: the new and changed tests FAIL.
- [ ] **Step 3: Implement.** Drop the `isAdopted` exemption in `died` and the `!e.adopted` filter in
  `unreportedChildren` (update both doc comments). The `report_result` description says "when your work is done"
  instead of "when the task is done". `familyBlock` stays as it is: it already shows "reported" for every child, and
  "adopted, no task" stays.
- [ ] **Step 4:** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(relay): an adopted child owes its parent a report and is told so when it is linked`.

### Task 5: The prompt editor and the new-session dialog

**Files:**
- Create: `electron/renderer/prompt-editor.js`
- Create: `electron/test/prompt-editor.test.mjs`
- Modify: `electron/renderer/index.html` (`<dialog id="prompt-dialog">`), `electron/renderer/style.css`,
  `electron/renderer/app.js` (`newSession`)
- Modify: `scripts/ui-check/driver.mjs` (`newSession` presses Start), `scripts/ui-check/checks.mjs` (the in-page
  `newSession(…)` call near line 204 presses Start too; new check `new-session-prompt`)

**Interfaces:**
- Consumes: Task 2 (`api.newSession(cwd, own)`, `api.getSettings()` prompt fields).
- Produces:
  - `pickTemplate(state: { text: string, lastTemplateText: string | null }, template: { text: string }) -> { text: string, lastTemplateText: string } | { ask: true }`:
    replaces at once when `state.text` is empty or equals `lastTemplateText`, otherwise asks.
  - `createPromptEditor({ defaultPart: string, childPart: string | null, templates, own: string }) -> { el: HTMLElement, value(): string, focus(): void }`
    (`childPart` null → that fold is not shown).
  - `openPromptDialog({ title: string, okLabel: string, note?: string, editor }) -> Promise<string | null>`
    (null on Cancel/Esc; Ctrl+Enter = OK). Ids: `#prompt-dialog`, `#prompt-ok`, `#prompt-cancel`.

- [ ] **Step 1: Write the failing tests.**
  - `prompt-editor.test.mjs` (pure part, no DOM): `pickTemplate replaces an empty text`, `… replaces the untouched
    text of the last template`, `… asks when the text was typed or edited`.
  - UI check `new-session-prompt` (mode `off`), settings `{ promptDefault: "D", promptTemplates: [{ id: "t1", name: "Rev", text: "Review only." }] }`:
    `newSession(work)` opens `#prompt-dialog`; the Default fold holds `D`; there is no "Working with the parent"
    fold; picking `Rev` fills `Review only.`; typing ` Be brief.` and picking `Rev` again shows the inline
    question and Keep leaves the text; Ctrl+Enter starts the session and its `starts` entry is
    `["D\n\nReview only. Be brief."]`. A second `newSession(work)` with Cancel starts no process and creates no view.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: Implement.** `newSession(cwd)`: pick the folder as today, then
  `openPromptDialog({ title: "New session in <cwd>", okLabel: "Start", editor })`; null → return; otherwise
  `api.newSession(cwd, own)` and the existing view setup. The folds are `<details>` with read-only `<pre>`. The Replace/Keep
  question is an inline row in the editor. Update the driver's `newSession` to press `#prompt-ok` once the dialog is
  open, and Task 2's check to go through it.
- [ ] **Step 4:** `npm test` and `node scripts/ui-check/run.mjs` (all checks: every one that creates a session goes
  through the dialog now). Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): a new session opens the prompt editor, with the templates from Settings`.

### Task 6: The child card, the session's Prompt button and Settings

**Files:**
- Modify: `electron/renderer/app.js` (`SessionView.delegationCard`, the session header, `openSettings`, the
  `#settings` close handler), `electron/renderer/index.html` (Settings "Prompts" section), `electron/renderer/style.css`
- Modify: `scripts/ui-check/checks.mjs` (checks `child-card-prompt`, `session-prompt-edit`, `settings-prompts`)

**Interfaces:**
- Consumes: Task 5 (`createPromptEditor`, `openPromptDialog`), Task 2 (`api.getPrompt`, `api.setPrompt`, settings
  fields), Task 3 (`api.answerDelegation(id, approved, own)`).

- [ ] **Step 1: Write the failing UI checks.**
  - `child-card-prompt`: `${V}.delegationCard({ … })` shows an editor with both folds (the child one holds
    `childPartDefault`), and Approve calls `answerDelegation` with the editor's text (spy on `api.answerDelegation`
    in the page, as the existing delegation check does).
  - `session-prompt-edit`: the header's Prompt button opens the dialog with the stored own part, `RESTART_NOTE`
    and "Save and restart"; saving a new text reopens the session (the last `starts` entry changes); while the view is
    busy the button is disabled; a `{ refused }` answer keeps the dialog open with the text and shows the refusal.
  - `settings-prompts`: Settings shows `SETTINGS_NOTE`, edits `promptDefault`, the child part ("Restore default"
    puts `childPartDefault` back and saves `promptChild: null`), adds, renames and deletes a template; after Save and
    a relaunch with the same folder (as `save-keeps-mode` does) the values are back.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: Implement.** The card puts the editor between the task and the buttons. The Prompt button sits in
  the view's header next to the config selects and follows `setBusy`. On `{ reopen: true }` the view reopens the way
  a Context change does (reuse that path in `app.js`). Template ids: `crypto.randomUUID()`.
- [ ] **Step 4:** `npm test` and `node scripts/ui-check/run.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): prompts on the child's card, in a running session and in Settings`.

### Task 7: Real Copilot, docs and backlog

**Files:**
- Modify: `electron/README.md` (a "Session prompts" section: the parts, templates, restart on change, children report)
- Create: `docs/superpowers/backlog/2026-11-23-session-prompts-deferred.md` (sections A–D, as the other backlog files)

- [ ] **Step 1: Manual check on real Copilot** (this Linux machine): start the app (`npm run app`), create a session
  with own part `End every reply with the word PINEAPPLE.`, send a message → the reply ends with PINEAPPLE; change it
  to MANGO with "Save and restart" → the next reply ends with MANGO and the history is there. Write the outcome in
  the backlog's D section (with the Copilot version), including that Windows and the corp PC were not run.
- [ ] **Step 2:** Write the README section and the backlog file: every review finding not fixed, the known
  limitations from the spec, and the open manual checks.
- [ ] **Step 3: Commit** `docs: session prompts in the README, deferred items`.
