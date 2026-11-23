# Session prompts: deferred findings

Source: the seven task reviews of `feat/session-prompts` (opus, high) and the scripted real-Copilot run of Task 7.
Spec: `docs/superpowers/specs/2026-11-23-session-prompts-design.md`. Plan:
`docs/superpowers/plans/2026-11-23-session-prompts.md`. None of these blocked the merge. Line numbers are left out on
purpose; the symbol or test name is given instead.

## A. Worth doing first (analysed below)

1. **A pending own part is lost when `setPrompt` throws** (Task 6). In the Prompt dialog's `editPrompt` `onOk`
   (`electron/renderer/`, the Save and restart path), a thrown `setPrompt` (`prompts.set` fails on disk; the session
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
   `electron/session-prompts.mjs`): one `rmSync` failure (a locked folder on Windows) aborts the loop, so later
   leftovers stay until the next start; `writePromptDir` also leaves its folder when the file write fails. Both are
   cleared at the next start, but only if the first one is not locked again.
   *Proposal:* a try/catch per entry in `clearPromptDirs`, and remove the folder in `writePromptDir` when the write
   throws. The app's call at start-up must stay wrapped.
5. **Children adopted before v0.23.0 owe a report from v0.23.0 on** (spec, Known limitations). One that ends without
   reporting gets its parent the "ended without reporting" notice though it was never told to report; only the
   child part at its next start and the adoption note tell it.
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
    templates list in `electron/renderer/`).
12. Scripted agent comments (Task 3, `electron/test/fixtures/acp/scripted-agent.mjs`): the `uniqueIds` header
    comment says the suffix counts all starts (including `session/load`), not only `session/new`; the `REMINDER`
    doc comment says the child part "also says" it, while `CHILD_PART` says the same in other words.

## C. Behaviour, small

13. `settings:set` stores prompt keys only as strings (done in Task 6 as `applyPromptSettings`); a Settings save of a
    child part identical to `childPartDefault` is stored as a string, not `null`, so a later change of the built-in
    text does not reach it (Task 6, Settings form).
14. The re-pick of the template shown in the editor fires no `change`, so a template cannot be re-applied after
    editing the text (Task 5, `createPromptEditor`). Idea: a "re-apply" button.
15. `newSession` guards only before the folder pick: a dialog opened meanwhile drops the pick silently (Task 5,
    `electron/renderer/`).
16. `delegationCard`: Reject before `getSettings` resolves puts a fresh enabled editor on the answered card (cosmetic,
    Task 6). Settings parts on a card/dialog are read once, at open; Approve is disabled until the settings loaded.
17. The late `close` handling fixed in `openPromptDialog` may affect the `#settings` and `#delete-tree` dialogs too
    (Task 6).
18. `createPromptStore.copy()` with a missing source removes the target's entry (Task 1; untested). `get()` reads the
    file twice.
19. `writePromptDir`: the app's data folder with a comma in its path makes `instructionsEnv` throw; the start fails
    with a message (by design, untested on a real path with a comma).

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
    for `applyPromptSettings` (Task 6).
23. Task 4 and 5: the Task 4 UI run captured only the tail (accepted, Task 5 ran all UI checks again).
24. **Manual checks still open (user):**
    - The GUI pass on Linux: the Prompt dialog on a new session, "Save and restart" on a running session (history
      kept), the child card's editor, the Settings section (parts, templates), and **Esc on the real `<dialog>`**,
      including while `onOk` runs. A synthetic keydown cannot trigger the native cancel, so the UI checks do not
      cover it (Tasks 5 and 6).
    - Windows: not run (the prompt folder, the removal of a locked folder, `copilot.cmd` with the variable).
    - The corp PC: not run.
25. **Scripted run on real Copilot (Task 7, Linux, GitHub Copilot CLI 1.0.115-7).** Not the GUI: a throwaway script
    drove `copilot --acp --stdio` through the app's `AcpConnection`, with `composePrompt`, `writePromptDir` and
    `instructionsEnv` from `electron/session-prompts.mjs`. Own part `End every reply with the word PINEAPPLE.`:
    the reply to a `session/prompt` ended with `PINEAPPLE`. The process was killed, a new folder written with
    `End every reply with the word MANGO.`, a new process started and the same session loaded with `session/load`:
    the next reply ended with `MANGO`. The folder was gone after `remove()` both times. `copilot sessions` has no
    delete, so the scratch session was left in Copilot's store: `dae14e34-0cd2-46ea-85d2-96ebeba20999`
    (`~/.copilot/session-state/`; the app's delete or a manual removal clears it). Not run: Windows, the corp PC,
    the app's GUI.
