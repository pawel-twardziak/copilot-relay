# Child card retry: deferred findings

Source: the whole-branch review of `feat/child-card-retry` and the notes of the work itself. No plan of its own: item
A.1 of `2026-11-24-child-command-card-deferred.md`, asked by the owner with "the command can be corrected and tried
again". Design: `2026-11-24-session-command-design.md`, section 4 (updated in this branch). A child whose Copilot
does not start now leaves its approval card open with the reason; the request stays pending in the main process
(`delegation:answer`, `createChild` in `electron/main.mjs`; `delegationCard` in `electron/renderer/app.js`) and the
parent is told nothing until the card is approved or rejected. None of these blocked the merge.

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
   written (`createSession` in `electron/main.mjs`). Trying again is harmless in each, and Reject ends it.

## C. Behaviour, small

4. **A parent that is closed while its card is open after a failed start**: the request is dropped with it
   (`pendingRequests.dropForParent`), and a later click on the card answers "This request is no longer open."
5. **A second card for the same parent is independent**: each request is taken while it is answered, so a double
   click on Approve cannot start two children; two cards can be answered at the same time.

## D. Tests and housekeeping

6. **No check for "Not created: …"** (a failure after the child's Copilot started): the scripted agent's
   `create_session` sends only a name and a task, so an agent or model the session does not offer cannot be asked
   for in a UI check (`electron/test/fixtures/acp/scripted-agent.mjs`).
7. **No check for a parent that goes away during the child's start** (`retry` is then false: `createChild`'s inner
   catch compares the parent's entry).
8. **The outcome's shape (`{ outcome, text, retry }`) is tested only through the UI checks** `child-card-retry` and
   `child-card-retry-reject`; `createChild` lives in `electron/main.mjs`, which `node --test` cannot load.

## Not verified

- **Windows and macOS**, and **the real Copilot CLI** (the checks use a scripted agent): a mistyped command on the
  card, the error text there, a second Approve.
