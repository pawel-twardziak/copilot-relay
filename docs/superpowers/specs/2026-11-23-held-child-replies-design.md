# Spec: Held replies from sub-sessions (approve one by one)

Extends `2026-11-08-delegated-sessions-design.md`, `2026-11-20-subsession-tree-design.md`,
`2026-11-23-link-sessions-design.md` and the message queue (`electron/renderer/message-queue.js`). Where the documents
disagree, this one wins.

## Intent

A parent with many sub-sessions gets their replies as prompts, one turn after the other, without the user in between.
When several children finish close together, their replies land on the parent at once: the parent works through a
burst the user did not choose, in an order the user did not choose.

The user wants every reply from a direct child to wait until they approve it. The parent receives one reply at a
time, when the user says so. Each chat has a switch that turns this off, and then a child's reply arrives as it does
today. The switch is on by default.

## Goals

1. A message from a direct child of a session (its `report_result` and its `send_message` to the parent) does not
   become a prompt of the parent by itself. It waits in a list of its own in the parent's view, oldest on top.
2. The user approves one waiting message at a time (any of them, in any order). An approved message joins the end of
   today's queue and from there is delivered exactly as today (`queueMidTurn` decides when).
3. The user can discard a waiting message (✕). It is not delivered and the broker does not send it again.
4. Each session has a switch, "Approve replies from sub-sessions", on by default. Off: a child's message goes straight
   to the queue, as today. Turning it off moves everything waiting into the queue, oldest first.
5. A waiting message survives a window reload, a view rebuild (edit, fork, delete of a message), an app restart and a
   broker restart, until it is approved and has started, or discarded.
6. The user notices waiting messages in every parent in the sidebar: one they are not looking at, one open in the
   app but without a view yet (after a window reload or an app start), and one that is closed.

## Non-goals

- Holding messages from anyone else: the session's parent, sessions that are not relatives, the relay GUI ("user"),
  and the broker's own notices (`from: "relay"`: "ended without reporting", link and reopen outcomes, "not
  delivered"). They go to the queue as today.
- Holding messages from grandchildren. Only direct children are held.
- An "approve all" button. Approving everything at once brings back the burst this feature exists to stop.
- Changing `queueMidTurn`, the queue, its pause on Stop, take-back (Up) or the answer-then-continue flow.
- Holding in parents that are not desktop-app sessions (terminal extension, MCP peers): they behave as today.
- Editing a waiting message before approving it.

## Anti-goals

- A held message is lost: dropped by a reload, a restart or a release, without the user discarding it.
- A held message is delivered without an approval while the switch is on.
- A held message blocks the queue: the user's own messages, or messages from others, wait behind it.
- An interrupted task never continues because the queue logic counts a held message as deliverable.
- A message is delivered twice (once from the waiting list, once from a redelivery).

## Decisions (made with the user)

| Topic | Decision |
|---|---|
| What is held | Only messages from direct children: `report_result` and `send_message` from child to parent. |
| How a child's message is recognised | The broker marks it (`fromChild: true`), when the child sends it. Not by name in the app. |
| `send_message` from child to parent | The broker stores it in the outbox, like a report, so it survives a restart and is redelivered until acknowledged. |
| Where held messages wait | A separate list above the queue, not items in the queue. |
| Order | Arrival order, oldest on top, new ones at the bottom. |
| The switch | Per chat, on by default. Off = today's behaviour. |
| `queueMidTurn` | Unchanged and independent: it decides when an approved message is delivered. |
| Waiting count | Shown on every parent in the sidebar: with a view, open without a view, or closed. |
| Approved but not started when the parent closes | Comes back held: it must be approved again. |

## Approaches considered

How the app knows a message comes from a direct child:

- **A. The broker marks the message (chosen).** `Delegation.report` and the child-to-parent path of `Registry.send`
  set `fromChild: true` on the delivered message; the app holds what carries the mark. Exact, unaffected by renames.
  Needs "Update and restart broker"; with an older broker nothing carries the mark and nothing is held.
- **B. The app matches the sender's name** against its children in the tree. No broker change, but wrong across a
  rename, and for a message redelivered after a restart under an old name. Rejected.
- **C. The broker holds the message** until an approval endpoint is called. A new endpoint and a new broker state for
  what the app's queue plus the outbox already provide. Rejected.

Where held messages wait in the app:

- **A. A separate list (chosen).** The queue keeps its rule that every item in it can be delivered; approving moves a
  message to the queue with the existing `enqueue`. Nothing in `pump`, `deliverMidTurn`, the pause on Stop or
  `followUp.afterTurn` changes.
- **B. A "held" flag on queue items.** Every place that reads `queue[0]` or `queue.length` (idle pump, mid-turn
  delivery, status line, pause on Stop, `afterTurn` "pump") would need an exception; a missed one leaves an
  interrupted task waiting forever. Rejected.

Durability of `send_message` from a child:

- **A. The broker stores it in the outbox (chosen).** Same store, same redelivery and acknowledgement as a report,
  so reports and messages come back in one order after a restart.
- **B. The app stores the waiting list on disk.** A second store of the same items that must be reconciled with the
  broker's redelivery of reports. Rejected.

## Design

### 1. Broker: the mark (`src/delegation.mjs`, `src/registry.mjs`)

- A delivered item may carry `fromChild: true`. It is computed when the child sends, stored on the outbox item, and
  sent with every (re)delivery. A later `release_session` does not change it: a message sent while the sender was a
  child stays held.
- `Delegation.report`: the outbox item gets `fromChild: true`; `#deliver` passes `fromChild` through to `pushTo`.
- `Registry.send`, when the sender's `parentKey` is the recipient (`from.parentKey === to.key`) and the recipient is
  a desktop-app session (`to.app`): instead of its own `#deliver`, it hands the message to a new hook on the registry
  (wired in `server.mjs` next to `offlineRelative` and `decorate`, calling into `Delegation`). The hook writes an outbox item
  `{ id, toKey, from, fromCwd, text, prompt: relayPrompt(...), fromChild: true }` and delivers it with
  `Delegation.#deliver` (which decorates it and sets `deliveryId`, `wake: true`). The budget charge, the `message`
  event and the tool's reply text stay as they are. Other senders and recipients keep today's path.
- `Delegation.messageClosed`, child to a closed parent: the awaiting item also gets `fromChild: true`, so it is held
  when the reopen is approved and it is delivered.
- Parent to child, non-relatives, `sendFromUser` and every broker notice (`#notice`, `#inform`, `outcome`,
  `#notDelivered`, `#endedNotice`, link outcomes): no mark.
- The extension (`onceDelivery`) ignores the mark: a terminal parent injects and acknowledges as today.
- A marked outbox item also stores the sender's key (`fromKey`), so it can be counted per parent after a rename or a
  release.

### 1a. Broker: the count per parent (`src/delegation.mjs`, `src/links-api.mjs`)

- `GET /api/links` answers `{ links, held }`, where `held` maps a parent key to the number of its outbox items with
  `fromChild` that are not acknowledged and not awaiting a reopen (`!awaiting`). An old app ignores `held`.
- The count covers parents that are open, open without a view, or closed, and a former child's messages after a
  release (they are counted by item, not by link).
- `links_changed` goes out when the count changes: a marked item is stored, acknowledged (`Delegation.ack`, which
  emits no change today) or dropped.
- The count includes a message that was approved and waits in the parent's queue but has not started (it is
  acknowledged only when its prompt starts). The renderer therefore uses the broker's count only for a session that
  has no view; a session with a view shows `view.held.length`.

### 2. App main process (`electron/main.mjs`, `electron/preload.cjs`)

- `relay:message` carries `fromChild` (`onMessage` in `relayStart`).
- **A cache of held messages per session**, in memory, like `reopenCards`: every message with `fromChild` and a
  `deliveryId` is kept under its session until the renderer acknowledges it (`relay:ack`) or the session's relay
  connection goes away. When a window is reloaded or a view is opened (`sessions:open`), the cached messages of that
  session are sent to the window again (in arrival order). Reason: the broker redelivers unacknowledged items only
  when a peer registers again, and a window reload does not re-register root sessions, so without the cache a reload
  would drop held messages until the next app start.
- A desktop notification when the window is not focused and a held message arrives
  (`notifyIfUnfocused("A sub-session replied", "<child> → <parent>")`), once per `deliveryId`.
- **The switch per session**, stored in a JSON file in `userData` (pattern of `createTierStore`,
  `context-tiers.json`): only the "off" overrides are stored, the default is on. IPC to read and set it. It is copied
  on a fork (`tiers.copy` sits at the same place) and deleted with the session.

### 3. Renderer (`electron/renderer/app.js`, `message-queue.js` or a new pure module, `index.html`, `style.css`)

- `SessionView.incoming(m)`: after `acceptDelivery` and the `wake === false` branch, a message with `fromChild` goes
  to `this.held` when the switch is on, otherwise to `enqueue` as today. Messages without `fromChild` are unchanged.
- `this.held`: array of `{ id, from, text, prompt, fromCwd, deliveryId, arrivedAt }`, arrival order.
  - **Approve**: removes the item from `held` and calls `enqueue({ kind: "relay", …, human: false, command: false })`.
    From there the queue rules apply.
  - **Discard (✕)**: removes it, `api.relayAck(sessionId, deliveryId)`, and a system line
    `Discarded a reply from <child>.` (as `removeQueued` does).
  - **Switch off**: every held item is enqueued, oldest first, then the list is empty.
  - **Switch on**: nothing moves back; only new messages are held.
- The acknowledgement stays where it is today: when the approved item's prompt starts (`itemPrompt` →
  `deliveryAck`). A held message is never acknowledged by being held.
- `reopenView` hands `held` over to the new view, as it does with `queue` and `seenDeliveries`. A view that comes
  back dead removes the `deliveryId`s of its held messages from `seenDeliveries` (which `openSession` hands to the
  next resume), so the broker's redelivery at the next registration is held again instead of being rejected as
  seen. It says `N replies from sub-sessions will come back when the session is open again.`
- **A reply that waited**: when an approved message waited longer than a minute, the app adds one line to its prompt
  before it is queued: `(This reply waited N min for your user's approval. The list of your children above may be
  out of date: call list_sessions for their current state.)` The family block in the prompt was built by the broker
  when the message was delivered to the app; the app cannot rebuild it.
- **The list** sits above the queue strip. Shown only when it is not empty:

  ```
  ┌ Replies from sub-sessions (3) ──────────────────────────────┐
  │ docs-9f8e7d  · 18:41   Updated the API reference…  [Approve] [✕] │
  │ tests-41ac0b · 18:43   3 tests fail in …           [Approve] [✕] │
  │ lint-77e210  · 18:44   Done, 0 errors              [Approve] [✕] │
  └──────────────────────────────────────────────────────────────┘
  ┌ Queue (1) ───────────────────────────────────────────────────┐
  │ you: check the README too                                 [✕] │
  └──────────────────────────────────────────────────────────────┘
  ```

  A row shows the child's name, the arrival time and the first line of the text; the full text on hover and by
  expanding the row (plain text, like the queue). The text is model-written: plain text only, no HTML.
- **The switch** is a checkbox "Approve replies from sub-sessions" in the chat's bottom bar. It is shown when the
  session has a direct child in the tree or has held messages; otherwise hidden. Its state comes from main and is set
  through IPC.
- **Status line**: when idle with held messages and an empty queue: `N replies waiting for approval`. The existing
  texts are unchanged otherwise.
- **Sidebar**: a parent row with held messages shows a count mark (e.g. `⏸ 3`) with the title
  `3 replies from sub-sessions wait for your approval`. The count is `view.held.length` for a session with a view,
  otherwise the broker's `held[cli:<sessionId>]` from `links:update` (main passes `held` along with the links and
  keeps it in its links cache, so the mark shows at start-up before the broker answers). A closed parent with held
  messages shows the mark too; opening it delivers them, and they are held in its view.
- The quit and reload warnings (`confirmLeavingChildren`, `reloadWarning`) need no change: held messages survive both.

### 4. Interaction with other features

- **`release_session`**: the link goes, held messages from the former child stay and are approved or discarded as
  usual (the mark was set at send time), and they stay in the sidebar count. New messages from the former child are
  no longer marked. A child's message to a closed parent that still awaits a reopen is dropped by the release, as
  `#release` does today, and the child is told; it was never held, since it never reached the parent.
- **`adopt_session`**: messages from an adopted child are held like any child's, from the approval on. The broker's
  notices about the link (`Session "<child>" is now your child.`, `… is no longer your child.`, the rejection) come
  from `relay` and are not held.
- **Link and reopen cards** are unaffected: they are cards, not queue items.
- **A child deleted** while its message is held: the message stays held (`store.forget(child)` drops only items
  addressed to the child).
- **The parent deleted**: its held messages go with it (`store.forget(parent)` drops items addressed to it; the
  main cache is cleared with the session).
- **Pair message budget**: charged when the child sends, as today. Approving is not a human prompt and does not
  refill it.
- **Old app, new broker**: ignores `fromChild`; today's behaviour, and `send_message` from a child is now
  acknowledged by the app's existing ack path (the app acks every `deliveryId` it delivers).
- **New app, old broker**: no mark, nothing held; the switch still shows but has no effect. No capability flag is
  needed.

### 5. A parent or a child closes or ends while messages wait

A held message is an unacknowledged outbox item addressed to the parent; nothing below acknowledges it.

| Event | Held messages of that parent | Approved, still queued (not started) |
|---|---|---|
| The user closes the parent (`closeView`; its open sub-sessions close with it) | the view and main's cache go; the broker keeps the items; the sidebar shows the broker's count; reopening the parent redelivers them (`attached`) and they are held again, in the same order | also unacknowledged, so they come back too, and come back **held**: they must be approved again |
| The parent's process ends unexpectedly (view stays, marked dead) | stay listed; Approve is disabled, ✕ still works; a resume hands them over (`reopenView`) or gives them back to the broker's redelivery (section 3) | as for the queue today |
| Window reload | main's cache sends them to the window again when the session's view opens; the sidebar shows them before that | come back held |
| App quit and start | come back from the broker when the parent is opened; the sidebar shows the count from the start | come back held |
| The child closes or ends | unchanged: they are in the parent's outbox, not the child's. A child that ends without reporting still sends the parent the broker's "ended without reporting" notice, which is not held | unchanged |
| The child is deleted | unchanged (`store.forget(child)` drops only items addressed to the child) | unchanged |
| The parent is deleted | gone with it (`store.forget(parent)`) | gone |

- After approval the parent may answer a child that is closed by then: `send_message` asks the user to reopen it,
  as today (`messageClosed`).
- A child's `send_message` to a closed parent waits for a reopen card in the child's view, as today; once the parent
  is open and the message delivered, it is held. A `report_result` to a closed parent waits in the outbox and is held
  when the parent opens.
- The close question (`closeQuestion`) is unchanged: it warns only about your own unsent messages, and held messages
  are not lost by a close.

## Constraints

- Existing `delegations.json` files load unchanged; `fromChild` is an optional field of an outbox item.
- Windows and Linux builds; nothing platform-specific is expected.
- Tests run with `npm test` (`node --test electron/test/*.test.mjs`) and the UI checks in `scripts/ui-check/`.
  Broker logic in `delegation-broker.test.mjs`, the renderer's pure rules in a unit test, the list and the switch in a
  UI check.
- The broker changes: after updating the app, users press "Update and restart broker".
- Release: the next minor version after whatever is on `main` when this merges (`v0.20.0` is link-sessions;
  `feat/changes-tree` also plans a minor).

## Known limitations

- A child's `send_message` to a parent that is a terminal (extension) session is not stored durably; it keeps
  today's path, since only app parents hold messages.
- The broker redelivers unacknowledged items only when a peer registers. A message that reached main but not the
  window (window closed on macOS while the app runs) waits in main's cache; if the app quits meanwhile, it comes back
  from the broker at the next start.

- Outbox items stored before the upgrade carry no `fromChild`, so they are not held after "Update and restart
  broker" (a one-time gap).

## Left to the builder

Wording of the labels and status texts; the sidebar mark's glyph; whether the list's pure rules live in
`message-queue.js` or a new module; names of the registry hook and of IPC channels; styling; test split.

## Calls made by the author (not decided with the user)

- An approved message goes to the end of the queue, not to its head.
- Turning the switch off moves everything waiting into the queue; turning it on does not move anything back.
- Discarding acknowledges the message, so it is not redelivered.
- The switch is shown only on sessions that have direct children or held messages.
- A desktop notification when unfocused.
- On a dead parent view, Approve is disabled and ✕ still works.
- The sidebar count for sessions without a view comes from the broker (`held` in `GET /api/links`); the user chose
  that every parent in the sidebar shows it, the source is the author's call.
- The main-process cache, so held messages survive a window reload without a broker redelivery.
- Only app parents get the durable `send_message` path.
- Approving does not refill the pair budget.
- A dead view gives its held messages back to the broker's redelivery (removed from `seenDeliveries`) instead of
  dropping them.
- A reply that waited over a minute gets a line telling the parent its family block may be out of date.
