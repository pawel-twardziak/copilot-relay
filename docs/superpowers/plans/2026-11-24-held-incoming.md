# Held Incoming Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A parent's orders, messages from other sessions, and the user's own messages sent during a turn wait in
lists of their own in the receiving chat until the user approves them; each list has its own per-chat switch.

**Architecture:** The broker stores every agent message and every relay-GUI message to a desktop-app session in the
delegation outbox and marks its kind when it is sent (`fromChild` as today, or `heldAs`). The app's main process
forwards the mark, caches marked messages until acknowledged and stores four switches per session. The renderer
keeps one held list with a kind per item; approving moves an item into the queue with the existing `enqueue`. Typed
messages never pass the broker: `send()` puts them in the held list while a turn runs.

**Tech Stack:** Node.js ESM (broker, Electron main), classic scripts in the renderer, `node --test`, the UI checks in
`scripts/ui-check/`.

**Spec:** `docs/superpowers/specs/2026-11-24-held-incoming-design.md` (extends
`docs/superpowers/specs/2026-11-23-held-child-replies-design.md`; read both).

## Global Constraints

- Kinds, exact values: `child` (wire mark `fromChild: true`, unchanged), `parent`, `other`, `user` (wire mark
  `heldAs: "parent" | "other" | "user"`). The mark is computed when the message is sent and stored on the outbox item.
- Never held: broker notices (`from: "relay"`), the first task of a new sub-session (no mark, no `deliveryId`), a
  message of the user while no turn is running.
- "A turn is running" is `SessionView.prompting`, not `SessionView.busy`.
- A held broker message is acknowledged only when its approved prompt starts or when it is discarded. Never by being
  held.
- The queue code (`pump`, `deliverMidTurn`, pause on Stop, `followUp.afterTurn`, `takeBack`) is not changed.
- Switches: per session and kind, default on, only "off" is stored, in `userData/held-replies.json`. A file of
  v0.22 to v0.24 (`{ "<sessionId>": false }` = `child` off) reads unchanged.
- Existing `delegations.json` and `links-cache.json` files load unchanged. `held` in `GET /api/links` keeps its
  meaning (child only); the new counts are in `heldByKind`.
- Recipients that are not desktop-app sessions (`peer.app` false) keep today's delivery path.
- Labels, exactly:
  - list titles: `Orders from parent (N)`, `Other sessions (N)`, `Your messages (N)`, `Replies from sub-sessions (N)`;
  - list order, top to bottom: `parent`, `other`, `user`, `child`, then the queue;
  - status bar: the text `Approve:` followed by four checkboxes labelled `Sub-session replies`, `Parent orders`,
    `Other sessions`, `My messages while busy` (in this order);
  - idle status: `1 message waiting for approval` / `N messages waiting for approval`;
  - sidebar mark `⏸ N`, title `1 message waits for your approval` / `N messages wait for your approval`;
  - discard lines: `Discarded a reply from <name>.` (child), `Discarded an order from <name>.` (parent),
    `Discarded a message from <name>.` (other), `Discarded your message.` (user);
  - dead-view line: `1 held message will come back when the session is open again.` /
    `N held messages will come back when the session is open again.`;
  - notifications: `A sub-session replied` (child, unchanged), `Your parent session sent a message` (parent),
    `Another session sent a message` (other); body `<sender> → <session name>`; none for `user`.
- Wait note (threshold 60 000 ms, `N` = whole minutes, at least 1), appended after a blank line:
  - child: unchanged;
  - parent: `(This message waited N min for your user's approval. The list of your relatives above may be out of date: call list_sessions for their current state.)`
  - other: `(This message waited N min for your user's approval.)`
  - user: none.
- Text from a model or another session is shown as plain text only (`textContent`, the `h()` helper).
- Tests: `npm test` at the repo root; UI checks: `node scripts/ui-check/run.mjs <name>`; before a check that uses the
  broker run `npm --prefix electron run copy-relay`.
- Commits follow the repo style (`feat(relay): …`, `feat(desktop): …`, `test(desktop): …`, `docs: …`) and end with the
  `Co-Authored-By` trailer your session's instructions give.

## Review Focus

1. The first task of a new sub-session reaches the child although "Parent orders" is on (no mark, no `deliveryId`).
   Test: Task 3 (`shouldHold` with `kind: null`), Task 4 UI check step 2.
2. A relay-GUI message that arrives while a view is only resuming (`busy`, no turn) starts its turn; the same message
   coming back after a reload is held. Test: Task 3 (`shouldHold`), Task 4 UI check step 5.
3. Switching one kind off releases that kind only, oldest first, and leaves the other lists alone. Test: Task 4 UI
   check step 7.
4. A typed message that is held when its session is closed or dies is asked about or reported, never dropped
   silently. Test: Task 5 UI check steps 4 and 5.
5. An old broker (no `heldAs`, no `heldByKind`) and a `held-replies.json` of v0.22: nothing throws, `child` works as
   before, the sidebar falls back to `held`. Test: Task 2 (`createHoldStore` legacy file, `readLinksCache`), Task 3
   (`sidebarCount`).

---

### Task 1: Broker — marks for every kind, one durable path, counts

**Files:**
- Modify: `src/registry.mjs` (`constructor`: hook `childMessage` becomes `appMessage`, new hook `userMessage`; `send`;
  `sendFromUser`)
- Modify: `src/delegation.mjs` (`childMessage` becomes `appMessage`, new `userMessage`, `messageClosed`, `#deliver`,
  `attached`, `ack`, new `heldByKind`)
- Modify: `src/delegation-store.mjs` (new `heldItems()`)
- Modify: `server.mjs` (wiring next to `registry.decorate`)
- Modify: `src/links-api.mjs` (`GET /api/links`)
- Test: `electron/test/delegation-broker.test.mjs`, `electron/test/links-api.test.mjs`

**Interfaces:**
- Produces (wire, to an app session's push): the message object of `Delegation.#deliver` gains `heldAs?: "parent" |
  "other" | "user"`, `redelivered?: true`, and `human` is the item's own value (`true` only for `user`).
- Produces: `Registry#appMessage: (fromKey, toKey, text) => boolean`, `Registry#userMessage: (toKey, text) => boolean`
  (both null by default; true = taken over).
- Produces: `Delegation#appMessage(fromKey, toKey, text): true`, `Delegation#userMessage(toKey, text): true`,
  `Delegation#heldByKind(): { [toKey]: { child: number, parent: number, other: number } }` (only keys with a count).
- Produces: `GET /api/links` → `{ links, held, heldByKind }`.

- [ ] **Step 1: Write the failing tests** in `electron/test/delegation-broker.test.mjs` (use `setup()`; add a third
  app peer `cli:x` named `obcy` with its own push array where needed):

```js
test("a parent's message to its app child is stored, marked parent and decorated", () => {
  const { d, registry, store, childPush } = setup();
  registry.appMessage = (f, t, x) => d.appMessage(f, t, x);
  registry.send("cli:parent", KID, "also update the changelog");
  const m = childPush.at(-1);
  assert.equal(m.heldAs, "parent");
  assert.equal(m.fromChild, undefined);
  assert.equal(m.human, false);
  assert.equal(typeof m.deliveryId, "string");
  assert.equal(m.redelivered, undefined);
  assert.match(m.prompt, /Your parent/); // the family block, as a linked send has today
  assert.equal(store.pending("cli:child").length, 1);
});

test("a message between sessions that are not linked is stored, marked other and not decorated", () => {
  // cli:x → cli:child: heldAs "other", prompt === relayPrompt("obcy", cwd, text) exactly, global budget charged by 1
});

test("a child's message to its parent keeps fromChild and gets no heldAs", () => { /* fromChild true, heldAs undefined */ });

test("a relay-GUI message to an app session is stored as user and stays human on redelivery", () => {
  // registry.userMessage wired; sendFromUser(KID, "hi"): push has heldAs "user", human true, from "user", prompt "hi";
  // a new Delegation over the same store + attached("cli:child"): the same id again, human true, redelivered true
});

test("a recipient that is not an app session keeps the old path", () => {
  // peer with app: false: registry.send and sendFromUser push a message without deliveryId; the outbox stays empty
});

test("a parent's message to a closed child is marked parent when the reopen is approved", () => { /* awaiting item has heldAs "parent" */ });

test("the mark is set when the message is sent: a release afterwards does not change it", () => {
  // parent → child stored; unlink; attached("cli:child") redelivers with heldAs "parent"
});

test("heldByKind counts unacknowledged marked items per recipient and kind, without user and awaiting", () => {
  // one child reply to cli:parent, one parent order and one other message to cli:child, one user message to cli:child:
  assert.deepEqual(d.heldByKind(), { "cli:parent": { child: 1, parent: 0, other: 0 }, "cli:child": { child: 0, parent: 1, other: 1 } });
  // after d.ack("cli:child", <the parent order's id>) the listener registered with d.onChange has been called and parent is 0
});
```

  In `electron/test/links-api.test.mjs`: `GET /api/links` answers `heldByKind` equal to `delegation.heldByKind()` next
  to the unchanged `held`.

- [ ] **Step 2: Run them and see them fail**

Run: `node --test electron/test/delegation-broker.test.mjs electron/test/links-api.test.mjs`
Expected: the new tests FAIL (`appMessage is not a function`, `heldAs` undefined).

- [ ] **Step 3: Implement**

  - `Registry.send`: when `to.app` and `this.appMessage?.(from.key, to.key, text)` is true, skip its own `#deliver`
    (today the condition is `from.parentKey === to.key && to.app && this.childMessage?.(…)`). Budget, `message` event
    and answer text unchanged.
  - `Registry.sendFromUser`: when `to.app` and `this.userMessage?.(to.key, text)` is true, skip its own `#deliver`.
  - `Delegation.appMessage(fromKey, toKey, text)`: the body of today's `childMessage`, with the mark
    `fromKey`'s parent is `toKey` → `{ fromChild: true }`; `toKey`'s parent is `fromKey` → `{ heldAs: "parent" }`;
    else `{ heldAs: "other" }`. Read the parents from the registry peers (`parentKey`), as `Registry.send` does.
  - `Delegation.userMessage(toKey, text)`: item `{ id, toKey, from: "user", text, prompt: text, human: true, heldAs: "user" }`.
  - `Delegation.messageClosed`: the awaiting item for a closed child gets `{ heldAs: "parent", fromKey }`.
  - `Delegation.#deliver(item, { redelivered = false } = {})`: `human: item.human === true`; the family block only
    when `item.heldAs` is not `"other"` and not `"user"`; passes `heldAs` and, when asked, `redelivered: true`.
    `attached` calls it with `{ redelivered: true }`; every other caller as today.
  - `DelegationStore.heldItems()`: outbox items with `fromChild === true` or `heldAs` of `"parent"` / `"other"`, not
    awaiting. `marked()` and `heldCounts()` stay.
  - `Delegation.ack`: emits a change when the removed item is one of `heldItems()` (today: `fromChild` only).
  - `server.mjs`: `registry.appMessage = (f, t, x) => delegation.appMessage(f, t, x)` replaces the `childMessage`
    line; add `registry.userMessage = (t, x) => delegation.userMessage(t, x)`.

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: PASS, including the existing tests "a linked send to an online relative carries the family block" and
"extension delivery injects a durable item once and acks it after the injection" (rename `childMessage` in tests that
wire it).

- [ ] **Step 5: Commit** — `feat(relay): mark and store every message to an app session`

---

### Task 2: App main process — four switches, the cache for every kind, the counts

**Files:**
- Modify: `electron/held-replies.mjs` (`createHoldStore`, new `HELD_KINDS`, new `heldKind`)
- Modify: `extension/copilot-relay/relay-client.mjs` (`fetchLinkState`), then `npm --prefix electron run copy-relay`
- Modify: `electron/links-cache.mjs` (`readLinksCache`, `writeLinksCache`)
- Modify: `electron/main.mjs` (`relayStart` `onMessage`, `brokerGetLinks`, the replay in `sessions:open`, `held:get`,
  `held:set`)
- Modify: `electron/preload.cjs` (`setHoldReplies`)
- Test: `electron/test/held-replies-main.test.mjs`, `electron/test/links-cache.test.mjs`,
  `electron/test/relay-client.test.mjs`

**Interfaces:**
- Consumes: the wire fields of Task 1 (`fromChild`, `heldAs`, `redelivered`), `heldByKind` in `GET /api/links`.
- Produces: `HELD_KINDS = ["child", "parent", "other", "user"]`; `heldKind(m): "child" | "parent" | "other" | "user" | null`
  (`fromChild === true` → `"child"`, a valid `heldAs` → itself).
- Produces: `createHoldStore(file)` → `{ get(id): { child, parent, other, user } (booleans), set(id, kind, on),
  copy(fromId, toId), delete(id) }`; `set` throws on an unknown kind or a failed write.
- Produces (IPC): `api.getHoldReplies(sessionId)` → `{ child, parent, other, user }`;
  `api.setHoldReplies(sessionId, kind, on)`.
- Produces: the `relay:message` payload gains `heldAs` (raw, as the broker sent it), `redelivered: boolean`, and
  `replayed: true` when main sends a cached message again.
- Produces: `links:update` / `links:get` / the links cache carry `{ links, held, heldByKind }` (`heldByKind` is `{}`
  from an older broker or an older cache file).

- [ ] **Step 1: Write the failing tests** in `electron/test/held-replies-main.test.mjs` (replace the two switch tests):

```js
test("every switch is on by default and only off is stored", (t) => {
  const file = storeFile(t);
  const s = createHoldStore(file);
  assert.deepEqual(s.get("a"), { child: true, parent: true, other: true, user: true });
  s.set("a", "parent", false);
  assert.deepEqual(s.get("a"), { child: true, parent: false, other: true, user: true });
  assert.deepEqual(stored(file), { a: { parent: false } });
  s.set("a", "parent", true);
  assert.deepEqual(stored(file), {});
  assert.throws(() => s.set("a", "nope", false));
});

test("a file of v0.22 reads as child off, and child-only off is still written that way", (t) => {
  const file = storeFile(t);
  writeFileSync(file, JSON.stringify({ a: false }));
  const s = createHoldStore(file);
  assert.deepEqual(s.get("a"), { child: false, parent: true, other: true, user: true });
  s.set("b", "child", false);
  assert.deepEqual(stored(file), { a: false, b: false });
  s.set("b", "user", false);
  assert.deepEqual(stored(file).b, { child: false, user: false });
});

test("the switches are copied on a fork and deleted with the session", (t) => { /* all kinds copied; delete → all on */ });

test("heldKind reads fromChild and heldAs", () => {
  assert.equal(heldKind({ fromChild: true }), "child");
  assert.equal(heldKind({ heldAs: "parent" }), "parent");
  assert.equal(heldKind({ heldAs: "user" }), "user");
  assert.equal(heldKind({ heldAs: "bogus" }), null);
  assert.equal(heldKind({}), null);
});
```

  `links-cache.test.mjs`: a round trip keeps `heldByKind`; a file without it and a bare-array file read
  `heldByKind: {}`. `relay-client.test.mjs`: `fetchLinkState` returns the broker's `heldByKind`, `{}` when missing or
  not an object.

- [ ] **Step 2: Run them and see them fail**

Run: `node --test electron/test/held-replies-main.test.mjs electron/test/links-cache.test.mjs electron/test/relay-client.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement** the three modules, then run `npm --prefix electron run copy-relay`.

- [ ] **Step 4: Implement in `electron/main.mjs`**
  - `onMessage`: the payload adds `heldAs: m.heldAs` and `redelivered: m.redelivered === true`; a message is cached
    when `heldKind(payload)` is not null and it has a `deliveryId` (today: `fromChild` only); the notification fires
    for kinds `child`, `parent`, `other` when `holds.get(sessionId)[kind]` is on, with the titles of Global
    Constraints, once per `deliveryId` as today.
  - The replay of `heldCache.list(sessionId)` in `sessions:open` sends each message with `replayed: true`.
  - `held:get` returns the object; `held:set(sessionId, kind, on)` checks the session id as today and that `kind` is
    one of `HELD_KINDS`.
  - `brokerGetLinks` returns `heldByKind` like `fetchLinkState`.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit** — `feat(desktop): hold switches per kind and the cache for every held kind`

---

### Task 3: Renderer rules — pure functions

**Files:**
- Modify: `electron/renderer/held-replies.js`
- Modify: `electron/renderer/message-queue.js` (`statusText`)
- Test: `electron/test/held-replies.test.mjs`, `electron/test/message-queue.test.mjs`

**Interfaces:**
- Produces, on `globalThis.HeldReplies`:
  - `KINDS = ["parent", "other", "user", "child"]` (the order of the lists);
  - `SWITCH_KINDS = ["child", "parent", "other", "user"]` (the order of the switches);
  - `kindOf(m)`: same rule as `heldKind` of Task 2;
  - `shouldHold({ kind, on, deliveryId, prompting, cameBack }): boolean`;
  - `listTitle(kind, n)`, `switchLabel(kind)`, `discardLine(kind, from)`;
  - `showSwitch({ kind, hasChildren, hasParent, onRelay, held }): boolean` (`held` = held items of that kind);
  - `approvedPrompt(prompt, arrivedAt, now, kind = "child")`;
  - `sidebarCount({ view, brokerHeld, brokerByKind, sessionId })`;
  - `markTitle(n)`, `comeBackLine(n)`, `insertByArrival`, `WAIT_NOTE_MS` (as today).
- Produces: `MessageQueue.statusText` with the new held texts.

- [ ] **Step 1: Write the failing tests**

```js
test("shouldHold: child, parent and other need the switch and a delivery id", () => {
  for (const kind of ["child", "parent", "other"]) {
    assert.equal(shouldHold({ kind, on: true, deliveryId: "d", prompting: false, cameBack: false }), true);
    assert.equal(shouldHold({ kind, on: false, deliveryId: "d", prompting: true, cameBack: true }), false);
    assert.equal(shouldHold({ kind, on: true, deliveryId: undefined, prompting: true, cameBack: false }), false);
  }
});

test("shouldHold: a user message is held during a turn or when it comes back", () => {
  const base = { kind: "user", on: true, deliveryId: "d" };
  assert.equal(shouldHold({ ...base, prompting: false, cameBack: false }), false); // idle, or a view that only resumes
  assert.equal(shouldHold({ ...base, prompting: true, cameBack: false }), true);
  assert.equal(shouldHold({ ...base, prompting: false, cameBack: true }), true);
  assert.equal(shouldHold({ ...base, on: false, prompting: true, cameBack: true }), false);
});

test("shouldHold: a message without a kind is never held", () => {
  assert.equal(shouldHold({ kind: null, on: true, deliveryId: "d", prompting: true, cameBack: true }), false);
});

test("showSwitch per kind", () => {
  const none = { hasChildren: false, hasParent: false, onRelay: false, held: 0 };
  assert.equal(showSwitch({ ...none, kind: "user" }), true);
  assert.equal(showSwitch({ ...none, kind: "child" }), false);
  assert.equal(showSwitch({ ...none, kind: "child", hasChildren: true }), true);
  assert.equal(showSwitch({ ...none, kind: "parent" }), false);
  assert.equal(showSwitch({ ...none, kind: "parent", hasParent: true }), true);
  assert.equal(showSwitch({ ...none, kind: "other", onRelay: true }), true);
  for (const kind of ["child", "parent", "other"]) assert.equal(showSwitch({ ...none, kind, held: 1 }), true);
});

test("approvedPrompt: the note depends on the kind", () => {
  const t = 5 * 60000;
  assert.equal(approvedPrompt("P", 0, 59999, "parent"), "P");
  assert.equal(approvedPrompt("P", 0, t, "parent"), "P\n\n(This message waited 5 min for your user's approval. The list of your relatives above may be out of date: call list_sessions for their current state.)");
  assert.equal(approvedPrompt("P", 0, t, "other"), "P\n\n(This message waited 5 min for your user's approval.)");
  assert.equal(approvedPrompt("P", 0, t, "user"), "P");
  assert.match(approvedPrompt("P", 0, t), /This reply waited 5 min/); // child, unchanged
});

test("sidebarCount: the view, else the broker's counts by kind, else the old count", () => {
  assert.equal(sidebarCount({ view: { held: [1, 2, 3] }, brokerByKind: {}, brokerHeld: {}, sessionId: "s" }), 3);
  assert.equal(sidebarCount({ view: null, brokerByKind: { "cli:s": { child: 1, parent: 2, other: 1 } }, brokerHeld: { "cli:s": 1 }, sessionId: "s" }), 4);
  assert.equal(sidebarCount({ view: null, brokerByKind: {}, brokerHeld: { "cli:s": 2 }, sessionId: "s" }), 2);
  assert.equal(sidebarCount({ view: null, brokerByKind: undefined, brokerHeld: undefined, sessionId: "s" }), 0);
});
```

  Plus: `kindOf` (as `heldKind` in Task 2); `listTitle`, `switchLabel`, `discardLine`, `markTitle`, `comeBackLine`
  for every kind and for 1 and 2, with the exact strings of Global Constraints; in `message-queue.test.mjs`:
  `statusText({ held: 1 }) === "1 message waiting for approval"`, `statusText({ held: 2 }) === "2 messages waiting for approval"`.

- [ ] **Step 2: Run them and see them fail**

Run: `node --test electron/test/held-replies.test.mjs electron/test/message-queue.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement** the functions above; update the existing tests whose strings changed (`markTitle`,
  `comeBackLine`, `listTitle`, `showSwitch`, `statusText`).

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit** — `feat(desktop): rules for held messages of every kind`

---

### Task 4: Renderer — the lists, the switches, the sidebar, forgetting deleted sessions

**Files:**
- Modify: `electron/renderer/app.js` (`SessionView` constructor, `incoming`, `hold`, `approveHeld`, `discardHeld`,
  `setHoldReplies`, `loadHoldSwitch`, `renderHeld`, `renderRelations`, `heldComeBack`, the `links:update` handler,
  the sidebar row, `forgetDeleted`)
- Modify: `electron/renderer/style.css` (`.held-group`, the switch row)
- Modify: `scripts/ui-check/checks.mjs` (check `held-replies` updated, new check `held-kinds`)

**Interfaces:**
- Consumes: `HeldReplies.*` of Task 3; `api.getHoldReplies` / `api.setHoldReplies(sessionId, kind, on)` and the
  `relay:message` fields of Task 2.
- Produces: `SessionView.holdOn: { child, parent, other, user }` (replaces `holdReplies`);
  `SessionView.setHold(kind, on)` (replaces `setHoldReplies`); held items
  `{ id, kind, from, text, prompt, fromCwd, human, deliveryId, arrivedAt }`.
- Produces (DOM): one `.held-group[data-kind="<kind>"]` per non-empty kind inside `.held`, with a `.held-head` and
  `.held-row`s built as today; switches `input.held-switch[data-kind="<kind>"]`, `child` first in the DOM.
- Produces: module variable `heldByKindKey` (the broker's `heldByKind`) next to `heldByKey`.

- [ ] **Step 1: Write the UI check `held-kinds`** in `scripts/ui-check/checks.mjs`, built like `held-replies`
  (`sessionId: HISTORY_ID`, `modes: ["off"]`, messages injected with `${V}.incoming(…)`). Steps and assertions:

  1. `incoming({ from: "lead", heldAs: "parent", deliveryId: "p1", prompt: "P-p1", text: "do x", wake: true })` and
     the same with `heldAs: "other"` / `"o1"`: two groups, `[data-kind="parent"] .held-head` reads
     `Orders from parent (1)`, `[data-kind="other"] .held-head` reads `Other sessions (1)`; the queue is empty; no turn
     started; status `2 messages waiting for approval`; the sidebar mark reads `⏸ 2`.
  2. The first task of a sub-session, as main sends it (`{ from: "lead", text: "task", prompt: "P-task", wake: true }`,
     no mark, no `deliveryId`): not held, a turn starts with `P-task`.
  3. A fromChild message `c1` adds a third group; the groups are in DOM order parent, other, child.
  4. Approve `p1`: its turn starts, the bubble's sender is `lead`, the parent group is gone, the other two are
     unchanged.
  5. `user` from the relay GUI: with `${V}.setBusy(true)` only (no turn),
     `incoming({ from: "user", human: true, heldAs: "user", deliveryId: "u1", prompt: "P-u1", text: "hi", wake: true })`
     goes to the queue; the same with `deliveryId: "u2", replayed: true` is held under `Your messages (1)`; during a
     real turn (send a prompt the scripted agent answers slowly, as `held-replies` step "approve while busy" does)
     `u3` is held too. Approving `u3` puts an item with `human === true` in the queue.
  6. ✕ on `o1`: the row is gone, the log ends with `Discarded a message from api-77e2.` (use that sender name in
     step 1), and `api.relayAck` was called with `o1` (stub it as `held-replies` does).
  7. Switch `other` off with one `other` and one `child` held: the `other` item is in the queue, the `child` item is
     still held, `${V}.holdOn.other === false`, `api.setHoldReplies` was called with `(HISTORY_ID, "other", false)`.
     A new `other` message then goes to the queue; switching on moves nothing back.
  8. The switch row: the `user` switch is visible in a session without relatives; the `parent` switch is hidden until
     a `parent` message is held.

- [ ] **Step 2: Run it and see it fail**

Run: `node scripts/ui-check/run.mjs held-kinds`
Expected: FAIL at step 1 (no `.held-group`).

- [ ] **Step 3: Implement**
  - `incoming(m)`: after the `wake === false` branch,
    `const kind = HeldReplies.kindOf(m)`; hold when
    `HeldReplies.shouldHold({ kind, on: this.holdOn[kind], deliveryId: m.deliveryId, prompting: this.prompting, cameBack: m.redelivered === true || m.replayed === true })`.
  - `hold(m)` stores `kind` and `human`; `approveHeld` enqueues with `human: item.human === true` and
    `HeldReplies.approvedPrompt(item.prompt, item.arrivedAt, Date.now(), item.kind)`; `discardHeld` writes
    `HeldReplies.discardLine(item.kind, item.from)`.
  - `setHold(kind, on)`: as `setHoldReplies` today, for one kind; off releases that kind's items only, oldest first.
  - `loadHoldSwitch`: reads the object; for every kind that is off and was not touched meanwhile, releases what was
    held (today: `child` only).
  - `renderHeld`: one group per kind of `HeldReplies.KINDS` with items; the switch row shows `Approve:` and the
    switches of `HeldReplies.SWITCH_KINDS` for which `showSwitch` is true (`hasParent`: the tree gives the session a
    parent that is not deleted; `onRelay`: the view has a relay name). The row is hidden when no switch shows.
    `renderRelations` calls the same code (backlog T4-m2 asked for one place).
  - `heldComeBack`: gives back the items that have a `deliveryId` and keeps the rest in the list (Task 5 adds them).
  - Sidebar: `heldByKindKey` is set where `heldByKey` is; the row passes it as `brokerByKind`.
  - `forgetDeleted(idx, ids)`: every deleted id is sent to `api.forgetLinks`, not only the linked ones. The returned
    warning text stays for ids that are in the tree; when only unlinked ids failed, log with `console.warn` and
    return null (a session without a link has no tree to update, and the broker may be off).

- [ ] **Step 4: Update `held-replies`** (the status texts, `holdReplies` → `holdOn.child`, the switch selector
  `.held-switch[data-kind="child"]`) and run both checks.

Run: `node scripts/ui-check/run.mjs held-kinds held-replies`
Expected: PASS.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit** — `feat(desktop): held lists for parent orders, other sessions and relay-GUI messages`

---

### Task 5: Renderer — your typed messages during a turn

**Files:**
- Modify: `electron/renderer/app.js` (`send`, `setBusy` and wherever `prompting` changes the Send button, new
  `holdTyped`, `approveHeld`, `discardHeld`, `closeQuestion`, `reopenView`)
- Modify: `scripts/ui-check/checks.mjs` (new check `held-typed`)

**Interfaces:**
- Consumes: `SessionView.holdOn`, `setHold`, the held list and `renderHeld` of Task 4.
- Produces: `SessionView.holdTyped(text, command)`: adds
  `{ id, kind: "user", typed: true, from: "you", text, prompt: text, command, arrivedAt: Date.now() }` (no
  `deliveryId`) to the held list.

- [ ] **Step 1: Write the UI check `held-typed`** (`modes: ["off", "on"]` so it runs with `queueMidTurn` off and on;
  the driver's slow scripted turn as in `held-replies`). Steps and assertions:

  1. During a turn the Send button is enabled in both modes; typing `check the README` and Enter adds a row under
     `Your messages (1)` with sender `you`; the queue is empty; the input is empty.
  2. The turn ends: the row is still there, no new turn started, status `1 message waiting for approval`.
  3. Approve: a turn starts whose user bubble reads `check the README` (an own message, not a relay bubble).
  4. Hold a second typed message during a turn, then call `closeQuestion([sessionId])` after the turn ended: it
     returns the text for unsent messages of yours (`This session has queued messages of yours that were not sent.
     Close and discard them?`).
  5. With a typed message held, mark the view dead and reopen it as a dead view (as `held-replies` step "dead parent"
     does): the log has `1 queued message(s) waiting for this session were discarded.` and the list is empty.
  6. ✕ on a typed row: gone, the log ends with `Discarded your message.`, `api.relayAck` was not called.
  7. Switch `user` off during a turn: Send behaves as before this feature in that mode (`on`: the message is queued;
     `off`: the button is disabled).
  8. `/rename x` and an agent command during a turn are refused with `Wait until Copilot finishes this turn.`, as
     today.

- [ ] **Step 2: Run it and see it fail**

Run: `node scripts/ui-check/run.mjs held-typed`
Expected: FAIL at step 1.

- [ ] **Step 3: Implement**
  - `send()`: in the busy branch, after the refusals that exist (`cmd`, `rename`, `edit`, `historyOp`): when
    `this.prompting && this.holdOn.user`, take the input and call `holdTyped(text, SlashCommands.isCommandPrompt(text))`;
    otherwise today's code (`!queueMidTurn` refuses, else `enqueue`).
  - The Send button is enabled during a turn when `queueMidTurn` is on or `holdOn.user` is on; recompute it when the
    `user` switch changes and when a turn starts or ends.
  - `approveHeld` for a typed item: `enqueue({ kind: "app", text, prompt: text, command })`; no wait note.
  - `discardHeld` for a typed item: no acknowledgement, no `discarded` entry.
  - `closeQuestion`: a view counts as having unsent messages of yours when its queue has a `kind: "app"` item or its
    held list has a typed item.
  - `reopenView`: typed held items are handed over with the list; when the new view is dead they are removed and
    counted in the existing `N queued message(s) waiting for this session were discarded.` line.

- [ ] **Step 4: Run the checks**

Run: `node scripts/ui-check/run.mjs held-typed held-kinds held-replies`
Expected: PASS.

- [ ] **Step 5: Run the whole suite and the queue checks** (the Send button and `send()` changed)

Run: `npm test && node scripts/ui-check/run.mjs` (all checks)
Expected: PASS.

- [ ] **Step 6: Commit** — `feat(desktop): hold your own messages sent during a turn`

---

### Task 6: End to end through a real broker, docs

**Files:**
- Modify: `scripts/ui-check/checks.mjs` (new check `held-kinds-e2e`, built like `held-e2e`: `scenario: LINK_SCENARIO`,
  `settings: { relay: true }`, `broker: true`)
- Modify: `electron/README.md` (the paragraph "Replies from sub-sessions wait for you")
- Modify: `README.md` if it describes what the broker stores or `GET /api/links`

**Interfaces:**
- Consumes: everything above; the scripted agent's `send_message <to> <text>` (it exists).

- [ ] **Step 1: Write the check.** Parent = the driver's session, child = a second session in `<app.dir>/child`, a
  third session `<app.dir>/other` that is not linked. Steps and assertions:

  1. Link parent and child (`adopt_session`, approve the card), as `held-e2e` does.
  2. The parent sends `send_message <child> order one`: the child's view shows one row under `Orders from parent (1)`,
     no turn started in the child, `(await fetch(/api/links)).heldByKind["cli:<child>"].parent === 1`.
  3. The third session sends `send_message <child> hello`: a row under `Other sessions (1)`; `…other === 1`.
  4. Approve the order in the child: its turn starts; after it started, `heldByKind[…].parent` is 0.
  5. Close the child's view and open it again: the `other` row is back (still unacknowledged), in the same list.
  6. `POST <broker>/api/send { to: <child>, text: "from the gui" }` while the child is idle: a turn starts, nothing is
     held. The same during a turn of the child: a row under `Your messages (1)`.
  7. ✕ on the `other` row: `heldByKind[…]` has no `other` count left.
  8. Delete the third (unlinked) session in the app while a message addressed to it is in the broker's outbox (send
     it one from the child first, do not approve it): afterwards `delegations.json` of the check's broker has no
     outbox item with `toKey` of that session.

- [ ] **Step 2: Run it**

Run: `npm --prefix electron run copy-relay && node scripts/ui-check/run.mjs held-kinds-e2e held-e2e link-e2e`
Expected: PASS (fix the code of Tasks 1 to 5 in their own files if a step fails; say in the report which).

- [ ] **Step 3: Update `electron/README.md`**: the four kinds, where each waits, the four switches and their
  defaults, that your own messages are held only during a turn and wait for Approve after it, that typed messages
  are lost with the window, that a switched-off kind is now delivered after a reopen instead of being lost, and that
  the broker must be updated ("Update and restart broker").

- [ ] **Step 4: Run everything**

Run: `npm test && node scripts/ui-check/run.mjs`
Expected: PASS.

- [ ] **Step 5: Commit** — `test(desktop): held kinds through a real broker; docs`

---

### Task 7: Manual check with real Copilot (with the user)

Not for a subagent. After the branch review, with the app started from the branch and the broker updated:

- [ ] A parent sends its child a follow-up: the child holds it; Approve starts the turn; the switch off delivers at
  once.
- [ ] A new sub-session still starts on its first task without an approval.
- [ ] Two unrelated sessions message each other: held on both sides.
- [ ] A message typed during a turn waits, stays after the turn, runs after Approve; the same from the relay GUI.
- [ ] Window reload (Ctrl+R) with a held order: it is back, held, in its list.
- [ ] Four switches in a narrow window: the status bar wraps without hiding the usage chip.

Open items go to `docs/superpowers/backlog/2026-11-24-held-incoming-deferred.md` with the deferred review findings
(see `CLAUDE.md`), including the spec's Known limitations: outbox items of an unlinked session deleted outside the
app, and backlog A1 to A4 of held-child-replies now applying to the new kinds.
