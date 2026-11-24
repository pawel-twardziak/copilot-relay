# Child command card: deferred findings

Source: the whole-branch review of `feat/child-command-card` (fable, medium) and the notes of the work itself. No plan
of its own: a follow-up to `2026-11-24-session-command-design.md` (updated in this branch), after the first report
from Windows: `--allow-tool 'shell(dotnet:*)'` reached Copilot with the single quotes in it. Three changes: the hint
of a failed start whose command ended by itself, the Windows quoting rule in the command hints, and the Copilot
command field on the card that approves a delegated child. None of these blocked the merge. See also
`2026-11-24-session-command-deferred.md`.

Fixed after the review, so not listed below: on Windows the new hint dropped the pointer to installing Copilot
(a missing program ends `cmd` with an ordinary exit code there; the hint now says "Check that the program is
installed, and its arguments…"); "with the message above" when there is none (now "(see above)"); "Change it on the
card" pointed at a card that is already answered (now "on the next card"); the spec's goal 5 and its "a signal"
clause; the comment of the field's Enter guard.

## A. Worth doing first (analysed below)

1. **A child that fails to start shows "→ Approved" on its card, and the reason only as a relay notice in the
   parent's chat** (`delegationCard`'s `answer` in `electron/renderer/app.js`; `createChild`'s catch and `tellParent`
   in `electron/main.mjs`). Before this branch a child's command could not be mistyped; now a typo on the card ends
   this way, and the card with the typed command is already disabled.
   *Proposal:* let `delegation:answer` return the outcome (`created` / `failed` with its text), and show a failure
   on the card itself, with the command still readable.

## B. Window and wording

2. **A failed child start still quotes the command to the parent's model and the broker** (item 4 of
   `2026-11-24-session-command-deferred.md`). With the card's field the quoted command may be one the user typed on
   the card, with any variable written into it. The owner's decision, as there.
3. **The hint of a stopped command is one text for every cause**: an argument Copilot refuses, a shell error, and
   on Windows a missing program. The app does not read the message to tell them apart (its wording depends on the
   system language).
4. **`cmd` and `sh` quote differently**, and one command line cannot serve both: a session's command written on
   Linux does not carry over to Windows. The hints say so on Windows; nothing converts.

## C. Behaviour, small

5. **Ctrl+Enter in the card's command field does nothing** (as in the card's text area): the card is approved by
   its button only. The field's Enter guard (`createPromptEditor` in `electron/renderer/prompt-editor.js`) has no
   effect there, as the card is not in a form.
6. **A text field on the card can lose the focus to the chat's input while the parent streams**; the card's text
   area behaves the same.
7. **`createChild` returns without a word when the parent is gone** and the card then shows "→ Approved"
   (`electron/main.mjs`). Before this branch; `pendingRequests.dropForParent` makes it nearly unreachable.

## D. Tests and housekeeping

8. **No check for the card's fallback**: when the card's editor cannot be built (Settings unreadable), `answer`
   sends the parent's command from the request's payload (`delegationCard` in `electron/renderer/app.js`).
9. **The `win32` branch of the Settings hint has no check** (`openSettings` in `electron/renderer/app.js`); the unit
   test covers `commandHint` and `WINDOWS_QUOTES` only.
10. **`new-session-start-stopped` returns at once on Windows** and reports ok (`scripts/ui-check/checks.mjs`); the
    UI checks run on Linux only.
11. **The scripted agent tells only the first child of a folder apart** (`uniqueIds` in
    `electron/test/fixtures/acp/scripted-agent.mjs` counts the starts in a file that every session of the folder
    rewrites with its own copy), so a check cannot create two children of one parent. `child-command-card` and
    `child-command-card-empty` are two checks for that reason.

12. **"(a deadline, a signal)" in the doc comment of `startFailureText`** (`electron/copilot-command.mjs`) and
    "(a timeout, a signal)" in its unit test mean a signal that ended the shell itself; the spec now says so, the
    comments do not. Found by the re-review of the fixes (opus, high).

## Not verified

- **Windows:** the new hint texts in the window; that `--allow-tool "shell(dotnet:*)"` with double quotes starts
  Copilot (the report that led here used single quotes); the exit code of `cmd` for a missing program; the card's
  command field.
- **macOS**, and **the real Copilot CLI** on the card's path (the checks use a scripted agent). Run by hand here:
  Copilot 1.0.115 on Linux starts with `--allow-tool 'shell(dotnet:*)' … --acp --stdio` through `sh`, and refuses
  the rule with exactly the reported message when the quotes are part of the value.
