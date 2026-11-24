# Child card retry: deferred findings

Source: the whole-branch review of `feat/child-card-retry` (fable, medium), the re-review of its fixes, and the notes
of the work itself. No plan of its own: item A.1 of `2026-11-24-child-command-card-deferred.md`, asked by the owner
with "the command can be corrected and tried again". Design: `2026-11-24-session-command-design.md`, section 4
(updated in this branch). A child whose Copilot does not start now leaves its approval card open with the reason;
the request stays pending in the main process (`delegation:answer`, `createChild` in `electron/main.mjs`;
`delegationCard` in `electron/renderer/app.js`) and the parent is told nothing until the card is approved or
rejected. None of these blocked the merge.

Fixed after the review, so not listed below: a window reload during a start that then failed left a pending request
without a card (the request now ends and the parent is told, without the command; `windowReloads`); a parent
restarted during the start was told nothing and its ended card said "approve again" (it is told now, in words of
its own); a card that could not load its editor said "change it on the card" with no field there (it says so now);
the focus was lost after a failed start (it goes to the command field); the error text could overflow the card; the
check looked for a notice to the parent too early.

## A. Worth doing first

Nothing.

## B. Window and wording

1. **The parent's model waits without a word while the card is open after a failed start.** By design: it is the
   state of a card nobody has answered yet. A parent that asked with `create_session` got "the user was asked" at
   once and keeps working; it learns the outcome only when the card is approved (created) or rejected.
2. **"Not created: …" on the card for a failure after the child's Copilot started** (an agent or model it does not
   offer, no connection to the broker, a setup deadline): the request is over and the parent has been told. The
   card does not offer another try there; the parent's model asks again.
3. **Every failure before the child exists counts as "can be tried again"**, not only a command that does not
   start: a folder that is gone, a `session/new` that Copilot did not answer in time, a store that could not be
   written (`createSession` in `electron/main.mjs`). Trying again is harmless for the first two. For a store that
   could not be written it is not quite: `session/new` has succeeded by then, so each try makes one more Copilot
   session that nothing points at, and a failed `commands.set` after `prompts.set` leaves a prompt row for it (item
   13 of `2026-11-24-session-command-deferred.md`). The card now invites repeating it; Reject ends it.
4. **A card that could not load its editor cannot change the command**: after a failed start it says so and asks
   for a Reject. Approve is still there and sends the parent's command again (which may work after a deadline).

## C. Behaviour, small

5. **A parent that is closed while its card is open after a failed start**: the request is dropped with it
   (`pendingRequests.dropForParent`), and a later click on the card answers "This request is no longer open."
6. **A second card for the same parent is independent**: each request is taken while it is answered, so a double
   click on Approve cannot start two children; two cards can be answered at the same time.
7. **A reload that does not go through `confirmedReload`** is not counted in `windowReloads`, and a start that
   failed across it leaves a pending request without a card again. The app has one such way: the View menu opens
   DevTools, and a reload from there (Ctrl+R with DevTools focused, `location.reload()` in its console) goes
   around `confirmedReload`. A developer's path. Found by the re-review of the fixes (opus, high), which also found
   that the reload was counted only after the children were closed (fixed: it is counted as soon as the reload is
   certain).
8. **A reload during a child's start shows no warning**: the request is taken while it is answered, so
   `confirmedReload` does not count it (`pendingRequests.size`). The start's outcome is still handled (item 7's
   counter); only the question before the reload is missing. As before this branch.
9. **The text a restarted parent's model gets** reads 'Session "X" was not created: the session that asked for it
   was closed or restarted…', and the parent is that session. It holds no command; the wording is a little odd.
10. **Reject before the card's editor has loaded** leaves the later-loaded editor enabled on an ended card. As
   before this branch.

## D. Tests and housekeeping

11. **No check for "Not created: …"** (a failure after the child's Copilot started): the scripted agent's
   `create_session` sends only a name and a task, so an agent or model the session does not offer cannot be asked
   for in a UI check (`electron/test/fixtures/acp/scripted-agent.mjs`).
12. **No check for a parent that goes away or is restarted during the child's start**, nor for a window reload
    during it (`createChild`'s inner catch; `windowReloads` in `delegation:answer`). Both need a start that hangs
    until something else happens.
13. **No check that the parent's "!" mark in the list goes and comes back** with the card; `child-card-retry`
    checks `openCards.size` only.
14. **No check for the card without an editor** (Settings unreadable) after a failed start.
15. **The outcome's shape (`{ outcome, text, retry }`) is tested only through the UI checks** `child-card-retry` and
    `child-card-retry-reject`; `createChild` lives in `electron/main.mjs`, which `node --test` cannot load.

16. **`confirmedReload` is not run by any check**: the UI checks reload through the driver (`app.reload()` in
    `scripts/ui-check/driver.mjs`), not through the app's menu, so the `windowReloads` counter is covered by
    reading only.

## Not verified

- **Windows and macOS**, and **the real Copilot CLI** (the checks use a scripted agent): a mistyped command on the
  card, the error text there, a second Approve.
