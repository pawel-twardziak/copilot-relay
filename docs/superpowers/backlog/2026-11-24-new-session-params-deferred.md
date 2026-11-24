# New session params: deferred findings

Source: the task reviews and re-reviews (opus, high), the final whole-branch review (fable, medium) and the re-review
of its fix wave (opus, high) of `feat/new-session-params`. Spec:
`docs/superpowers/specs/2026-11-24-new-session-params-design.md`, plan:
`docs/superpowers/plans/2026-11-24-new-session-params.md`. None of these blocked the merge. Line numbers were taken
at the review that found them and may drift.

Fixed on the branch, so not listed below: a model-written UNC folder (also with mixed separators `/\host`, `\/host`)
stat'ed before approval (`isRemote` hardened for every caller); a parent command path with spaces losing its quotes
once arguments were appended; a rejected folder pick as an unhandled rejection; a long parent-written command hiding
flags past the edge of the command field (the card now lists the added arguments in full); a folder on a network
mount stat'ed synchronously before approval (`folderState` with the app's `allowAutomatic` rule); notes echoing
model text with line breaks; no length cap on `agent`/`model` in the tool; stale README sentences.

## A. Worth doing first

1. **The "inherited (<model>)" label is a snapshot** (`cardStart` `currentModel` in `electron/delegation.mjs`;
   `createChild` reads `findModelOption(parent.configOptions)?.currentValue` at Approve in `electron/main.mjs`).
   If the parent's model changes between the request and Approve, the child gets a model the card did not show.
   *Proposal:* send the model the card showed (`start.currentModel`) as the inherited value in `fields`, or refresh
   the label when the parent's config changes.
2. **Each Approve refused by the child's lists starts and discards a real Copilot session** (`createChild`, the
   `config.error` branch). The `prompts`, `commands` and `tiers` stores keep entries for the discarded id, and the
   session may stay in Copilot's own list. It used to happen once per request (the old `invalid` outcome); with the
   retry it can repeat. Not checked against real Copilot.
   *Proposal:* forget the discarded id in the three stores in `discard()`, and check on the corp PC whether Copilot
   lists the discarded session.

## B. Window and wording

3. **N_FOLDER_REMOTE says "network location" for a local folder** outside home and the known folders when the
   location table could not be read (no `/proc/self/mountinfo`/`mount`, or the PowerShell CIM query failed or ran
   past 5 s; a null table is cached for 30 s). Conservative (nothing is touched; Change… still works). Wording, e.g.
   "…which is not checked automatically (a network location, or outside the trusted folders while the drive list
   cannot be read)".
4. **The retry text without the editor says "Reject it"** although the folder row and the selects still work
   (`electron/renderer/app.js:2221`). Append the sentence only for a command failure, or reword it.
5. **The retry focus always goes to `.pe-command`** (`app.js:2226`), also after a refused model or a removed folder.
6. **README: the model's fallback is called "default"** although the card labels it "inherited (…)"
   (`electron/README.md:204`, `:218`).
7. **README Permissions bullet** (`electron/README.md:262-264`): uneven rewrap; "inherits" — the card only
   pre-fills the parent's command, and the Settings command (a cleared field) can also allow more.
8. **The card can appear a few seconds after the OS notification** on the first request: `sessionRequested` now
   awaits the location table (up to its 5 s timeout on Windows), and the notification fires before the await.
9. **"Valid models: ." on an empty list** in N_MODEL (`cardStart`) when the parent has no model option at all.

## C. Behaviour, small

10. **`--acp=…`, `--stdio=…` and flag abbreviations pass the validator** (`electron/child-command.mjs`,
    `src/child-command.mjs`); only `--context` gets the `=` form. Unknown whether Copilot accepts `--flag=value` or
    abbreviations for these; worst case a start failure with the retry card. Check against Copilot.
11. **A bad `context` gets the SDK's zod error, not "Not sent: …"** (`src/mcp.mjs`, the enum). N_TIER is reachable
    only from a sender that bypasses the tool.
12. **The command note echoes the word refused by `childCommandArgs` raw** (`cardStart`, `electron/delegation.mjs:124`):
    up to ~4000 characters, tab/`\v`/`\f` kept. Only a non-tool sender reaches it. One line: `echo(parsed.refused)` in
    delegation.mjs (keep `child-command.mjs` identical in both places).
13. **`echo()` keeps `\p{Cf}` bidi controls** (U+202A–202E, U+2066–2069), which reorder how the rest of a note is
    drawn, and `slice(0, 200)` can split a surrogate pair (`electron/delegation.mjs:59`). Replace them too and cut by
    code point.
14. **Main has no length cap on `prompt` or `folder`** (`cardStart`); only the tool caps them. A non-tool
    `session_request` sender only.
15. **`lexicalPath` still uses the old UNC regex** (`electron/paths.mjs:46`, `/^(\\\\|\/\/)/`). No leak (the check
    after `resolve` catches the mixed forms), but inconsistent with `isRemote`; could import it.
16. **On POSIX a path starting with `/\` now counts as remote** (`isRemote`, `/^[\\/]{2}/`). Practically unused.
17. **`createFolderRow` does not coerce a non-string value** (`electron/renderer/folder-row.js`); main always sends
    a string today.

## D. Tests and housekeeping

18. Validator: the length boundary (4000 passes, 4001 fails, padded 4000 passes) and leading/trailing non-space
    whitespace are untested; the byte-identity assert has no message (`electron/test/child-command.test.mjs:33`, `:68`).
19. Tool: the handler wiring (a refused input never reaches `requestCreate`) has no unit test (covered end to end by
    the UI check `child-card-params`); no case with the `command` key absent (`delegation-broker.test.mjs:76`).
20. `cardStart`: folder normalisation (`/work/x/../other`), a bare `copilot` (`from.command` false, no note) and a
    prompt-only request are untested.
21. `sessionRequested`'s re-check after the await (a close, reload or reopen during the folder check gives no card)
    has no automated test; main.mjs is not unit-tested.
22. `child-config-retry`: the "no view came" assert cannot fail (`scripts/ui-check/checks.mjs:724`; line 723 covers
    it). Use `views.size === viewsBefore - 2` or check that no view has `cwd === work`.
23. The N_TIER, N_AGENT, N_MODEL and N_COMMAND notes on the card have no UI check (same code path as N_FOLDER, which
    has one); the `getSettings`-failure fallback of the card is untested.
24. `newSession` reads `row.value()` twice (`app.js` ~2937/2946); keep the started folder from `onOk`.
25. `style.css:259` uses an undefined `var(--mono)` (falls back to `monospace`); use the app's mono stack.
26. The fake DOM in `electron/test/folder-row.test.mjs` is a copy of the one in `prompt-editor.test.mjs`; a shared
    `electron/test/fake-dom.mjs`.
27. The folder button being disabled while the new-session dialog's `onOk` runs is untested.
28. The tier labels on the card are a copy of `LABEL` in `electron/context-tier.mjs` (`app.js:2177`); main could send
    them in `start`.
29. The card's freeze disables the folder button through `querySelectorAll`, not `row.setDisabled` (`app.js:2208`).

## Manual checks still open

- Windows as a whole: the native folder picker (opens at the current folder, Cancel keeps it, a picked folder starts
  the child there), a mapped drive and a fixed drive as a proposed folder, the card layout.
- A real Copilot child started with `copilot <args>` appended to the corp PC's command (also item 10's flags).
- The native folder picker on Linux, and the card layout by eye.
- Real NFS/SMB/autofs mounts as a proposed folder (only the unit test with an injected rule covers them).
- Whether Copilot lists a session discarded after a refused agent/model (item 2).

Not a defect: Approve cannot be clicked while the native picker is open (`dialog.showOpenDialog(win, …)` is modal).
