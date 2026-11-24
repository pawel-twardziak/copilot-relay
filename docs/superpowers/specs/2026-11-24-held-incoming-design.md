# Spec: Held incoming messages (parent orders, other sessions, your own while busy)

Extends `2026-11-23-held-child-replies-design.md` and the message queue (`2026-11-21-message-queue-design.md`,
`electron/renderer/message-queue.js`). Where the documents disagree, this one wins. Everything the held-child-replies
spec says about replies from direct children stays as it is, unless a section below changes it.

## Intent

Since v0.22.0 a reply from a direct child waits in its parent's chat until the user approves it. Every other message
still becomes a prompt by itself: a parent's `send_message` to its child, a message from a session that is not a
relative, and what the user sends while the session is working (queued, then delivered at the end of the turn or, with
`queueMidTurn`, in the middle of it).

The user wants the same control over these: each of them waits in a list of its own in the chat of the session that
receives it, and reaches the agent only after the user approves it. Each list has its own switch per chat.

## Goals

1. Three new kinds of held messages in the receiving session's chat, next to the existing one (`child`):
   - **`parent`**: a `send_message` from the session's direct parent.
   - **`other`**: a `send_message` from any other agent session: a sibling, a grandchild, a grandparent, a session that
     is no relative at all.
   - **`user`**: a message from the user that arrives while the session is working: typed in the chat's own message
     box, or sent from the relay GUI (`POST /api/send`, `from: "user"`).
2. Each kind has a list of its own above the queue and a switch of its own in the chat's status bar, stored per
   session, on by default. The existing switch and list for `child` stay.
3. Approve, discard (✕), switch off and switch on behave for every kind as they do for `child` today: Approve moves
   one message to the end of the queue; ✕ drops it for good; switching off moves everything waiting of that kind to
   the queue, oldest first; switching on moves nothing back.
4. A held message stays held until the user approves or discards it. The end of a turn releases nothing, also not a
   `user` message.
5. A held message that came through the broker (`parent`, `other`, `user` from the relay GUI) survives a window
   reload, a view rebuild, an app restart and a broker restart, like a held child reply.
6. The sidebar mark `⏸ N` counts all four kinds.

## Non-goals

- Holding the broker's own notices (`from: "relay"`: `#notice`, `#inform`, outcomes of create, link, reopen). They go
  to the queue, or to the next prompt for `wake: false`, as today.
- Holding the first task of a new sub-session. The user already approved it on the "new session" card; main sends it
  to the child without a mark and without a `deliveryId` (`createChild` in `electron/main.mjs`).
- Holding a message the user sends while the session is idle. It starts a turn, as today.
- Holding in recipients that are not desktop-app sessions (terminal extension, MCP peers, broker-run ACP agents).
- An "approve all" button, editing a held message, reordering a list.
- Changing `queueMidTurn`, the queue, its pause on Stop, or the answer-then-continue flow. An approved message is a
  queue item like any other.
- Durable storage of messages typed in the chat's message box. They live in the window, like the queue's own items.
- Fixing the open findings of `docs/superpowers/backlog/2026-11-23-held-child-replies-deferred.md` (A1 to A4 apply to
  the new kinds in the same way; see Known limitations).

## Anti-goals

- A held message is delivered without an approval while its switch is on.
- A held broker message is lost without the user discarding it.
- A message is delivered twice (from a list and from a redelivery).
- A held message blocks the queue, or the queue logic counts it as deliverable.
- The first task of a new sub-session, or a broker notice, lands in a list.
- A message the user typed disappears without a trace (it is in a list, in the queue, in the chat, or the app said it
  was discarded).

## Decisions (made with the user)

| Topic | Decision |
|---|---|
| Where a message waits | In the chat of the session that receives it (the mirror image of held child replies), not in the sender's chat. |
| What is held | `parent`, `other`, `user` as defined in Goals; broker notices are not. |
| `user` | Both sources: the chat's message box and the relay GUI. Held only when the session is working at that moment. |
| Lists | One list per kind, separate from each other and from the queue. |
| Switches | One per kind, per chat. Four in total with the existing one. |
| End of a turn | Releases nothing. A held `user` message waits for Approve like every other kind. |

## Approaches considered

Where a parent's order waits:

- **A. In the child's chat (chosen).** The recipient holds, as for child replies. Reuses the outbox, main's cache,
  the list and the acknowledgement that exist. With many children the user approves in each child's chat; the sidebar
  mark shows where.
- **B. In the parent's chat**, as a list of outgoing orders with one switch for all children. One place to approve,
  but the broker would have to keep the message back and get an approve / discard endpoint and a state of its own:
  approach C of the held-child-replies spec, rejected there for the same reason.

How the app knows the kind of a message:

- **A. The broker marks it when it is sent (chosen)**, as it does with `fromChild`. Exact, unaffected by renames and
  by a later `release_session` / `adopt_session`.
- **B. The app works it out from the sender's name and its tree.** Wrong across a rename and for a redelivery under an
  old name. Rejected in the held-child-replies spec, rejected here.

How broker messages become durable:

- **A. Every agent message and every relay-GUI message to a desktop-app session goes through the delegation outbox
  (chosen).** Today a child's message to its parent, a message awaiting a reopen (`messageClosed`) and the broker's
  notices (`#notice`) do. One path, one acknowledgement, one redelivery.
- **B. The app stores held messages on disk.** A second store to reconcile with the broker's redelivery. Rejected.

Messages typed in the chat's message box:

- **A. Held in the window only (chosen).** They never pass the broker today; the queue's own items are not durable
  either. No broker change for them, so this part works with an old broker too.
- **B. Sent through the broker to make them durable.** A new path for something the queue does not offer today.
  Rejected.

## Design

### 1. Broker: the mark (`src/registry.mjs`, `src/delegation.mjs`, `server.mjs`)

- A delivered item may carry `heldAs: "parent" | "other" | "user"`. `fromChild: true` stays the mark of a child's
  message (an app of v0.22 to v0.24 reads only that); the new app reads `fromChild` as kind `child`. The mark is
  computed when the message is sent, stored on the outbox item, and sent with every (re)delivery.
- `Registry.send` to a recipient that is a desktop-app session (`to.app`): the registry hook that today takes over a
  child's message (`childMessage`, wired in `server.mjs`) takes over every such message. The kind:
  - `from.parentKey === to.key` → `fromChild: true` (as today);
  - `to.parentKey === from.key` → `heldAs: "parent"`;
  - otherwise → `heldAs: "other"`.
  The outbox item is `{ id, toKey, from, fromCwd, text, prompt, fromKey, <mark> }`, delivered with
  `Delegation.#deliver` (`deliveryId`, `wake: true`).
- The prompt the recipient gets must be the one it gets today. `Delegation.#deliver` adds the family block
  (`decorate`) to every outbox item today; from now on it decides by the item: yes for `fromChild`, `parent` and the
  broker's notices (as today), no for `other` and `user` (`Registry.send` does not decorate a message between
  sessions that are not linked, and `sendFromUser` decorates nothing).
- The budgets, the `message` event and the tool's answer text stay as they are.
- `Registry.sendFromUser` to a desktop-app session: stored in the outbox with `heldAs: "user"` and `human: true`, no
  `fromKey`, `from: "user"`, and the prompt is the bare text as today. `#deliver` sends `human: false` for every item
  today; it sends the item's own value, so a redelivery is still a human message. `humanPrompt` is called as today.
  To other recipients: unchanged.
- `Delegation.messageClosed`, parent to a closed child: the awaiting item gets `heldAs: "parent"`, so it is held when
  the reopen is approved and it is delivered.
- A delivery made when a peer registers (`Delegation.attached`) carries `redelivered: true`; a delivery made when the
  message is sent does not. A message stored while its recipient was offline is first delivered by `attached` and
  carries the flag too. (Needed for kind `user`, section 3.)
- No mark: `#notice`, `#inform`, `outcome`, `#notDelivered`, `#endedNotice`, link outcomes.
- Recipients that are not desktop-app sessions keep today's path.

### 1a. Broker: the counts (`src/delegation.mjs`, `src/links-api.mjs`)

- `GET /api/links` keeps `held` (key → number of unacknowledged `fromChild` items) for apps of v0.22 to v0.24, and
  adds `heldByKind`: key → `{ child, parent, other }`, counting unacknowledged marked items that are not awaiting a
  reopen. Kind `user` is not counted: whether the app held such a message depends on the view's state when it
  arrived, which the broker does not know.
- `links_changed` goes out when any of these counts changes (a marked item stored, acknowledged or dropped).

### 1b. Broker: a deleted session's items (`src/delegation.mjs`, `electron/renderer/app.js`)

Today the app tells the broker to forget a deleted session only when it is in the tree (`forgetDeleted`), because
only linked sessions had outbox items. From now on any desktop-app session can have them. Deleting a session in the
app makes the broker forget it whether it has a link or not (`store.forget` already drops the items addressed to a
key). A session deleted outside the app is still reported only when it is linked (`pruneMissing`); see Known
limitations.

### 2. App main process (`electron/main.mjs`, `electron/held-replies.mjs`, `electron/preload.cjs`)

- `relay:message` carries the kind (`heldAs`, or `child` for `fromChild`) and `redelivered`.
- The cache of held messages (`createHeldCache`) keeps every message with a kind and a `deliveryId`, not only
  `fromChild`. When it sends cached messages to a window again (`sessions:open`), they carry `replayed: true`.
- The switch store (`createHoldStore`, `held-replies.json`) holds one value per session and kind; only "off" is
  stored. A file of v0.22 to v0.24 (`{ [sessionId]: false }` = `child` off) still reads correctly. `copy` (fork) and
  `delete` cover all kinds. IPC: read all four for a session, set one.
- Desktop notification when the window is not focused: for a `parent` or `other` message whose switch is on, once per
  `deliveryId`, like "A sub-session replied". None for `user`.

### 3. Renderer (`electron/renderer/app.js`, `held-replies.js`, `message-queue.js`, `style.css`)

- **When a message is held.** `SessionView.incoming(m)`, after `acceptDelivery` and the `wake === false` branch:
  - `child`, `parent`, `other`: held when the kind's switch is on and the message has a `deliveryId`.
  - `user` (relay GUI): held when the switch is on, the message has a `deliveryId`, and a turn is running
    (`this.prompting`, not `this.busy`, which is also set while a view resumes) or the message is `redelivered` or
    `replayed`. A message that comes back was held or was queued without having started; either way it comes back
    held, as an approved child reply does today.
  - Otherwise: `enqueue`, as today.
  - Each kind reads its own switch. Until main has answered with the stored values, every switch counts as on, and
    what was held meanwhile for a kind that turns out to be off is released (`loadHoldSwitch` does this for `child`).
- **Typed messages.** `send()` while a turn is running (`this.prompting`): where it enqueues a `kind: "app"` item
  today, it puts the message in the `user` list instead when that switch is on. With the switch on, Send works during
  a turn also when `queueMidTurn` is off (today the button is disabled then). What `send()` refuses while busy today
  (agent change, `/rename`, an edit, a history operation) it still refuses, and while the view is busy without a
  turn (a resume) it behaves as today.
- **One held list in the view** (`this.held`), each item with its kind; typed items have no `deliveryId`.
  - **Approve** removes the item and calls `enqueue`: a broker item as `kind: "relay"` with its `human` flag and
    `deliveryId` (acknowledged when its prompt starts, as today); a typed item as `kind: "app"` exactly as `send()`
    would have enqueued it.
  - **✕** removes it. A broker item is acknowledged (`relayAck`, with the `discarded` set as today) and a system line
    names it. A typed item is dropped with a system line, like `removeQueued`.
  - **Switch off**: every held item of that kind is enqueued, oldest first. **Switch on**: nothing moves back.
- **A message that waited** over a minute: `parent` and `other` get a line like the one for `child` (it waited N min
  for the user's approval; for `parent`, the family block may be out of date). `user` gets none.
- **The lists** sit above the queue strip, each shown only when it is not empty, in this order:

  ```
  ┌ Orders from parent (1) ─────────────────────────────────────┐
  │ lead-3c1a · 14:02  Also update the changelog… [Approve] [✕] │
  └─────────────────────────────────────────────────────────────┘
  ┌ Other sessions (2) ─────────────────────────────────────────┐
  │ api-77e2  · 14:03  Is the schema final?       [Approve] [✕] │
  │ docs-9f8e · 14:05  FYI: I renamed the folder  [Approve] [✕] │
  └─────────────────────────────────────────────────────────────┘
  ┌ Your messages (1) ──────────────────────────────────────────┐
  │ you       · 14:06  check the README too       [Approve] [✕] │
  └─────────────────────────────────────────────────────────────┘
  ┌ Replies from sub-sessions (3) ──────────────────────────────┐
  │ …                                                           │
  └─────────────────────────────────────────────────────────────┘
  ┌ Queue (1) ──────────────────────────────────────────────────┐
  ```

  A row is built like a held child reply's row today (name, arrival time, first line, full plain text on click).
- **The switches** are checkboxes in the chat's status bar, next to the existing one:
  `[✓ Sub-session replies] [✓ Parent orders] [✓ Other sessions] [✓ My messages while busy]`.
  Shown when: `child` as today (has a direct child or held items); `parent` when the session has a parent that is
  not deleted, or held items; `other` when the session is on the relay, or held items; `user` always.
- **Status line** when idle with an empty queue: the total of all lists, `N message(s) waiting for approval`.
- **Sidebar**: `⏸ N` is the total of the view's lists; for a session without a view, the sum of the broker's
  `heldByKind` (`held` from an older broker). The title names the total.
- **Hand-over and loss.** `reopenView` and `openSession` hand the held list over as today. Broker items of a view
  that comes back dead go back to the broker's redelivery (`heldComeBack`, which today clears the whole list and
  must leave typed items to the next rule). Typed items follow the queue's own items everywhere: where those are
  handed over, discarded with a message, or asked about before a close (`closeQuestion`), held typed items are
  handed over, counted in that message, and counted in that question.

### 4. Interaction with other features

- **The first task of a new sub-session** is never held (no mark, no `deliveryId`).
- **`adopt_session` / `release_session`**: the mark is set when the message is sent. A message sent before a release
  stays `parent`; after it the sender is `other`.
- **Reopen cards**: an order to a closed child waits for the reopen card as today and is held once delivered.
- **Budgets**: charged when the agent sends, as today. Approving is not a human prompt and refills nothing.
- **`queueMidTurn` off**: an approved message waits in the queue for the end of the turn, as any queue item.
- **A kind whose switch is off** is durable too: a `parent`, `other` or relay-GUI message that was queued but had
  not started when its session closed is delivered again when the session opens, and goes to the queue without an
  approval. Today such a message is lost with the close. A child's reply already behaves this way.
- **Take-back (Up)** takes back queued messages only, as today. A held typed message leaves its list by Approve or ✕.
- **Old app, new broker**: ignores `heldAs` and `redelivered`; nothing new is held. Messages from other sessions and
  from the relay GUI now carry a `deliveryId`, which the app acknowledges as it does every delivery.
- **New app, old broker**: no `heldAs`, so `parent`, `other` and relay-GUI `user` messages are not held; typed
  messages are. The switches show but only "My messages while busy" (for typed messages) and the existing one work.

## Constraints

- Existing `delegations.json` and `held-replies.json` files load unchanged.
- Windows and Linux builds; nothing platform-specific is expected.
- Tests: `npm test` in `electron/` and the UI checks in `scripts/ui-check/`. Broker logic in
  `delegation-broker.test.mjs`, the pure rules of the lists in a unit test, the lists and switches in a UI check.
  Run `npm --prefix electron run copy-relay` before the relay UI checks.
- The broker changes: after updating the app, users press "Update and restart broker".
- `electron/README.md`: the section "Replies from sub-sessions wait for you" describes all four kinds.
- Release: `v0.26.0` (`v0.25.0` went to the child command card, merged to `main` while this was built).

## Known limitations

- The sidebar count for a session without a view comes from the broker and ignores the switches (as today for
  `child`), and never includes `user`.
- Typed held messages are lost with the window (reload, close, crash), like the queue's own items.
- Outbox items stored before the upgrade carry no mark, so they are not held (a one-time gap).
- Outbox items addressed to a session that has no link and was deleted outside the app (in a terminal, by Copilot's
  cleanup) stay in `delegations.json` and in `heldByKind`. To the backlog.
- Backlog A1 (a lost ack is never repeated), A2 (a dead view shows no mark), A3 (a terminal recipient's items are
  counted) and A4 (`send` says "delivered" when only the store has it) now also apply to the new kinds.

## Left to the builder

Names (the mark's values, IPC channels, the registry hook, the flags), the shape of `held-replies.json` and of
`heldByKind`, labels and system lines, the wait note's wording, how the four switches wrap at narrow widths, whether
the held list is one array with a kind or four arrays, the test split.

## Calls made by the author (not decided with the user)

- All three new switches are on by default (stated to the user, not objected to).
- `other` is every agent session that is not the direct parent or a direct child, grandchildren included.
- With "My messages while busy" on, Send works while busy even when `queueMidTurn` is off.
- A relay-GUI message that comes back (replay, redelivery) is held even if the session is idle then.
- "Working" for kind `user` means a turn is running (`prompting`); a view that is only resuming does not hold.
- With a kind's switch off, its unstarted messages survive a close and run when the session opens again, instead of
  being lost (after the builder check).
- Deleting any session in the app makes the broker forget its items, linked or not (after the builder check).
- `held` in `GET /api/links` stays child-only for older apps; the new counts are in `heldByKind`.
- Kind `user` is not in the broker's counts and gets no desktop notification and no wait note.
- The order of the lists; the switch visibility rules.
- Up does not take back held typed messages.
- Held typed messages are treated like the queue's own items on hand-over, close and loss.
