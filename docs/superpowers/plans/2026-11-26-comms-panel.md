# Communication panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Communication panel, in the Activity panel's slot, that shows a session tree as a live graph and a durable,
ordered log of the messages between its sessions, with statistics.

**Architecture:** The broker appends every communication event to `communications.jsonl` (`src/comms-log.mjs`),
writing at each existing message path in `Delegation`/`Registry`. It serves the tree's events at `GET /api/comms`
and pushes each new event as a `comms` control event. Main forwards both to the renderer. There, a pure model
(`comms-model.js`) and a pure layout (`comms-layout.js`) feed a DOM view (`comms-view.js`) mounted in the
`chat-row` next to the Activity panel.

**Tech Stack:** Node ≥ 18 ESM broker, Electron main (ESM) + preload (CJS), renderer as classic `<script>` files that
set a global and `module.exports` (pattern of `changes-model.js`), inline SVG, `node --test`, UI checks in
`scripts/ui-check/checks.mjs` on the scripted agent.

**Spec:** `docs/superpowers/specs/2026-11-26-comms-panel-design.md`

## Global Constraints

- Log file `$XDG_STATE_HOME/copilot-relay/communications.jsonl` via `stateFile("communications.jsonl")`
  (`src/name-store.mjs`), override `COPILOT_RELAY_COMMS_FILE`.
- Event kinds: `task`, `message`, `report`, `notice`, `user`, `status`. Message statuses: `queued`, `delivered`,
  `awaiting-reopen`, `blocked`. Later statuses: `delivered`, `taken`, `discarded`, `dropped`.
- Stored text cut at 65 536 characters plus `…`; preview = first 300 characters plus `…` when longer.
- Cap: newest 50 000 events, applied at broker start.
- Ack outcome: `"taken"` (default, also when absent) or `"discarded"`.
- Graph minimums: node width 140 px; label font = the UI font size (read from computed style, never smaller).
- Split default 50 %, each part ≥ 120 px. UI state fields `rightPanel` (`"activity"` | `"comms"`, default
  `"activity"`) and `commsSplit` (0..1, default 0.5) in the `copilot-sessions.ui.v1` object.
- UI copy (English, as the rest of the app): button and panel title `Communication`; old broker hint
  `The relay broker is older than the app and keeps no message history; restart it to get one.`
- Old app + new broker and new app + old broker must keep working (spec §7).
- No new npm dependency.
- After changing `extension/copilot-relay/relay-client.mjs`, run `npm --prefix electron run copy-relay` before UI
  checks (the electron copy is git-ignored).

## Review Focus

1. **Redelivery after a broker or app restart** must not add a second message event or count twice in statistics;
   only one `status: delivered` per id. → test in Task 2 (`attached` twice).
2. **A renamed session**: the graph keys by key, the log shows the name at the time; a rename must not split one
   node into two. → test in Task 5 (`build` with two names for one key).
3. **A huge tree / narrow panel (280 px)**: never a label below the UI font; scroll appears instead. → test in
   Task 6 (12 children at 280 px).
4. **A corrupt or half-written last line** of `communications.jsonl` (crash while appending) must not stop the
   broker or lose the other events. → test in Task 1.
5. **Switching sessions of the same tree** must show the same graph without refetch flicker, and a session that
   leaves the tree (release) must hide the Communication button and fall back to Activity. → UI check in Task 9.

---

### Task 1: The communication log module

**Files:**
- Create: `src/comms-log.mjs`
- Test: `electron/test/comms-log.test.mjs`

**Interfaces:**
- Produces:
  - `class CommsLog { constructor({ file?, newId?, now?, cap? = 50000 }) }`
  - `append({ id?, kind, fromKey, toKey, from, to, text, status }) -> Event` — writes the line synchronously
    (`appendFileSync`), returns the public form.
  - `status(ref: string, status: string) -> Event | null` — null when `ref` is unknown; for `"delivered"` also null
    unless the ref's last status is `queued` or `awaiting-reopen`.
  - `lastStatus(id) -> string | undefined`
  - `eventsOf(keys: Iterable<string>) -> Event[]` — message events with `fromKey` or `toKey` in keys, plus the
    status events of those, in append order.
  - `text(id) -> string | null` — the stored (cut) text, read from the file at the event's offset.
  - `purge(key) -> number` — drops events naming `key` and their status events from memory, schedules a rewrite
    (debounced ~1 s, `unref`'d; `flush()` forces it for tests).
  - `onAppend(fn: (Event) => void)` — listeners, throws swallowed.
  - `Event = { id, ts, kind, fromKey, toKey, from, to, size, preview, status, ref? }` (no `text`).
- File line = Event without `preview`, plus `text`.

- [ ] **Step 1: Write the failing tests**

```js
test("append returns the public form with preview and size, and the line holds the cut text", ...)
  // text of 70 000 chars: event.size === 70000, event.preview.length === 301 (300 + "…"),
  // log.text(event.id).length === 65537 and ends with "…"; no "text" key on the event
test("a reloaded log has the same events in order", ...)
test("a corrupt middle line and a half-written last line are skipped", ...)
  // write two good lines, "{broken", a good line, '{"id":"x","ts"' (no newline) -> 3 events, then append works
test("status: unknown ref -> null; delivered only after queued or awaiting-reopen; once", ...)
  // append status:"queued" -> status(id,"delivered") is an event; again -> null; status(id,"taken") is an event
test("eventsOf: by fromKey or toKey, status events follow their message", ...)
test("purge drops the key's events and their statuses, also from the file after flush", ...)
test("the cap keeps the newest events at load", ...) // cap: 3, five lines -> the last three, file rewritten
test("onAppend listeners get every appended event; a throwing listener does not break append", ...)
```

- [ ] **Step 2: Run** `node --test electron/test/comms-log.test.mjs` — expected FAIL (module missing).
- [ ] **Step 3: Implement `src/comms-log.mjs`.** Memory holds `{ event, offset, length }` per id and an ordered array;
  offsets are byte offsets (`Buffer.byteLength`) of each line. Rewrite = write to `file.tmp`, `renameSync` (as
  `delegation-store.mjs`). Missing directory → `mkdirSync(recursive)`.
- [ ] **Step 4: Run** the test file — expected PASS.
- [ ] **Step 5: Commit** `feat(comms): durable communication log`.

### Task 2: Broker write points

**Files:**
- Modify: `src/delegation.mjs` (constructor, `setTask`, `report`, `appMessage`, `userMessage`, `messageClosed`,
  `answerReopen`, `#release`, `#forget`, `#notice`, `#inform`, `#endedNotice`, `attached`, `ack`, `#deliver`,
  `snapshot`)
- Modify: `src/delegation-store.mjs` (return the dropped items from `forget` and `dropAwaiting`; `isEndedNotice(key)`)
- Modify: `src/registry.mjs` (`send`, `sendFromUser`, `#deliver` returns `true` when pushed)
- Test: `electron/test/comms-broker.test.mjs`

**Interfaces:**
- Consumes: `CommsLog` (Task 1).
- Produces:
  - `new Delegation({ ..., comms })` and `registry.comms = comms` (both optional; absent = no logging).
  - `Delegation.ack(key, id, outcome = "taken") -> boolean`.
  - `snapshot()` items gain `endedNotice: boolean`; `#deliver` pushes `fromKey` when the item has one.

Event per path (spec §2 table, exact):
- `setTask`: only when the log has no `task` event to this child yet → `task`, from the parent, `delivered`.
- `Registry.send`: budget block → `message` `blocked`; non-app recipient → `message`, `delivered` if
  `#deliver` pushed else `queued`. App recipients are logged by `appMessage` only (no double event).
- `messageClosed`: budget block → `blocked`; queued → `message` `awaiting-reopen` with the item's id.
- `appMessage` / `report`: id = the item id; status from `#deliver`'s result.
- `answerReopen`: approved → `status delivered` only for items whose `#deliver` returned true; rejected → `dropped`
  per item. `#release` and `#forget`: `dropped` per dropped item; then `#forget` calls `comms.purge(key)`.
- `#notice` (id = item id, status by delivery), `#inform` (`delivered`), `#endedNotice` (via `#notice`): `notice`,
  `fromKey: null`, `from: "relay"`.
- `userMessage` and `sendFromUser` for non-app peers: `user`, `fromKey: null`, `from: "user"`.
- `attached`: for each redelivered item `status(id, "delivered")` (Task 1 makes it once).
- `ack`: `status(id, outcome)`.

- [ ] **Step 1: Write the failing tests** (use the `setup()` pattern of `delegation-broker.test.mjs` plus a
  `CommsLog` in the temp dir):

```js
test("setTask logs one task event; a second setTask does not", ...)
test("send_message between app sessions logs one message event with the outbox id", ...)
test("send_message to a non-app peer logs delivered, to an offline one queued", ...)
test("a budget block logs blocked (Registry.send and messageClosed)", ...)
test("report logs report delivered; to an offline parent queued, then attached logs delivered once", ...)
  // attached called twice -> exactly one status delivered for that id
test("messageClosed logs awaiting-reopen; approve with the target still closed logs no status; attached does", ...)
test("rejected reopen, release and forget log dropped; forget purges the key", ...)
test("notices and informs log notice from relay; userMessage logs user", ...)
test("ack logs taken by default and discarded with the outcome", ...)
test("snapshot has endedNotice; the push carries fromKey", ...)
test("without comms nothing changes (no throw)", ...)
```

- [ ] **Step 2: Run** `node --test electron/test/comms-broker.test.mjs` — FAIL.
- [ ] **Step 3: Implement** the write points listed above. `Delegation` uses a private `#log(fields)` that is a no-op
  without `comms`; names come from `#nameOf`/peer names.
- [ ] **Step 4: Run** `npm test` — the new file passes and all existing tests still pass.
- [ ] **Step 5: Commit** `feat(comms): log every message path in the broker`.

### Task 3: Broker routes, control event and the relay client

**Files:**
- Modify: `server.mjs` (create `CommsLog`, pass it to `Delegation` and `registry.comms`; GET link routes get
  `Object.fromEntries(url.searchParams)`; `POST /api/peer/ack` passes `outcome`; `comms.onAppend` → `control("comms",
  { event })` to every app peer)
- Modify: `src/links-api.mjs` (`linksRoutes({ delegation, comms, registry })`: `GET /api/comms`, `GET /api/comms/text`)
- Modify: `extension/copilot-relay/relay-client.mjs` (`fetchComms(key)`, `fetchCommsText(id)`, `onComms` for the
  `comms` event, `ack(id, outcome)`)
- Test: `electron/test/comms-api.test.mjs`

**Interfaces:**
- Consumes: Task 1, Task 2.
- Produces:
  - `GET /api/comms?key=cli:<id>` → `200 { root, keys, events, peers }`; missing key → 400.
    `peers[key] = { name, online, busy, kind }` for the root, every descendant and every `fromKey`/`toKey` of the
    events (registry first, else stored link name, else `nameOf`).
  - `GET /api/comms/text?id=<id>` → `200 { text }` | `404`.
  - `RelayClient.fetchComms(key = this.key) -> Promise<{root,keys,events,peers}>`,
    `fetchCommsText(id) -> Promise<string|null>`, `onComms(event)` callback, `ack(id, outcome?)`.

- [ ] **Step 1: Write the failing tests:**

```js
test("GET /api/comms from a grandchild returns the root, all keys and their events", ...)
test("GET /api/comms lists outside counterparts in peers with their online state", ...)
test("GET /api/comms for an unknown key: itself only, no events", ...)
test("GET /api/comms/text returns the stored text; unknown id 404", ...)
test("the relay client gets comms control events and acks with an outcome", ...)
  // http server around linksRoutes as in links-api.test.mjs
```

- [ ] **Step 2: Run** `node --test electron/test/comms-api.test.mjs` — FAIL.
- [ ] **Step 3: Implement** the routes, the dispatcher change and the client calls. The root is found by following
  `store.parentOf` up (stop on a cycle).
- [ ] **Step 4: Run** `npm test` — PASS (the existing `links-api` tests too).
- [ ] **Step 5: Commit** `feat(comms): serve the tree's events and push new ones`.

### Task 4: Main and preload

**Files:**
- Create: `electron/comms-forward.mjs`
- Modify: `electron/main.mjs` (`onComms` in the relay client options ~line 181; `comms:get`, `comms:text` handlers;
  `relay:ack` takes `outcome`; a `brokerGetJson(path)` helper next to `brokerGetLinks` ~265)
- Modify: `electron/preload.cjs` (`getComms(sessionId)`, `getCommsText(sessionId, id)`,
  `onCommsEvent(fn)`, `relayAck(sessionId, id, outcome)`)
- Test: `electron/test/comms-forward.test.mjs`

**Interfaces:**
- Consumes: Task 3.
- Produces:
  - `createCommsForward({ send, max = 2000 }) -> (event) => void` — forwards each event id once as
    `send("comms:event", event)`, remembers the last `max` ids.
  - IPC `comms:get(sessionId) -> {root,keys,events,peers} | { unsupported: true } | { error }` (404 → unsupported),
    `comms:text(sessionId, id) -> { text } | { error }`. Through the open view's relay client when there is one,
    else `brokerGetJson`.
  - Renderer API: `api.getComms`, `api.getCommsText`, `api.onCommsEvent`, `api.relayAck(sessionId, id, outcome)`.

- [ ] **Step 1: Write the failing test:** `"each event id is forwarded once, also from several sessions"`,
  `"old ids fall out after max"`.
- [ ] **Step 2: Run** `node --test electron/test/comms-forward.test.mjs` — FAIL.
- [ ] **Step 3: Implement** `comms-forward.mjs`, then wire main and preload (one forwarder for the whole app).
- [ ] **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(comms): main forwards the log to the window`.

### Task 5: The renderer model

**Files:**
- Create: `electron/renderer/comms-model.js` (global `CommsModel`, `module.exports`)
- Test: `electron/test/comms-model.test.mjs`

**Interfaces:**
- Produces `CommsModel.build(input) -> Model`, where
  - `input = { comms: {root,keys,events,peers} | null, links, heldByKind, current, live, now, filter }`;
    `live[sessionId] = { ctx?: {pct, level}, keeper?: {phase, pingsSent, pings, compactAt}, cards?: [{kind,id,name?}] }`
    (session ids bare, as `tree`); `filter = null | { node } | { from, to }`.
  - `Model = { nodes, edges, rows, stats, unsupported }`
  - `node = { id, name, inTree, released, parent, depth, state, waitingSince?, ctx?, keeper?, cards, badges: {relay, user}, sent, received, current }`;
    `state ∈ "working" | "idle" | "waiting-task" | "closed" | "proposed"`.
  - `edge = { from, to, tree: boolean, count, size, last, live: null | "in-progress" | "waiting-report" | "waiting-reply" | "ended-no-report" | "awaiting-reopen", since?, held }`.
  - `row = { id, ts, kind, from, to, size, preview, status }` (latest status folded in), filtered, in time order.
  - `stats = { messages, size, avgTaskToReport: ms | null, heldNow, discarded, dropped, blocked }` over the filtered rows.
- Also `CommsModel.inTree(tree, sessionId) -> boolean` (has a parent or children) for the button.

- [ ] **Step 1: Write the failing tests** (one per row of the spec's live-state table plus):

```js
test("tree nodes from links, outside counterparts from events, a released child marked", ...)
test("a renamed session stays one node; rows keep the name at the time", ...)
test("working child: node working, parent edge in-progress since the task event", ...)
test("not reported: child->parent edge waiting-report; endedNotice -> ended-no-report", ...)
test("idle after report: waiting-task", ...)
test("waiting-reply only after a message with no answer back", ...)
test("held badge from heldByKind; relay/user badges on the recipient, not nodes", ...)
test("create card -> a proposed ghost node under its parent", ...)
test("closed session and awaiting-reopen edge", ...)
test("ctx and keeper copied onto the node", ...)
test("status events fold into rows; redelivery does not add a row", ...)
test("stats: totals, avg task->report over reported children only, counts by status", ...)
test("filter by node and by edge narrows rows and stats", ...)
test("comms null (old broker): nodes and live state from links, rows empty, unsupported true", ...)
```

- [ ] **Step 2: Run** `node --test electron/test/comms-model.test.mjs` — FAIL.
- [ ] **Step 3: Implement `comms-model.js`.** Keys from the broker are `cli:<id>`; strip to bare ids like
  `SessionTree.index`. Tree membership and order come from `SessionTree.index(links)` (`createdAt`).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(comms): renderer model of the tree's communication`.

### Task 6: The graph layout

**Files:**
- Create: `electron/renderer/comms-layout.js` (global `CommsLayout`, `module.exports`)
- Test: `electron/test/comms-layout.test.mjs`

**Interfaces:**
- Consumes: `Model.nodes`/`edges` (Task 5).
- Produces `CommsLayout.layout(nodes, edges, { width, height, font, minNode = 140 }) -> { width, height, scrollX, scrollY, nodes: [{ id, x, y, w, h }], edges: [{ from, to, path, labelX, labelY }] }`.
  - Coordinates in px of the SVG; `width`/`height` ≥ the area; `scrollX/Y` true when larger than the area.
  - Node size grows with the room (largest that fits), never below `minNode` × (`font` × 3.2) height.
  - A generation wider than the area wraps into rows under its parent.
  - Outside nodes in a right-hand column; tree edges straight, others as quadratic arcs avoiding node boxes;
    opposite directions of a pair are offset so both labels show.

- [ ] **Step 1: Write the failing tests:**

```js
test("root and two children at 420x300 fit without scroll, nodes larger than the minimum", ...)
test("twelve children at 280 px wrap into rows; node width >= 140; scroll only vertical if rows exceed the height", ...)
test("a deep chain larger than the area scrolls; no node below the minimum", ...)
test("outside nodes sit right of the tree; their edges are arcs", ...)
test("a pair in both directions gets two offset edges with distinct label points", ...)
test("a larger area gives larger nodes (fit grows)", ...)
```

- [ ] **Step 2: Run** `node --test electron/test/comms-layout.test.mjs` — FAIL.
- [ ] **Step 3: Implement** the layout (tidy tree by generation; scale = min(fitX, fitY) clamped at the minimum).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(comms): graph layout that fits the panel`.

### Task 7: The panel slot and the switch

**Files:**
- Modify: `electron/renderer/ui-state.js` (`slotPanel`, `clampSplit`)
- Modify: `electron/renderer/app.js` (`loadUi`/`saveUi` fields; `SessionView` constructor ~368-463: a
  `commsBtn`, `aside.comms-panel` sibling in `chat-row`; `updatePanelShown`, `layoutPanel`, `togglePanel`,
  `hidePanel`, `revealPanel`, `setDrawer` work on the visible panel; a per-view `pendingCards` list maintained
  where create, permission and link cards are shown and answered/dismissed, and from `reopenRequests`)
- Modify: `electron/renderer/style.css` (`.comms-panel` shares `.activity-panel` rules)
- Test: `electron/test/ui-state.test.mjs`

**Interfaces:**
- Produces:
  - `UiState.slotPanel(choice, activityAvailable, commsAvailable) -> "activity" | "comms" | null` — the choice if
    available, else the other if available, else null.
  - `UiState.clampSplit(ratio, total, min = 120) -> ratio`.
  - `SessionView.panelKind` (the shown one), `SessionView.showPanel(kind)`, `SessionView.pendingCards`
    (`[{ kind: "create"|"permission"|"link"|"reopen", id, name? }]`), and a view event `cardsChanged` that calls
    the global `commsRefresh()` (Task 8).

- [ ] **Step 1: Write the failing tests:** `slotPanel` (6 cases incl. both unavailable → null) and `clampSplit`
  (default, out of range, too small total).
- [ ] **Step 2: Run** `node --test electron/test/ui-state.test.mjs` — FAIL.
- [ ] **Step 3: Implement** `ui-state.js` functions, then the slot in `app.js`: Activity keeps "available while it
  has entries"; Communication is available while `CommsModel.inTree(tree, sessionId)`; clicking the hidden one's
  button switches (`ui.rightPanel`, `saveUi`, reveal); clicking the shown one collapses as today. Re-evaluate the
  slot in `setLinks` and in `updatePanelShown`.
- [ ] **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(comms): one right-hand slot for Activity or Communication`.

### Task 8: The Communication view

**Files:**
- Create: `electron/renderer/comms-view.js` (global `CommsView`)
- Modify: `electron/renderer/index.html` (scripts `comms-model.js`, `comms-layout.js`, `comms-view.js` before `app.js`)
- Modify: `electron/renderer/app.js` (a global per-tree cache `commsByRoot`; `commsRefresh()`; fetch on view open
  and on `setLinks` when the tree's root changed; `api.onCommsEvent` appends to the cache of the tree that holds
  `fromKey`/`toKey`; re-render the shown Communication panels on links, comms events, usage (`api.onUsage`),
  keeper state changes and `cardsChanged`; a 1 s ticker only while some node has a timer)
- Modify: `electron/renderer/style.css` (graph, states, split bar, summary, log rows; light and dark)

**Interfaces:**
- Consumes: Tasks 4–7.
- Produces `CommsView.create({ h, el, on: { openSession(id), fetchText(id) -> Promise<string> } }) -> { render(model, layoutInput), destroy() }`;
  filter clicks call back into app.js which rebuilds the model with the filter.

Behaviour (spec §6): graph area (SVG from `CommsLayout`, re-laid on the panel's ResizeObserver; node and edge
`<title>` tooltips with counts, sizes and the last time; state classes from `node.state`/`edge.live`), split bar dragged
vertically (`ui.commsSplit`, `UiState.clampSplit`, saved on pointer up), summary bar, log rows with expand (async
`fetchText`, error keeps the preview), scroll-follow of the log, click node/edge = filter, click empty space or the
filter chip = clear, double click node = `activate(id)`. `unsupported` → the old-broker hint in the log.

- [ ] **Step 1: Implement** the view and the wiring.
- [ ] **Step 2: Run** `npm test` — PASS; start the app (`npm --prefix electron start`) with a scripted tree and look
  at both themes, 280 px and wide.
- [ ] **Step 3: Commit** `feat(comms): the Communication panel`.

### Task 9: UI checks

**Files:**
- Modify: `scripts/ui-check/checks.mjs` (new checks; the `link-e2e` pattern with `broker: true`)

Checks:
- `comms-switch`: a session without a tree has no Communication button; with a child it has; switching shows
  exactly one of the two panels; the choice survives a reload.
- `comms-graph-e2e` (broker): parent with two children → three nodes; a child working → `working` class and the
  parent edge `in-progress`; after `report_result` → `waiting-task` and a `report` row; row expand shows the full text.
- `comms-split`: dragging the bar changes and persists `commsSplit`; both parts ≥ 120 px.
- `comms-narrow`: at a narrow window the panel is the drawer, labels keep the UI font, the graph area scrolls.
- `comms-same-tree`: activating another session of the tree shows the same nodes; releasing the child hides its
  button and shows Activity (Review Focus 5).

- [ ] **Step 1: Run** `npm --prefix electron run copy-relay`.
- [ ] **Step 2: Write** the checks.
- [ ] **Step 3: Run** `node scripts/ui-check/run.mjs comms-switch comms-graph-e2e comms-split comms-narrow comms-same-tree` — all pass.
- [ ] **Step 4: Run** the full `node scripts/ui-check/run.mjs` and `npm test` — all pass.
- [ ] **Step 5: Commit** `test(comms): UI checks for the Communication panel`.
