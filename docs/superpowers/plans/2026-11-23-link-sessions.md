# Link and Unlink Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two relay tools, `adopt_session` and `release_session`, let a desktop-app session take another existing
session as its child or end the link to a child, each only after the user approves a card in the app.

**Architecture:** The broker holds a pending link request in memory (`Delegation`), emits it on the parent's control
stream, and changes the link only when the app answers `POST /api/peer/link-answer` with the request's id, after
validating again. The app (`RelayClient` → `main.mjs` → renderer) shows the card in the parent's view and follows
`parent_changed` on the child's stream.

**Tech Stack:** Node.js (ESM), `@modelcontextprotocol/sdk`, zod, Electron, vanilla JS renderer, `node:test`, the UI
checks in `scripts/ui-check` (Xvfb).

**Spec:** `docs/superpowers/specs/2026-11-23-link-sessions-design.md`

## Global Constraints

- Branch `feat/link-sessions`, cut from `main`. The spec file is committed on it first (it is untracked on `main`).
- No new dependencies.
- Existing `delegations.json` files load unchanged; the only new stored field is the optional `adopted: true` on a link.
- Pending link requests are in memory only. Nothing about them is written to `delegations.json`.
- No endpoint links or unlinks a pair of keys directly. The only path is `link-answer` with a pending `requestId`.
- The tool reply never contains the `requestId`.
- `report_result` keeps working once per link, also for an adopted child.
- Control event names: `link_request`, `parent_changed`. Stream capability: `caps=links`.
- Tests: `npm test` from the repo root. UI checks: `node scripts/ui-check/run.mjs <name…>`.
- Commits: `feat(relay): …` for `src/`, `server.mjs`, `extension/`; `feat(desktop): …` for `electron/`;
  `test(relay|desktop): …`; `docs: …`. No version tag in this plan (v0.20.0 goes on main's merge commit).
- Exact texts (tests match them by regex; keep the wording):

| Id | Text |
|---|---|
| `SENT` | `The user was asked to approve it. The outcome arrives as a message from relay. Do not wait for it.` |
| `NO_APP` | `Your app connection is not connected, so the user cannot be asked now.` |
| `OLD_APP` | `The desktop app is older than the relay broker and cannot show the approval card. Update the app.` |
| `NO_TARGET` | `No open session "<name>". Call list_sessions to see who is online.` |
| `SELF` | `You cannot adopt yourself.` |
| `NOT_APP` | `"<name>" is not a desktop-app session, so it cannot be adopted.` |
| `ALREADY` | `"<name>" is already your child.` |
| `HAS_PARENT` | `"<name>" already has a parent ("<parent>"). It must be released first.` |
| `CYCLE` | `"<name>" is one of your ancestors, so it cannot become your child.` |
| `CLOSED_NOW` | `Session "<name>" is closed now. Open it and ask again.` |
| `NOT_CHILD` | `"<name>" is not one of your children.` |
| parent, linked | `Session "<child>" is now your child. It can send you results with report_result.` |
| child, linked | `The user made this session a child of "<parent>". Send it results with the report_result tool.` |
| parent, released | `Session "<child>" is no longer your child.` |
| child, released | `The user ended the link to "<parent>". You no longer report to it.` |
| parent, rejected | `The user rejected the request to link "<child>".` / `…to release "<child>".` |
| reopen dropped | `The link to "<target>" was ended; your queued message was not delivered.` |

## Review Focus

1. **Two sessions ask to adopt the same child and both cards are approved.** Expected: the first links, the second
   answers `refused` with `HAS_PARENT`; the child has one parent. Task 2 test.
2. **The child is renamed between the request and the approval.** Expected: it is linked (the request holds keys),
   and the notices use the current name. Task 2 test.
3. **A release is approved while a reopen card for the same pair is open.** Expected: the queued message is dropped,
   its sender is told, and the reopen card's answer gets 404. Task 2 test.
4. **The broker restarts while a link card is on screen.** Expected: the card's answer is 404 and the card says
   `This request is no longer pending.`; nothing is linked. Task 3 client test, Task 6 UI check.
5. **The parent of an adopted child is deleted.** Expected: the child becomes an orphan like any other and can be
   adopted by another session, with a fresh link. Task 2 test.

---

### Task 0: Branch and spec

- [ ] **Step 1:** `git switch -c feat/link-sessions` from `main` (or a worktree on that branch, per
  superpowers:using-git-worktrees; copy the two untracked files into it).
- [ ] **Step 2:** Commit the spec and this plan.

```bash
git add docs/superpowers/specs/2026-11-23-link-sessions-design.md docs/superpowers/plans/2026-11-23-link-sessions.md
git commit -m "docs: link sessions design and plan (adopt_session, release_session)"
```

---

### Task 1: Store — adopted links and unlink

**Files:**
- Modify: `src/delegation-store.mjs` (`link`, new `adopt`, `unlink`, `isAdopted`)
- Test: `electron/test/delegation-broker.test.mjs`

**Interfaces:**
- Produces:
  - `DelegationStore.adopt(child: string, parent: string, name: string): void` — writes a fresh link
    `{ parent, name, reported: false, ended: false, createdAt: Date.now(), adopted: true }`, replacing any previous
    link of `child` as a whole.
  - `DelegationStore.unlink(child: string): boolean` — deletes the child's link only; false when it has none.
  - `DelegationStore.isAdopted(child: string): boolean`.
  - `DelegationStore.link(child, parent, name)` keeps `adopted` when the previous link had the same `parent`.

- [ ] **Step 1: Write the failing tests**

```js
test("adopt writes a fresh link and drops an orphan's old task and date", async () => {
  const { store, file } = setup(); // cli:child is linked to cli:parent
  store.setTask("cli:child", "old task");
  const before = store.linkOf("cli:child").createdAt;
  store.forget("cli:parent"); // cli:child is an orphan now
  await tick();
  store.adopt("cli:child", "cli:other", "badacz");
  const l = new DelegationStore(file).linkOf("cli:child"); // on disk
  assert.deepEqual({ ...l, createdAt: 0 }, { parent: "cli:other", name: "badacz", reported: false, ended: false, createdAt: 0, adopted: true });
  assert.ok(l.createdAt > before);
  assert.equal(store.isAdopted("cli:child"), true);
});

test("link keeps adopted for the same parent (a rename) and unlink removes the link only", () => {
  const { store, file } = setup();
  store.link("cli:grand", "cli:child", "wnuk");
  store.adopt("cli:child", "cli:parent", "badacz");
  store.link("cli:child", "cli:parent", "nowa-nazwa");
  assert.equal(store.isAdopted("cli:child"), true);
  store.enqueue({ id: "r1", toKey: "cli:parent", from: "badacz", text: "report", prompt: "report" });
  assert.equal(store.unlink("cli:child"), true);
  assert.equal(store.unlink("cli:child"), false);
  const fresh = new DelegationStore(file);
  assert.equal(fresh.linkOf("cli:child"), null);
  assert.equal(fresh.isAdopted("cli:child"), false);
  assert.deepEqual(fresh.childrenOf("cli:child"), ["cli:grand"]); // its own children stay
  assert.equal(fresh.linkOf("cli:grand").parentDeleted, undefined); // and are not orphaned
  assert.equal(fresh.pending("cli:parent").length, 1); // a report already sent stays
});
```

- [ ] **Step 2:** Run `node --test electron/test/delegation-broker.test.mjs`. Expected: both fail (`store.adopt is not a function`).
- [ ] **Step 3:** Implement `adopt`, `unlink`, `isAdopted` and the `adopted` carry-over in `link` in `src/delegation-store.mjs`.
- [ ] **Step 4:** Run the file again. Expected: all pass.
- [ ] **Step 5:** `git commit -m "feat(relay): the link store adopts and unlinks"`

---

### Task 2: Broker logic — request, validate, answer, effects

**Files:**
- Modify: `src/delegation.mjs` (new `requestLink`, `answerLink`; `attached`, `#forget`, `died`, `snapshot`, constructor)
- Modify: `src/registry.mjs` (`upsert` gets `linkCards`; new `dropPair`)
- Test: `electron/test/delegation-broker.test.mjs`

**Interfaces:**
- Consumes: Task 1's `adopt`, `unlink`, `isAdopted`.
- Produces:
  - `Registry.upsert({ …, linkCards?: boolean })` — stored as `peer.linkCards`; a re-attach that leaves it out keeps it.
  - `Registry.dropPair(parentKey: string, childKey: string): void` — deletes the pair's entry in `pairBudgets`.
  - `Delegation.requestLink(callerKey: string, kind: "adopt" | "release", name: string): string` — a refusal text or `SENT`.
  - `Delegation.answerLink(parentKey: string, requestId: string, approved: boolean): null | { result: "linked" | "released" | "rejected" | "refused", text: string }` — `null` when `parentKey` has no such pending request; the request is removed whenever it returns an object.
  - Control event on the parent's stream: `link_request` with
    `{ requestId, kind, childKey, childName, childCwd, parentName, task }` (`childCwd` and `task` are `""` when unknown; `task` is the link's task for `release`, `""` for `adopt`).
  - Control event on the child's stream: `parent_changed` with `{ parentKey: string | null, adopted: boolean }`.
  - `Delegation.snapshot()` entries gain `adopted: boolean`.

**Behaviour the tests pin (spec sections 2, 3, 5):**
- Pending requests: a private `Map` keyed by `requestId`. A second request with the same `kind`, parent and child
  reuses the id and emits `link_request` again.
- Validation order for both tools: caller registered, then `control` and `app` (`NO_APP`), then `linkCards` (`OLD_APP`).
- `adopt` at the call: the name resolves as in `Registry.send` (`getByName` of the trimmed, lower-cased name) and the
  peer is online (`NO_TARGET`); not the caller (`SELF`); `peer.app` (`NOT_APP`); not already the caller's child
  (`ALREADY`); no link, or a link with `parentDeleted` (`HAS_PARENT` otherwise, naming the current parent); not an
  ancestor of the caller (`CYCLE`: walk `store.linkOf` upward from the caller with a `seen` set, stop at no link or
  at `parentDeleted`).
- `adopt` at approval: the same checks by key; an offline or unknown child is `CLOSED_NOW`.
- `release` at the call: `name` matches a direct child the way `messageClosed` matches (registry name, the link's
  stored name, `nameOf`; case-insensitive); otherwise `NOT_CHILD`. At approval: `store.parentOf(childKey)` is still
  the parent and the link is not `parentDeleted`; otherwise `refused` with `NOT_CHILD`.
- Effects of an approved adopt: `store.adopt`, `peer.parentKey`, `parent_changed`, `#changed()`, a durable waking
  notice to the parent (enqueue + `#deliver`, as `outcome` does for non-`created` kinds), a `pushTo` notice with
  `wake: false` and no `deliveryId` to the child.
- Effects of an approved release: for `store.reopenFor(parent, child)` and `store.reopenFor(child, parent)`:
  `dropAwaiting`, `removeReopen`, and a durable notice ("reopen dropped") to that request's sender;
  `store.unlink`, `peer.parentKey = null`, `registry.dropPair`, `parent_changed { parentKey: null, adopted: false }`,
  `#changed()`, the parent's durable notice, the child's `wake: false` notice when it is online.
- Rejected or refused: a durable waking notice to the parent (the rejection text, or the refusal text).
- `attached(key)` emits again every pending link request whose parent is `key`.
- `#forget(key)` drops pending requests that name `key`. A `peer_removed` registry event drops `adopt` requests that
  name the removed key as parent or child; `release` requests stay.
- `died(childKey)` returns without a notice when `store.isAdopted(childKey)`.

- [ ] **Step 1: Add the test helper and write the failing tests**

Helper, beside `setup()`:

```js
/** Three unlinked desktop-app sessions that can show link cards. */
function linkSetup() {
  const base = setup({ registry: new Registry() });
  const { registry, store, d } = base;
  store.unlink("cli:child"); // setup() linked it
  registry.get("cli:child").parentKey = null;
  const pushes = { "cli:p": [], "cli:c": [], "cli:x": [] };
  const controls = { "cli:p": [], "cli:c": [], "cli:x": [] };
  for (const [key, name] of [["cli:p", "szef"], ["cli:c", "pomocnik"], ["cli:x", "trzeci"]])
    registry.upsert({ key, name, kind: "cli", cwd: `/work/${name}`, app: true, linkCards: true,
      push: (m) => (pushes[key].push(m), true), control: (...a) => controls[key].push(a) });
  const nm = (k) => registry.get(k).name;
  const cards = (k) => controls[k].filter((c) => c[0] === "link_request").map((c) => c[1]);
  const adopt = (parent, child) => d.requestLink(parent, "adopt", nm(child));
  return { ...base, pushes, controls, nm, cards, adopt };
}
```

Tests (each a separate `test(...)`; the assertions below are the ones that must be present):

```js
test("adopt_session asks the parent's app and changes nothing until answered", () => {
  const s = linkSetup();
  const reply = s.d.requestLink("cli:p", "adopt", s.nm("cli:c").toUpperCase());
  assert.match(reply, /^The user was asked to approve it\./);
  const [card] = s.cards("cli:p");
  assert.doesNotMatch(reply, new RegExp(card.requestId));
  assert.deepEqual(card, { requestId: card.requestId, kind: "adopt", childKey: "cli:c", childName: s.nm("cli:c"),
    childCwd: "/work/pomocnik", parentName: s.nm("cli:p"), task: "" });
  assert.equal(s.store.linkOf("cli:c"), null);
  assert.equal(s.registry.get("cli:c").parentKey ?? null, null);
});

test("an approved adopt links the pair, wakes the parent and only informs the child", () => {
  const s = linkSetup();
  s.adopt("cli:p", "cli:c");
  const { requestId } = s.cards("cli:p")[0];
  const out = s.d.answerLink("cli:p", requestId, true);
  assert.equal(out.result, "linked");
  const l = s.store.linkOf("cli:c");
  assert.equal(l.parent, "cli:p");
  assert.equal(l.adopted, true);
  assert.equal(l.task, undefined);
  assert.equal(s.registry.get("cli:c").parentKey, "cli:p");
  assert.deepEqual(s.controls["cli:c"].at(-1), ["parent_changed", { parentKey: "cli:p", adopted: true }]);
  const toParent = s.pushes["cli:p"].at(-1);
  assert.match(toParent.text, new RegExp(`^Session "${s.nm("cli:c")}" is now your child\\.`));
  assert.equal(toParent.wake, true);
  assert.ok(toParent.deliveryId);
  assert.equal(s.store.pending("cli:p").length, 1); // durable until acked
  const toChild = s.pushes["cli:c"].at(-1);
  assert.match(toChild.text, new RegExp(`^The user made this session a child of "${s.nm("cli:p")}"\\.`));
  assert.equal(toChild.wake, false);
  assert.equal(toChild.deliveryId, undefined);
  assert.equal(s.store.pending("cli:c").length, 0);
  assert.equal(s.d.answerLink("cli:p", requestId, true), null); // answered once
  assert.equal(s.d.snapshot().find((x) => x.key === "cli:c").adopted, true);
});

test("a rejected adopt changes nothing and tells the parent", () => {
  const s = linkSetup();
  s.adopt("cli:p", "cli:c");
  const out = s.d.answerLink("cli:p", s.cards("cli:p")[0].requestId, false);
  assert.equal(out.result, "rejected");
  assert.equal(s.store.linkOf("cli:c"), null);
  assert.match(s.pushes["cli:p"].at(-1).text, /rejected the request to link/);
  assert.equal(s.pushes["cli:c"].length, 0);
});

test("adopt_session refuses what cannot be linked", () => {
  const s = linkSetup();
  const ask = (name, from = "cli:p") => s.d.requestLink(from, "adopt", name);
  assert.match(ask("nikt"), /^No open session "nikt"\./);
  assert.match(ask(s.nm("cli:p")), /cannot adopt yourself/);
  s.registry.get("cli:x").online = false;
  assert.match(ask(s.nm("cli:x")), /^No open session/);
  s.registry.get("cli:x").online = true;
  s.registry.get("cli:x").app = false;
  assert.match(ask(s.nm("cli:x")), /not a desktop-app session/);
  s.registry.get("cli:x").app = true;
  s.d.link("cli:c", "cli:p");
  assert.match(ask(s.nm("cli:c")), /is already your child/);
  assert.match(ask(s.nm("cli:c"), "cli:x"), new RegExp(`already has a parent \\("${s.nm("cli:p")}"\\)`));
  assert.match(ask(s.nm("cli:p"), "cli:c"), /one of your ancestors/); // a cycle
  s.registry.get("cli:p").linkCards = false;
  assert.match(ask(s.nm("cli:x")), /older than the relay broker/);
  s.registry.get("cli:p").linkCards = true;
  s.registry.get("cli:p").control = null;
  assert.match(ask(s.nm("cli:x")), /app connection is not connected/);
  assert.equal(s.cards("cli:p").length + s.cards("cli:c").length + s.cards("cli:x").length, 0);
});

test("two approved requests for one child: the first links, the second is refused", () => {
  const s = linkSetup();
  s.adopt("cli:p", "cli:c");
  s.adopt("cli:x", "cli:c");
  assert.equal(s.d.answerLink("cli:p", s.cards("cli:p")[0].requestId, true).result, "linked");
  const second = s.d.answerLink("cli:x", s.cards("cli:x")[0].requestId, true);
  assert.equal(second.result, "refused");
  assert.match(second.text, /already has a parent/);
  assert.equal(s.store.parentOf("cli:c"), "cli:p");
  assert.match(s.pushes["cli:x"].at(-1).text, /already has a parent/);
});

test("a child that closed before the approval is refused; a renamed one is linked under its new name", () => {
  const s = linkSetup();
  s.adopt("cli:p", "cli:c");
  s.registry.get("cli:c").online = false;
  const out = s.d.answerLink("cli:p", s.cards("cli:p")[0].requestId, true);
  assert.equal(out.result, "refused");
  assert.match(out.text, /is closed now/);
  assert.equal(s.store.linkOf("cli:c"), null);
  s.registry.get("cli:c").online = true;
  s.adopt("cli:p", "cli:c");
  const renamed = s.registry.rename("cli:c", "inna");
  assert.equal(s.d.answerLink("cli:p", s.cards("cli:p").at(-1).requestId, true).result, "linked");
  assert.match(s.pushes["cli:p"].at(-1).text, new RegExp(`"${renamed}" is now your child`));
  assert.equal(s.store.nameOf("cli:c"), renamed);
});

test("the same request twice shares one id; attached asks again; a removed peer drops adopt requests", () => {
  const s = linkSetup();
  s.adopt("cli:p", "cli:c");
  s.adopt("cli:p", "cli:c");
  const [a, b] = s.cards("cli:p");
  assert.equal(a.requestId, b.requestId);
  s.d.attached("cli:p");
  assert.equal(s.cards("cli:p").length, 3);
  s.registry.remove("cli:c");
  assert.equal(s.d.answerLink("cli:p", a.requestId, true), null);
});

test("an answer from another session than the parent finds nothing", () => {
  const s = linkSetup();
  s.adopt("cli:p", "cli:c");
  const { requestId } = s.cards("cli:p")[0];
  assert.equal(s.d.answerLink("cli:c", requestId, true), null);
  assert.equal(s.d.answerLink("cli:p", requestId, true).result, "linked");
});

test("an orphan can be adopted again after its parent was deleted", () => {
  const s = linkSetup();
  s.adopt("cli:p", "cli:c");
  s.d.answerLink("cli:p", s.cards("cli:p")[0].requestId, true);
  s.d.forget("cli:p");
  assert.equal(s.store.linkOf("cli:c").parentDeleted, true);
  s.adopt("cli:x", "cli:c");
  assert.equal(s.d.answerLink("cli:x", s.cards("cli:x")[0].requestId, true).result, "linked");
  assert.equal(s.store.linkOf("cli:c").parent, "cli:x");
  assert.equal(s.store.linkOf("cli:c").parentDeleted, undefined);
});

test("an approved release unlinks, keeps the child's children and report, and drops the pair's reopen requests and budget", () => {
  const s = linkSetup();
  s.d.link("cli:c", "cli:p");
  s.d.setTask("cli:c", "zadanie");
  s.d.link("cli:x", "cli:c"); // a grandchild
  s.d.report("cli:c", "wynik");
  s.registry.send("cli:p", s.nm("cli:c"), "hej"); // charges the pair budget
  assert.equal(s.registry.pairBudgets.has("cli:p|cli:c"), true);
  s.registry.get("cli:c").online = false;
  s.d.messageClosed("cli:p", s.nm("cli:c"), "queued"); // a reopen request with one awaiting message
  const reopenId = s.store.reopensFrom("cli:p")[0].requestId;
  assert.match(s.d.requestLink("cli:p", "release", s.nm("cli:c").toUpperCase()), /^The user was asked/); // a closed child
  const card = s.cards("cli:p").at(-1);
  assert.deepEqual({ kind: card.kind, childKey: card.childKey, task: card.task }, { kind: "release", childKey: "cli:c", task: "zadanie" });
  const out = s.d.answerLink("cli:p", card.requestId, true);
  assert.equal(out.result, "released");
  assert.equal(s.store.linkOf("cli:c"), null);
  assert.equal(s.registry.get("cli:c").parentKey ?? null, null);
  assert.deepEqual(s.store.childrenOf("cli:c"), ["cli:x"]);
  assert.ok(s.store.pending("cli:p").some((i) => i.text === "wynik"));
  assert.equal(s.store.reopensFrom("cli:p").length, 0);
  assert.equal(s.store.awaitingFor(reopenId).length, 0);
  assert.equal(s.d.answerReopen("cli:p", reopenId, true), false); // its card finds nothing
  assert.ok(s.pushes["cli:p"].some((m) => /was ended; your queued message was not delivered/.test(m.text)));
  assert.ok(s.pushes["cli:p"].some((m) => /is no longer your child/.test(m.text)));
  assert.equal(s.registry.pairBudgets.has("cli:p|cli:c"), false);
  assert.match(s.d.report("cli:c", "x"), /not a delegated session/);
});

test("an open released child is told and its stream gets parent_changed", () => {
  const s = linkSetup();
  s.d.link("cli:c", "cli:p");
  s.d.requestLink("cli:p", "release", s.nm("cli:c"));
  s.d.answerLink("cli:p", s.cards("cli:p")[0].requestId, true);
  assert.deepEqual(s.controls["cli:c"].at(-1), ["parent_changed", { parentKey: null, adopted: false }]);
  const m = s.pushes["cli:c"].at(-1);
  assert.match(m.text, /^The user ended the link to/);
  assert.equal(m.wake, false);
});

test("release_session refuses a session that is not a direct child", () => {
  const s = linkSetup();
  s.d.link("cli:c", "cli:p");
  s.d.link("cli:x", "cli:c");
  assert.match(s.d.requestLink("cli:p", "release", s.nm("cli:x")), /is not one of your children/); // a grandchild
  assert.match(s.d.requestLink("cli:c", "release", s.nm("cli:p")), /is not one of your children/); // its parent
  assert.match(s.d.requestLink("cli:p", "release", "nikt"), /is not one of your children/);
});

test("a release request outlives its child leaving the registry and is refused once the link is gone", () => {
  const s = linkSetup();
  s.d.link("cli:c", "cli:p");
  s.d.requestLink("cli:p", "release", s.nm("cli:c"));
  const { requestId } = s.cards("cli:p")[0];
  s.registry.remove("cli:c");
  s.store.unlink("cli:c");
  assert.equal(s.d.answerLink("cli:p", requestId, true).result, "refused");
});

test("an adopted child owes no report but can report once", () => {
  const s = linkSetup();
  s.adopt("cli:p", "cli:c");
  s.d.answerLink("cli:p", s.cards("cli:p")[0].requestId, true);
  const before = s.pushes["cli:p"].length;
  s.d.died("cli:c");
  assert.equal(s.pushes["cli:p"].length, before); // no "ended without reporting"
  assert.match(s.d.report("cli:c", "gotowe"), /^Report delivered/);
  assert.match(s.d.report("cli:c", "znowu"), /already reported/);
});
```

- [ ] **Step 2:** Run `node --test electron/test/delegation-broker.test.mjs`. Expected: the new tests fail (`requestLink is not a function`), the old ones pass.
- [ ] **Step 3:** Implement `linkCards` in `Registry.upsert` and `Registry.dropPair` in `src/registry.mjs`.
- [ ] **Step 4:** Implement `requestLink`, `answerLink`, the pending map and the changes to the constructor
  (`peer_removed`), `attached`, `#forget`, `died` and `snapshot` in `src/delegation.mjs`. Validation is one private
  function used at the call and at the approval; it returns a refusal text or `null`.
- [ ] **Step 5:** Run `npm test`. Expected: all pass.
- [ ] **Step 6:** `git commit -m "feat(relay): the broker holds link and unlink requests until the user answers"`

---

### Task 3: Relay client — capability, events, answer

**Files:**
- Modify: `extension/copilot-relay/relay-client.mjs`
- Test: `electron/test/links-api.test.mjs` (the client tests live there; they use stub HTTP servers, not the broker)

**Interfaces:**
- Consumes: nothing from the broker's code. The wire shapes are fixed here and built by Task 4:
  `POST /api/peer/link-answer { key, requestId, approved }` → 200 `{ result, text }` or 404 `{ error }`; stream
  events `link_request` and `parent_changed` (payloads in Task 2); stream query `caps`.
- Produces, on `RelayClient`:
  - constructor option `caps?: string[]` — sent as `caps=<comma-joined>` on every connection (not first-only);
  - `onLinkRequest?: (payload) => void` for `link_request`; `onParentChanged?: (payload) => void` for `parent_changed`;
  - `async answerLink(requestId: string, approved: boolean): Promise<{ result, text }>` — throws an `Error` with
    `status` on a non-2xx answer (as `answerReopen`), and throws when the broker is unreachable.

- [ ] **Step 1: Write the failing tests** in `electron/test/links-api.test.mjs`, modelled on the two existing client
  tests there (`the client's answerReopen throws…`, `the client calls onReopenRequest…`):

```js
test("the client's answerLink returns the result, and throws with the status when the request is not pending", async () => {
  // a stub server: POST /api/peer/link-answer answers 200 {"result":"linked","text":"ok"} for requestId "r1", else 404 {"error":"This link request is not pending."}
  assert.deepEqual(await client.answerLink("r1", true), { result: "linked", text: "ok" });
  await assert.rejects(client.answerLink("r2", true), (e) => e.status === 404 && /not pending/.test(e.message));
  assert.deepEqual(bodies[0], { key: "cli:me", requestId: "r1", approved: true });
});

test("the client sends caps and calls onLinkRequest and onParentChanged for their events", async () => {
  // a stub stream that records req.url and writes: registered, link_request {"requestId":"r1","kind":"adopt"}, parent_changed {"parentKey":null,"adopted":false}
  assert.equal(new URL(seenUrl, "http://x").searchParams.get("caps"), "links");
  assert.deepEqual(linkRequests, [{ requestId: "r1", kind: "adopt" }]);
  assert.deepEqual(parentChanges, [{ parentKey: null, adopted: false }]);
});
```

- [ ] **Step 2:** Run `node --test electron/test/links-api.test.mjs`. Expected: both fail.
- [ ] **Step 3:** Implement the option, the two events and `answerLink` in `relay-client.mjs`.
- [ ] **Step 4:** Run `npm test`. Expected: all pass.
- [ ] **Step 5:** `git commit -m "feat(relay): the relay client announces link cards and answers them"`

---

### Task 4: Broker surface — tools, answer route, stream capability

**Files:**
- Modify: `src/mcp.mjs` (two tools, `instructions`)
- Modify: `src/links-api.mjs` (route)
- Modify: `server.mjs` (`GET /api/peer/stream`: `caps`, `registered` payload)
- Modify: `electron/test/broker-helper.mjs` (`connect` options and what it records)
- Modify: `README.md` (tool list near line 68, delegated sessions near line 86, HTTP API table)
- Test: `electron/test/links-api.test.mjs`, new `electron/test/link-sessions-e2e.test.mjs`

**Interfaces:**
- Consumes: Task 2's `requestLink`, `answerLink`, `Registry.upsert({ linkCards })`; Task 1's `isAdopted`; Task 3's
  `RelayClient` options `caps`, `onLinkRequest`, `onParentChanged` (in the test helper).
- Produces:
  - MCP tools, registered inside the existing `if (delegation && delegationToolsAllowed(fixedKey))` block:
    `adopt_session({ name: string })` → `delegation.requestLink(key, "adopt", name)`;
    `release_session({ name: string })` → `delegation.requestLink(key, "release", name)`.
    Both descriptions contain the sentence `Use it only when the user has explicitly asked, in this conversation, to
    link these sessions` (`to unlink` for release) and say that the user must approve a card and that the outcome
    arrives later as a message from relay.
  - `POST /api/peer/link-answer { key, requestId, approved }` → 400 `{ error }` without a string `key` or
    `requestId`; 404 `{ error: "This link request is not pending." }` when `answerLink` returns `null`; otherwise
    200 with `answerLink`'s object. `approved` counts only when `=== true`.
  - Stream query `caps`: a comma-separated list; `links` in it sets `linkCards: true` on the peer.
  - The `registered` event payload gains `adopted: boolean`.
  - `broker-helper.mjs` `connect(key, { name, parentKey, alias, caps })` resolves
    `{ client, got, key, linkRequests, parentChanges, registered }`: arrays of the `link_request` and
    `parent_changed` payloads and the last `registered` payload.
  - `broker-helper.mjs` `startBroker` also returns `tools(alias: string): Promise<string[]>` — the names from
    `listTools()` of the MCP endpoint `?peer=<alias>`, built like the existing `tool`.

- [ ] **Step 1: Write the failing route tests** in `electron/test/links-api.test.mjs`

```js
test("link-answer approves a pending request once and is 404 afterwards", () => {
  const { routes, registry, delegation, controls } = setup(); // cli:child is linked to cli:parent
  registry.get("cli:parent").linkCards = true;
  delegation.requestLink("cli:parent", "release", registry.get("cli:child").name);
  const { requestId } = controls.find((c) => c[1] === "link_request")[2];
  assert.equal(routes["POST /api/peer/link-answer"]({ key: "cli:parent", approved: true }).status, 400);
  assert.equal(routes["POST /api/peer/link-answer"]({ requestId, approved: true }).status, 400);
  assert.equal(routes["POST /api/peer/link-answer"]({ key: "cli:child", requestId, approved: true }).status, 404);
  const ok = routes["POST /api/peer/link-answer"]({ key: "cli:parent", requestId, approved: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.result, "released");
  const again = routes["POST /api/peer/link-answer"]({ key: "cli:parent", requestId, approved: true });
  assert.equal(again.status, 404);
  assert.match(again.json.error, /not pending/);
});

test("link-answer treats anything but approved === true as a rejection", () => {
  const { routes, registry, delegation, controls, store } = setup();
  registry.get("cli:parent").linkCards = true;
  delegation.requestLink("cli:parent", "release", registry.get("cli:child").name);
  const { requestId } = controls.find((c) => c[1] === "link_request")[2];
  assert.equal(routes["POST /api/peer/link-answer"]({ key: "cli:parent", requestId, approved: "true" }).json.result, "rejected");
  assert.equal(store.parentOf("cli:child"), "cli:parent");
});
```

- [ ] **Step 2: Write the e2e test** `electron/test/link-sessions-e2e.test.mjs` (a real broker, as `broker-stream.test.mjs`)

```js
const post = (b, route, body) => fetch(`${b.url}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const links = async (b) => (await (await fetch(`${b.url}/api/links`)).json()).links;

test("adopt and release through the tools, the card answer and the streams", async (t) => {
  const b = await startBroker(t);
  const p = await b.connect("cli:p1", { name: "szef", alias: "app:p1", caps: ["links"] });
  const c = await b.connect("cli:c1", { name: "pomocnik", alias: "app:c1", caps: ["links"] });
  assert.match(await b.tool("app:p1", "adopt_session", { name: c.client.name }), /^The user was asked/);
  await until(() => p.linkRequests.length === 1, "the link card");
  assert.deepEqual(await links(b), []);
  const answer = await post(b, "/api/peer/link-answer", { key: p.key, requestId: p.linkRequests[0].requestId, approved: true });
  assert.equal((await answer.json()).result, "linked");
  await until(() => c.parentChanges.length === 1, "parent_changed");
  assert.deepEqual(c.parentChanges[0], { parentKey: "cli:p1", adopted: true });
  assert.deepEqual((await links(b)).map((l) => [l.key, l.parent, l.adopted]), [["cli:c1", "cli:p1", true]]);
  await until(() => p.got.some((m) => /is now your child/.test(m.text)), "the parent's notice");
  // the child's next registration carries the link
  await b.disconnect(c);
  const c2 = await b.connect("cli:c1", { alias: "app:c1", caps: ["links"] });
  assert.equal(c2.registered.parentKey, "cli:p1");
  assert.equal(c2.registered.adopted, true);
  // release
  assert.match(await b.tool("app:p1", "release_session", { name: c2.client.name }), /^The user was asked/);
  await until(() => p.linkRequests.length === 2, "the unlink card");
  const out = await post(b, "/api/peer/link-answer", { key: p.key, requestId: p.linkRequests[1].requestId, approved: true });
  assert.equal((await out.json()).result, "released");
  assert.deepEqual(await links(b), []);
  await until(() => c2.parentChanges.some((x) => x.parentKey === null), "parent_changed to none");
});

test("an app that does not announce link cards is refused, and a terminal session has no such tools", async (t) => {
  const b = await startBroker(t);
  await b.connect("cli:p2", { name: "stary", alias: "app:p2" }); // no caps
  const c = await b.connect("cli:c2", { name: "cel", alias: "app:c2", caps: ["links"] });
  assert.match(await b.tool("app:p2", "adopt_session", { name: c.client.name }), /older than the relay broker/);
  await b.connect("cli:t1", { name: "terminal", alias: "term-1" });
  const terminal = await b.tools("term-1");
  assert.equal(terminal.includes("adopt_session") || terminal.includes("release_session"), false);
  const app = await b.tools("app:p2");
  assert.equal(app.includes("adopt_session") && app.includes("release_session"), true);
});
```

- [ ] **Step 3:** Run `node --test electron/test/links-api.test.mjs electron/test/link-sessions-e2e.test.mjs`.
  Expected: the four new tests fail (no such route, no such tool).
- [ ] **Step 4:** Implement the route, the two tools, the `caps` handling, the `registered` payload and the helper
  changes. Add one sentence about the pair to the MCP `instructions` string.
- [ ] **Step 5:** Run `npm test`. Expected: all pass.
- [ ] **Step 6:** Update `README.md`: the two tools beside `create_session` / `report_result`, a short paragraph in the
  delegated-sessions section (who calls, the card, what a release leaves in place, an adopted child owes no report),
  and the `POST /api/peer/link-answer` row in the HTTP API table.
- [ ] **Step 7:** `git commit -m "feat(relay): adopt_session and release_session, answered by the app's link card"`

---

### Task 5: App main process and preload

**Files:**
- Modify: `electron/delegation.mjs` (`unreportedChildren`, new `isRelayTool`, new `linkCardOf`)
- Modify: `electron/main.mjs` (`relayStart`, the permission handler near line 322, `sessions:open` near line 440,
  the three `dropReopenCards` call sites, new `link:answer`)
- Modify: `electron/preload.cjs`
- Test: `electron/test/delegation-main.test.mjs`

**Interfaces:**
- Consumes: Task 3's `caps`, `onLinkRequest`, `onParentChanged`, `answerLink`; Task 4's `adopted` in the
  `registered` payload.
- Produces:
  - `electron/delegation.mjs`:
    - `unreportedChildren(entries)` no longer returns an entry with `adopted: true`;
    - `isRelayTool(title: string | undefined): boolean` — true for `relay-send_message`, `relay-list_sessions`,
      `relay-create_session`, `relay-report_result`, `relay-adopt_session`, `relay-release_session`; replaces the
      inline regex in `main.mjs`;
    - `linkCardOf(sessionId: string, payload): { sessionId, requestId, kind, childSessionId, childName, childCwd, parentName, task }`
      — `childSessionId` is `childKey` without its `cli:` prefix.
  - Window event `link:request` with `linkCardOf`'s object; IPC `link:answer(sessionId, requestId, approved)` →
    `{ result, text }`, or `false` when the broker answers 404; it throws
    `The session that asked is no longer connected to copilot-relay.` when the session has no relay.
  - `preload.cjs`: `answerLink: (sessionId, requestId, approved) => call("link:answer", …)`,
    `onLinkRequest: on("link:request")`.
  - `relay:status` gains `parentChanged: true` when it is sent because of `parent_changed` (its `parentSessionId`
    may then be `null`).

**Behaviour:**
- `relayStart` passes `caps: ["links"]`.
- `onRegistered` also sets `entry.adopted = Boolean(payload?.adopted)`.
- `onParentChanged({ parentKey, adopted })`: `entry.parentSessionId` = the key without `cli:` or `undefined`,
  `entry.reported = false`, `entry.adopted = Boolean(adopted)`, then `status({ parentChanged: true })` and `refreshLinks()`.
- `onLinkRequest`: a `linkCards` map (`requestId → card`), handled exactly like `reopenCards`: a desktop
  notification `"A session asks to change a session link"` for a new id when the window is not focused; replayed in
  `sessions:open`; dropped by a `dropLinkCards(sessionId)` at the three places `dropReopenCards` is called; an
  answered or 404 card is removed.

- [ ] **Step 1: Write the failing tests** in `electron/test/delegation-main.test.mjs`

```js
test("an adopted child is not counted as unreported", () => {
  const entries = [{ parentSessionId: "p", reported: false, adopted: true }, { parentSessionId: "p", reported: false }];
  assert.deepEqual(unreportedChildren(entries), [entries[1]]);
});

test("isRelayTool knows the relay's six tools by their prefixed title", () => {
  for (const n of ["send_message", "list_sessions", "create_session", "report_result", "adopt_session", "release_session"])
    assert.equal(isRelayTool(`relay-${n}`), true);
  assert.equal(isRelayTool("relay-adopt_session-x"), false);
  assert.equal(isRelayTool("adopt_session"), false);
  assert.equal(isRelayTool(undefined), false);
});

test("linkCardOf turns the broker's request into the window's card", () => {
  assert.deepEqual(
    linkCardOf("s1", { requestId: "r", kind: "release", childKey: "cli:abc", childName: "c", childCwd: "/w", parentName: "p", task: "t" }),
    { sessionId: "s1", requestId: "r", kind: "release", childSessionId: "abc", childName: "c", childCwd: "/w", parentName: "p", task: "t" },
  );
});
```

- [ ] **Step 2:** Run `node --test electron/test/delegation-main.test.mjs`. Expected: the three fail.
- [ ] **Step 3:** Implement the three functions in `electron/delegation.mjs`.
- [ ] **Step 4:** Wire `main.mjs` and `preload.cjs` as described under Behaviour and Interfaces.
- [ ] **Step 5:** Run `npm test`. Expected: all pass. Run `npm run app` once and check the window opens without an
  error in the console (the relay chip shows `relay: <name>`).
- [ ] **Step 6:** `git commit -m "feat(desktop): the app follows link changes and carries link cards to the window"`

---

### Task 6: Renderer — the link card

**Files:**
- Modify: `electron/renderer/app.js` (`SessionView.linkCard`, `relayStatus`, wiring next to `api.onReopenRequest`)
- Modify: `electron/renderer/style.css` only if `.perm.link` needs a rule the other `.perm` cards do not give it
- Modify: `scripts/ui-check/checks.mjs` (new check `link-card`)
- Modify: `electron/README.md` (the relay tools near line 96, the delegated-sessions section near lines 184–194 and 232)

**Interfaces:**
- Consumes: `api.onLinkRequest`, `api.answerLink` (Task 5); the card object of `linkCardOf`.
- Produces: `SessionView.linkCard({ requestId, kind, childName, childCwd, parentName, task })`.

**Behaviour:**
- Built like `delegationCard` (`this.flush()`, `h(...)`, `this.append(card)`, `this.openCard(card)`), class
  `perm link`, plain text only. A `requestId` already shown in this view is ignored (a `Set` on the view).
- Texts, `adopt`:
  - title `Link sessions`; line `<parentName> asks to take <childName> as its sub-session.` (names in `<b>`);
  - fields `Session` = `childName`, `Folder` = `childCwd` (the row is left out when empty);
  - note `<childName> will be listed under <parentName> and can report to it. Closing <parentName> will also close <childName>.`
- Texts, `release`:
  - title `Unlink sessions`; line `<parentName> asks to release its sub-session <childName>.`;
  - fields `Session` = `childName`, `Task` = `task` (left out when empty);
  - note `<childName> becomes a top-level session and keeps its own sub-sessions.`
- Buttons `Approve` (class `primary`) and `Reject`. After a click: `Linking…` / `Unlinking…` / `Rejecting…`, then
  `→ Linked`, `→ Released`, `→ Rejected`, the `text` of a `refused` result, or `This request is no longer pending.`
  when `api.answerLink` returns `false`; the card gets class `done`. A thrown answer shows
  `Could not answer: <message>` (class `err`) and brings both buttons back, as in `reopenCard`.
- `relayStatus`: when `parentChanged` is true, `this.parentSessionId = parentSessionId ?? null` and `renderList()`.
  The existing "only ever set" rule stays for every other status.
- Wiring: `api.onLinkRequest((r) => forView(r.sessionId, (v) => v.linkCard(r)));`

- [ ] **Step 1: Write the failing UI check** `link-card` in `scripts/ui-check/checks.mjs`, in the style of the
  delegation-card part of the drawer check (near line 1093): after `firstTurn(app)`,

```js
await app.ev(`${V}.linkCard({ requestId: "ui-adopt", kind: "adopt", childName: "docs-9f8e7d", childCwd: "/tmp/docs", parentName: "backend-a1b2c3", task: "" })`);
await frames(app);
const text = (sel) => app.ev(`${V}.el.querySelector(${JSON.stringify(sel)}).textContent`);
assert.match(await text(".perm.link"), /Link sessions/);
assert.match(await text(".perm.link"), /backend-a1b2c3 asks to take docs-9f8e7d as its sub-session\./);
assert.match(await text(".perm.link"), /Closing backend-a1b2c3 will also close docs-9f8e7d\./);
// the same id again adds no second card
await app.ev(`${V}.linkCard({ requestId: "ui-adopt", kind: "adopt", childName: "x", childCwd: "", parentName: "y", task: "" })`);
assert.equal(await app.ev(`${V}.el.querySelectorAll(".perm.link").length`), 1);
// no broker request stands behind it: the answer is 404 and the card says so
await app.ev(`${V}.el.querySelector(".perm.link button.primary").click()`);
await app.check(`${V}.el.querySelector(".perm.link").classList.contains("done")`, "the answered card");
assert.match(await text(".perm.link .opts"), /This request is no longer pending\./);
await app.ev(`${V}.linkCard({ requestId: "ui-release", kind: "release", childName: "docs-9f8e7d", childCwd: "", parentName: "backend-a1b2c3", task: "Update the API reference" })`);
await frames(app);
const release = `${V}.el.querySelectorAll(".perm.link")[1].textContent`;
assert.match(await app.ev(release), /Unlink sessions/);
assert.match(await app.ev(release), /Update the API reference/);
assert.match(await app.ev(release), /becomes a top-level session and keeps its own sub-sessions\./);
```

  If the scripted session of the UI check has no relay connection, `link:answer` throws instead of answering 404;
  then assert `Could not answer:` and that both buttons are back, and say so in the check's comment.

- [ ] **Step 2:** Run `node scripts/ui-check/run.mjs link-card`. Expected: fails (`linkCard is not a function`).
- [ ] **Step 3:** Implement `linkCard`, the `relayStatus` change and the wiring.
- [ ] **Step 4:** Run `node scripts/ui-check/run.mjs link-card` and `npm test`. Expected: pass.
- [ ] **Step 5:** Update `electron/README.md`: the two tools in the list of relay tools that run without Copilot's
  prompt, and a paragraph on the link and unlink cards in the delegated-sessions section.
- [ ] **Step 6:** `git commit -m "feat(desktop): link and unlink cards in the parent's view"`

---

### Task 7: Whole-feature check with the real app and Copilot

**Files:**
- Create: `docs/superpowers/backlog/2026-11-23-link-sessions-deferred.md` (layout of the files already there:
  A. worth doing first, B. window and wording, C. small behaviour, D. tests and housekeeping)

- [ ] **Step 1:** Run `npm test` and `node scripts/ui-check/run.mjs` (every check). Expected: all pass.
- [ ] **Step 2:** Restart the broker from this branch (`npm start`, after stopping a running one) and start the app
  (`npm run app`). With two sessions A and B open in different folders, type in A: "adopt session <B's relay name>
  as your child". Check, in order:
  - the card appears in A's view and Copilot's own permission prompt does not;
  - Reject: nothing changes in the sidebar; A is told;
  - ask again, Approve: B nests under A in the sidebar, A's relation bar shows B, B's shows "Parent: A", B's chat
    shows the notice and B does not start a turn;
  - `list_sessions` in A shows B under "Your children"; `report_result` in B reaches A;
  - quit the app with B open: no "sub-sessions have not reported yet" question because of B;
  - "release session <B>" in A, Approve: B is a top-level session again, both chats show the notice.
- [ ] **Step 3:** Check the open question of the spec: with a session open, restart the broker, then ask that
  session to adopt another one. Note whether the two tools are available without reopening the session.
- [ ] **Step 4:** Write the backlog file: the answer to Step 3, every review finding not fixed, the known limitations
  of the spec (requests lost at a broker restart; the unauthenticated local HTTP API), and what was not run
  (Windows). Commit it on this branch.

```bash
git add docs/superpowers/backlog/2026-11-23-link-sessions-deferred.md
git commit -m "docs: link sessions deferred items"
```
