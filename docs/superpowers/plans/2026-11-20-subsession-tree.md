# Sub-session Tree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permanent parent–child links between delegated sessions, visible both ways in the app, with no auto-close,
no limits, any depth, unique permanent names and approval-gated reopen of closed relatives.

**Architecture:** The broker (`DelegationStore` + `Delegation`) is the single source of truth for links, tasks,
queued messages and pending reopen requests. It exposes `GET /api/links` and a few peer endpoints; the Electron main
process caches the snapshot in `userData/links-cache.json` and forwards it to the renderer, which builds the tree with
pure functions (`renderer/session-tree.js`) for the sidebar, the relation bar, cascade close and the delete dialog.

**Tech Stack:** Node ≥ 18 ESM, `node:test`, Electron (main + preload + plain-JS renderer), MCP SDK + zod.

**Spec:** `docs/superpowers/specs/2026-11-20-subsession-tree-design.md`

## Global Constraints

- Name format: `<base>-<suffix>`, `suffix` = first 6 hex chars of SHA-256 of the peer key; 8 chars only on a full-name collision; a name never moves to another key.
- Full names are ≤ 32 chars and match `/^[a-z0-9][a-z0-9_-]{0,31}$/` → `base` is cut to 32 − 1 − suffix length.
- Existing `delegations.json` must load: missing `task`/`createdAt`/`parentDeleted`, outbox items with `parentKey` instead of `toKey`, no `reopens`.
- Store writes stay write-to-temp + rename; every outbox item is on disk before any delivery attempt.
- `report_result`, notices and reopen-delivered messages keep at-least-once delivery with ack.
- Copy for the model, verbatim:
  - closed relative: `Session "<name>" is closed. The user was asked to reopen it; your message is queued and will be delivered if they approve. Do not wait for it.`
  - no app connection: `Session "<name>" is closed and you have no app connection to ask the user to reopen it.`
  - rejected: `The user did not reopen "<name>"; your message was not delivered.`
  - ended: `Session "<name>" ended without reporting a result. You can ask the user to reopen it.` (unchanged)
- Pruning of missing sessions only after a successful, complete session list, only for `cli:` keys.
- Edit `extension/copilot-relay/relay-client.mjs` only; `electron/relay-client.mjs` is an untracked copy made by `npm --prefix electron run copy-relay` (run it after changing the extension file).
- Tests: `npm test` (runs `electron/test/*.test.mjs`); one file: `node --test electron/test/<file>.test.mjs`.

## Review Focus

1. Relay client reconnects re-register the sender → broker re-emits `reopen_request` → the renderer must not show a second card for the same `requestId` (test in Task 4 + dedupe in Task 8).
2. Closing a parent whose subtree has a busy grandchild: one confirmation for the whole subtree, not one per view (Task 7 `closeOrder` + Task 8).
3. A corrupt or cyclic `delegations.json` (`a.parent = b`, `b.parent = a`, or `a.parent = a`) must not hang `descendantsOf` or the sidebar (tests in Task 2 and Task 7).
4. A rename via `/rename`, `set_name` or the GUI keeps the suffix; a model passing the old base name gets `No session` instead of reaching a stranger (test in Task 1).
5. The session list call failing or still loading must never prune links (test in Task 7 `pruneCandidates`).

---

### Task 1: Permanent unique names

**Files:**
- Modify: `src/registry.mjs` (`freeName`, `upsert`, `rename`)
- Modify: `server.mjs:39-48` (`pickName`), `src/name-store.mjs` (`#save` pruning)
- Test: `electron/test/registry-links.test.mjs`

**Interfaces:**
- Produces: `nameSuffix(key: string, len = 6): string` and `uniqueName(wanted: string, key: string, taken: (name) => boolean): string` exported from `src/registry.mjs`; `Registry#freeName(wanted, key)` now returns `uniqueName(...)` (no `-2` loop). `NameStore` constructor gains option `{ keep: (key) => boolean }`.

- [ ] **Step 1: Write the failing tests** (replace "a taken name yields a suffixed final name")

```js
test("a name gets the key's 6-hex suffix and keeps it across renames", () => {
  const r = new Registry();
  const p = r.upsert({ key: "cli:aaa", name: "api-tests", kind: "cli" });
  assert.equal(p.name, `api-tests-${nameSuffix("cli:aaa")}`);
  assert.match(p.name, /^api-tests-[0-9a-f]{6}$/);
  assert.equal(r.rename("cli:aaa", "docs"), `docs-${nameSuffix("cli:aaa")}`);
});
test("a requested name already carrying the own suffix is not suffixed twice", () => {
  const r = new Registry();
  const n = `x-${nameSuffix("cli:aaa")}`;
  assert.equal(r.upsert({ key: "cli:aaa", name: n, kind: "cli" }).name, n);
});
test("same base for two keys gives two different names; a suffix collision extends to 8", () => {
  assert.notEqual(uniqueName("w", "cli:a", () => false), uniqueName("w", "cli:b", () => false));
  const six = uniqueName("w", "cli:a", () => false);
  assert.equal(uniqueName("w", "cli:a", (n) => n === six), `w-${nameSuffix("cli:a", 8)}`);
});
test("a long base is cut so the full name stays within 32 chars", () => {
  const n = uniqueName("a".repeat(40), "cli:a", () => false);
  assert.ok(n.length <= 32 && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(n));
});
test("an old base name does not reach the renamed session", () => {
  const r = new Registry();
  r.upsert({ key: "cli:s", name: "sender", kind: "cli", push: () => true });
  r.upsert({ key: "cli:t", name: "old", kind: "cli", push: () => true });
  r.rename("cli:t", "new");
  assert.match(r.send("cli:s", "old", "hi"), /^No session "old"/);
});
test("reserved names still get another name", () => { /* keep existing assertion, adjusted to the suffixed form */ });
```

- [ ] **Step 2: Run** `node --test electron/test/registry-links.test.mjs` — Expected: FAIL (`nameSuffix` not exported).
- [ ] **Step 3: Implement** `nameSuffix` with `createHash("sha256").update(key).digest("hex").slice(0, len)`; `uniqueName` = sanitise → strip an own suffix already present → reserved-name rule as today → cut base → append 6-char suffix, 8 chars if `taken(full)`. `freeName` passes `taken = (n) => this.byName.has(n) && this.byName.get(n).key !== key`. `rename` uses `freeName` instead of throwing "taken". Update the `freeName` doc comment.
- [ ] **Step 4: Migration + NameStore.** `pickName(key, explicit)` in `server.mjs` returns the stored name as the *wanted* name (`upsert` suffixes it, so a pre-suffix stored name migrates on next registration; random names likewise). `NameStore.#save` skips pruning entries for which `keep(key)` is true; `server.mjs` constructs it with `keep: (k) => delegationStore.parentOf(k) != null || delegationStore.childrenOf(k).length > 0`.
- [ ] **Step 5: Run** `npm test` — Expected: PASS (fix any test that hard-coded unsuffixed names, e.g. in `delegation-broker.test.mjs`: compare with `registry.get(key).name` instead of literals).
- [ ] **Step 6: Commit** `feat(relay): permanent unique session names with key-hash suffix`

---

### Task 2: Store schema — tasks, outbox recipients, reopen requests, forget

**Files:**
- Modify: `src/delegation-store.mjs`
- Test: `electron/test/delegation-broker.test.mjs` (store section)

**Interfaces:**
- Produces on `DelegationStore`:
  - `link(child, parent, name)` — sets `createdAt: Date.now()` on a new link (kept on re-link), keeps `task`.
  - `setTask(child, task): boolean` — only when the link exists and has no task.
  - `taskOf(child): string`, `linkOf(child): object|null`, `allLinks(): Array<[key, link]>`.
  - `descendantsOf(key): string[]` — depth-first, children ordered by `createdAt`, cycle-safe (visited set), excludes `key`.
  - `enqueue(item)` — items carry `toKey`; `pending(toKey)` returns items for `toKey` **without** `awaiting`.
  - `awaitingFor(requestId): item[]`, `release(requestId)` (deletes `awaiting` on its items), `dropAwaiting(requestId): item[]`.
  - `addReopen({ requestId, fromKey, targetKey })`, `reopensFrom(fromKey): object[]`, `reopenFor(fromKey, targetKey): object|null`, `removeReopen(requestId)`.
  - `forget(key)` — deletes the link, outbox items with `toKey === key`, reopens with `fromKey` or `targetKey === key`; sets `parentDeleted: true` on links whose `parent === key`.
- Load fallback: outbox item without `toKey` gets `toKey = parentKey`; missing `reopens` → `{}`.

- [ ] **Step 1: Write the failing tests**

```js
test("link records createdAt once and setTask works only once", ...)          // createdAt unchanged on re-link; setTask true then false
test("an old file with parentKey outbox items and no reopens loads", ...)     // write raw JSON, new store, pending("cli:p").length === 1
test("descendantsOf walks the subtree in createdAt order", ...)               // p → a, b; a → c  ⇒ ["cli:a","cli:c","cli:b"]
test("descendantsOf terminates on a cycle and on a self-parent", ...)         // a.parent=b, b.parent=a; c.parent=c ⇒ returns finite arrays without the start key
test("awaiting items are not pending until released", ...)                    // enqueue {awaiting:"r1"} ⇒ pending empty; release("r1") ⇒ 1
test("dropAwaiting removes and returns the items of one request", ...)
test("forget removes link, its outbox and reopens, and orphans its children", ...) // linkOf(child).parentDeleted === true
test("reopens survive a new store instance", ...)
```

- [ ] **Step 2: Run** `node --test electron/test/delegation-broker.test.mjs` — Expected: FAIL.
- [ ] **Step 3: Implement** the methods above; data shape `{ links, outbox, reopens }`; rename every internal `parentKey` on outbox items to `toKey`.
- [ ] **Step 4: Run** `npm test` — Expected: PASS (update `Delegation` call sites that read `item.parentKey` to `item.toKey` in this task so the suite stays green).
- [ ] **Step 5: Commit** `feat(relay): store tasks, recipient outbox and reopen requests`

---

### Task 3: Delegation — any depth, died, family block, state

**Files:**
- Modify: `src/delegation.mjs`, `src/mcp.mjs` (`formatList`, tool descriptions, server instructions), `server.mjs` (remove `registry.on("peer_removed", … childGone …)`)
- Test: `electron/test/delegation-broker.test.mjs`

**Interfaces:**
- Consumes: Task 2 store API.
- Produces on `Delegation`:
  - `requestCreate` — no longer refuses children.
  - `setTask(childKey, task): boolean` (delegates to store).
  - `setBusy(key, busy: boolean)` — stores `peer.busy` on the registry peer; emits `links_changed` (below).
  - `died(childKey)` — ended notice if unreported (replaces `childGone` and `#sweep`; both removed, `sweepDelayMs` option removed).
  - `familyBlock(key): string` — "" when no parent and no children; format below.
  - `decorate(toKey, prompt): string` — `prompt + "\n\n" + familyBlock(toKey)` when the block is non-empty.
  - `isRelative(a, b): boolean` — one is the stored parent of the other.
  - `snapshot(): Array<{ key, parent, name, task, createdAt, reported, parentDeleted, online, busy }>`.
  - `onChange(fn)` — called after any link/state change (link, rename via `attached`, setTask, report, setBusy, forget, online/offline); server wires it to a `links_changed` control event on every peer with `control`, swallowing throws.
- `#deliver(item)` decorates `item.prompt` with `decorate(item.toKey, …)` at delivery time (stored prompt stays raw).
- `formatList(registry, selfKey, delegation?)` appends `delegation.familyBlock(selfKey)` after the online list (also when nobody else is online).

Family block format (state words fixed; task = first line, cut at 120 chars with "…"):

```
Your children (2) — names are current; a closed child can still be messaged (the user is asked to reopen it):
- "api-tests-1a2b3c" — open, working — task: Write e2e tests for /orders [has 2 children]
- "docs-update-9f0c4e" — closed, reported — task: (task not recorded)
Your parent: "refactor-api-c3d4e5" — closed
```
State: `open, working` | `open, idle` | `closed`; append `, reported` when reported. Parent line: `open`/`closed`/`deleted`. `[has N children]` only when N > 0.

- [ ] **Step 1: Write the failing tests** (delete "create_session is refused for a child", the sweep tests and "a child gone without a report notifies the parent once"; replace with:)

```js
test("a child can request its own child", ...)                    // requestCreate from cli:child emits session_request
test("died sends the ended notice once, only for an unreported child", ...)
test("removing a peer from the registry produces no notice", ...) // registry.remove("cli:child") ⇒ parentPush empty
test("familyBlock lists direct children with state, task and grandchild badge", ...) // assert exact lines for open/working, closed/reported, (task not recorded), [has 1 children]
test("familyBlock is empty for a session without relatives", ...)
test("a report delivered to a parent carries the children block", ...)
test("list_sessions shows the family block even when nobody else is online", ...)
test("snapshot reports online and busy from the registry", ...)
test("onChange fires on link, setTask, report and setBusy", ...)
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** `create_session` description: drop "A delegated session cannot create further sessions."; add "Delegated sessions may delegate further." `report_result` description unchanged. Server instructions mention "list_sessions also shows your children and your parent."
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(relay): any-depth delegation, died notice and children block for the model`

---

### Task 4: Messages to a closed relative and reopen approval (broker side)

**Files:**
- Modify: `src/registry.mjs` (`send`), `src/delegation.mjs`
- Test: `electron/test/delegation-broker.test.mjs`

**Interfaces:**
- Consumes: Task 1 `uniqueName`, Task 2 reopen/awaiting API, Task 3 `isRelative`, `decorate`.
- Produces:
  - `Registry#offlineRelative: null | ((fromKey, name, text) => string | null)` — hook; in `send`, when no online peer matches `name`, `send` returns `this.offlineRelative?.(fromKey, name, text) ?? <today's No session text>`.
  - `Registry#chargePair(parentKey, childKey): boolean` — same pair-budget arithmetic as linked `send`, false when exhausted (then the budget-exhausted text is returned).
  - `Registry#send` uses `delegation.decorate` via another hook `Registry#decorate: null | ((toKey, prompt) => string)` for linked recipients.
  - `Delegation#messageClosed(fromKey, name, text): string | null` — matches `name` (case-insensitive) against the sender's stored parent and direct children not online; null if none. Charges the pair, enqueues `{ id, toKey, from, fromCwd?, text, prompt, awaiting: requestId }`, creates/reuses the reopen for `(fromKey, targetKey)` (one card per pair; later messages join the same `requestId`), emits `control("reopen_request", { requestId, targetKey, targetName, fromName, previews: string[] })` on the sender; no control → drops the item and returns the "no app connection" copy.
  - `Delegation#answerReopen(fromKey, requestId, approved: boolean, reason?: "missing")` — approved: `release(requestId)`, deliver at once if the target is online; rejected: `dropAwaiting`, waking `[from relay]` notice with the "did not reopen" copy; `reason: "missing"` also `forget(targetKey)`. Always `removeReopen`.
  - `attached(key)` additionally re-emits `reopen_request` for every `reopensFrom(key)` (same `requestId`).
  - Server wires `registry.offlineRelative = (f, n, t) => delegation.messageClosed(f, n, t)` and `registry.decorate = (k, p) => delegation.decorate(k, p)`.

- [ ] **Step 1: Write the failing tests**

```js
test("a message to a closed child is queued awaiting approval and a card is requested", ...) // result === closed copy; parentControl has ["reopen_request", {requestId, targetKey:"cli:child", ...}]; store.pending("cli:child") empty
test("two messages to the same closed child share one requestId", ...)
test("approve releases the queue; the child gets it on attach, decorated", ...)
test("reject drops the queue and wakes the sender with the not-delivered notice", ...)
test("a missing target on approve is forgotten", ...)
test("the sender's re-registration re-emits the same reopen_request", ...)   // Review Focus 1: same requestId, once per attach
test("a closed unrelated session still gets No session", ...)
test("a sender without app control gets the no-app-connection copy and nothing is queued", ...)
test("the pair budget is charged for a message to a closed relative", ...)
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** as in Interfaces.
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(relay): approval-gated reopen for messages to closed relatives`

---

### Task 5: Broker HTTP API and relay client

**Files:**
- Create: `src/links-api.mjs` (route logic, testable without HTTP)
- Modify: `server.mjs` (wire routes and hooks), `extension/copilot-relay/relay-client.mjs`
- Test: `electron/test/links-api.test.mjs`, `electron/test/delegation-broker.test.mjs` (client event parsing)

**Interfaces:**
- Produces `linksRoutes({ delegation, store })` returning handlers keyed `"GET /api/links"`, `"POST /api/links/forget"`, `"POST /api/links/missing"`, `"POST /api/peer/task"`, `"POST /api/peer/state"`, `"POST /api/peer/died"`, `"POST /api/peer/reopen-answer"`; each `(body) => { status, json? }`:
  - `GET /api/links` → `{ links: delegation.snapshot() }`
  - `POST /api/links/forget { keys: string[] }` and `POST /api/links/missing { keys }` → `store.forget` each `cli:` key (missing = same effect, separate route for logging) → 204
  - `POST /api/peer/task { key, task }` → `{ ok: boolean }`
  - `POST /api/peer/state { key, busy }` → 204
  - `POST /api/peer/died { key }` → 204
  - `POST /api/peer/reopen-answer { key, requestId, approved, reason? }` → 204
- `server.mjs` dispatches these before its `switch`, with the same `rejectForeign` protection; `delegation.onChange` → `control("links_changed", {})` for every registry peer with `control`.
- `RelayClient` gains: `setTask(task)`, `state(busy)`, `died()`, `answerReopen(requestId, approved, reason)` (all POST, errors swallowed like `ack`), callbacks `onReopenRequest(payload)` and `onLinksChanged()`, and static-free helper `fetchLinks(): Promise<object[]>` (GET `/api/links`).

- [ ] **Step 1: Write the failing tests** — one per route (status + store effect), e.g. `test("forget ignores non-cli keys", ...)`, `test("reopen-answer approve releases the queue", ...)`; and `test("the client calls onReopenRequest and onLinksChanged for their events", ...)` using a tiny `http.createServer` that writes the two SSE events then ends.
- [ ] **Step 2: Run** `node --test electron/test/links-api.test.mjs` — Expected: FAIL.
- [ ] **Step 3: Implement**; then `npm --prefix electron run copy-relay`.
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(relay): links API, peer state/died/reopen endpoints and client support`

---

### Task 6: Main process — no limits, no idle close, task/busy/died, links cache, reopen IPC

**Files:**
- Create: `electron/links-cache.mjs`
- Modify: `electron/main.mjs`, `electron/delegation.mjs`, `electron/preload.cjs`, `electron/renderer/ui-state.js` (remove `shouldCloseIdle`), `electron/package.json` (`files` list gets `links-cache.mjs`)
- Test: `electron/test/links-cache.test.mjs`, `electron/test/delegation-main.test.mjs`, `electron/test/ui-state.test.mjs`, `electron/test/packaging.test.mjs` (existing test must pass with the new file)

**Interfaces:**
- Consumes: Task 5 `RelayClient` methods/callbacks and `GET /api/links`.
- Produces:
  - `electron/links-cache.mjs`: `readLinksCache(file): object[]` (missing/corrupt → `[]`), `writeLinksCache(file, links): void` (temp + rename).
  - IPC (preload `api`): `getLinks(): Promise<object[]>` (cache first, then a fresh fetch replaces it via the event), `onLinks(cb)` (`"links:update"`, payload = snapshot array), `onReopenRequest(cb)` (`"reopen:request"`, payload `{ sessionId: senderSessionId, requestId, targetSessionId, targetName, fromName, previews }`), `answerReopen(senderSessionId, requestId, approved, reason?)`, `reportMissing(keys: string[])`, `forgetLinks(keys: string[])`.
  - Remove: `limitError`, `delegationLimitError`, `creating`, `"limit"` outcome path, the limit test(s), `delegation:stopChildren` IPC and `api.stopChildren`, `shouldCloseIdle` (+ its tests).
- Behaviour:
  - `createChild`: after `waitRegistered`, `await entry.relay.setTask(task)`.
  - Busy: wherever `entry.prompting` changes, call `entry.relay?.state(Boolean(entry.prompting))`.
  - `conn.on("exit")` (unexpected exit branch, after the `open.get(...)?.conn !== conn` guard): `entry.relay?.died()` **before** `entry.relay?.stop()` (move the `stop()` below the guard for this branch; keep stopping on both branches).
  - `onLinksChanged` from any relay client and app start (once the first relay client registers or `relayConfig().enabled`): fetch `/api/links`, write the cache in `app.getPath("userData")/links-cache.json`, `send("links:update", links)`; debounce 200 ms.
  - `onReopenRequest` → `notifyIfUnfocused("A session wants to reopen another one", fromName)` + `send("reopen:request", …)` with keys mapped `cli:<id>` → `<id>`.
  - `confirmLeavingChildren` keeps counting `unreportedChildren(open.values())` (every open child at any depth has `parentSessionId`); its message text says "sub-sessions".

- [ ] **Step 1: Write the failing tests** — `test("a missing or corrupt cache reads as []", ...)`, `test("write then read round-trips", ...)`; remove limit tests in `delegation-main.test.mjs` and `shouldCloseIdle` tests in `ui-state.test.mjs`.
- [ ] **Step 2: Run** — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** as above.
- [ ] **Step 4: Run** `npm test` — Expected: PASS, including `packaging.test.mjs`.
- [ ] **Step 5: Commit** `feat(desktop): links cache, reopen IPC; drop child limits and idle close`

---

### Task 7: Pure tree model for the renderer

**Files:**
- Create: `electron/renderer/session-tree.js` (UMD like `ui-state.js`: `globalThis.SessionTree` + `module.exports`)
- Modify: `electron/renderer/index.html` (script tag before `app.js`)
- Test: `electron/test/session-tree.test.mjs`

**Interfaces:**
- Input `links`: the snapshot array from Task 5/6 (keys `cli:<id>`). All functions take session ids (no `cli:`).
- Produces:
  - `index(links) → { parentOf: Map<id, id|null>, childrenOf: Map<id, id[]>, link: Map<id, link> }` — children by `createdAt`, links with `parentDeleted` have `parentOf = null`.
  - `descendants(idx, id): id[]` — cycle-safe, depth-first.
  - `closeOrder(idx, id, isOpen: (id) => boolean): id[]` — open descendants, deepest first (for one confirmation + cascade).
  - `nest(sessionsInGroup: {sessionId}[], idx): Array<{ s, depth }>` — keeps the group's order for roots, places each session under its parent when the parent is in the same group (siblings by `createdAt`), otherwise at depth 0; cycle-safe.
  - `relation(idx, id) → { parent: id|null, parentDeleted: boolean, children: Array<{ id, grandchildren: number }> }`.
  - `pruneCandidates(links, sessions, { listOk: boolean }): string[]` — `cli:` keys in links not in `sessions` (by id); `[]` unless `listOk`.

- [ ] **Step 1: Write the failing tests**

```js
test("nest puts children under their parent within a group", ...)        // [p, a, c, b] with depths [0,1,2,1]
test("a child whose parent is in another group stays at depth 0", ...)
test("nest and descendants terminate on a cycle", ...)                    // Review Focus 3
test("closeOrder lists open descendants deepest first", ...)              // Review Focus 2
test("relation gives parent, orphan flag and grandchild counts", ...)
test("pruneCandidates is empty when the list is not ok", ...)             // Review Focus 5
test("pruneCandidates returns only cli keys missing from the list", ...)
```

- [ ] **Step 2: Run** `node --test electron/test/session-tree.test.mjs` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): session tree model`

---

### Task 8: Renderer — sidebar tree, relation bar, cascade close, reopen card

**Files:**
- Modify: `electron/renderer/app.js`, `electron/renderer/style.css`

**Interfaces:**
- Consumes: Task 6 IPC, Task 7 `SessionTree`.
- Behaviour:
  - Module state `links` (array) + `tree = SessionTree.index(links)`; load with `api.getLinks()` at start, update on `api.onLinks`, then `renderList()` and every view's `renderRelations()`.
  - Remove the idle-close `setInterval` and `SessionView.lastActivity`.
  - `renderList`: every group (Open in app, Pinned, project groups, search) goes through `SessionTree.nest`; `item(s, v, { depth })` indents by depth (CSS var `--depth`, tree connector `└`); the "child of X" meta uses `tree.parentOf` (not `v.parentSessionId`) and shows "parent deleted" for orphans. `parentLabel` falls back to the link's `name`.
  - Relation bar `this.relationsEl` under `.head`: child → `Parent: [name]` / `Parent: deleted`; parent → `Sub-sessions:` chips with dot (open/busy as in the sidebar), `✓` when reported, `+N` when it has children; hidden when neither. Click → `activate` if open, else `openSession(s)` (sidebar path, it activates).
  - `closeView(id)`: `ids = SessionTree.closeOrder(tree, id, isOpen)`; one `confirm()` if any of `[...ids, id]` is busy ("N sessions are still working. Stop them and close?"); then close `ids` then `id`.
  - "Stop all children" → label "Close all sub-sessions", title "Close every sub-session of this one (they stay resumable)", visible when `closeOrder` is non-empty, closes `closeOrder` only.
  - `openSession(s, { activate = true } = {})` — the reopen path passes `false`.
  - Reopen card `SessionView#reopenCard({ requestId, targetSessionId, targetName, fromName, previews })` in the sender's view, styled like the delegation card: "<fromName> wants to message the closed session <targetName>. Reopen it?" + previews + Approve / Reject; dedupe by `requestId` (a second request with an open card for the same id is ignored — Review Focus 1). Approve: if the target is not in `sessions` → `api.answerReopen(…, false, "missing")` and the card says "This session no longer exists."; else `api.answerReopen(…, true)`, then `openSession(target, { activate: false })` unless already open. Reject → `api.answerReopen(…, false)`.

- [ ] **Step 1: Implement** the behaviour above.
- [ ] **Step 2: Run** `npm test` — Expected: PASS (no renderer unit tests; Task 7 covers the logic).
- [ ] **Step 3: Manual check** (`npm run app`, relay on; Copilot is 403 on the dev machine, so run on the corp PC): parent creates child → nested in sidebar + both bars; close parent → child closes; restart app → tree still shown; child closed, parent sends `send_message` → card → Approve → child reopens in background and answers.
- [ ] **Step 4: Commit** `feat(desktop): sub-session tree in sidebar and session view, cascade close, reopen card`

---

### Task 9: Delete dialog with per-descendant choice, and pruning of missing sessions

**Files:**
- Modify: `electron/renderer/app.js` (`deleteSessionFlow`, `refresh`), `electron/renderer/index.html` (a `<dialog id="delete-tree">`), `electron/renderer/style.css`

**Interfaces:**
- Consumes: Task 6 `api.forgetLinks`, `api.reportMissing`; Task 7 `descendants`, `pruneCandidates`.
- Behaviour:
  - `deleteSessionFlow(s)`: when `SessionTree.descendants(tree, s.sessionId)` is empty → today's `confirm()` path unchanged. Otherwise show `#delete-tree`: today's warning text, then the descendants indented by depth, each with an unchecked "Delete too" checkbox (independent rows), Delete / Cancel.
  - On Delete: delete `s` then each checked descendant through the existing delete path (one at a time, same status/error handling); close every unchecked open descendant; `api.forgetLinks(["cli:"+id for each deleted id])` (the broker orphans the kept children).
  - Sessions without descendants also call `api.forgetLinks` after a successful delete if they have a link (a deleted child disappears from its parent's tree).
  - `refresh()`: after a successful `api.listSessions()`, `keys = SessionTree.pruneCandidates(links, sessions, { listOk: true })`; non-empty → `api.reportMissing(keys)`. On failure pass `listOk: false` (no call).

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Run** `npm test` — Expected: PASS.
- [ ] **Step 3: Manual check:** parent with two children → Delete parent, check one → that child is deleted, the other shows "parent deleted"; delete a child's folder session from the terminal → after the next refresh it disappears from the tree.
- [ ] **Step 4: Commit** `feat(desktop): delete dialog for sub-session trees; prune sessions missing on disk`
