# Communication panel: "queued" / "reading" instead of "awaits reply" (v0.33.1) — deferred findings

The fix replaced the `waiting-reply` edge state ("m:ss awaits reply", which counted until the recipient wrote back)
with `queued` (not delivered, recipient not online) and `reading` (delivered in the recipient's current turn).
"Processed" is inferred from the recipient's busy state and turn start (`busySince`), not from a per-message turn end.

## A. Worth doing first

### A.1 The broker logs no `delivered` for inbox and flushed messages
- Where: `src/registry.mjs` `send` (logs `queued` when `#deliver` returns false), `drain` / `waitForMessages`,
  `#flush`.
- What: an MCP peer's inbox is drained and an offline push peer's backlog is flushed without a status event, so the log
  row of such a message stays `queued` forever. The panel hides it by showing `queued`
  (`electron/renderer/comms-model.js`, the loop after `ranked`) only for a closed app session (in the tree, linked,
  or open in `live`), whose delivery always writes a status; but the log row and the statistics still say queued for
  MCP and terminal peers, and a message to them that really waits shows no clock.
- Proposal: give inbox items an id (the comms event id), and write `comms.status(id, "delivered")` in `drain`,
  `waitForMessages` and `#flush`. Then the panel's `queued` rule could drop the app-session and closed conditions.

## C. Small behaviour

### C.1 The reading clock restarts when the message is taken
- Where: `electron/renderer/comms-model.js` `messagesOf` (`statusAt` = the latest status's time) and the `reading` rule.
- What: a message delivered to a busy app view waits in the view's queue and already shows "reading" from delivery;
  when its turn starts (`taken`) the clock jumps back to 0:00.
- Proposal: show the wait in the view's queue as `queued` (delivered after `busySince` and not yet taken), and
  count `reading` from `taken`.

### C.2 A held child reply can show "reading"
- Where: same rule; held counts are per recipient and kind (`heldByKind`), not per message.
- What: a reply held for the user's approval is delivered but not taken; while the parent is busy with something else
  the edge says "recipient is processing it". The held badge on the node is correct.
- Proposal: the broker's held list carries message ids; skip `reading` for an id that is still held.

### C.3 "reading" while the message only waits in the turn
- Where: `comms-model.js` `reading` rule; `app.js` `setBusy(true)` while a session opens (~3083).
- What: a message pushed as `delivered` while the recipient is busy with another turn (the app queue with
  queueMidTurn off), or delivered while the session opens (early queue), shows "reading" for that whole turn.
- Proposal: with C.1, treat delivered-and-not-taken in an open view as `queued`.

### C.4 The 5 s turn slack can carry a message into the next turn
- Where: `comms-model.js` `TURN_SLACK`.
- What: a message read mid-turn A, delivered less than 5 s before A ended, shows "reading" again if turn B starts
  within the rest of those 5 s. Rare; accepted.

## D. Tests and housekeeping
- The edge colour for `reading` (blue, moving, `comms-view.js` arrow kind and `style.css`) is covered only by the UI
  checks' general rendering, not by an assertion.
- Not checked by hand: a real Copilot tree (here and on the corp PC), Windows/macOS.
