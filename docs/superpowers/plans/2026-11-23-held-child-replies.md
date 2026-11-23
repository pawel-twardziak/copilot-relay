# Held Child Replies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Messages from a session's direct children wait in a list of their own in the parent's view until the user
approves them one by one; a per-chat switch (on by default) turns this off.

**Architecture:** The broker marks every message a child sends to its parent (`fromChild`, set at send time, stored
on the outbox item) and stores the child's `send_message` durably like a report. It also counts unacknowledged marked
items per parent in `GET /api/links`. The app's main process forwards the mark, keeps marked messages in memory until
acknowledged (replayed to a reloaded window), and stores the switch per session. The renderer keeps held messages in
`SessionView.held`, separate from the queue; approving moves one into the queue with the existing `enqueue`.

**Tech Stack:** Node.js ESM (broker, Electron main), classic scripts in the renderer, `node --test`, the UI checks in
`scripts/ui-check/`.

**Spec:** `docs/superpowers/specs/2026-11-23-held-child-replies-design.md`

## Global Constraints

- Only messages from **direct** children are held: `report_result`, and `send_message` whose sender's `parentKey` is
  the recipient. Never `from: "relay"` notices, never the parent's messages, never `from: "user"`.
- `fromChild` is computed when the child sends and travels on the stored item; a later `release_session` does not
  change it.
- The durable child `send_message` path is used only when the recipient is a desktop-app session (`peer.app`).
- A held message is acknowledged to the broker only when its approved prompt starts (`deliveryAck`) or when it is
  discarded (✕). Never by being held.
- The queue code (`pump`, `deliverMidTurn`, pause on Stop, `followUp.afterTurn`, `takeBack`) is not changed.
- The switch is per session, default on; only "off" is stored, in `userData/held-replies.json`.
- Existing `delegations.json` files and an old `links-cache.json` (a bare array) load unchanged.
- Wait note threshold: 60 000 ms. Note text, exactly:
  `(This reply waited N min for your user's approval. The list of your children above may be out of date: call list_sessions for their current state.)`
  with `N` = whole minutes, rounded down, at least 1.
- Labels: list title `Replies from sub-sessions (N)`; buttons `Approve`, `✕`; switch `Approve replies from sub-sessions`;
  idle status `1 reply waiting for approval` / `N replies waiting for approval`; discard line
  `Discarded a reply from <name>.`; sidebar mark `⏸ N` with title `N replies from sub-sessions wait for your approval`
  (`1 reply … waits …`); dead-view resume line `N replies from sub-sessions will come back when the session is open again.`;
  notification title `A sub-session replied`, body `<child name>`.
- Text from the model is shown as plain text only (`textContent`, the `h()` helper), never as HTML.
- Tests: `npm test` (`node --test electron/test/*.test.mjs`); UI checks: `node scripts/ui-check/run.mjs <name>`.
- Commit messages follow the repo style (`feat(relay): …`, `feat(desktop): …`, `test(desktop): …`, `docs: …`) and end
  with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A message redelivered by the broker after a reconnect while it is already held or queued in a live view must not
   appear twice (`acceptDelivery` with the shared `seenDeliveries`). Test: Task 4, "a redelivered held message is
   ignored".
2. Approving the last held message while an interrupted task waits must still lead to the continue prompt (the
   approved item goes through `enqueue`, nothing else). Test: Task 4 UI check step "approve while busy".
3. A child renamed between sending and approval: the row shows the name from the message, the sidebar count (keyed by
   the parent) is unchanged. Test: Task 1, "a marked item is counted for its parent after the child is renamed and
   released".
4. A held message whose parent's view comes back dead: Approve disabled, ✕ works, ids leave `seenDeliveries` on a dead
   resume. Test: Task 4 UI check step "dead parent".
5. A broker without `held` in `/api/links` (old broker) or a bare-array cache file: the sidebar shows no mark and
   nothing throws. Test: Task 2, "readLinksCache accepts an old array file"; Task 3, `sidebarCount` with
   `brokerHeld` undefined.

---

### Task 1: Broker — the mark, the durable child message, the count

**Files:**
- Modify: `src/registry.mjs` (`constructor`: new hook `childMessage`; `send`)
- Modify: `src/delegation.mjs` (`report`, `messageClosed`, `#deliver`, `ack`, new `childMessage`, new `heldCounts`)
- Modify: `src/delegation-store.mjs` (new `marked()`)
- Modify: `server.mjs` (wire `registry.childMessage` next to `registry.decorate`)
- Modify: `src/links-api.mjs` (`GET /api/links`)
- Test: `electron/test/delegation-broker.test.mjs`, `electron/test/links-api.test.mjs`

**Interfaces:**
- Produces:
  - Outbox item fields (optional): `fromChild: true`, `fromKey: string` (the child's key).
  - Pushed message field (optional): `fromChild: true` (from `Delegation.#deliver` when the item has it).
  - `Registry#childMessage: ((fromKey: string, toKey: string, text: string) => boolean) | null` — true when the
    message was taken over (stored and delivered or stored for later); `send` then skips its own `#deliver`.
  - `Delegation.childMessage(fromKey: string, toKey: string, text: string): boolean`
  - `Delegation.heldCounts(): Record<string, number>` — parent key → number of outbox items with `fromChild` and no
    `awaiting`.
  - `DelegationStore.marked(): object[]` — outbox items with `fromChild === true` and no `awaiting`.
  - `GET /api/links` → `{ links: snapshot[], held: Record<string, number> }`.
  - `Delegation.onChange` listeners fire when a marked item is stored or acknowledged.

- [ ] **Step 1: Write the failing tests** in `delegation-broker.test.mjs` (use `setup()`; child `cli:child`, parent
  `cli:parent`, both `app: true`):

```js
test("a report is marked fromChild on the push and on the stored item", () => {
  const { d, store, parentPush } = setup();
  d.report("cli:child", "wynik");
  assert.equal(parentPush[0].fromChild, true);
  assert.equal(store.pending("cli:parent")[0].fromChild, true);
  assert.equal(store.pending("cli:parent")[0].fromKey, "cli:child");
});

test("send_message from a child to an app parent is stored, marked and redelivered until acked", () => {
  const s = setup();
  s.registry.childMessage = (f, t, x) => s.d.childMessage(f, t, x);
  const reply = s.registry.send("cli:child", s.registry.get("cli:parent").name, "pytanie");
  assert.match(reply, /^Message to .* delivered/);
  assert.equal(s.parentPush.length, 1);
  assert.equal(s.parentPush[0].fromChild, true);
  assert.ok(s.parentPush[0].deliveryId);
  assert.equal(s.parentPush[0].wake, true);
  assert.equal(s.store.pending("cli:parent").length, 1);
  s.d.attached("cli:parent");
  assert.equal(s.parentPush.length, 2);
  assert.equal(s.parentPush[1].deliveryId, s.parentPush[0].deliveryId);
  assert.ok(s.d.ack("cli:parent", s.parentPush[0].deliveryId));
  assert.equal(s.store.pending("cli:parent").length, 0);
});

test("parent to child, non-relatives and relay notices carry no mark", () => {
  const s = setup();
  s.registry.childMessage = (f, t, x) => s.d.childMessage(f, t, x);
  s.registry.send("cli:parent", s.registry.get("cli:child").name, "zadanie");
  assert.equal(s.childPush[0].fromChild, undefined);
  s.d.outcome("cli:parent", { kind: "rejected", text: "no" });
  assert.equal(s.parentPush.at(-1).fromChild, undefined);
  s.registry.upsert({ key: "cli:x", name: "obcy", kind: "cli", app: true, push: () => true });
  s.registry.send("cli:x", s.registry.get("cli:parent").name, "hej");
  assert.equal(s.parentPush.at(-1).fromChild, undefined);
});

test("a child message to a terminal (non-app) parent keeps today's path", () => {
  const s = setup();
  s.registry.get("cli:parent").app = false;
  s.registry.childMessage = (f, t, x) => s.d.childMessage(f, t, x);
  s.registry.send("cli:child", s.registry.get("cli:parent").name, "pytanie");
  assert.equal(s.parentPush[0].fromChild, undefined);
  assert.equal(s.store.pending("cli:parent").length, 0);
});

test("a child's message to a closed parent is marked when the reopen is approved", () => {
  // the parent goes offline, the child messages it (messageClosed), the parent approves… the released item is marked
  // assert: store.awaitingFor(requestId)[0].fromChild === true; after answerReopen(…, true) and attached("cli:parent"),
  // the push to the parent has fromChild === true
});

test("heldCounts counts marked, unacked, non-awaiting items per parent and changes fire", () => {
  const s = setup();
  let changes = 0;
  s.d.onChange(() => changes++);
  s.d.report("cli:child", "wynik");
  assert.deepEqual(s.d.heldCounts(), { "cli:parent": 1 });
  const before = changes;
  s.d.ack("cli:parent", s.parentPush[0].deliveryId);
  assert.deepEqual(s.d.heldCounts(), {});
  assert.ok(changes > before, "an ack of a marked item is a change");
});

test("a marked item is counted for its parent after the child is renamed and released", () => {
  // linkSetup(): adopt cli:c under cli:p (requestLink + answerLink approved), cli:c reports, rename cli:c
  // (registry.rename or upsert with a new name), release (requestLink "release" + answerLink approved)
  // assert: d.heldCounts()["cli:p"] === 1; the pending item still has fromChild === true
});
```

  In `links-api.test.mjs`:

```js
test("GET /api/links answers links and held", () => {
  // build routes with a delegation stub { snapshot: () => [], heldCounts: () => ({ "cli:p": 2 }) }
  // assert: status 200, json deepEqual { links: [], held: { "cli:p": 2 } }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test electron/test/delegation-broker.test.mjs electron/test/links-api.test.mjs`
Expected: the new tests FAIL (`fromChild` undefined, `childMessage` / `heldCounts` not a function).

- [ ] **Step 3: Implement**
  - `Registry.send`: after the budget charge and the `message` event, when `from.parentKey === to.key && to.app &&
    this.childMessage?.(from.key, to.key, text)`, skip `#deliver`; the reply text is computed as today.
  - `Delegation.childMessage`: build the item as `report` does (`from: child.name`, `fromCwd`, `prompt:
    relayPrompt(...)`) plus `fromChild: true, fromKey`, `store.enqueue`, `#changed()`, `#deliver`; return true.
  - `report`: add `fromChild: true, fromKey: callerKey` to its item.
  - `messageClosed`: when the target is the sender's parent, add `fromChild: true, fromKey: fromKey` to the awaiting
    item.
  - `#deliver`: pass `fromChild: true` when the item has it.
  - `ack`: if the removed item had `fromChild`, `#changed()`.
  - `DelegationStore.marked()` and `Delegation.heldCounts()`.
  - `server.mjs`: `registry.childMessage = (f, t, x) => delegation.childMessage(f, t, x);`
  - `links-api.mjs`: `json: { links: delegation.snapshot(), held: delegation.heldCounts() }`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all PASS (the existing `link-e2e` and `links-api` tests that read `.links` keep passing).

- [ ] **Step 5: Commit**

```bash
git add src/registry.mjs src/delegation.mjs src/delegation-store.mjs server.mjs src/links-api.mjs electron/test/delegation-broker.test.mjs electron/test/links-api.test.mjs
git commit -m "feat(relay): the broker marks and stores the messages a child sends its parent and counts them"
```

### Task 2: App main process — the mark, the cache of held messages, the switch, the count

**Files:**
- Create: `electron/held-replies.mjs`
- Modify: `extension/copilot-relay/relay-client.mjs` (new `fetchLinkState`)
- Modify: `electron/links-cache.mjs` (`readLinksCache`, `writeLinksCache` take/return `{ links, held }`)
- Modify: `electron/main.mjs` (`relayStart` `onMessage`, `loadLinks`, `brokerGetLinks`, `links:get`, `relay:ack`,
  `resumeSession` already-open branch, `closeEntry`, the `exit` handler, the fork at `tiers.copy`, the delete at
  `tiers.delete`, new IPC `held:get`, `held:set`)
- Modify: `electron/preload.cjs` (`getHoldReplies`, `setHoldReplies`; `getLinks`/`onLinks` now carry `{ links, held }`)
- Test: `electron/test/held-replies-main.test.mjs` (new), `electron/test/links-cache.test.mjs`, `electron/test/relay-client.test.mjs`

**Interfaces:**
- Consumes: Task 1's `GET /api/links` → `{ links, held }`, pushed `fromChild`.
- Produces:
  - `createHoldStore(file: string): { get(id: string): boolean, set(id: string, on: boolean): void, copy(from: string, to: string): void, delete(id: string): void }` — `get` is true unless "off" was stored.
  - `createHeldCache(): { add(sessionId: string, msg: object): boolean, ack(sessionId: string, deliveryId: string): void, list(sessionId: string): object[], drop(sessionId: string): void }` — `add` returns false for a `deliveryId` already cached (no second notification); `list` in arrival order.
  - `RelayClient.fetchLinkState(): Promise<{ links: object[], held: Record<string, number> }>` (`held` = `{}` when the broker sent none). `fetchLinks` stays.
  - `readLinksCache(file): { links: object[], held: Record<string, number> }` (an old array file → `{ links: thatArray, held: {} }`); `writeLinksCache(file, { links, held })`.
  - Window events: `relay:message` payload gains `fromChild` (boolean, `true` only when the broker sent it);
    `links:update` payload is `{ links, held }`; `links:get` returns `{ links, held }`.
  - IPC: `held:get(sessionId) → boolean`, `held:set(sessionId, on: boolean) → void`.
  - Preload: `api.getHoldReplies(sessionId)`, `api.setHoldReplies(sessionId, on)`.

- [ ] **Step 1: Write the failing tests** in `held-replies-main.test.mjs`:

```js
test("the hold switch is on by default and only off is stored", () => {
  // file in a temp dir; s = createHoldStore(file)
  // assert s.get("a") === true; s.set("a", false) → get false, file JSON deepEqual { a: false }
  // s.set("a", true) → get true, file JSON deepEqual {}; a new store on the same file reads the same
});
test("the hold switch is copied on a fork and deleted with the session", () => {
  // set("a", false); copy("a", "b") → get("b") false; delete("a") → get("a") true
});
test("the held cache keeps marked messages per session in arrival order until acked", () => {
  // c = createHeldCache(); add("s", {deliveryId:"1"}) true; add("s", {deliveryId:"2"}) true; add("s", {deliveryId:"1"}) false
  // list("s").map(m=>m.deliveryId) deepEqual ["1","2"]; ack("s","1") → ["2"]; drop("s") → []
});
```

  In the links-cache test:

```js
test("readLinksCache accepts an old array file", () => {
  // write "[{\"key\":\"cli:a\"}]" → deepEqual { links: [{ key: "cli:a" }], held: {} }
});
test("writeLinksCache and readLinksCache keep held", () => {
  // write { links: [], held: { "cli:p": 2 } } → read deepEqual the same; missing file → { links: [], held: {} }
});
```

  In `relay-client.test.mjs`: `fetchLinkState` against a stub server answering `{ links: [], held: { "cli:p": 1 } }`
  returns it; against `{ links: [] }` returns `held: {}`.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test electron/test/held-replies-main.test.mjs electron/test/relay-client.test.mjs electron/test/links-cache.test.mjs`
Expected: FAIL (module not found / `fetchLinkState` not a function / array returned).

- [ ] **Step 3: Implement** `electron/held-replies.mjs` (the store follows `createTierStore` in
  `electron/context-tier.mjs`), `fetchLinkState`, the cache format, and the wiring in `main.mjs`:
  - `onMessage`: add `fromChild: m.fromChild === true` to the `relay:message` payload; when it is true and
    `m.deliveryId` is set, `heldCache.add(sessionId, payload)`, and on `true` call
    `notifyIfUnfocused("A sub-session replied", m.from)`.
  - `relay:ack`: also `heldCache.ack(sessionId, id)`.
  - `resumeSession`, already-open branch: after the card replays, `for (const m of heldCache.list(sessionId)) send("relay:message", m)`.
  - `closeEntry` and the `exit` handler: `heldCache.drop(sessionId)` next to `dropLinkCards`.
  - `loadLinks`: `client.fetchLinkState()` / `brokerGetLinks` returning `{ links, held }`; send and cache that object.
  - Fork: `holds.copy(sessionId, res.sessionId)` next to `tiers.copy`; delete: `holds.delete(sessionId)` next to
    `tiers.delete`.
  - `held:get` / `held:set` with `handle(...)`, the file `path.join(app.getPath("userData"), "held-replies.json")`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/held-replies.mjs electron/links-cache.mjs electron/main.mjs electron/preload.cjs extension/copilot-relay/relay-client.mjs electron/test/
git commit -m "feat(desktop): main keeps held replies until acknowledged, stores the switch per session and passes the broker's count"
```

### Task 3: Renderer rules — pure functions

**Files:**
- Create: `electron/renderer/held-replies.js` (classic script: sets `globalThis.HeldReplies`, `module.exports` for
  tests, like `message-queue.js`)
- Modify: `electron/renderer/message-queue.js` (`statusText` takes `held`)
- Modify: `electron/renderer/index.html` (load `held-replies.js` before `app.js`)
- Test: `electron/test/held-replies.test.mjs` (new), `electron/test/message-queue.test.mjs`

**Interfaces:**
- Produces:
  - `HeldReplies.WAIT_NOTE_MS = 60000`
  - `HeldReplies.approvedPrompt(prompt: string, arrivedAt: number, now: number): string` — `prompt` unchanged when
    `now - arrivedAt < 60000`, else `${prompt}\n\n${note}` with the note of Global Constraints.
  - `HeldReplies.sidebarCount({ view, brokerHeld, sessionId }): number` — `view.held.length` when `view` exists, else
    `brokerHeld?.[\`cli:${sessionId}\`] ?? 0`.
  - `HeldReplies.markTitle(n: number): string`, `HeldReplies.listTitle(n: number): string`.
  - `HeldReplies.showSwitch({ hasChildren: boolean, held: number }): boolean` — `hasChildren || held > 0`.
  - `MessageQueue.statusText({ …, held = 0 })`: when not busy, not dead, not deleting and `queued === 0` and
    `held > 0`: `1 reply waiting for approval` / `N replies waiting for approval`; otherwise unchanged.

- [ ] **Step 1: Write the failing tests**

```js
test("approvedPrompt adds the wait note from one minute on", () => {
  assert.equal(HeldReplies.approvedPrompt("P", 0, 59_999), "P");
  assert.equal(HeldReplies.approvedPrompt("P", 0, 60_000), `P\n\n(This reply waited 1 min for your user's approval. The list of your children above may be out of date: call list_sessions for their current state.)`);
  assert.match(HeldReplies.approvedPrompt("P", 0, 7 * 60_000 + 59_000), /waited 7 min/);
});
test("sidebarCount uses the view when there is one, else the broker's count", () => {
  assert.equal(HeldReplies.sidebarCount({ view: { held: [1, 2] }, brokerHeld: { "cli:a": 5 }, sessionId: "a" }), 2);
  assert.equal(HeldReplies.sidebarCount({ view: null, brokerHeld: { "cli:a": 5 }, sessionId: "a" }), 5);
  assert.equal(HeldReplies.sidebarCount({ view: null, brokerHeld: undefined, sessionId: "a" }), 0);
});
test("titles and the switch rule", () => {
  assert.equal(HeldReplies.markTitle(1), "1 reply from sub-sessions waits for your approval");
  assert.equal(HeldReplies.markTitle(3), "3 replies from sub-sessions wait for your approval");
  assert.equal(HeldReplies.listTitle(3), "Replies from sub-sessions (3)");
  assert.equal(HeldReplies.showSwitch({ hasChildren: false, held: 0 }), false);
  assert.equal(HeldReplies.showSwitch({ hasChildren: false, held: 1 }), true);
});
```

  In `message-queue.test.mjs`:

```js
test("statusText shows held replies only when idle with an empty queue", () => {
  assert.equal(MessageQueue.statusText({ held: 1 }), "1 reply waiting for approval");
  assert.equal(MessageQueue.statusText({ held: 2 }), "2 replies waiting for approval");
  assert.equal(MessageQueue.statusText({ held: 2, queued: 1 }), "1 message(s) waiting");
  assert.equal(MessageQueue.statusText({ held: 2, busy: true }), "Working…");
});
```

- [ ] **Step 2: Run to verify they fail** — `node --test electron/test/held-replies.test.mjs electron/test/message-queue.test.mjs`; FAIL.
- [ ] **Step 3: Implement** the module and the `statusText` change.
- [ ] **Step 4: Run** `npm test`; all PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(desktop): rules for held replies (wait note, sidebar count, titles)"`

### Task 4: Renderer — the held list, the switch, the sidebar mark

**Files:**
- Modify: `electron/renderer/app.js` (`SessionView` constructor: `held`, `holdReplies`, `heldEl`, `holdSwitch`;
  `incoming`; new `hold`, `approveHeld`, `discardHeld`, `setHoldReplies`, `renderHeld`; `showQueueStatus` passes
  `held`; the dead handling calls `renderHeld`; `reopenView`; `openSession` hand-over; `item` (sidebar mark);
  `setLinks`, `api.onLinks`, `api.getLinks` for `{ links, held }`; a global `heldByKey`)
- Modify: `electron/renderer/style.css` (`.held-*`, `.held-mark`)
- Modify: `scripts/ui-check/checks.mjs` (new check `held-replies`)

**Interfaces:**
- Consumes: Task 2's `relay:message.fromChild`, `{ links, held }`, `api.getHoldReplies`, `api.setHoldReplies`;
  Task 3's `HeldReplies.*`, `MessageQueue.statusText({ held })`.
- Produces (for the UI check and Task 5):
  - `SessionView#held: Array<{ id: number, from: string, text: string, prompt: string, fromCwd: string|null, deliveryId: string, arrivedAt: number }>`
  - `SessionView#holdReplies: boolean` (true until `api.getHoldReplies` answers)
  - `SessionView#approveHeld(item)`, `#discardHeld(item)`, `#setHoldReplies(on: boolean)`
  - DOM: `.held` strip (above `.queue`), rows `.held-row` with `.held-from`, `.held-time`, `.held-text`, buttons
    `.held-approve`, `.held-discard`; switch `input.held-switch` in `.status-bar`; sidebar `.held-mark`.

- [ ] **Step 1: Write the UI check** `held-replies` (`modes: ["off"]`, no broker; drive the view as `link-card` does,
  `V` = the active view). Steps and assertions:
  1. `firstTurn(app)`; `${V}.incoming({ from: "docs-9f8e7d", text: "first\nmore", prompt: "P1", deliveryId: "h1", fromChild: true, wake: true })`
     and the same for `h2` (`from: "tests-41ac0b"`): `.held-row` count 2, first row's `.held-from` is
     `docs-9f8e7d`, `.held-text` is `first`; `.queue` hidden; status `2 replies waiting for approval`; the sidebar
     row of the session has `.held-mark` with text `⏸ 2`.
  2. A redelivered held message is ignored: `incoming` again with `deliveryId: "h1"` → still 2 rows.
  3. A message without `fromChild` (`from: "relay"`) goes to the queue/prompt as today (no row added).
  4. Approve the second row (`.held-approve` of row 2): 1 row left, a turn starts with prompt `P2`, the bubble shows
     `from tests-41ac0b`.
  5. Approve while busy: during that turn approve `h1` → it shows in `.queue` as `from docs-9f8e7d:`, delivered after
     the turn (`queueMidTurn` off).
  6. ✕ discards: add `h3`, click `.held-discard` → no row, the log has `Discarded a reply from <from>.`.
  7. Switch off moves everything: add `h4`, `h5`; uncheck `.held-switch` → `.held` hidden, `.queue` or turns hold
     both, in order h4, h5; a new `fromChild` message goes straight to the queue; check it again → nothing moves back.
  8. The wait note: add `h6` with the view's clock stub (`Date.now` overridden in the page to `arrivedAt + 61_000`
     before approving) → the prompt sent ends with `call list_sessions for their current state.)`.
  9. Dead parent: add `h7`, mark the view dead (as the existing dead checks do) → `.held-approve` disabled,
     `.held-discard` enabled.
- [ ] **Step 2: Run it to verify it fails** — `node scripts/ui-check/run.mjs held-replies`; FAIL (no `.held-row`).
- [ ] **Step 3: Implement** in `app.js`:
  - `incoming(m)`: after `acceptDelivery` and the `wake === false` branch, `if (m.fromChild && m.deliveryId && this.holdReplies) return this.hold(m);`
  - `approveHeld(item)`: remove from `held`; `enqueue({ kind: "relay", text: item.text, prompt: HeldReplies.approvedPrompt(item.prompt, item.arrivedAt, Date.now()), from: item.from, human: false, fromCwd: item.fromCwd, deliveryId: item.deliveryId, command: false })`; `renderHeld()`; `renderList()`.
  - `discardHeld(item)`: remove, `api.relayAck(this.sessionId, item.deliveryId).catch(() => {})`, `this.system(\`Discarded a reply from ${item.from}.\`)`, `renderHeld()`, `renderList()`.
  - `setHoldReplies(on)`: `api.setHoldReplies(this.sessionId, on)`; when off, `approveHeld` every held item, oldest
    first (the one path, so a long wait gets its note here too).
  - Constructor: `held` from the constructor argument (default `[]`), `api.getHoldReplies(sessionId).then(...)`.
  - `reopenView` / `openSession`: hand `held` over like `queue`; when the new view is dead, delete each held
    `deliveryId` from `seenDeliveries` and `v.system("N replies from sub-sessions will come back when the session is open again.")`.
  - Sidebar `item()`: `const n = HeldReplies.sidebarCount({ view: v, brokerHeld: heldByKey, sessionId: s.sessionId })` → `n > 0 && h("span", { class: "held-mark", title: HeldReplies.markTitle(n) }, \`⏸ ${n}\`)` after the attention mark.
  - Switch visibility: `HeldReplies.showSwitch({ hasChildren: (tree.childrenOf.get(this.sessionId) ?? []).length > 0, held: this.held.length })`, re-evaluated in `renderRelations` and `renderHeld`.
  - `setLinks(next)`: accept `{ links, held }` (and an array, for safety); set `heldByKey = next.held ?? {}`.
- [ ] **Step 4: Run** `node scripts/ui-check/run.mjs held-replies` and `npm test`; all PASS. Also run the queue checks
  that exist today (`node scripts/ui-check/run.mjs` with the names containing `queue`) and `link-e2e`; PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(desktop): replies from sub-sessions wait for approval in their own list"`

### Task 5: End to end through a real broker, docs

**Files:**
- Modify: `electron/test/fixtures/acp/scripted-agent.mjs` (`relayTool`: also `send_message <to> <text>` →
  `{ to, text }`, `report_result <text>` → `{ text }`)
- Modify: `scripts/ui-check/checks.mjs` (new check `held-e2e`, built like `link-e2e` with `LINK_SCENARIO`,
  `settings: { relay: true }`, `broker: true`)
- Modify: `electron/README.md` (a paragraph in the delegated-sessions section), `README.md` if it lists relay
  behaviour

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the check** `held-e2e`: parent = the driver's session, child = a second session; link them with
  `adopt_session <child>` from the parent and approve the card (as `link-e2e` does). Then:
  1. In the child, prompt `send_message <parentName> hello parent` → the parent's view gets one `.held-row` with
     `.held-text` `hello parent`, no turn starts in the parent; `GET /api/links` answers `held["cli:<parent>"] === 1`.
  2. In the child, prompt `report_result done` → two rows, oldest on top.
  3. Approve the top row → a parent turn starts; after it, `GET /api/links` `held` count is 1.
  4. Reload the window (`app.reload()`) and open the parent → one `.held-row` again.
  5. ✕ it → `held` count 0 on the broker.
- [ ] **Step 2: Run** `node scripts/ui-check/run.mjs held-e2e`; FAIL before the scripted-agent change, PASS after.
- [ ] **Step 3: Update the READMEs** (what is held, the switch, that approving goes to the queue, "Update and restart
  broker").
- [ ] **Step 4: Run** `npm test` and `node scripts/ui-check/run.mjs`; all PASS.
- [ ] **Step 5: Commit** — `git commit -m "test(desktop): held replies through a real broker; docs"`

### Task 6: Manual check with real Copilot (with the user)

- [ ] After "Update and restart broker" with this branch: a parent creates two children (`create_session`), both
  report close together → two held rows, nothing runs in the parent until Approve; the switch off → both go;
  a closed parent shows `⏸ N` in the sidebar and holds them after opening. Record the outcome in the backlog file.
