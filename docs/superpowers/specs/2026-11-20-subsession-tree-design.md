# Spec: Sub-session tree (persistent parent–child links, no auto-close)

Extends `2026-11-08-delegated-sessions-design.md`. Where the two disagree, this one wins.

## Intent

A session that delegates work (`create_session`) must stay connected to what it created, for the user and for the
model. Today the link is visible only while the child's view is open ("child of X" in the sidebar, held in renderer
memory), the parent cannot see its children at all, children close themselves after 15 idle minutes, and the app
caps children at 3 per parent / 5 total. The user wants the relationship to be permanent and always visible, children
to live until the user or the parent's closing ends them, and no caps.

## Goals

1. The parent–child link is permanent: visible after a view is closed and after an app or broker restart.
2. The UI shows the relation both ways: in the sidebar (children nested under the parent) and in a bar in the session
   view ("Parent: X" in a child, "Children: A, B" in a parent), with clickable entries.
3. Children never close on their own. A session closes only when the user closes it, or when an ancestor closes
   (the whole subtree closes with it), or when the app quits.
4. No limits on the number of children.
5. Any depth: a child can create its own children.
6. The parent model always knows precisely who its children are and what each is doing, so it addresses the right one.
7. Writing to a closed relative (parent or child) reopens it after the user approves.
8. Deleting a parent lets the user choose, per descendant, whether to delete it too.

## Non-goals

- Re-parenting, or linking sessions that were not created by `create_session`.
- Auto-reopening children when their parent reopens.
- Aggregated cost across a tree.
- Changes to the pair message budget (stays as is).

## Anti-goals

- A child disappears from the parent's view or from the model's list because it was closed, renamed or the app
  restarted.
- The model mixes up recipients because names are stale or children with similar names are listed vaguely.
- A closed session is resumed without the user approving it (an approval card is required for model-initiated reopens;
  a user clicking a closed session in the UI is itself the approval).

## Decisions (made with the user)

| Topic | Decision |
|---|---|
| Source of truth | The broker (`DelegationStore`, `delegations.json`). The app keeps only a read cache. |
| UI | Sidebar nesting **and** a relation bar in the session view. |
| Delete of a parent | Dialog lists descendants, each with its own "delete too" checkbox. Unchecked ones are closed and stay as orphans. |
| Reopen of parent | Does not reopen children. |
| Message to a closed child | Approval card in the sender's view; on Approve the child resumes and receives the message. |
| Message from a child to a closed parent (`send_message`) | Same: approval card in the child's view. (`report_result` keeps its durable delivery on the parent's return, no card.) |
| Depth | Unlimited tree. |
| What the parent model sees | Its **direct** children only, each with a badge if it has children of its own. |
| How the model gets it | A "Your children" section in `list_sessions`, **and** a compact current list appended to every prompt delivered to a parent from a relative or from relay. |
| Limits | Removed entirely. |
| Idle close | Removed entirely. |

## Approaches considered

- **A. Broker is the single source of truth (chosen).** It already persists links, routes reports, resolves names and
  serves `list_sessions`. Detecting "recipient is a closed relative" happens inside `registry.send`, so the broker
  must know closed sessions anyway. The app reads links over HTTP and caches the last snapshot in `userData` so the
  sidebar tree renders before the broker answers. Cost: the UI depends on the broker's HTTP API; the app already
  auto-starts the broker.
- **B. App is the source of truth** (`userData/session-links.json`). Sidebar independent of the broker, but the broker
  still needs tasks, names and states for `list_sessions` and closed-recipient detection — two stores that drift, or a
  synchronous broker→app query in the middle of `send_message`. Rejected.
- **C. Both, synchronised.** Combines the costs of A and B. Rejected.

## Design

### 1. Store (`src/delegation-store.mjs`)

A link record becomes:

```
links[childKey] = { parent, name, task, createdAt, reported, ended, parentDeleted, closedBy, missing }
```

- `task`: the `task` text from `create_session`, stored when the link is created. Links that exist from before this
  change have no task; they are shown as "(task not recorded)".
- `createdAt`: ms since epoch, for stable ordering of children.
- `parentDeleted`: set when the parent session is deleted and this child was kept (orphan).
- New queries: `descendantsOf(key)` (whole subtree, depth-first, cycle-safe), `childByName(parentKey, name)` and
  `parentByName`-style lookup used by name resolution below, `forget(key)` (remove a deleted session's own link;
  children of it get `parentDeleted: true`).
- The outbox is generalised from "items for a parent" to "items for a recipient": `parentKey` is renamed to `toKey`
  (read old files with a fallback). This lets queued `send_message` text wait for a reopened session, with the same
  write-to-disk-before-delivery and ack rules as reports.

The task must reach the broker at link time: `createSession(..., { name, parentKey, task })` passes it through
`relayStart` (stream URL already carries `parentKey`; add the task on the first registration — builder chooses query
parameter vs. a follow-up POST, given task length).

### 2. Removals

- `UiState.shouldCloseIdle`, the 60 s idle timer in `electron/renderer/app.js`, and `SessionView.lastActivity`
  (if nothing else uses it).
- `limitError`, `delegationLimitError`, the `creating` bookkeeping that exists only for limits, the
  `maxChildrenPerParent` / `maxChildrenTotal` settings, and the limit texts in `delegation.mjs` and the original spec.
  The "Over limit" outcome notice disappears.
- `Delegation.requestCreate`'s "A delegated session cannot create sessions." refusal. The `create_session` tool
  description and the MCP server instructions are updated so children are told they may delegate too.

### 3. Closing

- Closing a session's view (Close button, sidebar, `closeView`) also closes every **open** descendant, deepest first.
  The existing "Stop all children" button stays and closes the subtree but keeps the parent open; its label becomes
  "Close all sub-sessions".
- Closed sessions stay resumable and stay in the tree (marked closed).
- App quit: unchanged (everything closes; the existing confirmation for unreported children now counts every
  unreported descendant).
- A parent's process dying (crash/kill, `markDead`) is **not** a close: its children keep running (decided by the
  user). Their reports wait durably and arrive when the parent is resumed. The dead parent is shown as dead in the
  tree.
- **Deliberate closes** (call made in the builder check): the app tells the broker before it closes a session on
  purpose — view close, subtree close, "Close all sub-sessions", window reload after the user agreed, app quit after
  the confirmation. The broker stores `closedBy: "user"` on the link (cleared when the session registers again).
- `childGone` / `#sweep` ("ended without reporting" notice): fires only for children without `closedBy`, i.e. whose
  process ended on its own. A deliberately closed child produces at most a non-waking "closed by the user" notice to
  its parent, if the parent is open; the parent's reopen sweep never reports deliberately closed children.

### 4. Reopen on message

**Addressing (call made in the builder check).** Names are freed 30 s after a session disconnects, so a closed
child's name can be taken by another session, and two closed siblings can share a stored name. Therefore:

- `send_message`'s `to` also accepts a session key (`cli:<id>`, or the short key shown in "Your children").
- Resolution order in `Registry.send`: (1) exact key; (2) the sender's **relatives** (parent, direct children) by
  stored name, online or closed; (3) online peers by name. A relative therefore wins over an unrelated session that
  took its name.
- Two relatives with the same name → not delivered; the tool returns both keys and asks the model to use one.
- A reopened session whose old name is taken comes back with a new name as today; the store's `name` is updated on
  registration and the next "Your children" block shows it.

In `Registry.send(fromKey, to, text)`, when `to` resolves to a relative that is not online:

1. Unrelated closed sessions keep today's `No session "…"` error.
2. If a relative matches: charge the pair budget as for a normal linked message, write an outbox item
   `{ id, toKey, from, text, prompt }` to disk, and emit a `reopen_request { requestId, targetKey, targetName, fromName,
   preview }` on the **sender's** control stream.
3. Return to the model: `Session "<name>" is closed. The user was asked to reopen it; your message is queued and will
   be delivered if they approve. Do not wait for it.`
4. The app shows a card in the sender's view: "<fromName> wants to message the closed session <targetName>. Reopen
   it?" with the message preview, Approve / Reject. While a card is open the sender's sidebar entry has the attention
   marker, and an OS notification fires if the window is unfocused (same as permission cards).
5. Approve → the renderer resumes the target (same path as clicking it in the sidebar, **without** activating it).
   On its registration the broker's existing `attached()` redelivery delivers the queued item.
6. Reject, or the sender's view closing while the card is open → the outbox item is dropped and the sender gets a
   waking `[from relay]` notice: `The user did not reopen "<name>"; your message was not delivered.`
7. Several messages to the same closed target before an answer: one card, messages queue in order (builder detail).

**Pending approvals are durable (call made in the builder check).**
- A queued item for a closed relative is stored with `awaiting: requestId` and is **not** delivered by `attached()`
  redelivery until approved. Only Approve clears `awaiting`.
- Pending reopen requests live in the store, not only in the renderer: on the sender's next registration (app
  restart, reload, broker restart) the broker re-emits `reopen_request` and the card reappears.
- If the user opens the target some other way while a card is pending, nothing is delivered; the card stays, and
  Approve then just delivers (no resume needed).
- If the target session no longer exists on disk, Approve fails visibly in the card ("This session no longer
  exists"), the item is dropped and the sender gets the not-delivered notice.

### 5. What the parent model sees

**`list_sessions`** gains a section, rendered for any caller that has children (online or not):

```
Your children (3):
- "api-tests" (cli:…1a2b) — open, working — task: Write e2e tests for /orders … [has 2 children]
- "docs-update" (cli:…9f0c) — closed, reported — task: Update README for the new flags
- "perf-probe" (cli:…77aa) — open, idle — task: (task not recorded)
Your parent: "refactor-api" (cli:…c3d4) — closed
```

- Each child line: current name, short key (enough to disambiguate equal-looking names), state, task (first line,
  truncated at a builder-chosen length with "…"), and `[has N children]` when it has descendants.
- State is `open`/`closed` plus `working`/`idle` when open, plus `reported`. `working`/`idle` comes from the app:
  the renderer already knows `busy`; main reports it to the broker over the peer connection whenever it changes
  (builder picks the endpoint; a small `POST /api/peer/state`, same auth as the peer stream, is the obvious one).
- The section explicitly says names are current and closed children can be messaged (which asks the user to reopen).

**Automatic list:** every prompt delivered to a session from one of its relatives or from relay (reports, notices,
`send_message` from a child or parent) gets the same "Your children" block appended (direct children only), so the
model never acts on stale names. Messages from unrelated sessions and from the user are not touched.

### 6. Broker API for the app

- `GET /api/links` → `{ links: [{ key, parent, name, task, createdAt, reported, parentDeleted, online, busy }] }`.
  Same foreign-origin protection as the other `/api` routes.
- The broker announces changes (link created, renamed, reported, online/offline, busy, deleted) so the app can
  refresh; builder picks the channel (an event on the existing GUI `/events` SSE is the natural one).
- `POST /api/links/forget { key, keepChildren: [...], deleteChildren: [...] }` or equivalent, called by the app when a
  session is deleted (see 8). Builder may fold this into the existing delete path.
- The app caches the last `/api/links` result in `userData/links-cache.json` and renders from it until the first
  fresh response.

### 7. UI

**Sidebar** (`renderList`, `item`):
- In every group (Open in app, Pinned, project groups, search results), a session whose parent appears in the same
  group is rendered indented under it with a tree connector; otherwise it is rendered at top level with the existing
  "child of X" meta (X from the link store, not from an open view). Orphans show "parent deleted".
- The open/busy dot, attention marker, pin and delete buttons work per row as today.
- Collapsing subtrees, sort order of siblings (recommended: `createdAt`), and how search shows a matching child's
  ancestors are left to the builder.

**Relation bar** in the session view (under the header):
- Child: `Parent: [refactor-api]`. Orphan: `Parent: deleted`.
- Parent: `Sub-sessions: [api-tests ●] [docs-update ○ ✓] …` — dot = open/busy as in the sidebar, ✓ = reported,
  a count badge on entries that have their own children.
- Clicking an entry activates it if open, or resumes and activates it if closed (no approval card: the click is the
  approval).
- Hidden when the session has neither parent nor children.

### 8. Delete of a session with descendants

The native `confirm()` in `deleteSessionFlow` is replaced, only when the session has descendants, by an in-app
dialog:

- The existing warning text, then the descendants as an indented tree, each with a "Delete too" checkbox,
  unchecked by default.
- Checking a node does not imply its descendants (each row independent); unchecking a parent of a checked node is
  allowed — the kept node becomes an orphan of a deleted parent only if its own parent is deleted.
- On confirm: delete the session and every checked descendant (existing delete path, one by one); close every
  unchecked descendant that is open; tell the broker to forget deleted keys and mark kept direct children of deleted
  nodes `parentDeleted`.
- Sessions without descendants keep today's `confirm()`.

### 9. Sessions missing on disk (call made in the builder check)

Sessions can vanish without the in-app delete (Copilot cleanup, terminal, web GUI). Links are **not** pruned
automatically. After loading its session list, the app reports keys it knows from `/api/links` but cannot find on
disk; the broker marks them `missing` (cleared if they reappear). Missing sessions show greyed "missing" in the
sidebar tree, the relation bar and "Your children"; messages to them are refused at once (no card). The user can
remove a missing entry from the tree by deleting it (delete then only forgets the link).

## Constraints

- The relay broker is shared with Copilot CLI sessions outside the app (extension, MCP peers). Name resolution for
  closed relatives and the "Your children" block apply to any peer with links; reopen cards need the sender's app
  control connection — a sender without one gets `Session "<name>" is closed and you have no app connection to ask
  the user to reopen it.`
- Delivery stays at-least-once with ack (`deliveryAck` in the renderer); queued messages for reopened sessions use it.
- Windows and Linux builds; nothing platform-specific is expected.
- Existing `delegations.json` files must load (missing `task`, `createdAt`, `parentDeleted`; `parentKey` in outbox).

## Left to the builder

Endpoint shapes and names, the change-notification channel, task truncation length, sidebar collapse/sort/search
behaviour, card styling, whether the "closed by the user" notice is sent, and how several queued messages to one
closed target are batched into a single card.
