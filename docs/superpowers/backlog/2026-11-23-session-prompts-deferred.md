# Session prompts: deferred findings

Source: the seven task reviews of `feat/session-prompts` (opus, high) and the scripted real-Copilot run of Task 7.
Spec: `docs/superpowers/specs/2026-11-23-session-prompts-design.md`. Plan:
`docs/superpowers/plans/2026-11-23-session-prompts.md`. None of these blocked the merge. Each item names its file and symbol;
line numbers are given where they were checked at the final review (branch head `1a36150`) and may drift.

## A. Worth doing first (analysed below)

1. **A pending own part is lost when `setPrompt` throws** (Task 6). In the Prompt dialog's `editPrompt` `onOk`
   (`electron/renderer/app.js`, `editPrompt` l.2334, `onOk` l.2346, the Save and restart path), a thrown `setPrompt` (`prompts.set` fails on disk; the session
   is not closed) closes the dialog and the typed text is gone.
   *Proposal:* catch it in `onOk` and return the error text, as the refusal path does, so the dialog stays open with
   the text.
2. **`createSession`: `prompts.set` failing after `session/new` leaves a Copilot session that is not attached**
   (Task 2, `electron/main.mjs`). Rare disk error; the session exists in Copilot's history but not in the app.
   *Proposal:* write the own part before `session/new` under a provisional key, or close/delete the session in the
   catch.
3. **`will-quit` waits 3.5 s for connections that are still in `connect()` and that nobody killed** (Task 2,
   `electron/main.mjs`).
   *Proposal:* kill them before waiting.
4. **A prompt-folder leftover that cannot be removed stops `clearPromptDirs`** (Task 1 and 2,
   `electron/session-prompts.mjs`). **Fixed in the final fix wave** for `clearPromptDirs`: a try/catch with
   `console.warn` per entry, so one locked folder no longer stops the rest. Still open: `writePromptDir` leaves its
   folder when the file write fails (cleared at the next start).
5. **Children adopted before v0.23.0 owe a report from v0.23.0 on** (spec, Known limitations). One that ends without
   reporting gets its parent the "ended without reporting" notice though it was never told to report; only the
   child part at its next start tells it; it never got the new adoption note.
   *Proposal:* none (accepted). A one-time note to such children at the first start after the update would close it.

## B. Window and wording

6. An adopted child learns the rule from the broker's note until its next process start; the note does not wake it,
   so it reads it with the next message it gets (spec, Known limitations).
7. A child whose link is not in the app's snapshot when it is reopened (broker down, empty cache) starts without
   the child part; it gets it at the next start that knows the link (spec).
8. Settings changes reach a running session only at its next start; a change takes a restart: no turn running, and
   the session's subagents and shell commands stop (spec).
9. The `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` variable is in the session's Copilot environment, which Copilot passes to
   the agent's shell commands: a `copilot` started from inside a session's shell reads the same folder while that
   session's process lives. Accepted (spec, author's call).
10. Whether Copilot reads the instructions at process start or at `session/new` / `session/load` was not separated;
    both orders are covered because the folder exists before the process starts and lives as long as it (spec).
    The scripted run below showed it is followed on `session/new` and on `session/load` after a restart.
11. Template names: an empty name gives a blank option; "Template N" can repeat after a delete (Task 6, Settings
    templates list: `electron/renderer/app.js`, `templateRow` l.3542 / `#set-template-add` handler l.3565).
12. Scripted agent comments (Task 3, `electron/test/fixtures/acp/scripted-agent.mjs`): the `uniqueIds` header
    comment says the suffix counts all starts (including `session/load`), not only `session/new`; the `REMINDER`
    doc comment says the child part "also says" it, while `CHILD_PART` says the same in other words.

13a. `#set-command` and `#set-broker-repo` (single-line inputs in `#settings`, `electron/renderer/index.html`): Enter
    submits the form through its first button (Cancel) and discards the whole Settings visit. Pre-existing; the
    template name input was fixed in the final fix wave (`templateRow` keydown), these two were left.
    Not verified: the `#set-relay` and `#set-queue` checkboxes in the same form may submit it on Enter as well
    (Chromium's implicit submission); check with the UI-check driver's `pressEnter()`. Final re-review, Minor.

## C. Behaviour, small

13. `settings:set` stores prompt keys only as strings (done in Task 6 as `applyPromptSettings`); a Settings save of a
    child part identical to `childPartDefault` is stored as a string, not `null`, so a later change of the built-in
    text does not reach it (Task 6, Settings form).
14. The re-pick of the template shown in the editor fires no `change`, so a template cannot be re-applied after
    editing the text (Task 5, `createPromptEditor`). Idea: a "re-apply" button.
15. `newSession` guards only before the folder pick: a dialog opened meanwhile drops the pick silently (Task 5,
    `electron/renderer/app.js`, `newSession` l.2813).
16. `delegationCard`: Reject before `getSettings` resolves puts a fresh enabled editor on the answered card (cosmetic,
    Task 6). Settings parts on a card/dialog are read once, at open; Approve is disabled until the settings loaded.
17. The late `close` handling fixed in `openPromptDialog` may affect the `#settings` and `#delete-tree` dialogs too
    (Task 6).
18. `createPromptStore.copy()` with a missing source removes the target's entry (Task 1; untested). `get()` reads the
    file twice.
19. `writePromptDir`: the app's data folder with a comma in its path makes `instructionsEnv` throw; the start fails
    with a message (by design, untested on a real path with a comma). Because the built-in child part is never
    empty, a comma in the userData path blocks every child start, not only sessions with an own part
    (`electron/session-prompts.mjs`, `instructionsEnv` l.119).
26. A running broker keeps the old adopted-child rule until it is restarted (`src/delegation.mjs`, `died` l.520 and
    the `LINK` texts); the README now says to restart the broker after an update.
27. Text typed on a child's approval card is lost when the parent's view is rebuilt (`electron/renderer/app.js`,
    `delegationCard` l.2094).

## D. Tests and housekeeping

20. Test gaps: `CHILD_PART` test checks only the first and last words (Task 1); no test for the failed-start folder
    removal (ENOENT, deadline) nor for a Settings-form save keeping the prompt keys (Task 2); no test that Reject
    ignores `own` or that a non-string `own` is coerced (Task 3); the broker unit test checks only fragments of
    `LINKED_CHILD` / `LINKED_PARENT`, the full strings only in the UI check (Task 4); the `new-session-prompt` check
    re-picks the shown template with a hand-dispatched `change` (pick a second template instead), and misses the
    Replace button, Start with a pending question, emptying to "— none —", and the select going back after Keep
    (Task 5); `settings-prompts` asserts right after `save()` without waiting for the async close handler, and does
    not check that the id is kept across a rename after save; `session-prompt-edit` step 3 starts a turn via Enter
    behind a modal (an unreachable gesture) (Task 6).
21. The scripted agent: parent and child share one `.scripted-agent.json` (last writer wins); the child-prompt check
    waits on "Do-it", which the parent's prompt also holds. *Proposal:* wait on `REMINDER`, or key the file by
    session id (Task 3).
22. TDD order: Task 3's unit test was confirmed RED only after the implementation, and there was no separate RED run
    for `applyPromptSettings` (Task 6), and the `child-prompt` UI check had no RED run.
23. Task 4 and 5: the Task 4 UI run captured only the tail (accepted, Task 5 ran all UI checks again).
24. **Manual checks still open (user):**
    - The GUI pass on Linux: the Prompt dialog on a new session, "Save and restart" on a running session (history
      kept), the child card's editor, the Settings section (parts, templates), and **Esc on the real `<dialog>`**,
      including while `onOk` runs. A synthetic keydown cannot trigger the native cancel, so the UI checks do not
      cover it (Tasks 5 and 6).
    - Windows: not run (the prompt folder, the removal of a locked folder, `copilot.cmd` with the variable). Also
      `instructionsEnv` (`electron/session-prompts.mjs`): `{ ...process.env }` loses Windows' case-insensitive key
      lookup; Node keeps the upper-case key, so it should work, but it was not run.
    - The corp PC: not run.
25. **Scripted run on real Copilot (Task 7, Linux, GitHub Copilot CLI 1.0.115-7).** Not the GUI: a throwaway script
    drove `copilot --acp --stdio` through the app's `AcpConnection`, with `composePrompt`, `writePromptDir` and
    `instructionsEnv` from `electron/session-prompts.mjs`. Own part `End every reply with the word PINEAPPLE.`:
    the reply to a `session/prompt` ended with `PINEAPPLE`. The process was killed, a new folder written with
    `End every reply with the word MANGO.`, a new process started and the same session loaded with `session/load`:
    the next reply ended with `MANGO`. The folder was gone after `remove()` both times. History retention after `session/load` was not asserted (the load
    succeeded). `copilot sessions` has no
    delete, so the scratch session was left in Copilot's store: `dae14e34-0cd2-46ea-85d2-96ebeba20999`
    (`~/.copilot/session-state/`; the app's delete or a manual removal clears it). Not run: Windows, the corp PC,
    the app's GUI.

<!-- Final re-review cosmetics left as they are: 13a sits in B while C starts at 13; C26/C27 follow D in number; A1's `editPrompt` line is one off. -->
