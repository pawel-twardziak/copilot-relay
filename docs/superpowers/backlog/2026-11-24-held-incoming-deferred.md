# Held incoming messages: deferred findings

Source: the six task reviews, the whole-branch review of `feat/held-incoming` and its fix wave.
Spec: `docs/superpowers/specs/2026-11-24-held-incoming-design.md`. None of these blocked the merge. Fixed on the branch
and therefore not open: the delete's discard message counts held typed messages (`SessionView.unsentCount`), the README
sentence on a switched-off kind, and the final fix wave (the README passages that still described the old default, the
`unsentCount` comment, the name of the mark test). Line numbers are left out; the symbol is given instead.

## A. Worth doing first (analysed below)

1. **Queued relay items "discarded" with a dead view are neither acknowledged nor un-seen.** `reopenView`
   (`electron/renderer/app.js`, the line `N queued message(s) waiting for this session were discarded.`) and the
   `res.stuck` branch of `deleteOne` drop the queue of a view that came back dead. A relay item in it (an approved held
   message, or one of a switched-off kind) keeps its id in the handed-over `seenDeliveries` and is not acknowledged. A
   redelivery in that window is dropped silently; after an app restart the message returns: held if its switch is on,
   run without an approval if it is off. The mechanism is older than this branch (child replies, notices); the branch
   widens it to every message between sessions and from the relay GUI.
   *Proposal:* acknowledge the dropped relay items as `removeQueued` does, or remove their ids from `seenDeliveries` and
   say that they will come back.
2. **A lost ack is never repeated, now for every kind** (A1 of `2026-11-23-held-child-replies-deferred.md`:
   `RelayClient.ack` swallows errors, `relay:ack` answers true). Before this branch only reports, child messages and
   notices were durable; now every agent message and relay-GUI message to an app session is. With a switch off, or with
   an app of v0.22 to v0.24 against the new broker, a lost ack means the message runs again after an app restart.
   *Proposal:* as in A1 there (acknowledge again when a seen id is redelivered and is no longer held, queued or
   starting); do it before the next feature that adds durable messages.
3. **An orphan outbox item in the 30 seconds after an in-app delete.** `forgetDeleted` makes the broker drop the
   deleted session's items (`Delegation.forget`), but its peer stays in the registry as offline for the grace period,
   with `app: true`. A `send_message` to it in that window is taken over by `Delegation.appMessage` (`Registry.send`,
   `src/registry.mjs`): the sender is told "queued (recipient briefly offline)", the item is never delivered and never
   forgotten, and it stays in `delegations.json` and `heldByKind`. Before the branch it went to the in-memory inbox and
   vanished with the peer.
   *Proposal:* `Delegation.forget` also removes the registry peer (or `appMessage` refuses a key the store has just
   forgotten).
4. **Outbox items of a session without a link that was deleted outside the app** (in a terminal, by Copilot's cleanup)
   stay in `delegations.json` and in `heldByKind` (spec, Known limitations). `pruneMissing`
   (`electron/renderer/app.js`) reports only linked sessions (`SessionTree.pruneCandidates`).
   *Proposal:* let the broker list the recipient keys that have outbox items (they are in `heldByKind` already, except
   kind `user`) and let `pruneMissing` report those too; or drop items for a key that has no peer and no link after N
   days.
5. **A2, A3 and A4 of `2026-11-23-held-child-replies-deferred.md` now apply to the new kinds.** A2: a view that died
   after it was opened shows no sidebar mark (`HeldReplies.sidebarCount` prefers the view). A3: items for a recipient
   that is not an app session any more are counted; a session first opened in the app and later resumed in a terminal
   gets its stored items unheld. A4: `Registry.send` says "delivered" when only the store has the message; this now
   covers every message to an app session, not only a child's.

## B. Window, wording

6. **The switch shows the old state for a moment.** `renderHoldSwitches` (`electron/renderer/app.js`) sets `checked`
   from `holdOn` on every render and is also called from `renderRelations`; a re-render while `api.setHoldReplies` is
   pending flips the box back until the write finishes. Track the pending kind and skip it.
7. **Send is enabled but does nothing for a short time.** `chainEnded` (`electron/renderer/app.js`): after a command
   prompt the chain is no longer active while the view is still busy; with `queueMidTurn` off and "My messages while
   busy" on, Send stays enabled and a press returns silently (the text stays in the box). Call `updateSendBtn` when the
   chain ends.
8. **`listTitle` and `discardLine` give "undefined …" for an unknown kind** (`electron/renderer/held-replies.js`). No
   caller passes one today. Fall back to the child wording or throw.
9. **The switch tooltips (`HOLD_TITLES`) live in `electron/renderer/app.js`**, the other held wording in
   `HeldReplies`. A `switchTitle(kind)` next to `switchLabel` keeps it in one module.
10. **The sender is not told when its held message is discarded** (✕) or dropped by a delete. The spec is silent; a
    child's reply behaves the same since v0.22.
11. **For the release notes of v0.26.0:** messages typed during a turn now wait for Approve by default, also for users
    of "Deliver queued messages during a turn"; the switches are per chat and there is no global default; the broker
    must be updated ("Update and restart broker").
12. **README wording left by the fix wave** (its re-review). `electron/README.md`: two lines of about 168 columns (the
    Queue bullet, "relay messages are held too …"; "Messages to a closed relative", "… delivers every queued message
    (an order …"); "an approved message becomes a new turn as soon as the session is idle" leaves out the mid-turn
    delivery with "Deliver queued messages during a turn"; "like a message you typed while it was busy" fits only when
    "My messages while busy" is off. Root `README.md`: a short, unwrapped line in the held paragraph ("… the first
    task of a").

## C. Small behaviour

13. **Approving a relay-GUI message refills the budgets a second time.** Its prompt goes out with the source `human`
    (`itemPrompt` in `electron/renderer/app.js`, the budget refill in `electron/main.mjs`), after the broker already
    refilled when it was sent (`Registry.sendFromUser`). Spec section 4 says approving refills nothing. An unheld queued
    GUI message always did the same.
14. **`hold()` stores `human` as `m.human === true`**, the not-held path of `incoming` uses
    `m.human ?? m.from === "user"` (`electron/renderer/app.js`). Harmless while the broker sets `human` on every `user`
    item (`Delegation.userMessage`).
15. **A relay-GUI message between a window reload and the view's re-creation** reaches the `early` buffer
    (`electron/renderer/app.js`), is enqueued instead of held, and its later replay is dropped as seen. A narrow window;
    not analysed further.
16. **A relay-GUI message sent to an app session that is offline** is first delivered by `Delegation.attached` and
    carries `redelivered`, so it is held although it never waited before (stated in the spec, section 1).
17. **`#changed()` fires for `user` items** (`Delegation.userMessage`, `src/delegation.mjs`) although they are never
    counted: one `links_changed` per relay-GUI message (debounced in `server.mjs`).
18. **`Delegation.ack` scans the outbox three times** (`pending` twice, `heldItems().includes`). A store predicate
    `isHeld(item)` used by `heldItems()` and `ack` keeps the rule in one place (T1-m1 of the earlier backlog asked for
    the same).
19. **The outbox file is rewritten for every stored message and every ack** (`DelegationStore.#save`, pretty-printed).
    The budgets bound it; with A1 to A4 above it is where growth would show.
20. **Small things:** the mark in `Delegation.appMessage` is one long nested ternary; `held:set` checks the kind in the
    IPC handler and again in `createHoldStore.set`; `KINDS` and `SWITCH_KINDS` (`held-replies.js`) are not frozen;
    `loadHoldSwitch` calls `updateSendBtn` inside its loop over kinds.

## D. Tests and housekeeping

21. **Broker tests** (`electron/test/delegation-broker.test.mjs`): the `heldByKind` test has no awaiting item (its
    title says "without … awaiting"); nothing asserts that acknowledging a `user` item or a notice fires no change.
22. **Main process** (`electron/main.mjs` cannot be imported in a test): no test drives the replay with
    `replayed: true`, a broker restart for the new kinds, or the notifications for `parent` and `other`. The fork /
    delete test of the switch store (`held-replies-main.test.mjs`) turns only `child` and `other` off.
23. **Stale child-only wording:** the comment on the hold switch in `electron/preload.cjs`, line 1 of
    `electron/test/held-replies-main.test.mjs`, the doc of `fetchLinkState` in
    `extension/copilot-relay/relay-client.mjs` (no `heldByKind`), the header of `electron/test/held-replies.test.mjs`,
    a test name in `message-queue.test.mjs` ("held replies"), `style.css` (`replies from sub-sessions waiting for
    approval`), `app.js` ("replies handed over from the view this one replaces"), the comment on the held item's shape
    in `SessionView` (no `typed`, `command`).
24. **Rule tests** (`electron/test/held-replies.test.mjs`): no case for `approvedPrompt` with the default kind under
    the threshold, `kindOf(null)`, or `sidebarCount` with an empty by-kind entry.
25. **UI check `held-kinds`:** step 2 does not assert the prompt was `P-task`; step 4 does not re-check the user
    group; nothing checks that the `other` switch is hidden with the relay off, or `loadHoldSwitch`'s per-kind
    release; step 2 depends on the scripted agent's prompt order (a changed scenario fails later, at
    `Your messages (1)`).
26. **UI checks `held-typed` / `held-typed-queue` / `held-typed-delete`:** the refusal step sends `/rename` only, not
    an agent command; the singular `1 message waiting for approval` is not asserted; step 3 asserts the bubble, not the
    prompt sent; `held-typed-delete` does not assert `queue.length === 0` and `typed: true` before the delete; the
    `res.stuck` branch of `deleteOne` has no check (the harness cannot produce main's `stuck` result).
27. **UI check `held-kinds-e2e`:** the header comment says the second prompt waits (it is the third, `prompts[2]`);
    `window.__deleted` is never awaited, so a rejected delete shows only as a timeout. The header line of
    `electron/test/fixtures/acp/scripted-agent.mjs` is about 170 columns wide.
28. **Process:** the Task 1 implementer wrote the code before the tests (the failing run was produced by reverting).

## Known limitations and open manual checks

- From the spec: the sidebar count for a session without a view comes from the broker, ignores the switches and never
  includes `user`; typed held messages are lost with the window (reload, close, crash), and the reload / quit dialog
  does not count them; outbox items stored before the upgrade carry no mark and are not held (a one-time gap).
- A v0.22 to v0.24 app against the new broker was checked by reading the code only. A downgrade reads an object entry
  of `held-replies.json` as "on" for `child`.
- After a window reload during a running turn the new view does not know that a turn runs (`prompting` is false), so a
  typed or relay-GUI message is not held then. Older than this branch.
- Task 7 of the plan with real Copilot is open: a parent's follow-up is held in the child and Approve starts it; a new
  sub-session starts on its first task without an approval; two unrelated sessions message each other (held on both
  sides); a message typed during a turn waits, stays after the turn and runs after Approve, and the same from the relay
  GUI; a real window reload (Ctrl+R) with a held order; the four switches in a narrow window.
- Not checked: the desktop notifications for `parent` and `other` with the window unfocused; Windows and the packaged
  build; the look of the lists and the switch row at narrow widths.
- The last full run of the UI checks was at `18977fe`; the commits after it change documentation, one comment and one
  test.
