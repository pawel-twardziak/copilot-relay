# Spec: Communication panel for a session tree (`comms-panel`)

Implementation starts from `main` (after v0.30.0, `f06bb2d`). The version is decided at the merge.

## Intent

The owner works with trees of sessions: a parent delegates to children (`create_session`), children report back
(`report_result`), sessions talk with `send_message`, relay sends notices. Today the only way to follow this is to
open each session and read its chat. The owner wants to see, while working, **how the sessions of the tree talk to
each other, what is going on right now, and statistics of it**, in one panel next to the chat.

Success: from any session of a tree, one click shows the whole tree as a graph, who waits for whom, who works on
what, which session will compact soon, and below it the full ordered history of messages, with counts and sizes.

## Goals

1. A **Communication panel** in the place of the Activity panel (same right-hand slot, same width, collapse and
   drawer behaviour). The two panels are never shown at the same time; the view header switches between them.
2. **Graph** (top part): the sessions of the tree as nodes, messages as directed edges with counts. It shows the
   **live state** of each node and edge (see "Live state").
3. **Log** (bottom part): every message of the tree in time order. The border between graph and log is dragged
   vertically with the mouse.
4. **Statistics**: per node, per edge, and a summary bar over the log.
5. The history is **durable**: it starts when the tree starts (after this ships) and survives restarts of the broker
   and the app.
6. The graph is **always legible**: nodes and gaps as large as the panel allows, fitted to it on every resize; text
   never smaller than the UI font. Scrolling (vertical and/or horizontal) only as a last resort.

## Non-goals

- No history from before this feature ships (no reconstruction from `events.jsonl`).
- No editing or sending from the panel (approve/discard of held messages stays in the chat).
- No graph of Copilot's own in-session subagents: that stays in Activity.
- No new graph library.

## Anti-goals

- A graph that shrinks into unreadable text on a big tree.
- A panel whose live state lies (e.g. "working" on a closed session).
- Losing or duplicating events on broker restart or on redelivery (`redelivered` must not count twice).

## Approaches (decided: 1)

1. **Durable event log in the broker** (picked). The broker appends every communication event to a JSONL file next
   to `delegations.json`, at the places messages already pass. An endpoint and a peer control event serve it to
   the app. One source of truth, covers sessions not open in the app, survives restarts. Cost: broker changes, so
   the full feature needs a broker restart; history begins at deployment.
2. Log in the Electron main process from `relay:message` arrivals and the outgoing tool calls of each ACP stream.
   No broker change, but gaps while the app is closed, no sender id today, and both ends of a message must be
   matched. Rejected.
3. Reconstruction from each session's `events.jsonl`. No new store and older history, but heavy parsing on every
   open, no held/discarded statuses, guessed kinds, clock merging across files. Rejected.

## How it works today (what this builds on)

- **Activity panel**: per `SessionView` in `electron/renderer/app.js` (built ~lines 368-385: `panelBody`,
  `panelClose`, `panel-head`, `aside.activity-panel`, `panelHandle`, `chat-row`). Shown only while it has entries
  (`updatePanelShown` ~1904, `layoutPanel` ~1915 also hides the `activityBtn`). Width/collapse shared by all views,
  as fields of the one localStorage JSON object `copilot-sessions.ui.v1` (`loadUi`/`saveUi` ~3490-3500 and
  ~3648, `setPanelCollapsed` ~3658); sizes from `UiState.PANEL` (`ui-state.js` ~145); narrow window = drawer. CSS
  `style.css` ~180-200.
- **Tree**: broker `Delegation.snapshot()` (`src/delegation.mjs` ~129) → `GET /api/links` → main `loadLinks()` →
  `links:update` IPC → renderer `links`, `tree = SessionTree.index(links)` (app.js ~250, `setLinks` ~3943).
  A link carries `{key, parent, name, task, createdAt, reported, parentDeleted, adopted, online, busy}`; also
  `held`/`heldByKind` counts per recipient. Only keys that have a link (children) are in the snapshot: a root has
  no entry, so its online/busy state is not there. The store's `ended` flag is not in the snapshot; it only means
  "the ended-without-report notice was sent" (`died()`, `#endedNotice` ~544).
- **GET link routes get no query string**: the dispatcher calls them with `{}` (`server.mjs` ~246).
- **Pending cards** in the renderer: only reopen cards are kept as state (`this.reopenRequests`, app.js ~2349);
  create, permission and link cards are DOM elements only.
- **Acks from the app** happen in three places: the prompt of a delivered message starts (app.js ~1469),
  `discardHeld` (~1334), and `removeQueued` (~1404, the user removed it from the queue). Main sends them through
  the open view's relay client or, for a dead view, `brokerPost("/api/peer/ack")` (`main.mjs` ~1242).
- **Message paths in the broker** (each gets a log write):
  - initial task: it never passes the broker as a message. After the user approves the create card and the child
    has registered, main calls `relay.setTask(task)` (→ `Delegation.setTask`, `POST` in `src/links-api.mjs`) and
    then sends the task straight to the child's renderer (`main.mjs` ~1197-1207), with no `deliveryId`;
  - `Registry.send` (`src/registry.mjs` ~219): `send_message` between peers, including the budget block (~233);
    for app sessions it continues in `Delegation.appMessage` (~226);
  - `Delegation.report` (~191): `report_result`;
  - `Delegation.messageClosed` (~282) / `answerReopen` (~325): message to a closed relative (budget checked too,
    ~296), reopen asked, approved or rejected (dropped). On approval the renderer answers first and opens the
    target afterwards (app.js ~2380), so the items usually reach the session only in `attached()` (~525);
  - `#release` (~476) drops the pair's awaiting items; `store.forget` drops every outbox item addressed to the key
    (`delegation-store.mjs` ~204);
  - messages to non-app peers (extension, MCP mailbox) go to an in-memory inbox with no id and no ack
    (`registry.mjs` ~287-303);
  - `Delegation.userMessage` (~247) and `Registry` user send (~258): messages from the relay web GUI;
  - `#notice` (~101, durable) and `#inform` (~108, not stored) from relay; `outcome()` (~271);
  - `#endedNotice` (~548): child ended without reporting;
  - `Delegation.ack` (~531): the recipient app took the item (sent to Copilot) or discarded it.
- Outbox items have no timestamp and are deleted on ack; the broker's in-memory `history` (`server.mjs` ~75) is
  lost on restart and not used by Electron. So no usable history exists today.
- The renderer never learns the sender's key: `#deliver` (~555) leaves out `fromKey`.

## Design

### 1. Broker: the communication log (`src/comms-log.mjs`, new)

A small module owned by the broker:

- File: `$XDG_STATE_HOME/copilot-relay/communications.jsonl` (same directory rule as `delegation-store.mjs`;
  override `COPILOT_RELAY_COMMS_FILE` for tests). Append-only, one JSON event per line, written synchronously
  before the message is delivered (same ordering rule as `store.enqueue`).
- Event shape:
  ```
  { id, ts, kind, fromKey|null, toKey|null, from, to, size, text, status, ref? }
  ```
  - `id`: the outbox item id when there is one (so later status events can refer to it), else a new id.
  - `kind`: `task` (initial task of a created child), `message` (`send_message`), `report` (`report_result`),
    `notice` (relay to a session, durable or not), `user` (relay web GUI), `status` (a later change of an earlier
    event, see `ref`).
  - `from` / `to`: names at the time of the event (sessions get renamed; the graph uses keys, the log shows names).
    `fromKey` null for relay and user.
  - `size`: length of `text` in characters (stored before truncation).
  - `text`: the message text, cut at 64 KiB (`…` mark), in the file only. Memory, pushes and `GET /api/comms`
    carry `preview` (the first ~300 characters) instead; the full text is read from the file on demand (see 3).
    The memory copy keeps each event's preview and its file offset.
  - `status` on a message event: `queued` (stored, recipient offline), `delivered` (pushed to the recipient now),
    `awaiting-reopen`, `blocked` (budget exhausted, not delivered).
  - `status` events (`kind: "status"`, `ref` = the message id): `delivered` (redelivery reached it, or reopen
    approved), `taken` (acked as sent into the session), `discarded` (acked as discarded by the user), `dropped`
    (reopen rejected, link ended, target forgotten).
- Read API: `eventsOf(keys)` returns the events whose `fromKey` or `toKey` is in `keys` (relay/user events count by
  `toKey`), in order. Loaded into memory at broker start; appends update the memory copy.
- Retention: when a session is deleted for good (`Delegation.forget`, reached from `/api/links/forget`), every event
  that names its key as `fromKey` or `toKey` is purged (memory at once, file rewritten, debounced). At broker start
  the file is capped at the newest 50 000 events. A corrupt line is skipped, never fatal. (Stored names are not a
  usable "forgotten" signal: NameStore never deletes on forget, `name-store.mjs` ~46.)
- A `redelivered` push does not write a new message event (at most a `status: delivered` once). The same id never
  appears twice as a message event.

### 2. Broker: who writes which event

| Place | Event |
|---|---|
| `setTask(childKey, task)` (first task of the link only) | `task` parent→child, status `delivered` (main sends it right after; it has no id, so no later status) |
| `Registry.send` or `messageClosed` blocked by budget | `message`, status `blocked` |
| `Registry.send` to a non-app peer (mailbox/extension) | `message`, `delivered` if pushed, else `queued`; no later status (inbox items have no id: known limitation) |
| `appMessage` | `message`, `delivered`/`queued` (by `#deliver`'s result) |
| `report` | `report`, `delivered`/`queued` |
| `messageClosed` | `message`, `awaiting-reopen` |
| `answerReopen` approved | `status: delivered` only for items `#deliver` really pushed; the rest stay as they are and get `delivered` in `attached` |
| `answerReopen` rejected, `#release`, `forget` dropping items | `status: dropped` per dropped item |
| `#notice`, `#inform`, `#endedNotice` | `notice` relay→session |
| `userMessage` / registry user send | `user` |
| `attached` redelivery | `status: delivered` once per item whose last status is `queued` or `awaiting-reopen` |
| `ack(key, id, outcome)` | `status` `taken` or `discarded` |

`ack` gets an optional `outcome` (`"taken"` default, `"discarded"`): `POST /api/peer/ack {key, id, outcome}`. The
app passes `discarded` from `discardHeld` and from `removeQueued` (renderer → `relay:ack` IPC with the outcome →
`relay.ack(id, outcome)`, or the dead-view `brokerPost` path in `main.mjs` ~1242). An older app sends no outcome:
logged as `taken`.

### 3. Broker: serving it

- The route dispatcher passes the URL's query (`url.searchParams`) to GET link routes (today it passes `{}`,
  `server.mjs` ~246).
- `GET /api/comms?key=cli:<id>` (in `src/links-api.mjs` or a sibling route module): finds the root of `key`'s tree
  (follow `parent` up through the links), collects the root and all descendants, returns
  `{ root, keys, events, peers }`. `events` carry `preview`, not `text`. `peers` maps every key the graph shows
  (the root, every descendant, every counterpart named by an event; see "Graph") to
  `{ name, online, busy, kind }` from the registry, falling back to the stored name, so a root and a session
  outside the tree get a live state too. Unknown key: `{ root: key, keys: [key], events: [], peers: {} }`.
- `GET /api/comms/text?id=<event id>` → `{ text }` read from the file (the 64 KiB cut applies).
- Peer control event `comms` `{ event }` (preview only) pushed to every app peer after each append, no debounce.
  The broker has one stream per session, so the app gets it once per open session: main dedupes by event id, the
  renderer filters by its tree. Old apps ignore unknown control events (verify in `relay-client.mjs` ~262).
- `#deliver` adds `fromKey` to the push (useful for the renderer; additive).
- `snapshot()` gains `endedNotice` (the store's `ended` flag): the child ended without reporting.

### 4. Electron main

- `relay-client.mjs`: `fetchComms(key)`, `fetchCommsText(id)`, an `onComms` handler for the control event,
  `ack(id, outcome)`.
- `main.mjs`: `comms:get` and `comms:text` IPC (through the open view's relay client, or a new plain broker GET
  helper next to `brokerGetLinks` ~265 when no view of the tree is open); forward `comms` control events as
  `comms:event` to the renderer once (dedupe by event id). An old broker (404) → `{ unsupported: true }`.
  `relay:ack` takes the outcome.
- `preload.cjs`: `getComms`, `getCommsText`, `onCommsEvent`; `relayAck(sessionId, id, outcome)`.

### 5. Renderer: the panel slot and the switch

- The right-hand slot holds one of two panels: `activity` or `comms`. Global UI state field `rightPanel` in the
  `copilot-sessions.ui.v1` object (`loadUi`/`saveUi` extended), default `activity`. Width, collapse, drawer and the resize handle stay shared.
- Header: the existing **Activity** button and a new **Communication** button, side by side. Clicking the button of
  the panel that is not shown switches the slot to it (and reveals the panel if collapsed); clicking the shown one
  collapses it, as `togglePanel()` does today.
- Visibility rules:
  - Activity: as today (shown/button present only while it has entries).
  - Communication: available while the session belongs to a tree (has a parent or children in `tree`), else its
    button is hidden.
  - When the chosen panel is unavailable and the other is available, the other one is shown (the choice is kept,
    so it comes back when available). Never both.
- The existing Activity code stays as is; the new panel is a sibling `aside.comms-panel` inside the same
  `chat-row`, and `updatePanelShown`/`layoutPanel` pick which one is visible.

### 6. Renderer: the Communication panel (`electron/renderer/comms-model.js` + `comms-view.js`, new)

Split like `changes-model.js` / `changes-list.js`: a pure model (unit-tested) and a DOM view.

**Model** (`CommsModel`): input = tree links, `heldByKind`, the event list, and live per-session facts (below);
output = nodes, edges, log rows, statistics. No DOM.

**Layout of the panel**: `panel-head` ("Communication", » and ✕ as in Activity), then the graph area, a horizontal
drag bar, the summary bar, the log. The split ratio is the UI state field `commsSplit` (default 50 %), clamped so
each part keeps at least ~120 px.

**Graph** (inline SVG, own layout code):

- Tree layout: root at the top, each generation below its parent, ordered by `createdAt` (as `SessionTree.index`).
  When a generation does not fit the width at the minimum node size, its nodes wrap into several rows under their
  parent (edge routing follows), so ordinary trees fit the default 420 px panel without scrolling. Edges between
  parent and child are straight; edges between other pairs (siblings, cousins, `heldAs: "other"`) are arcs so they
  do not cross nodes.
- **Counterparts outside the tree** (owner's choice): every session an event of the tree names that is not in
  `keys` (another tree, an extension terminal, an MCP client, a released child, an orphan whose parent was
  deleted) gets its own node with a dashed border, in a separate column "outside the tree" on the right. It has
  edges, counts and the live state from `peers` like the others. A released child is marked "released".
- **Relay and user** (owner's choice): not nodes. The recipient node gets a small badge ("relay 3", "user 1");
  the rows are in the log. Node statistics count them apart from session-to-session messages.
- Each direction of a pair is its own edge, labelled with its message count. Hover → tooltip with count, total
  size, last message time.
- Fit: on every panel resize (the panel's ResizeObserver) the layout computes the largest node size and gaps that
  fit the graph area. Minimums: node width ~140 px, label font = UI font size. If the tree does not fit at the
  minimums, the SVG keeps the minimum size and the graph area scrolls (horizontal and/or vertical). No zoom-out
  below the minimums, ever.
- The current session's node is highlighted. Click a node → filter the log to that session; click an edge → filter
  to that pair and direction; click empty space or the filter chip → clear. Double click a node → open/switch to
  that session (as the sidebar does).

**Live state** (recomputed on every links update, comms event, usage update, keeper state change, permission card
change):

| Shown | Derived from |
|---|---|
| Child **working on its task**: node pulses, parent→child edge marked "in progress" with time since the task | link `online && busy`, not `reported` (time from the `task` event or `createdAt`) |
| Parent **waiting for a report**: dashed child→parent edge with a waiting timer | link not `reported`, not `endedNotice` |
| Child **ended without a report**: red mark on the child→parent edge | `endedNotice` |
| Child **waiting for a task**: dimmed node, "idle" | `online && !busy` and (`reported` or no task) |
| A message **waits for a reply**: the edge shows "waiting" | the last `message` on a pair has no later message back (builder: only for pairs that already exchanged at least one message after the report) |
| A message **waits for your approval**: badge with the count on the edge's target | `heldByKind` of the recipient |
| **Waits for you**: create card (ghost node "proposed" under the parent until answered), reopen card, permission card, link card | a new per-view list of pending cards (`{kind, id, name?}`, added and removed where each card is shown and answered/dismissed; reopen cards already live in `reopenRequests`) |
| **Closed** session: grey node; a message to it shows "awaiting reopen" | `!online` (from links, or `peers` for the root and outside nodes), events with `awaiting-reopen` |
| **Context fill**: a bar on each node, same levels as the status-bar chip (`ok`/`warn`/`full`); `warn`/`full` mean Copilot's automatic compaction is near | `lastUsage` per session (app.js ~3967) |
| **Cache keeper**: "⏳ 1:45 to compaction" on the node during the countdown, "Compacting…" while it runs, the ping count while pinging | the view's `keeperState` (`{phase, pingsSent, pings, compactAt}`) |

Sessions not open in this app have no usage/keeper/card data: the node shows only what the links say (online,
busy, closed). `wait_for_message` is not shown: app sessions get pushed messages, only mailbox clients use it.

**Log** (bottom): one row per message event, newest at the bottom, scroll-following like the Activity panel.
Row: time, `from → to`, kind, size, current status (the latest `status` event folded in), the preview. Click a row
→ fetches the full text (`comms:text`) and expands it (pre-wrapped, as sent); a failed fetch keeps the preview with
a short error. Filters from the graph apply here. A broker without the endpoint: the log shows
one line "The relay broker is older than the app and keeps no message history; restart it to get one", while the
graph still shows the tree and live state.

**Statistics**:

- Node: messages sent / received between sessions, relay/user messages received apart (tooltip adds sizes).
- Edge: count and total size per direction.
- Summary bar over the log (follows the filter): total messages, total size, average time from `task` to `report`
  per child (over children that reported), number held now, number discarded/dropped/blocked.

### 7. Compatibility

- New app + old broker: no endpoint → graph from links + live state, log shows the restart hint.
- Old app + new broker: `fromKey` in pushes and the `comms` control event are ignored; acks without outcome log as
  `taken`.
- The broker restart limitation (known since v0.17.0) applies: the log starts after the broker runs the new code.

## Testing

- Unit (`node --test`): `comms-log` (append, reload, retention, corrupt line, redelivery not duplicated), each
  broker write point in `delegation`/`registry` tests, `/api/comms` tree collection, `CommsModel` (states table,
  statistics, filters, status folding), the graph layout fit (sizes at given panel sizes, minimums → scroll).
- UI checks on the scripted agent (as the cache-keeper checks): switch Activity ↔ Communication (never both),
  panel hidden button for a session without a tree, graph of a parent with two children, live "working" →
  "reported" transition, log row expand, split drag persists, narrow window drawer.
- Manual: real Copilot tree on the Linux machine and on the corp PC; Windows/macOS layout.

## Calls made by the designer (not discussed with the owner)

- Events of a session deleted for good are purged from the log.
- Pushes and the list carry a ~300-character preview; the full text is fetched when a log row is expanded.
- A generation that does not fit wraps into several rows.
- The task event is logged at the first `setTask` of a link; later tasks go as `send_message` and log as messages.
- Messages to non-app peers get no later status (their inbox has no ids).
- Statistics as listed above (the owner did not ask for others).

## Left to the builder

- Exact colours, icons and animation of the states (follow `style.css` tokens, both themes).
- Whether `comms-view.js` reuses the panel scroll-follow code or shares a helper with Activity.
- The arc routing details for non-tree edges.
- Where the `/api/comms` route lives (`links-api.mjs` or a new module).
