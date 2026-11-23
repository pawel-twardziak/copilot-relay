# Spec: Link and unlink existing sessions (`adopt_session`, `release_session`)

Extends `2026-11-20-subsession-tree-design.md` and `2026-11-08-delegated-sessions-design.md`. It lifts one non-goal of
the tree spec ("linking sessions that were not created by `create_session`"). Where the documents disagree, this one
wins.

## Intent

Today a parent–child link exists only when the parent created the child with `create_session`. Two sessions that were
started separately cannot be put into that relation, and a relation cannot be ended without deleting a session.

The user wants a tool that makes one existing session the child of another, and a second tool that ends such a
relation. Both are used only when the user explicitly asks for it in the chat, and both take effect only after the
user approves a card in the app.

## Goals

1. `adopt_session`: the calling session becomes the parent of another existing, unlinked session.
2. `release_session`: the calling session ends the link to one of its direct children. Works for adopted children and
   for children made by `create_session`.
3. Nothing changes until the user approves a card in the desktop app. No relay tool, and nothing a session sends
   through the relay, can stand in for that approval. (A process that talks to the broker's HTTP API directly is
   outside this guarantee, as it is today; see Constraints.)
4. After approval the pair behaves like a pair made by `create_session`: sidebar nesting, relation bar,
   `list_sessions` family block, `report_result`, pair message budget, reopen cards, close cascade, delete dialog,
   and the stop of sub-sessions at a window reload. One difference: an adopted child owes no report (section 5).
5. After a release the former child is a root session and keeps its own children.

## Non-goals

- Re-parenting in one step. A session that has a live parent is refused; release it first.
- A tool for the child's side (`attach_to_parent`), or a tool that names both sessions.
- Linking or unlinking from the UI (context menu, drag and drop).
- Children that are not desktop-app sessions (terminal extension peers, generic MCP peers, broker-spawned ACP
  sessions).
- Adopting a closed session.
- Requests that survive a broker restart.

## Anti-goals

- A link appears or disappears without an approved card.
- A cycle in the tree, or a session with two parents.
- An endpoint that links or unlinks an arbitrary pair of keys.
- A released child loses its own children, or reports it already sent are lost.

## Decisions (made with the user)

| Topic | Decision |
|---|---|
| Who calls | The future parent (`adopt_session`), the current parent (`release_session`). The card is shown in the parent's view. |
| Unlink | Included, as `release_session`. |
| Where the pending request lives | In the broker, like a reopen request. The card answers by `requestId`; the broker validates again and only then changes the link. |
| Approval | A card in the app; the answer is reachable only from the window. |
| "Only on the user's explicit request" | Stated in the tool descriptions. The card is the enforcement. |

## Approaches considered

- **A. The broker holds the request (chosen).** The tool validates, stores the request and emits a control event on
  the caller's app stream. The card answers with `POST /api/peer/link-answer { key, requestId, approved }`. The broker
  validates again and changes the link. No endpoint links an arbitrary pair, and validation is in one place. Cost: one
  more kind of pending request in `Delegation`.
- **B. The app holds the request**, as for `create_session`. The broker only forwards the request; after approval the
  app calls a general `POST /api/links/link { child, parent }`. Less broker code, but any local process could link
  any two sessions with that endpoint, and validation is split between app and broker. Rejected.
- **C. No model tool, a sidebar action only.** A click is its own approval and needs no card. Rejected: the user asked
  for a tool the model calls on request.

## Design

### 1. Tools (`src/mcp.mjs`)

Registered next to `create_session` and `report_result`, under the same condition (`delegationToolsAllowed`: desktop
app identity `app:<uuid>`).

| Tool | Input | Caller |
|---|---|---|
| `adopt_session` | `name`: the session to take as a child, as shown by `list_sessions` | the future parent |
| `release_session` | `name`: one of the caller's direct children | the current parent |

Both descriptions say: use only when the user has explicitly asked, in this conversation, to link (or unlink) these
sessions; never on your own initiative; the user must approve a card; the outcome arrives later as a message from
relay; do not wait for it. The MCP `instructions` string gets one sentence about the pair.

Both return at once with text: either a refusal (section 3) or
`The user was asked to approve it. The outcome arrives as a message from relay. Do not wait for it.`
The reply does not contain the `requestId`: the id is what answers the card.

### 2. Pending requests (`src/delegation.mjs`)

`Delegation` keeps them in memory: `requestId -> { requestId, kind: "adopt" | "release", parentKey, childKey }`.

- A second request with the same `kind`, `parentKey` and `childKey` reuses the pending `requestId` and emits the
  event again.
- The request is emitted on the parent's control stream as `link_request`:
  `{ requestId, kind, childKey, childName, childCwd, parentName, task }` (`task` only for `release`, from the link).
- `attached(key)` emits the parent's pending link requests again, as it does for reopen requests.
- `forget(key)` drops every pending link request that names `key` as parent or child.
- An `adopt` request is also dropped when its parent or its child leaves the registry (`peer_removed`: 30 s after it
  went offline, or a delete). The app does not report the delete of an unlinked session to the broker
  (`forgetDeleted` in the renderer sends only ids that are in the tree), so `forget` alone would miss it. A `release`
  request stays: its child may be closed and its parent may come back.
- They are not written to `delegations.json`. After a broker restart the card's answer gets 404.

### 3. Validation

Checked when the tool is called and again when the card is approved. Each refusal is a plain sentence for the model.

Both tools:

- The caller is registered, has a control stream, is an app session (`peer.app`) and its app announced that it can
  show link cards (section 7).

`adopt_session`:

- `name` resolves in the registry to a session that is online, at the call and again at approval. A child that
  closed in between is refused (`Session "<name>" is closed now. Open it and ask again.`). This also keeps a link
  from being made to a session that was deleted meanwhile.
- The target is not the caller.
- The target is a desktop-app session (`peer.app`).
- The target is not already the caller's child (`"<name>" is already your child.`).
- The target has no live parent: no link, or a link whose `parentDeleted` is set (an orphan can be adopted).
- No cycle: the target is not an ancestor of the caller. Walk `parentOf` from the caller, cycle-safe; a link with
  `parentDeleted` ends the walk.

`release_session`:

- `name` matches a direct child of the caller, open or closed. Names are compared the way `messageClosed` does it
  (registry name, the link's stored name, `nameOf`), case-insensitive.

### 4. Answer (`src/links-api.mjs`, `server.mjs`)

`POST /api/peer/link-answer { key, requestId, approved }`:

- 400 without `key` or `requestId`.
- 404 when `key` has no pending link request with that id (`key` must be the request's `parentKey`).
- 200 `{ result, text }` otherwise, `result` one of `linked`, `released`, `rejected`, `refused`. `refused`: approved,
  but validation failed now; `text` says why. The request is removed in every 200 case.

### 5. Effects (`src/delegation.mjs`, `src/delegation-store.mjs`, `src/registry.mjs`)

**Adopt, approved and valid:**

- The store gets a fresh link for the child: `parent`, the child's current name, `reported: false`, `ended: false`,
  `createdAt: now`, `adopted: true`, no `task`, no `parentDeleted`. An orphan's old link is replaced as a whole (its
  old `task` and `createdAt` do not carry over; `DelegationStore.link` keeps them today, so adoption needs its own
  path or a flag).
- **An adopted child owes no report.** It was given no task, so nothing that asks "has it reported" may count it as
  outstanding, while `report_result` still works for it, once:
  - `Delegation.died` sends no "ended without reporting" notice for it;
  - the quit question "N sub-sessions have not reported yet" (`confirmLeavingChildren`, `unreportedChildren`) does
    not count it: the `registered` payload and `parent_changed` carry `adopted`, and the app keeps it on the entry;
  - `snapshot()` carries `adopted`, for the tree.
  A window reload still stops it with the other sub-sessions (`confirmedReload`): the reason given there, a reloaded
  window cannot show their cards, holds for it too.
- `peer.parentKey` of the child is set.
- The child's control stream gets `parent_changed { parentKey, adopted: true }`.
- `links_changed` goes out as for every link change.
- The parent gets a durable notice that wakes it (`outcome`-style, through the outbox):
  `Session "<child>" is now your child. It can send you results with report_result.`
- The child gets a notice that does not wake it and is not stored (`pushTo`, `wake: false`):
  `The user made this session a child of "<parent>". Send it results with the report_result tool.`
  A closed child is not told; its next family block says it.

**Release, approved and valid:**

- New `DelegationStore.unlink(child)`: removes the child's link only. It does not touch the child's own children, the
  outbox items addressed to the parent (reports already sent stay and are delivered) or the items addressed to the
  child that are not awaiting a reopen.
- Reopen requests between the two (either direction) are removed, their awaiting items dropped, and the sender of each
  is told its message was not delivered.
- `peer.parentKey` of the child is cleared; the pair's entry in `Registry.pairBudgets` is removed.
- The child's control stream gets `parent_changed { parentKey: null }`.
- `links_changed` goes out.
- The parent gets a durable, waking notice: `Session "<child>" is no longer your child.`
- The child, if open, gets a non-waking, unstored notice:
  `The user ended the link to "<parent>". You no longer report to it.`

**Rejected:** the parent gets a durable, waking notice:
`The user rejected the request to link "<child>".` (or `to release "<child>"`).

**Refused at approval:** the parent gets a durable, waking notice with the refusal text.

### 6. App (`extension/copilot-relay/relay-client.mjs`, `electron/main.mjs`, `electron/preload.cjs`)

- `RelayClient`: handlers `onLinkRequest` (`link_request`) and `onParentChanged` (`parent_changed`); method
  `answerLink(requestId, approved)` that returns `{ result, text }` and throws with `status` like `answerReopen`.
- `main.mjs`:
  - `link_request` → a `linkCards` map (as `reopenCards`: replayed to a reloaded window, dropped when the session's
    relay connection goes away) and the window event `link:request` with
    `{ sessionId, requestId, kind, childSessionId, childName, childCwd, parentName, task }`. A desktop notification
    when the window is not focused.
  - IPC `link:answer(sessionId, requestId, approved)`, reachable only from the window like `reopen:answer`. Returns
    `{ result, text }`, or `false` on 404.
  - `parent_changed` → `entry.parentSessionId` set or cleared, `entry.reported = false`, `entry.adopted` set or
    cleared, a `relay:status` so the view follows. `onRegistered` sets `entry.adopted` from its payload too.
  - `adopt_session` and `release_session` are added to the relay tools that skip Copilot's own permission prompt
    (the regex in the `session/request_permission` handler). The app's card is the approval.
- `preload.cjs`: `answerLink`, `onLinkRequest`.

### 7. Old app with a new broker

The broker is updated by "Update and restart broker", the app by its installer, so a new broker can meet an old app
that ignores `link_request`. The app announces the ability in its stream URL (`caps=links`); the broker stores it on
the peer (kept on a re-attach, like `app`). Without it both tools refuse:
`The desktop app is older than the relay broker and cannot show the approval card. Update the app.`

A new app with an old broker needs nothing: the tools do not exist there.

### 8. Renderer (`electron/renderer/app.js`)

`SessionView.linkCard(r)` in the parent's view, built like `delegationCard` (class `perm`), plain text only (names
are model-visible strings). A card for an id already shown is ignored.

```
Link sessions
backend-a1b2c3 asks to take docs-9f8e7d as its sub-session.

  Session   docs-9f8e7d
  Folder    /home/user/project/docs

docs-9f8e7d will be listed under backend-a1b2c3 and can report to it.
Closing backend-a1b2c3 will also close docs-9f8e7d.

[ Approve ]  [ Reject ]
```

```
Unlink sessions
backend-a1b2c3 asks to release its sub-session docs-9f8e7d.

  Session   docs-9f8e7d
  Task      Update the API reference

docs-9f8e7d becomes a top-level session and keeps its own sub-sessions.

[ Approve ]  [ Reject ]
```

After an answer the buttons are replaced by `→ Linked`, `→ Released`, `→ Rejected`, the refusal text, or
`This request is no longer pending.` (404). An answer that did not arrive brings the buttons back, as in
`reopenCard`.

`relayStatus` must also clear `parentSessionId` (today it only sets it). The sidebar and the relation bar follow
`links:update` and need no change.

## Constraints

- Existing `delegations.json` files load unchanged; no new field is required in them.
- Windows and Linux builds; nothing platform-specific is expected.
- The broker's HTTP API is local and guarded by `rejectForeign` only. A local process, including a model with a
  shell tool, can already create a link with `/api/peer/stream?parent=`, and could read a pending `requestId` by
  attaching to the parent's stream and then answer it. This change adds no weaker path than the one that exists, and
  does not close it: closing it needs authentication between app and broker, which is a separate piece of work.
- Tests run with `npm test` (`node --test electron/test/*.test.mjs`). New broker logic is covered in
  `delegation-broker.test.mjs` and `links-api.test.mjs`, the client in `relay-client.test.mjs`.
- Release: v0.20.0. The broker changes, so users press "Update and restart broker" after updating the app.

## Known limitations

- A pending request is lost when the broker restarts, and an `adopt` request also when one of its two sessions has
  been closed for 30 s; the model is not told. Its card answers "no longer pending".
- Whether a Copilot session that was already open sees the two new tools after the broker restart, or only after it
  is reopened, is not known. To be checked with real Copilot during the build.
- The tool descriptions cannot stop a model from calling the tools unasked. The card stops the effect, not the call.

## Left to the builder

Wording of refusals, notices and card texts; names of internal methods and of the stream capability; card styling;
whether pending link requests are counted in the window-reload warning; test file split.

## Calls made by the author (not decided with the user)

- Tool names `adopt_session` and `release_session`.
- The capability guard of section 7.
- Approved outcomes wake the parent; the child is told without a turn of its own.
- A child that closed between request and approval is refused, not linked.
- An adopted child owes no report (no quit question, no "ended without reporting" notice), but can report once.
- A window reload stops an adopted child like any other sub-session.
- The tool reply does not show the `requestId`.
- An orphan (deleted parent) can be adopted, and its old task is dropped.
- Card texts, including the line about the close cascade.
