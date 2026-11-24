# New Session Params Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A parent session can propose every parameter of a child (folder, own prompt, context tier, agent, model,
command arguments); the approval card shows them all editable, and the folder of any new session can be changed
before it starts.

**Architecture:** The MCP tool takes the new fields and refuses a bad command at once. Main turns the request into
the card's start values with pure helpers in `electron/delegation.mjs` (fallback + note per field), the card edits
them, and `delegation:answer` hands the card's values to `createChild`. A shared validator (two identical copies, one
for the broker in `src/`, one for the app in `electron/`) admits only `copilot` with plain arguments. A small renderer
component shows a folder with **Change…** on the card and in the new-session dialog.

**Tech Stack:** Node.js (ESM), Electron, vanilla JS renderer, zod (MCP schema), `node:test`, the UI checks in
`scripts/ui-check` (Xvfb, scripted ACP agent).

**Spec:** `docs/superpowers/specs/2026-11-24-new-session-params-design.md`

## Global Constraints

- Branch `feat/new-session-params` in the worktree `.claude/worktrees/feat+new-session-params`, cut from `main`
  (v0.27.1). Ships as v0.28.0; the tag goes on `main`'s `--no-ff` merge commit, never on a branch commit.
- First commit (done before Task 1 by the controller): the spec and this plan, `docs: new session params spec and plan`.
- No new dependencies. Every new module `main.mjs` loads goes into `electron/package.json` `build.files`
  (`packaging.test.mjs` fails otherwise); `renderer/**` is already included.
- Nothing from the broker or a model reaches `createChild` directly: the child starts only with what the window sends
  through `delegation:answer` / `sessions:new`. Model-written values only pre-fill the card.
- The user's own typing in the card's command field is not validated (as today).
- No `alert`/`confirm`/`prompt` browser dialogs.
- Tests: `npm test` from the worktree root. UI checks: `npm --prefix electron run copy-relay` once, then
  `node scripts/ui-check/run.mjs <name…>`.
- Commits: `feat(relay): …` for `src/`, `feat(desktop): …` for `electron/`, `test(desktop): …`, `docs: …`; each ends
  with the `Co-Authored-By:` line of the model that wrote it.
- Reviews (CLAUDE.md): task reviews and re-reviews `model: opus`, `effort: high`; whole-branch review `model: fable`,
  `effort: medium`. Unfixed findings go to `docs/superpowers/backlog/2026-11-24-new-session-params-deferred.md`
  before the worktree is removed.
- Exact values and texts (`${…}` are the values named):

| Id | Value |
|---|---|
| CMD_MAX | 4000 (equals `COMMAND_MAX` in `electron/copilot-command.mjs`) |
| FOLDER_MAX | 4096 |
| PROMPT_MAX | 20000 |
| ARG_RE | `/^[A-Za-z0-9_.,:=@\/+-]+$/` |
| APP_FLAGS | `--acp`, `--stdio`, `--context`, any word starting with `--context=` |
| R_TYPE | `The command must be text.` |
| R_BREAK | `The command must be one line.` |
| R_LONG | `The command is longer than 4000 characters.` |
| R_EMPTY | `The command is empty.` |
| R_PROGRAM | `Only the copilot command is allowed, not "${first}".` |
| R_CHAR | `Argument "${word}" holds a character that is not allowed (allowed: letters, digits and _ . , : = @ / + -).` |
| R_APPFLAG | `Argument "${word}" is set by the app itself.` |
| TOOL_REFUSED | `Not sent: ${reason}` |
| TOOL_TOO_LONG | `Not sent: "${field}" is longer than ${max} characters.` |
| D_FOLDER | `Absolute path of the folder the new session works in. Default: your own folder. The user can change it before approving.` |
| D_PROMPT | `The new session's own prompt part (instructions added to its system prompt). Default: none. The user can change it before approving.` |
| D_CONTEXT | `Context window tier: "default" (200k) or "long_context" (1M). Default: yours. The user can change it before approving.` |
| D_COMMAND | `Only the copilot command with arguments, e.g. "copilot --foo bar". The arguments are added to the command your own session runs. Any other program, a path or shell syntax is refused. Default: your own command. The user can change it before approving.` |
| D_SUFFIX | ` The user can change it before approving.` (appended to the existing `agent` and `model` descriptions) |
| N_FOLDER | `Asked for the folder "${folder}", which is not an existing absolute path.` |
| N_TIER | `Asked for the context "${context}", which is not 200k or 1M.` |
| N_COMMAND | `Asked for a command that was not taken: ${reason}` |
| N_AGENT | `Asked for the agent "${agent}", which is not offered here. Valid agents: ${list}.` |
| N_NO_AGENTS | `Asked for the agent "${agent}", but there are no custom agents available.` |
| N_MODEL | `Asked for the model "${model}", which is not offered here. Valid models: ${list}.` |
| FROM | `from ${parentName}` (`parentName` falls back to `the session`) |
| W_COMMAND | `Written by the session that asked. It runs when you approve.` |
| C_OTHER | `Session "${name}" was created in the folder "${folder}" and has started on its task. It will send you its result with report_result.` |
| C_SAME | today's text: `Session "${name}" was created and has started on its task. It will send you its result with report_result.` |
| CHANGE | `Change…` |
| PICK_TITLE | `Folder for the new session` |
| DLG_TITLE | `New session` |
| TIER_LABELS | `default` → `200k`, `long_context` → `1M` |
| MODEL_INHERIT | `inherited (${currentModel})`, or `inherited` without a current model; value `""` |
| AGENT_DEFAULT | `default`; value `""` |

`${list}` is the values joined with `, `, as `resolveConfig` lists them.

## Review Focus

- A folder picked or proposed that is removed before Approve: the start fails with the reason and the card (or dialog)
  stays answerable — Task 5 `child-card-params` (folder removed before Approve), Task 4 `new-session-folder`.
- A model proposes a command with shell syntax hidden in an argument (`copilot --x;rm`, `copilot $(id)`,
  `copilot "a b"`, a tab or a newline): refused by the tool and again by main — Task 1 table.
- A parent closed between the request and Approve: today's "no longer open" outcome, no child, no crash —
  Task 3 `createChild` keeps the `open.get(parentSessionId)` checks; covered by `child-card-params` closing nothing,
  so Task 5 adds the closed-parent case to `child-config-retry`.
- A window reload while the card's start runs: the retry path already ends the request (`windowReloads`); the new
  agent/model retry goes through the same branch of `delegation:answer` — Task 3 states it, no new test.
- The user changes a field after a failed start: the second Approve uses the changed values, not the first ones —
  Task 5 `child-config-retry` (model changed between the two Approves).

---

### Task 1: The command validator

**Files:**
- Create: `electron/child-command.mjs`, `src/child-command.mjs` (byte-identical, no imports)
- Modify: `electron/package.json` (`build.files`: add `child-command.mjs`)
- Test: `electron/test/child-command.test.mjs`

**Interfaces:**
- Produces: `childCommandArgs(value: unknown) -> { args: string[] } | { refused: string }` exported from both files;
  `CHILD_COMMAND_MAX = 4000` exported from both.

- [ ] **Step 1: Write the failing test.** Import both copies; one table runs against each:
  passing: `"copilot"` → `[]`, `"  copilot   --foo  bar "` → `["--foo","bar"]`, `"copilot --model=gpt-5 -x a/b@c+d,e:f"`.
  refused with the exact texts: `5` → R_TYPE; `"copilot\n--x"`, `"copilot\r"`, `"copilot\0"` → R_BREAK;
  `"copilot " + "a".repeat(4000)` → R_LONG; `""`, `"   "` → R_EMPTY; `"node x"`, `"/usr/bin/copilot"`, `"Copilot"`,
  `"copilot.exe"` → R_PROGRAM with that first word; each of `; | & $ \` < > ( ) * ? ~ ! \ % ' "` inside an argument
  (`copilot --x<c>y`) → R_CHAR naming the word; a tab between words → R_CHAR (only spaces split); `--acp`, `--stdio`,
  `--context`, `--context=long_context` → R_APPFLAG. Two more tests: the two files are byte-identical
  (`readFileSync` compare), and `CHILD_COMMAND_MAX === COMMAND_MAX` from `electron/copilot-command.mjs`.
- [ ] **Step 2:** `node --test electron/test/child-command.test.mjs` → FAIL (module not found).
- [ ] **Step 3:** Implement `childCommandArgs` in `electron/child-command.mjs` per spec section 4 (trim, break and
  length checks before splitting on runs of spaces `/ +/`); copy the file to `src/child-command.mjs`; add to `build.files`.
- [ ] **Step 4:** `npm test` → PASS (including `packaging.test.mjs`).
- [ ] **Step 5:** Commit `feat(desktop): validator for a command proposed by a parent session`.

### Task 2: The `create_session` tool takes the new fields

**Files:**
- Modify: `src/mcp.mjs` (schema of `create_session`, its handler; new export), `src/delegation.mjs:178`
  (`requestCreate`)
- Test: `electron/test/delegation-broker.test.mjs`

**Interfaces:**
- Consumes: `childCommandArgs` from `src/child-command.mjs` (Task 1).
- Produces: `createSessionInput(input) -> { request: { name, task, agent, model, folder, prompt, context, command } } | { refused: string }`
  exported from `src/mcp.mjs`. Absent optional fields become `""` (agent, model, folder, prompt, command) or `""` for
  context. `requestCreate(callerKey, request)` forwards all eight fields plus `requestId` in `session_request`.

- [ ] **Step 1: Write the failing tests** in `delegation-broker.test.mjs`:
  `createSessionInput refuses a bad command` (`command: "node x"` → `{ refused: "Not sent: " + R_PROGRAM }`);
  `createSessionInput refuses an over-long field` (`folder` of 4097 chars → TOOL_TOO_LONG with `"folder"` and `4096`;
  `prompt` of 20001 → `"prompt"`, `20000`); `createSessionInput passes the fields` (all given → same values; none given
  → `""` each); `create_session forwards the new fields in session_request` (extend the existing test at line 71: the
  payload has `folder`, `prompt`, `context`, `command` as given).
- [ ] **Step 2:** `node --test electron/test/delegation-broker.test.mjs` → FAIL.
- [ ] **Step 3:** In `src/mcp.mjs`: add `folder` (`z.string().optional()`), `prompt`, `context`
  (`z.enum(["default", "long_context"]).optional()`), `command` to the schema with D_FOLDER, D_PROMPT, D_CONTEXT,
  D_COMMAND; append D_SUFFIX to `agent` and `model`. The handler calls `createSessionInput` and returns `refused` as
  the tool's text without calling `requestCreate`. An empty or blank `command` counts as not given (not validated).
  `requestCreate` destructures and forwards the four new fields.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat(relay): create_session takes folder, prompt, context and command`.

### Task 3: Main resolves the request into the card and starts the child with the card's values

**Files:**
- Modify: `electron/delegation.mjs` (three new pure helpers), `electron/main.mjs` (`sessionRequested` ~892,
  `createChild` ~983, `delegation:answer` ~1052, `dialog:pickDir` ~1297), `electron/preload.cjs` (`answerDelegation`,
  `pickDir`)
- Test: `electron/test/delegation-main.test.mjs`

**Interfaces:**
- Consumes: `childCommandArgs` from `electron/child-command.mjs`; `normalizeTier` from `electron/context-tier.mjs`;
  `findModelOption` (existing).
- Produces:
  - `cardStart(request, parent, { isDir }) -> start` where `request` is the `session_request` payload, `parent` is
    `{ cwd, tier, storedCommand, command, configOptions, name }` (`storedCommand`: `commands.get(parentId) ?? ""`;
    `command`: the parent's resolved line, `resolveCommand({ own: storedCommand, settings, envPath }).command`), and
    `isDir(path) -> boolean`. `start` is
    `{ cwd, tier, agent, model, own, command, agents: [{ value, name }], models: [{ value, name }], currentModel, parentName, from: { cwd, tier, agent, model, own, command }, notes: { cwd?, tier?, agent?, model?, command? } }`.
    Rules: spec section 2. `from.x` is true only when the parent's value was taken. `command` is
    `storedCommand` when no arguments were proposed (or they were refused), else `${parent.command} ${args.join(" ")}`.
    `agents`/`models` are the parent's option values deduplicated by `value` (first `name` wins); `currentModel` is the
    model option's `currentValue` or `null`; `parentName` is `parent.name || "the session"`.
  - `answerFields(fields, { parentCwd, parentTier }) -> { cwd, tier, agent, model }` (spec section 2: absolute
    `cwd` via `path.resolve`, else `parentCwd`; `normalizeTier(tier) ?? parentTier`; non-string agent/model → `""`).
  - `createdText({ name, childCwd, parentCwd }) -> string` (C_OTHER when `path.resolve` of both differs, else C_SAME).
  - IPC: `delegation:request` payload `{ requestId, name, task, start }`;
    `delegation:answer(requestId, approved, own, command, fields)`; `dialog:pickDir(title, defaultPath)`.
    Preload: `answerDelegation(requestId, approved, own, command, fields)`, `pickDir(title, defaultPath)`.

- [ ] **Step 1: Write the failing tests** in `delegation-main.test.mjs` (stub `isDir`):
  `cardStart takes valid parent values` (folder, prompt, context `long_context`, agent and model in the lists, command
  `copilot --foo` → `command === parent.command + " --foo"`, all `from.*` true, no notes);
  `cardStart falls back with a note` (relative folder and missing folder → parent's cwd + N_FOLDER; context `"huge"` →
  parent's tier + N_TIER; agent not offered → `""` + N_AGENT; parent without an agent option → N_NO_AGENTS; model not
  offered → `""` + N_MODEL; command `node x` → `storedCommand` + `N_COMMAND` with R_PROGRAM; each with `from.x` false);
  `cardStart without proposals keeps today's card` (`command === storedCommand`, `own === ""`, `cwd === parent.cwd`);
  `cardStart deduplicates the lists`; `answerFields normalises the card's values`; `createdText names another folder only`.
- [ ] **Step 2:** `node --test electron/test/delegation-main.test.mjs` → FAIL.
- [ ] **Step 3:** Implement the three helpers in `electron/delegation.mjs`.
- [ ] **Step 4: Wire main and preload.**
  - `sessionRequested`: store the whole request (`pendingRequests.add`), send
    `delegation:request` with `start = cardStart(req, { cwd: parent.cwd, tier: sessionTier(parentSessionId), storedCommand, command, configOptions: parent.configOptions, name: parent.relay?.name }, { isDir })`
    (`isDir` uses `existsSync` + `statSync().isDirectory()`).
  - `delegation:answer(requestId, approved, own, command, fields)`: `createChild(req, own, command, answerFields(fields ?? {}, { parentCwd, parentTier }))`
    (compute `parentCwd`/`parentTier` from the open parent; a closed parent goes the existing "no longer open" way).
  - `createChild(req, own, command, fields)`: start in `fields.cwd` with `fields.tier` (`tiers.set(sessionId, fields.tier)`);
    `resolveConfig(entry.configOptions, { agent: fields.agent, model: fields.model, inheritedModel })`. When it
    returns `error`: `await discard()`, then if `open.get(parentSessionId) === parent` return
    `{ outcome: "failed", text: config.error, retry: true }` (parent told nothing), else `failed("invalid", config.error)`.
    `tellParent(req, "created", createdText({ name: finalName, childCwd: child.cwd, parentCwd: parent.cwd }), finalName)`.
    `childPrompt` keeps the parent's folder.
  - `dialog:pickDir(title, defaultPath)`: pass `defaultPath` to `showOpenDialog` when it is a string naming an
    existing folder.
- [ ] **Step 5:** `npm test` → PASS.
- [ ] **Step 6:** Commit `feat(desktop): the delegation request carries every child parameter to the card`.

### Task 4: Folder row, and the new-session dialog uses it

**Files:**
- Create: `electron/renderer/folder-row.js` (IIFE exposing `globalThis.FolderRow`, `module.exports` for tests, like
  `prompt-editor.js`)
- Modify: `electron/renderer/index.html` (script tag before `app.js`), `electron/renderer/app.js` (`newSession` ~2924),
  `electron/renderer/style.css`
- Test: `electron/test/folder-row.test.mjs`, `scripts/ui-check/checks.mjs` (new check `new-session-folder`)

**Interfaces:**
- Consumes: `api.pickDir(title, defaultPath)` (Task 3).
- Produces: `FolderRow.createFolderRow({ value: string, pick: (current) => Promise<string|null>, h }) -> { el, value(): string, set(path: string): void, setDisabled(b: boolean): void }`.
  `el` has class `folder-row`, holds a `.folder-path` span (text and `title` = the path) and a `.folder-change`
  button with CHANGE; `el._row` is the returned object (the UI checks drive it, the native picker cannot be).

- [ ] **Step 1: Write the failing unit test** (`folder-row.test.mjs`, the fake `h` of `prompt-editor.test.mjs`):
  shows the start value; a click with `pick` resolving `"/b"` changes `value()` and the text; `null` keeps it;
  `pick` is called with the current value; `setDisabled(true)` disables the button; a click while a pick is running
  does not start a second one.
- [ ] **Step 2:** `node --test electron/test/folder-row.test.mjs` → FAIL.
- [ ] **Step 3:** Implement `createFolderRow`; add the script tag.
- [ ] **Step 4:** `newSession(cwd)`: after the picker (unchanged), build the row with
  `pick: (cur) => api.pickDir(PICK_TITLE, cur)`, put `h("div", {}, row.el, editor.el)` in the dialog by passing
  `{ ...editor, el: wrapper }` to `openPromptDialog` with title DLG_TITLE. `onOk` reads `row.value()` for the status
  line, `api.newSession` and the `SessionView`; `row.setDisabled(true)` while it runs, `false` after a refused start.
- [ ] **Step 5: UI check `new-session-folder`** (`modes: ["off"]`): open the dialog for `work`, assert title DLG_TITLE,
  the row shows `work` and CHANGE is enabled; `_row.set(<app.dir>/other)` (created with `mkdirSync`); Start; the new
  view's `cwd` is `other`. A second dialog: `_row.set` to a folder then remove it with `rmSync`, Start → the dialog
  stays open with `Could not start the session: Folder does not exist: …` and the button enabled again.
- [ ] **Step 6:** `npm test` and `node scripts/ui-check/run.mjs new-session-folder` → PASS; run the existing checks
  that open the dialog (`grep -n "newSession(" scripts/ui-check/checks.mjs`) and fix any that assert the old title.
- [ ] **Step 7:** Commit `feat(desktop): the folder of a new session can be changed in its dialog`.

### Task 5: The delegation card edits every parameter

**Files:**
- Modify: `electron/renderer/app.js` (`delegationCard` ~2159, the `onDelegationRequest` listener that calls it),
  `electron/renderer/style.css`, `electron/test/fixtures/acp/scripted-agent.mjs` (scenario `configOptions`,
  `session/set_config_option`, prompt `create_session_json`), new fixture
  `electron/test/fixtures/acp/child-params-scenario.mjs`
- Test: `scripts/ui-check/checks.mjs` (new checks `child-card-params`, `child-config-retry`; adjust existing
  delegation checks to the new payload)

**Interfaces:**
- Consumes: `start` from `delegation:request` (Task 3); `FolderRow.createFolderRow` (Task 4);
  `api.answerDelegation(requestId, approved, own, command, { cwd, tier, agent, model })`.
- Produces: card DOM used by the checks: `.delegation .folder-row`, `select.dc-context`, `select.dc-agent`,
  `select.dc-model`, `.dc-from` marks (one per field with `from.x`), `.dc-note` (one per note, under its field),
  `.dc-warning` (W_COMMAND, next to the command field, only when `from.command`).
  Scripted agent: scenario key `configOptions: (cwd) => options[]` (or an array), returned by `session/new` and
  `session/load`; `session/set_config_option({ configId, value })` sets `currentValue` and returns `{ configOptions }`;
  prompt `create_session_json <json>` calls `create_session` with the parsed object.

- [ ] **Step 1: Extend the scripted agent and add `child-params-scenario.mjs`**: like `child-prompt-scenario.mjs`
  (`uniqueIds`, relay prompts) plus `configOptions(cwd)`: in a folder named `other-b`, model values `["m-a"]`;
  everywhere else model `["m-a", "m-b"]` (current `m-a`) and agent `["", "rev"]`.
- [ ] **Step 2: Write the UI check `child-card-params`** (failing): parent command set in the dialog as in
  `child-command-inherited`; `mkdirSync(<app.dir>/other)`; send
  `create_session_json {"name":"kid","task":"T","folder":"<other>","prompt":"P1","context":"long_context","agent":"rev","model":"m-b","command":"copilot --foo bar"}`.
  Assert: the row shows `other`; `dc-context` is `long_context`, `dc-agent` `rev`, `dc-model` `m-b` (first option
  MODEL_INHERIT with `m-a`); `.pe-own` holds `P1`; `.pe-command` is the parent's command + ` --foo bar`;
  `.dc-warning` is W_COMMAND; six `.dc-from` with FROM; no `.dc-note`. Approve → while it runs the row button and the
  three selects are disabled; the child view's `cwd` is `other`; its argv line has `--context long_context`,
  `--foo bar` and `--tag parent`; the parent's outcome text is C_OTHER. Second request with `"folder":"/nope"` →
  the row shows the parent's folder and one `.dc-note` is N_FOLDER (N_TIER is unit-tested only: the tool's enum stops
  a bad context); then `_row.set` to a new folder, `rmSync` it, Approve → the card stays open with
  `Folder does not exist: …` and its controls enabled. Third request with `"command":"node x"` → the tool's reply is
  TOOL_REFUSED with R_PROGRAM and no new card appears.
- [ ] **Step 3:** `node scripts/ui-check/run.mjs child-card-params` → FAIL.
- [ ] **Step 4: Build the card.** `delegationCard({ requestId, name, task, start })`: Name and Task as today; Folder =
  folder row; Context, Agent, Model = selects (TIER_LABELS; `agents` with AGENT_DEFAULT first, disabled when the list
  is empty; `models` with MODEL_INHERIT first); prompt editor `own: start.own`, command `value: start.command`;
  FROM marks, notes and W_COMMAND per the Interfaces block. `answer()` freezes and re-enables the row and selects with
  the other controls and sends `{ cwd: row.value(), tier, agent, model }` on Approve, no fields on Reject. Update the
  listener and every existing check that calls `delegationCard` directly (`checks.mjs:1298` passes
  `{ … cwd }`: give it a `start`).
- [ ] **Step 5: UI check `child-config-retry`**: parent in `work`; `mkdirSync(<app.dir>/other-b)`; request with
  `"folder":"<other-b>","model":"m-b"`. Approve → the card stays open with `resolveConfig`'s text
  (`Unknown model "m-b". Valid models: m-a.`), no child view remains, the parent got no outcome message; switch
  `dc-model` to the MODEL_INHERIT option; Approve → the child starts in `other-b` and the card says Approved.
  Then a second request, close the parent's view (`sessions:close` via the session's Close button), answer the card's
  Approve through `api.answerDelegation` in the page → resolves `false` (request no longer open) and no child starts.
- [ ] **Step 6:** `npm test`, then `node scripts/ui-check/run.mjs child-card-params child-config-retry child-card-prompt child-command-inherited`
  and every other check that names `delegation` (`grep -n "delegation" scripts/ui-check/checks.mjs`) → PASS.
- [ ] **Step 7:** Commit `feat(desktop): the delegation card edits folder, context, agent, model, prompt and command`.

### Task 6: Docs and the full run

**Files:**
- Modify: `README.md` / `electron/README.md` where `create_session` and the delegation card are described
  (`grep -n "create_session\|New session requested" README.md electron/README.md`)

- [ ] **Step 1:** Describe the four new tool fields (the command rule in one sentence) and the editable card.
- [ ] **Step 2:** `npm test` and `node scripts/ui-check/run.mjs` (all checks) → PASS. Record the counts in the
  commit body.
- [ ] **Step 3:** Commit `docs: new session parameters`.
- [ ] **Manual checks (left open for the backlog file):** the native picker on Linux and Windows (opens at the current
  folder, Cancel keeps it); a real Copilot child started with `copilot <args>` appended to the corp PC's command.
