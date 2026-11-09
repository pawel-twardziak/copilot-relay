# Delegated Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A desktop-app session can request a new, visible session for one topic (with optional agent and model); after the user clicks Approve, the child works independently and reports back to its parent.

**Architecture:** The broker owns identity, parent–child links, budgets and durable delivery (`src/delegation*.mjs`). The Electron main process owns processes, limits and creation. The renderer owns the approval card and the prompt queue. A request travels MCP tool → broker → parent's SSE stream → main → renderer card → main creates the child.

**Tech Stack:** Node ≥ 18 ESM, Electron, `@modelcontextprotocol/sdk`, zod, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-08-delegated-sessions-design.md`

## Global Constraints

- Work on branch `feat/delegated-sessions`, never on `main`.
- Tests: `npm test` from the repo root runs `electron/test/*.test.mjs`. All must pass at the end of every task.
- Tools exist only when `?peer=` starts with `app:`; invalid callers get a readable refusal, never a hidden tool.
- Approval is answered only through IPC from the window. No MCP tool or HTTP endpoint may approve a request or answer a permission.
- `create_session` has no `cwd` and no permission parameter.
- Defaults: 3 live children per parent, 5 in the app, pair budget 12, idle close 15 minutes.
- Limits live in the settings file as `maxChildrenPerParent` and `maxChildrenTotal`; the pair budget is `maxAgentMessagesPerPair` in `relay.config.json`. No settings UI in this version.
- Waking: report, rejected, over limit, invalid agent/model, ended without report. Non-waking: the child's final name.
- Reports and waking notices are written to disk before delivery and removed only on the renderer's acknowledgement.
- The reserved sender for notices is `relay`.

## Review Focus

- An SSE reconnect while a report sits in the GUI queue: the report runs once, not twice (test in Task 7).
- The user approves a card after the parent was closed: nothing is created (test in Task 5).
- A child is requested as `relay`, `user`, or a name already taken: the parent learns the real final name (test in Task 2).
- Two requests near the limit, approved one after another: the limit still holds (test in Task 5).
- An idle child the user is reading, or one with a queued message: it is not closed under them (test in Task 7).

---

### Task 1: Verify config options on the live Copilot CLI

No product code. Decides whether Task 6 uses `session/set_config_option` or the `--model` fallback.

**Files:** a throwaway script in the session scratchpad.

**Interfaces:**
- Produces: the model option's `id`/`category`, recorded in the spec's "Must be verified" section.

- [ ] **Step 1: Create the branch**

Run: `git switch -c feat/delegated-sessions`

- [ ] **Step 2: Write a probe using `electron/acp.mjs`'s `AcpConnection`**

It runs `session/new` in the repo, prints each option's `id`, `category`, `currentValue` and values, sets a non-default model and agent (if any) with `session/set_config_option`, then sends the prompt `Name the model you are running on, in one line.`

- [ ] **Step 3: Run it and check**

Expected: a model option exists, and the reply or the `currentValue` shows the new model. Also run a turn on a `session/new` with an `mcpServers` entry to confirm alias-after-`session/new` tools still list.

- [ ] **Step 4: Record the result in the spec and commit**

If `set_config_option` does not apply before the first prompt, add an `args` option to `AcpConnection` (`["--acp", "--stdio", ...args]`) and have Task 6 pass `--model`/`--agent`.

```bash
git add docs/superpowers/specs/2026-11-08-delegated-sessions-design.md
git commit -m "docs(spec): record delegated session config verification"
```

---

### Task 2: Registry links and pair budgets

**Files:**
- Modify: `src/registry.mjs`
- Test: `electron/test/registry-links.test.mjs`

**Interfaces:**
- Produces:
  - `new Registry({ maxAgentMessages, maxPairMessages = 12 })`
  - `upsert({ ..., parentKey = null, control = null })`; peers gain `parentKey`, `control`; `disconnect` nulls `control`; `describe` includes `parentKey`
  - `isLinked(aKey, bKey) -> boolean`
  - `pushTo(key, msg) -> boolean` (true only if pushed to an online peer)
  - `humanPrompt(key?)` refills the global budget and every pair containing `key`; `sendFromUser` passes the target's key
  - Name `relay` is reserved.

- [ ] **Step 1: Write the failing tests**

```js
test("relay and user are reserved: a child requested as relay gets another name", () => {
  const r = new Registry();
  const p = r.upsert({ key: "cli:c", name: "relay", kind: "cli" });
  assert.notEqual(p.name, "relay");
  assert.throws(() => r.rename("cli:c", "relay"), /reserved/);
});
test("a taken name yields a suffixed final name", () => {
  const r = new Registry();
  r.upsert({ key: "a", name: "badacz", kind: "cli" });
  assert.equal(r.upsert({ key: "b", name: "badacz", kind: "cli" }).name, "badacz-2");
});
test("linked messages use the pair budget, not the global one", () => {
  const r = new Registry({ maxAgentMessages: 1, maxPairMessages: 2 });
  r.upsert({ key: "p", name: "p", kind: "cli", push: () => true });
  r.upsert({ key: "c", name: "c", kind: "cli", parentKey: "p", push: () => true });
  assert.match(r.send("c", "p", "1"), /delivered/);
  assert.match(r.send("p", "c", "2"), /delivered/);
  assert.match(r.send("c", "p", "3"), /budget/);
  assert.equal(r.budget, 1);
});
test("a human prompt in either session refills only that pair", () => {
  // two pairs exhausted; humanPrompt("p1") → p1 pair sends, p2 pair still blocked
});
test("unlinked messages still use the global budget", () => { /* budget decrements to 0, third is blocked */ });
test("pushTo is false for an offline peer", () => { /* disconnect → pushTo returns false */ });
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test electron/test/registry-links.test.mjs`
Expected: FAIL on the reserved name and pair budget assertions.

- [ ] **Step 3: Implement in `src/registry.mjs`**

Pair budgets are a `Map` keyed `parentKey|childKey`, lazily set to `maxPairMessages`. In `send`, a linked pair spends its own budget and leaves `this.budget` untouched; the exhausted text stays the same.

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/registry.mjs electron/test/registry-links.test.mjs
git commit -m "feat(relay): parent-child links and pair budgets in the registry"
```

---

### Task 3: Durable delegation service in the broker

**Files:**
- Create: `src/delegation-store.mjs`, `src/delegation.mjs`
- Modify: `src/name-store.mjs` (export `stateFile(name)` from `defaultFile`)
- Test: `electron/test/delegation-broker.test.mjs`

The store is a separate file (`delegations.json`, same state folder; `COPILOT_RELAY_DELEGATIONS_FILE` overrides) because `NameStore` prunes to 1000 entries and rebuilds each one; a link or report must not be pruned.

**Interfaces:**
- Consumes: Task 2 `Registry`.
- Produces:
  - `DelegationStore(file)`: `link(child, parent)`, `parentOf(child)`, `childrenOf(parent)`, `markReported(child)`, `isReported(child)`, `markEndedNotice(child) -> boolean` (true first time only), `enqueue(item)`, `pending(parentKey) -> item[]`, `remove(id) -> boolean`. Item: `{ id, parentKey, from, text, prompt }`. Writes are atomic (tmp + rename).
  - `new Delegation({ registry, store, sweepDelayMs = 30_000, newId = randomUUID })`:
    - `link(childKey, parentKey)`
    - `requestCreate(callerKey, { name, task, agent, model }) -> string`; calls `peer.control("session_request", { requestId, name, task, agent, model })`
    - `report(callerKey, text) -> string`; after success calls the child's `control("reported", {})`
    - `outcome(parentKey, { requestId, kind, name, text })`; `kind` is `created | rejected | limit | invalid | failed`
    - `attached(key)`: redeliver pending items, restore `parentKey`, schedule the sweep
    - `ack(key, id) -> boolean`
    - `childGone(childKey)`
  - Pushed message fields: `{ from, human: false, text, prompt, deliveryId?, wake }`.

- [ ] **Step 1: Write the failing tests**

```js
// setup(): temp-file store, Registry, Delegation with sweepDelayMs: 0;
// parent/child peers with push and control recording into arrays
test("create_session is refused for a child", () => {
  assert.match(d.requestCreate("cli:child", req), /cannot create/i);
  assert.equal(childControl.length, 0);
});
test("create_session is refused when the app connection is down", () => { /* parent disconnected → /not connected/i */ });
test("create_session returns a request id and emits session_request", () => {
  assert.match(d.requestCreate("cli:parent", req), /Do not wait/);
  assert.equal(parentControl[0][0], "session_request");
});
test("a report reaches the parent and stays on disk until acked", () => {
  d.report("cli:child", "wynik");
  assert.equal(parentPush[0].wake, true);
  assert.equal(store.pending("cli:parent").length, 1);
  assert.ok(d.ack("cli:parent", parentPush[0].deliveryId));
  assert.equal(store.pending("cli:parent").length, 0);
});
test("report_result works once and is refused for a non-child", () => {
  d.report("cli:child", "a");
  assert.match(d.report("cli:child", "b"), /already/i);
  assert.match(d.report("cli:parent", "x"), /not a delegated/i);
});
test("a report made with the budget spent is still delivered", () => { /* registry pair budget 0 → push received */ });
test("a report for an offline parent is delivered on attach", () => { /* disconnect, report, no push; upsert+attached → push */ });
test("an unacknowledged report survives a new store and is redelivered", () => { /* new DelegationStore(same file), attached → push */ });
test("the created notice does not wake and is not persisted", () => {
  d.outcome("cli:parent", { requestId: "r", kind: "created", name: "badacz", text: "..." });
  assert.equal(parentPush[0].wake, false);
  assert.equal(store.pending("cli:parent").length, 0);
});
test("rejected, limit, invalid and failed outcomes wake and persist", () => { /* each kind */ });
test("a child gone without a report notifies the parent once", () => { /* childGone twice → 1 item */ });
test("a child gone after reporting produces no notice", () => {});
test("attached sweeps offline unreported children, but not online ones", () => {});
test("a child that re-registers before the sweep produces no notice", () => { /* real sweepDelayMs: 5, child upserts first */ });
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test electron/test/delegation-broker.test.mjs`
Expected: FAIL, cannot find `src/delegation.mjs`.

- [ ] **Step 3: Implement both files**

Notice prompts are `[from relay]\n<text>`. Report prompts follow `Registry.send`'s `[from <child>]` format and relay note. The ended notice reads: `Session "<name>" ended without reporting a result. You can ask the user to reopen it.`; keep the last known name in the link record.

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/delegation-store.mjs src/delegation.mjs src/name-store.mjs electron/test/delegation-broker.test.mjs
git commit -m "feat(relay): durable delegation service with at-least-once reports"
```

---

### Task 4: Broker wiring, MCP tools and RelayClient

**Files:**
- Modify: `src/mcp.mjs`, `server.mjs`, `extension/copilot-relay/relay-client.mjs`, `relay.config.json`
- Test: `electron/test/delegation-broker.test.mjs`

**Interfaces:**
- Consumes: Task 3 `Delegation`.
- Produces:
  - `createMcpHandler(registry, delegation)`; tools `create_session` (`name`, `task`, optional `agent`, `model`, all strings) and `report_result` (`text`).
  - `formatList` output adds `your parent` / `your child`.
  - `GET /api/peer/stream` reads `parent=<key>`; passes `control`; `registered` payload is `{ name, parentKey, reported }`.
  - `POST /api/peer/ack { key, id }` and `POST /api/peer/delegation-outcome { key, requestId, kind, name, text }`.
  - `RelayClient`: ctor options `parentKey`, `onSessionRequest(req)`, `onReported()`; `onRegistered(name, payload)`; methods `ack(id)`, `outcome(o)`. `parentKey` is sent on the first connection only, as `requestedName` is.

- [ ] **Step 1: Write the failing test for the list and tool guard**

Export `formatList` and `delegationToolsAllowed(peerParam)` from `src/mcp.mjs`:

```js
test("list_sessions marks parent and child with current names", () => {
  assert.match(formatList(registry, "cli:child"), /- parent-name .*your parent/);
  assert.match(formatList(registry, "cli:parent"), /- child-name .*your child/);
});
test("delegation tools exist only for desktop aliases", () => {
  assert.equal(delegationToolsAllowed("app:123"), true);
  assert.equal(delegationToolsAllowed("cli:abc"), false);
  assert.equal(delegationToolsAllowed(null), false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test electron/test/delegation-broker.test.mjs`
Expected: FAIL, `formatList` is not exported.

- [ ] **Step 3: Implement**

In `server.mjs`: construct the store and `Delegation`, read `maxAgentMessagesPerPair`, call `delegation.attached(key)` after `write("registered", ...)`, route `registry.on("peer_removed", e => delegation.childGone(e.key))`, and pass `key` in `POST /api/peer/human`. Add the tools to the MCP server's `instructions` text.

- [ ] **Step 4: Run all tests and start the broker**

Run: `npm test` then `COPILOT_RELAY_PORT=7790 node server.mjs` and `curl -s localhost:7790/health`.
Expected: tests PASS; health returns `"ok":true`. Stop the broker.

- [ ] **Step 5: Commit**

```bash
git add src/mcp.mjs server.mjs extension/copilot-relay/relay-client.mjs relay.config.json electron/test/delegation-broker.test.mjs
git commit -m "feat(relay): create_session and report_result tools"
```

---

### Task 5: Main-process pure helpers

**Files:**
- Create: `electron/delegation.mjs`
- Test: `electron/test/delegation-main.test.mjs`

**Interfaces:**
- Produces:
  - `limitError(entries, parentId, { perParent = 3, total = 5 }, creating = []) -> string | null`; `entries` are `{ parentSessionId }`, `creating` are parent IDs of creations in progress
  - `findModelOption(options)` (uses Task 1's finding)
  - `resolveConfig(options, { agent, model, inheritedModel }) -> { sets: {configId, value}[] } | { error: string }`
  - `childPrompt({ parentName, task }) -> string`
  - `unreportedChildren(entries) -> entry[]`
  - `class PendingRequests`: `add(req)`, `take(id) -> req | undefined`, `dropForParent(parentId)`

- [ ] **Step 1: Write the failing tests**

```js
test("limits: 3 per parent, 5 in total", () => {
  assert.match(limitError(children("p", 3), "p"), /3/);
  assert.equal(limitError(children("p", 2), "p"), null);
  assert.match(limitError([...children("p", 2), ...children("q", 3)], "p"), /5/);
});
test("creations in progress count toward the limit", () => {
  assert.match(limitError(children("p", 2), "p", {}, ["p"]), /3/);
});
test("an unknown model is an error listing valid values", () => {
  assert.match(resolveConfig(options, { model: "nope" }).error, /gpt-a.*gpt-b/s);
});
test("no agent option at all is an error when an agent is requested", () => {
  assert.match(resolveConfig(noAgent, { agent: "x" }).error, /no custom agents/i);
});
test("omitted agent sets nothing; omitted model inherits", () => {
  assert.deepEqual(resolveConfig(options, { inheritedModel: "gpt-b" }).sets, [{ configId: MODEL_ID, value: "gpt-b" }]);
});
test("an inherited model that is unavailable is skipped, not an error", () => {});
test("a card answered after its parent closed finds nothing", () => {
  const p = new PendingRequests();
  p.add({ requestId: "r", parentSessionId: "p" });
  p.dropForParent("p");
  assert.equal(p.take("r"), undefined);
});
test("the child prompt names the parent, the task and report_result", () => {
  const t = childPrompt({ parentName: "glowna", task: "Sprawdź X" });
  assert.match(t, /^\[from glowna\]\n/);
  assert.match(t, /Sprawdź X/);
  assert.match(t, /report_result/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test electron/test/delegation-main.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `electron/delegation.mjs`**

Add the file to `files` in `electron/package.json` if that list names modules individually.

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/delegation.mjs electron/package.json electron/test/delegation-main.test.mjs
git commit -m "feat(desktop): delegation limits and config resolution"
```

---

### Task 6: Creating the child in the main process

**Files:**
- Modify: `electron/main.mjs`, `electron/preload.cjs`

Covered by the manual run in Task 9; its decisions are tested in Task 5.

**Interfaces:**
- Consumes: Tasks 4 and 5.
- Produces:
  - IPC: `relay:ack(sessionId, id)`, `delegation:answer(requestId, approved) -> boolean`, `delegation:stopChildren(parentSessionId)`
  - Events: `delegation:request { requestId, parentSessionId, name, task, agent, model, cwd }`, `delegation:created { sessionId, cwd, configOptions, parentSessionId, title }`, `delegation:closed { sessionId }`
  - Preload: `relayAck`, `answerDelegation`, `stopChildren`, `onDelegationRequest`, `onDelegationCreated`, `onDelegationClosed`
  - Entry fields: `parentSessionId`, `reported`, `configOptions`

- [ ] **Step 1: Extract `createSession(cwd, { name, parentKey } = {}) -> { sessionId, cwd, configOptions, entry }`** from `sessions:new`, and have the handler call it. `attach` and `relayStart` take `{ name, parentKey }`. `onMessage` forwards `deliveryId` and `wake`. Keep `entry.configOptions` current from `session/new`, `session/load`, `sessions:setConfig` and `config_option_update`.

- [ ] **Step 2: Extend the auto-approve regex in `attach`** to `send_message|list_sessions|create_session|report_result`.

- [ ] **Step 3: Handle `onSessionRequest`**: check `limitError`; if over, `outcome` kind `limit`. Otherwise `PendingRequests.add` and send `delegation:request`. Call `dropForParent` from `closeEntry` and the exit handler.

- [ ] **Step 4: Implement `delegation:answer`**: `take` the request (unknown → `false`). Rejected → outcome `rejected`. Approved: re-check `limitError` with in-progress creations, `createSession` in the parent's `cwd`, apply `resolveConfig` (error → `conn.kill`, close the entry, outcome `invalid`), send `delegation:created`, wait up to 10 s for `registered` (timeout → close, outcome `failed`), send outcome `created` with the final name, then send `relay:message` to the child with `childPrompt` and `wake: true`. Any thrown error → outcome `failed`.

- [ ] **Step 5: Set `parentSessionId`/`reported`** from the `registered` payload (strip `cli:`), and `reported = true` in `onReported`. Implement `delegation:stopChildren` with `closeEntry` plus `delegation:closed` per child.

- [ ] **Step 6: Run tests and start the app**

Run: `npm test`, then start the app from `electron/`.
Expected: tests PASS; a normal new session still starts and chats.

- [ ] **Step 7: Commit**

```bash
git add electron/main.mjs electron/preload.cjs
git commit -m "feat(desktop): create approved delegated sessions"
```

---

### Task 7: Renderer: card, delivery and child views

**Files:**
- Modify: `electron/renderer/app.js`, `electron/renderer/ui-state.js`, `electron/renderer/style.css`
- Test: `electron/test/ui-state.test.mjs`

**Interfaces:**
- Consumes: Task 6 preload API.
- Produces: `UiState.acceptDelivery(seen: Set, id) -> boolean`; `UiState.shouldCloseIdle({ parentSessionId, busy, inboxLength, pendingPermissions, active, lastActivity }, now, ms = 900_000) -> boolean`.

- [ ] **Step 1: Write the failing tests**

```js
test("a redelivered report is accepted once; messages without an id always pass", () => {
  const seen = new Set();
  assert.equal(acceptDelivery(seen, "d1"), true);
  assert.equal(acceptDelivery(seen, "d1"), false);
  assert.equal(acceptDelivery(seen, undefined), true);
});
const idle = { parentSessionId: "p", busy: false, inboxLength: 0, pendingPermissions: 0, active: false, lastActivity: 0 };
test("an idle child closes after 15 minutes", () => {
  assert.equal(shouldCloseIdle(idle, 900_000), true);
  assert.equal(shouldCloseIdle(idle, 899_999), false);
});
for (const [what, change] of [
  ["a busy child", { busy: true }],
  ["a child with a queued message", { inboxLength: 1 }],
  ["a child waiting for a permission", { pendingPermissions: 1 }],
  ["the child on screen", { active: true }],
  ["a session that is not a child", { parentSessionId: null }],
]) test(`${what} is not closed`, () => assert.equal(shouldCloseIdle({ ...idle, ...change }, 1e9), false));
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test electron/test/ui-state.test.mjs`
Expected: FAIL, `acceptDelivery` is not a function.

- [ ] **Step 3: Implement delivery in `SessionView`**

`incoming`: drop duplicates with `acceptDelivery`. `wake === false`: show with `system`, push `m.prompt` to `this.pendingNotes`, do not pump. `pump`: call `api.relayAck` right after `shift` when `m.deliveryId` is set. `runPrompt`: prepend `pendingNotes` to the text sent, and clear them. The bubble's `_matchText` must return the full text sent, so fork and delete still match it.

- [ ] **Step 4: Implement the card and child views**

The card in the parent's view shows name, full task as plain text, agent, model or `inherited`, and working directory, with Approve and Reject calling `answerDelegation`. `onDelegationCreated` builds the view as `newSession` does but never calls `activate`. Sidebar `item` shows a marker while a view has an unanswered card or permission, and the parent's name for a child. The parent's header gets "Stop all children" while it has live children. `onDelegationClosed` runs `dropView` and `renderList`. A 60 s interval closes views for which `shouldCloseIdle` is true.

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add electron/renderer/app.js electron/renderer/ui-state.js electron/renderer/style.css electron/test/ui-state.test.mjs
git commit -m "feat(desktop): approval card, delegated views and report delivery"
```

---

### Task 8: Quit confirmation and OS notifications

**Files:**
- Modify: `electron/main.mjs`

`before-quit` currently calls `killAll` before any window closes, so the confirmation has to come first.

**Interfaces:**
- Consumes: Task 5 `unreportedChildren`, Task 6 entry fields.
- Produces: `confirmLeavingChildren() -> boolean`, remembered as confirmed for the rest of the quit.

- [ ] **Step 1: Test `unreportedChildren`** in `electron/test/delegation-main.test.mjs`: returns children with `reported` false; skips reported children and non-children. Run it. Expected: PASS if Task 5 already covers it, otherwise add the case and fix.

- [ ] **Step 2: Implement `confirmLeavingChildren`** with `dialog.showMessageBoxSync` (buttons `Quit`, `Cancel`; text names the count). Call it in `win.on("close")` and in `before-quit`, using `preventDefault` when refused. `killAll` runs only after confirmation.

- [ ] **Step 3: Add `notifyIfUnfocused(title, body)`** with Electron's `Notification`, used for a creation card and for a child's permission request.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/main.mjs electron/test/delegation-main.test.mjs
git commit -m "feat(desktop): confirm quitting with unfinished delegated sessions"
```

---

### Task 9: End-to-end run and documentation

**Files:**
- Modify: `electron/README.md`, `README.md`

- [ ] **Step 1: Run the scenarios in the real app**

Restart the broker first, so it runs the new code. Each must behave as the spec says:

1. Approve with agent and model: child appears unfocused, works, report wakes the parent.
2. Reject: parent is told.
3. Invalid model: no child; parent gets valid values.
4. Fourth child of one parent: over-limit notice.
5. A child calling `create_session`: refused.
6. Rename a child, then parent `list_sessions` and `send_message`.
7. Report while the parent is busy, then close the parent's view and reopen: report arrives once.
8. Parent closed before the report: delivered on reopen.
9. Child needs a file edit while another session is on screen: marker, OS notification, waits.
10. Quit with an unfinished child: confirmation; Cancel keeps it running.
11. Kill the app process with a running child, reopen the parent after 30 s: one ended-without-report notice.
12. Broker restart between child creation and report.
13. Fork from a message that carried a prepended note.
14. Stop all children.

- [ ] **Step 2: Document the feature**, including tools, limits, settings keys, and that sessions share the working directory.

- [ ] **Step 3: Run tests and commit**

Run: `npm test`
Expected: PASS.

```bash
git add README.md electron/README.md
git commit -m "docs: delegated sessions"
```
