# Held child replies: deferred findings

Source: the six task reviews, the whole-branch review of `feat/held-child-replies` and its fix wave.
Spec: `docs/superpowers/specs/2026-11-23-held-child-replies-design.md`. None of these blocked the merge. Fixed in the
fix wave and therefore not open: I1 (`relay:ack` falls back to the broker's HTTP ack for a dead view; this also closes
T4-m6, `removeQueued`), M1 (`arrivedAt` stamped in `onMessage`, insertion by it), M3 (notification only when the switch
is on), M4 (`isSessionId` on `held:get` / `held:set`), M5 (= T2-m2, preload comment). Line numbers are left out where
the fix wave moved them; the symbol is given instead.

## A. Worth doing first (analysed below)

1. **M2. A lost ack is never repeated.** `RelayClient.ack` (`electron/relay-client.mjs`) swallows every error
   (`.catch(() => {})`), so `relay:ack` (`electron/main.mjs`) returns true when the broker was unreachable. The comment
   on `ackDiscarded` (`electron/renderer/app.js`, "only a confirmed ack") overstates it. An ack lost during "Update and
   restart broker" leaves the item in the broker; its redelivery is rejected as already seen (`seenDeliveries`) and never
   acked again, so the sidebar count stays too high and the reply comes back held at the next fresh open (reports had
   the same gap before, worse).
   *Proposal:* when a delivery id arrives that is no longer in `held`, the queue or an unstarted prompt but is in the
   view's seen set, acknowledge it again instead of dropping it silently. Optionally let `RelayClient.ack` return
   whether the POST succeeded, so `relay:ack` and the comment tell the truth.
2. **T4-m4. A view that died after it was opened shows no sidebar mark** although the broker still holds its replies
   (`sidebarCount` in `electron/renderer/held-replies.js` prefers the view's own list, which is empty or stale for a dead
   view; the dead-view line `comeBackLine` is shown only in the view).
   *Proposal:* for a view whose process has exited, take `max(view.held.length, brokerHeld)` or the broker's count
   alone. Worth doing first if users see parents die with replies pending.
3. **A terminal (extension) parent's marked report is counted in `held`.** The broker counts every unacknowledged marked
   item for `cli:<id>`, including one for a parent run by the extension, which never acknowledges a held item; the app's
   sidebar could show `⏸ N` for such a session. *Proposal:* count only for keys of peers with `app: true` (or ack on
   delivery for non-app recipients), decided in `Delegation.heldCounts`.
4. **M6. `Registry.send` says "delivered" when only the store has it** (`src/registry.mjs`, `send`): `childMessage` ran
   but `pushTo` failed, so the item is stored and delivered at the next registration. *Proposal:* reply "queued" in that
   case, as for an offline recipient.

## B. Window, wording

5. **T4-m7.** An expanded held row collapses on any re-render of the list (`renderHeld` in `electron/renderer/app.js`
   rebuilds the rows). Keep the expanded ids in a set on the view.
6. **M3 rest.** The notification "A sub-session replied" fires again after `closeEntry` / exit drops the cache
   (truncate, resume) and for a discarded reply that is delivered again.
7. Declined by the reviewer, recorded: an old app with the new broker now gets a child's `send_message` again at the
   next start if it dropped it from its queue on a window reload (arguably better); an older app after a downgrade reads
   the new links-cache object as an empty tree until the broker answers.

## C. Small behaviour

8. **T4-m1.** Approve and the switch stay enabled while a delete runs (`setDeleting` -> `setBusy` does not call
   `renderHeld`); harmless, `pump` refuses.
9. **T4-m3.** `renderHeld` during a pending `setHoldReplies` shows the old switch state.
10. **T1-m2.** `Delegation.childMessage` has no null guard for `registry.get(fromKey)`; cannot happen today
    (`Registry.send` returns early without `from`).
11. **T1-m3.** `Registry.send` has a braceless `if (!(... && this.childMessage?.(...)))` around `#deliver`, with a side
    effect inside the condition.
12. **T1-m1.** `Delegation.ack` calls `store.pending` twice (one `find`).

## D. Tests and housekeeping

13. **T1-m4.** No `heldCounts` test with several parents or with awaiting requests excluded.
14. **T2-m3.** `RelayClient.fetchLinks` and `fetchLinkState` duplicate the fetch/status check; `brokerGetLinks` duplicates
    the held normalization.
15. **T3-m1.** No `statusText` test for held with `dead: true`. **T3-m2.** `approvedPrompt` computes `now - arrivedAt` twice.
16. **T4-m2.** The show-switch rule is computed twice (`renderHeld` via `tree.childrenOf`, `renderRelations` via
    `rel.children`). **T4-m8.** `.held-text { cursor: pointer }` is a separate rule that could be merged.
17. **T4-m5.** UI check `held-replies`: step 4 does not assert the prompt sent is `P-h2`; steps 3 and 7 clear
    `queue.length` directly; no check for the `reopenView` / `openSession` hand-over, `heldComeBack`, a failed
    `setHoldReplies` write, or a broker-count mark without a view.
18. **T5-m1.** The `held-e2e` comment should say step 4 is close + reopen, not a window reload. **T5-m2.** `parentTurns`
    counts `.msg.user, .msg.relay` only. **T5-m3.** The scripted agent's `send_message` text cannot contain a newline
    (documented). **T5-m4 (reviewer).** The ui-check driver should run `copy-relay` itself: a stale or missing
    `electron/relay-client.mjs` makes broker checks fail to connect.
19. **I1 has no unit test.** The `relay:ack` handler lives in `main.mjs`, which cannot be imported in a test; the
    fallback was verified by running the existing checks only. *Proposal:* a `held-e2e` step that closes a dead view
    after a discard and reopens it (needs a child process that exits).

## Known limitations and open manual checks

- No check runs main's in-memory replay after a real window reload; `held-e2e` step 4 is close + reopen via the
  driver's `app.reload()`.
- Task 6 with real Copilot is still open: two children report close together -> two held rows, nothing runs until
  Approve; switch off -> both go; a closed parent shows `⏸ N` and holds them after opening.
- A real window reload (Ctrl+R) with a held reply in a parent: open the parent, the reply is back held and in order.
- Windows and the packaged build were not run. The look of the strip and the switch at narrow widths was not checked.
