# Spec: Every parameter of a new session can be set before it starts (`new-session-params`)

Extends `2026-11-23-session-prompts-design.md` (the dialog a session is created in, the prompt editor on the
delegation card) and `2026-11-24-session-command-design.md` (the command field on the delegation card). Where the
documents disagree, this one wins; in particular it replaces that spec's anti-goal "no model may set the command" with
the validated proposal in section 4.

Implementation starts from `main` (v0.27.1); this feature ships as v0.28.0.

## Intent

When a session asks for a sub-session (`create_session`), the child always starts in its parent's folder and the
approval card shows the folder as plain text. The user wants:

1. The folder of a new session can always be changed before the session starts, and never afterwards (as today).
2. The parent can set every parameter of the child's session in its request, not only the name, task, agent and
   model it sends today.

## Goals

1. `create_session` takes, besides `name`, `task`, `agent` and `model`, four optional parameters: `folder`, `prompt`
   (the child's own prompt part), `context` (the context tier) and `command` (the child's Copilot command).
2. What the parent sends only fills in the approval card. The user sees every value and can change the folder, the
   context tier, the agent, the model, the own prompt part and the command; Approve starts the child with what the
   card shows. Nothing starts without Approve, as today. The name and the task stay read-only, as today (the task is
   the parent's order, the name is what the parent addresses the child by).
3. The card shows the folder with a **Change…** button; it starts as the parent's `folder`, else the parent's own
   folder.
4. The new-session dialog (from **+ New session** and from the **+** of a project group) shows the same folder row,
   so the folder can be changed there too, up to **Start**.
5. A `command` from the parent is only `copilot` with arguments. It is validated in the tool and again in main; the
   tool's description says so. Only its arguments are used: they are added after the command the parent itself runs
   (its own command, else the Settings one), so a parent on a machine where Copilot is started by a path or a wrapper
   still gets a working child.
6. A value the parent sent that is not usable (a folder that does not exist, a command that fails validation, an
   unknown tier, an agent or model the parent's session does not offer) does not block the request: the card falls
   back to the default for that field and says what the parent asked for and why it was not taken.
7. The card marks every editable field whose value came from the parent's request, and warns at the command when it
   differs from the parent's own command.
8. When the child's folder differs from its parent's, the parent is told where the child runs.

## Non-goals

- Changing a parameter of an existing session (open, closed, forked, restarted): unchanged.
- A typed path field. The folder comes from the system folder picker (a path can still be pasted in it).
- Nesting a child from another folder under its parent in the sidebar. It is listed in its own folder's group, as an
  adopted session from another folder is today (`nest` in `electron/renderer/session-tree.js` nests in-group only).
- Validating what the user types into the card's command field: the user's own typing stays as free as today.
- Changes to the adopt/release card, or to `+ New session` beyond the folder row.

## Anti-goals

- A child started with a value the user did not see on the card.
- A model-written command that is anything but `copilot` with plain arguments: no other program, no path, no shell
  syntax (`;`, `|`, `&`, `$`, backticks, redirection, quotes, line breaks).
- A card or dialog whose fields can be changed while its start is running.
- A browser `alert`/`confirm` dialog.

## Decisions

- The user: the folder is editable before a session starts, read-only afterwards.
- The user: the parent may send every parameter of the child's session, the command included ("option 2"), and the
  command is validated to `copilot` with arguments; the tool's field description says so.
- The user: the parent's command gives arguments only; they are added to the program the parent runs, not run as a
  program of their own.
- The user: agent and model become selects on the card. Their lists come from the parent's session, because the
  child's own lists exist only once its Copilot runs (section 2).
- Claude's call: the system picker (`dialog.showOpenDialog`) for the folder instead of a text field: it cannot return
  a folder that does not exist, and it is what **+ New session** already uses.
- Claude's call: a parent value that is not usable falls back to the default with a note on the card (goal 6) instead
  of refusing the whole request: the user can still approve, and the parent gets one outcome per request as today.
  The tool itself refuses a command that fails validation (section 4), so the model learns at once and can retry.
- Claude's call: the child's first message keeps `[folder "<parent folder>"]` (`childPrompt` in
  `electron/delegation.mjs`). That line tells the child which folder the paths in its task are relative to, and the
  task was written in the parent's folder. Copilot knows its own working folder.

## Approaches

1. **Request parameters fill the card; the card stays the only way in (chosen).** The parent proposes, the user
   disposes. One control per field, the same approval as today, validation where a value would be run.
2. Request parameters bypass the card when they are all valid. Faster, but a model could then start a process in a
   folder and with a command nobody looked at; it works against the approval the delegation flow is built on.
3. Only the folder is editable (the first version of this spec). Smaller, but it does not give the parent the other
   parameters the user asked for.

## Design

### 1. The tool (`src/mcp.mjs`)

New optional fields in the `create_session` input schema:

| Field | Type | Description in the schema |
|---|---|---|
| `folder` | string | Absolute path of the folder the new session works in. Default: your own folder. |
| `prompt` | string | The new session's own prompt part (instructions added to its system prompt). Default: none. |
| `context` | `"default"` or `"long_context"` | Context window tier. Default: yours. |
| `command` | string | Only the `copilot` command with arguments, e.g. `copilot --foo bar`. The arguments are added to the command your own session runs. Any other program, a path or shell syntax is refused. Default: your own command. |

The descriptions of `agent` and `model` get "The user can change it before approving." so the model does not count on
its value.

The handler validates `command` with the validator of section 4 and, when it fails, returns the reason without
sending a request. The other fields pass through as given. `delegation.requestCreate` (`src/delegation.mjs`) forwards
them in the `session_request` payload; the relay client passes payloads through unchanged
(`extension/copilot-relay/relay-client.mjs`, `onSessionRequest`), so it needs no change.

Length caps (Claude's call): `folder` 4096, `prompt` the cap the own part has in the prompt editor (or 20 000 if it has
none), `command` `COMMAND_MAX`. A longer value is refused by the tool with the reason.

### 2. Main (`electron/main.mjs`)

- `sessionRequested` stores the four values with the request and resolves each into what the card starts with, plus
  a note when the parent's value was not taken:
  - folder: an absolute path naming an existing folder, else the parent's folder (note: "The parent asked for
    <path>, which is not an existing folder.").
  - prompt: the string as given (model-written text, shown in the prompt editor; the user sees and edits it).
  - context: a tier from `normalizeTier` (`electron/context-tier.mjs`), else the parent's tier (note on an unknown
    value).
  - command: passes the validator of section 4 again, else the parent's own command (note with the reason). A
    passing command gives its arguments; the card starts with the parent's command line (`commands.get(parentId)`,
    else the resolved Settings command, as `resolveCommand` gives it) followed by those arguments.
  - agent and model: the lists are the parent's `configOptions` (`findModelOption` and the `agent` option, values as
    `resolveConfig` reads them). A requested value in the list is the start value; one that is not gives the default
    (model: "inherited", which is the parent's current model as today; agent: `""`, the default agent) and a note
    naming the valid values. A parent without an agent option gives an empty list: the card shows "default" and a
    requested agent gets the note "there are no custom agents available".
- `delegation:request` sends these starting values, the agent and model lists, the notes, and which fields came from
  the parent, to the window.
- `delegation:answer` takes the card's folder, tier, agent and model besides `own` and `command`:
  `(requestId, approved, own, command, { cwd, tier, agent, model })`. A string `cwd` is made absolute
  (`path.resolve`); a missing one means the parent's folder. A tier that `normalizeTier` refuses means the parent's
  tier. Non-string agent or model means `""`. All go to `createChild`, which starts the child in that folder with that
  tier instead of `parent.cwd` and `sessionTier(parentSessionId)`, keeps the tier as the child's override
  (`tiers.set`, as today), and calls `resolveConfig` with the card's agent and model instead of the request's.
- The child's own lists can differ from the parent's (another folder can have other custom agents). When
  `resolveConfig` refuses the card's agent or model, the child is discarded as today but the request stays open: the
  result is `{ outcome: "failed", text, retry: true }` with `resolveConfig`'s text (which names the child's valid
  values), the parent is told nothing, and the card takes another answer. This replaces today's `invalid` outcome for
  the parent, because the value is now the user's choice on the card. Claude's call.
- The command from the card is the user's typing and is not validated (non-goal). What the window sends is still the
  only source; nothing from the broker reaches `createChild` directly.
- A folder removed after it was picked: `requireDir` throws inside `createSession`, which `createChild` already
  returns as `{ outcome: "failed", text, retry: true }` (the request stays open, the card shows the text).
- The `created` outcome: when the child's folder differs from the parent's,
  `Session "<name>" was created in the folder "<folder>" and has started on its task. …`; otherwise today's text.
- The resolutions above go into pure helpers in `electron/delegation.mjs` so they are unit-tested without Electron.

### 3. The window (`electron/renderer/app.js`, `electron/preload.cjs`)

- `dialog:pickDir` takes an optional `defaultPath` (used when it names an existing folder);
  `api.pickDir(title, defaultPath)`.
- A folder-row helper: the path as text (full path as `title`) and **Change…**, which calls
  `api.pickDir("Folder for the new session", current)`; a picked folder replaces the shown one, Cancel keeps it. It
  exposes the current value and a way to disable the button.
- **Delegation card** (`delegationCard`):
  - `Folder`: the folder row, starting with main's resolved folder.
  - `Context`: a select (200k / 1M, labels as in `contextOption`), starting with main's resolved tier.
  - `Agent` and `Model`: selects from main's lists, starting with main's resolved values. Model's first entry is
    "inherited (<parent's current model>)" (value `""`); Agent's first is "default" (value `""`). Name and task stay
    as they are today.
  - The prompt editor starts with the parent's `prompt` as its own part (`own`) and the resolved command in its
    command field.
  - A field whose value came from the parent carries a small "from <parent name>" mark. The command field, when its
    starting value differs from the parent's own command, also shows: "Written by the session that asked. It runs
    when you approve."
  - Each note from main is shown under its field.
  - `answer()` disables the folder button and the selects with the other controls while the answer runs, enables
    them again when the card takes another answer (`res.retry`), and sends what the card shows:
    `api.answerDelegation(requestId, approved, own, childCommand, { cwd, tier, agent, model })`. A Reject sends no
    fields.
- **New-session dialog** (`newSession`): the folder row above the editor in `#prompt-body` (or through a new `folder`
  option of `openPromptDialog`, builder's choice). The title becomes "New session". `onOk` starts in the folder shown
  at that moment (the status line and the `SessionView` use it too); the button is disabled while `onOk` runs.
  **+ New session** still opens the picker first; Cancel there still starts nothing.

### 4. The command validator

One pure function, used by the tool (`src/`) and by main (`electron/`). The relay code in `src/` and the app in
`electron/` do not share modules today; the builder either puts it where both can import it or keeps two copies with
one shared test table (builder's choice, the tests must run against both if there are two).

A command passes when, after trimming:

- it is at most `COMMAND_MAX` characters and has no line break or NUL;
- split on runs of spaces, the first word is exactly `copilot`;
- every further word matches `^[A-Za-z0-9_.,:=@/+-]+$` (no quotes, `$`, backticks, `;`, `|`, `&`, `<`, `>`, `(`, `)`,
  `*`, `?`, `~`, `!`, `\`, `%`);
- no word is one the app sets itself: `--acp`, `--stdio`, `--context` or a word starting with `--context=` (the tier
  is the `context` parameter).

`copilot` alone passes (no arguments to add). The result is the list of arguments after `copilot`; main joins them
with single spaces after the parent's command line. The reason of a failure names the rule, e.g. "Only the copilot command is allowed, not
`node`." or "Argument `$(x)` holds a character that is not allowed."

### 5. Tests

- `electron/test/delegation-main.test.mjs`: the folder, tier, command, agent and model resolutions with their notes
  (the command: arguments after the parent's own command, after the Settings command, `copilot` alone); the created
  text (same folder, other folder).
- The retry after `resolveConfig` refuses the card's agent or model: the request stays open, the parent is told
  nothing (a test at the level the existing `createChild` retry tests use; if there are none, a ui-check).
- The validator: a table of passing and failing lines (another program, a path to copilot, each forbidden character,
  the app's own flags, a line break, the length cap), run against every copy.
- The tool: a refused `command` returns the reason and sends no `session_request`; valid fields reach the payload
  (the broker tests that cover `requestCreate`).
- `scripts/ui-check/checks.mjs`: the card shows the folder row, the Context, Agent and Model selects, the parent's
  prompt in the editor, the parent's command line with the added arguments and the warning, the "from" marks and a
  note; its controls are disabled while an answer runs; a child started from a parent-written command runs with the
  added arguments (the scripted agent's command plus them); the new-session dialog shows the folder row. The native picker cannot be driven there: picking a folder and
  starting a child in it is a manual check (Linux and Windows).

## Known limitations

- The validator checks the form of the arguments, not their meaning: a parent can propose any `copilot` flag,
  including ones that widen what the child may do without asking. The card's warning and the user's Approve are the
  guard for that.
- The arguments are added to the parent's whole command line. If that line already holds the same flag, Copilot gets
  it twice; which one wins is Copilot's rule, not the app's. The card shows the whole line, so the user sees it.
- The agent and model lists are the parent's. A child in another folder may offer other agents; that shows only after
  Approve, as the retry text of section 2.

## Left to the builder

- Where the folder row goes in the new-session dialog (section 3) and the CSS of the row, the marks and the notes.
- Where the validator lives (section 4).
- Whether `newSession` keeps its `cwd` argument name.
