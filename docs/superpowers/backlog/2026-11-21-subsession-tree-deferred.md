# Sub-session tree (v0.12.0): deferred findings

Source: task reviews and the final whole-branch review of `feat/subsession-tree` (merged as v0.12.0, `b22c731`).
Spec: `docs/superpowers/specs/2026-11-20-subsession-tree-design.md`. None of these blocked the release.

## A. Worth doing first (analysed below)

1. **Pruning bound blocks small trees forever.** `pruneCandidates` refuses when it would prune more than half of the
   known keys, so a parent + child both deleted in a terminal never leave the tree. `electron/README.md` promises they
   do after the next complete refresh.
2. **Durable leak in `delegations.json`.** `forget(sender)` drops the sender's reopen requests but leaves their
   `awaiting` outbox items (addressed to the target) forever.
3. **Stale reopen card after a reload.** When the broker drops a reopen (its target was forgotten), main keeps the card
   in `reopenCards` and replays it after a reload; answering shows "no longer pending".
4. **Terminal peers don't see relatives.** `relay_list_sessions` / `/relay` in the extension use `/api/peer/list`, which
   has no "Your children / Your parent" section.

## B. UI, cosmetic

5. Relation-bar chips are rebuilt on every `renderList` (focus or a click can be lost).
6. Cascade close: focus briefly passes through views that are about to close.
7. The red "process ended" ring/tooltip also shows on a view that only failed to resume (`v.dead` is set there too).
8. Approve on a session that vanished from disk since the last list refresh shows "Approved", then a dead view.
9. The delete dialog's "Copilot is still working" warning covers only the chosen session, not checked descendants.

## C. Broker behaviour, small

10. Budget exhaustion on a message to a closed relative emits no "Blocked X → Y" `system` event (plain `send` does).
11. The pair budget is charged before the card is emitted; if the control stream throws, the charge is not refunded.
12. `setTask` accepts an empty task and lets it be overwritten later.
13. After a full-name collision the 8-char suffix can fall back to 6 chars on a later rename (negligible probability).

## D. Tests and housekeeping (no behaviour impact)

- Missing tests: cycles in `closeOrder` / `descendants`; `links_changed` debounce/broadcast; relay-client request
  bodies (only URLs checked); `answerReopen(true, "missing")`; registry-level name tests (8-char fallback, migration
  idempotence, 40-char cut via upsert/rename); `parentDeleted` carry-over on re-link; prune `exclude`; the delete and
  refresh flow in the renderer.
- Housekeeping: split `electron/test/delegation-broker.test.mjs` (~720 lines); rename `Delegation`'s injected
  `nameOf` (vs private `#nameOf`), e.g. `fallbackName`; one links-fetch path in main (`brokerGetLinks` vs
  `RelayClient.fetchLinks`); stale `"limit"` outcome kind in a broker test; duplicate `deleting` check in
  `deleteSessionFlow`.

---

## Analysis and proposed solutions for A1–A4

### A1. Pruning bound blocks small trees

**Today** (`electron/renderer/session-tree.js`, `pruneCandidates`): candidates = linked `cli:` keys (and parent keys)
not in a complete session list, not open/deleting/deleted, not online. Two guards against a bad list: an empty list
while links exist → nothing; `out.size * 2 > known.size` → nothing. The second one is what blocks: with known = {parent,
child} and both gone, 2·2 > 2 every time, forever.

**Why the ratio exists:** a `session/list` that succeeds but is truncated or temporarily wrong would otherwise wipe the
tree (and the undelivered reports addressed to pruned keys).

**Options:**
- (a) Ratio only above a floor (e.g. known ≥ 6). Trivial, but a small tree is still exposed to one bad list, and a large
  real cleanup (Copilot deleting many old sessions) is still blocked forever.
- (b) **Two-strike confirmation (recommended):** a key is pruned only when it is missing in two complete lists at least
  60 s apart. The renderer keeps `missingSince: Map<key, firstSeenMs>`; a key that reappears is removed from the map.
  Drop the ratio; keep the empty-list guard. A transient bad list costs nothing (the second list fixes it), a real
  deletion is pruned on the next refresh after a minute, any size. In-memory only: after an app restart the first
  refresh just re-arms the strike.
- (c) Let the broker decide (it knows nothing about disk) — no.

**Proposal:** (b). Change `pruneCandidates(links, sessions, { listOk, exclude, missingSince, now, confirmMs = 60_000 })`
to return keys whose first miss is ≥ `confirmMs` old and to update `missingSince`; remove the ratio; fix the
`electron/README.md` sentence ("…after two complete refreshes at least a minute apart"). Tests: first miss → not
pruned; second miss after 60 s → pruned; reappear → strike cleared; parent+child both gone → both pruned.

### A2. Leak of awaiting items when the sender is forgotten

**Today** (`src/delegation-store.mjs` `forget(key)`): deletes the link, outbox items with `toKey === key`, reopens with
`fromKey` or `targetKey === key`; returns the reopens of *other* senders targeting `key` (they get a not-delivered
notice). A reopen **from** `key` is deleted, but its held items have `toKey = target` and `awaiting = requestId`, so they
stay — never released (no reopen to approve), never dropped, never shown.

**Proposal:**
- In `forget(key)`, collect the requestIds of reopens with `fromKey === key` and delete outbox items whose `awaiting`
  is one of them (the sender is gone, nobody to notify).
- On load, sweep orphans: delete items whose `awaiting` refers to no reopen (cleans files written by v0.12.0). Log the
  count.
- Tests: forget(sender) removes its awaiting items and leaves the target's other items; a file with an orphan awaiting
  item loads without it.

### A3. Stale reopen card replayed after a reload

**Today:** main's `reopenCards` (requestId → card) is filled by `reopen_request`, cleared on an answer (incl. 404),
on close/exit/failed open of the sender. The broker removes a reopen in `forget(target)` (and then notifies the sender's
model) but says nothing to the sender's app, so the card stays and is replayed after a reload.

**Proposal:** an explicit withdraw signal.
- Broker: whenever a reopen is removed for any reason other than the sender's own answer (target forgotten, sender
  forgotten), emit `control("reopen_withdrawn", { requestId })` to the sender if it is online.
- Relay client: new callback `onReopenWithdrawn(payload)`.
- Main: delete the card from `reopenCards`, send `reopen:withdrawn` to the renderer.
- Renderer: the open card shows "This request is no longer pending.", loses its buttons and `closeCard`s (attention
  marker off); the id stays ignored.
- Offline sender: on its next registration the broker re-asks only live reopens, so main should also drop that
  session's cards on `onRegistered` before the re-asks arrive (a re-ask restores the live ones).
- Tests: broker emits `reopen_withdrawn` on forget(target); client parses the event; main/renderer by `node --check`.

### A4. Terminal peers don't see their relatives

**Who is affected:** only app-created sessions (or their parents) resumed in a terminal with `copilot --resume`. Their
incoming relay prompts already carry the "Your children" block (the broker decorates at delivery), only the list tools
lack it. Messages from such a peer to a closed relative get the "no app connection" text (by design since v0.12.0).

**Proposal (backward compatible):**
- Broker: new `GET /api/peer/family?key=` → `{ text: delegation.familyBlock(key) }` (empty string when no relatives).
- Relay client: `family()` → text; a 404 (older broker) → "".
- Extension: `relay_list_sessions` and `/relay` append the text when non-empty; `relay_list_sessions` also when no
  other peer is online (mirrors `formatList`).
- After the change the user runs `npm run install-extension` (the extension copies `relay-client.mjs`).
- Tests: route returns the block / empty; client 404 → ""; extension formatting via a small pure helper.

**Effort:** A1 small, A2 small, A3 medium (four layers), A4 small. Suggested order: A2 → A1 → A3 → A4, as v0.12.1.
