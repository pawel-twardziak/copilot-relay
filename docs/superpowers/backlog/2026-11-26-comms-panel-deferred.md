# Communication panel: deferred findings

**Sources:** the task reviews (Opus 5.5, high) of the nine plan tasks, their fix-round re-reviews, and the final
whole-branch review (Fable 5.2, medium) of `feat/comms-panel`. Execution was subagent-driven.

Spec: `docs/superpowers/specs/2026-11-26-comms-panel-design.md`. Plan: `docs/superpowers/plans/2026-11-26-comms-panel.md`.

None of these blocked the merge. Line numbers were taken at the review that found them and may drift.

**Fixed on the branch, so not listed below:** a log failure at broker start no longer stops the broker; the panel
refreshes peer state and drops deleted sessions on links changes; an outside node with an empty peer name takes the
event's name; a failed or old-broker fetch is retried once and the note no longer flashes "Loading"; a click on the split
bar without a drag keeps the automatic height, and a double click returns to it; with an old broker the root shows the
view's relay name. Earlier fix rounds: unguarded log rewrite and log writes in the message paths, test brokers writing
the real log, held counts repeated on sibling edges, dishonest idle/waiting states, edges crossing boxes and leaving the
SVG, pair lines merging, buses swapping directions, unreadable clocks and names, the graph scrolling at 420 px, the
shared handle and show-in-panel with Communication in the slot, the split bar jumping when grabbed.

## A. Worth doing first

1. **Every Communication view re-renders on every refresh** (`drawComms`, `electron/renderer/app.js` ~3769).
   - Every view whose slot holds Communication runs `CommsModel.build` over all of its tree's events and `drawLog` on
     each usage tick, keeper change and the 1 s ticker, including hidden and collapsed views. `drawGraph` exits early
     for hidden views; the model and the log do not. A hidden view's first render builds up to 1000 rows.
   - Also forced reflows per node per render (`comms-view.js`: `corner.offsetWidth` after `replaceChildren`,
     `status.scrollWidth` after a write).
   - Proposal: render only the active view and mark the others dirty (`activate()` already calls `commsRefresh`);
     batch reads after writes. Measure on a tree of thousands of events first.
2. **`commsByRoot` is never evicted** (`app.js`). Every tree whose root still has children stays cached after all its
   views are closed, and `onCommsEvent` keeps appending to it. Proposal: drop a root's entry when no open view belongs
   to its tree; refetch on next show.
3. **A second broker that fails to bind still opens the live log** (`server.mjs`, `CommsLog#load` at module top level).
   It runs before `listen` fails with `EADDRINUSE`; a truncation of a half-written tail or a cap rewrite then changes the
   file the running broker is using, its byte offsets go stale, and a later purge rewrite copies misaligned bytes.
   Proposal: create the `CommsLog` after `listen` succeeds (or open it lazily on the first event).
4. **The log line is written after the push, not before** (`Delegation.report`/`appMessage`/`userMessage`,
   `Registry.send`). The status comes from the push result (plan), so a crash between push and append loses that
   event, and the `comms` control event reaches the app after the message itself. Proposal: append as `queued`
   first, then `status(id, "delivered")` after a successful push.
5. **No refetch after a relay stream reconnect.** Events appended while all of the app's streams were down are missing
   from the cached tree until a links change or a reload (the links-change refresh mostly covers it). Proposal:
   refetch the shown trees on `onRegistered`.
6. **A failed refetch keeps stale data without a note** (`app.js` `done`). Proposal: keep the data, add a small
   "could not refresh" note with a retry. Related: a failed refetch of a loaded tree does not update `at`
   (`app.js` ~3844), so while the broker keeps failing every links change refetches at once (the 2 s throttle stops
   applying); set `at` on a failed refetch too.
7. **The links-change refresh refetches the whole tree** (`commsLinksChanged`, `app.js` ~3871): at most every 2 s per
   tree, for every tree whose view has Communication in its slot (`ui.rightPanel` is global, so usually every open
   tree, also inactive or collapsed ones; `commsOnScreen` would be stricter). A peers-only answer would be lighter. A
   closed root keeps its cached state for up to ~2.2 s until the answer arrives. `done` still writes back a tree that
   was dropped while its fetch ran, and `commsSoon` timers are not cleared when a tree is dropped (they exit through the
   `!events` guard).

## B. Window and wording

1. **Open-view fetch errors read differently** (`electron/main.mjs` `comms:get`/`comms:text`): with an open view and the
   broker unreachable the raw "fetch failed" shows; without a view, the readable "could not be reached (…)". And
   `fetchCommsText` maps every non-OK answer (a 500 too) to null → "not found".
2. **The 5-node "states" scene still scrolls at 420 and 280 px** when the held-messages strip takes ~180 px of the
   panel. It is the last-resort scroll; a larger graph share or a collapsible held strip would avoid it.
3. **Layout look to check by eye:** a pair's label may land on its twin's side when both sides are crowded; a child
   under the trunk gets a 2o jog on its return line; return lines of left and right children share `[tx−2o, tx+2o]` on
   the lower bus (a T-junction under the parent); in a bus row an inner child's drop crosses an outer child's bus line;
   a wide row with no pairs is also drawn as a bus (by design, so a row does not change style when a pair appears).
4. **Label proportions are tuned for 13–14 px fonts** (`comms-layout.js` `LABEL_W`/`LABEL_H`): at 11 px and 20 px many
   more labels touch a box or line. The seeded random suite allows ≤ 0.5 % crowded labels (ruling).
5. **Focus is lost in the narrow drawer on an automatic slot flip** (Communication shown because Activity was
   unavailable, then Activity's first entry arrives while the stored choice is Activity).
6. **Names longer than the 320 px box cap still ellipsize** (the status clock never does).

## C. Small behaviour

1. `src/comms-log.mjs`:
   - `append()` with an id it already holds creates a duplicate (callers never re-append; redelivery uses `status()`).
   - The cap at load leaves orphan status events (their message was cut); they count toward the cap.
   - Returned and listener events are the stored objects; a caller that mutates one corrupts memory.
   - `text()` throws on a missing file or stale offset instead of returning null (the route catches it).
   - `COPILOT_RELAY_COMMS_FILE=""` is used as a path (`??` instead of `||`).
   - After a failed rewrite `pending` stays true but no timer is re-armed; the retry comes on the next purge or
     shutdown `flush()`.
   - Whole-file synchronous I/O on every rewrite; the 50 000 cap applies only at broker start, so the file grows in
     between (known limitation).
2. `src/delegation.mjs` / `src/registry.mjs`:
   - `#forget` (and the reopen "missing" path) log `dropped` events that `purge` removes at once.
   - Warn-once differs: Registry once per lifetime (public `logWarned`), Delegation once per error code.
   - `#guarded` catches everything, so a programming error (TypeError) shows only as "write failed".
   - `setTask` logs the task once per child key for the life of the log; a child released and linked again with a new
     task gets no second `task` event, so its timer runs from `createdAt`.
   - `#logItem`'s `delivered` parameter is boolean-or-string.
   - `#inform` to an offline session is not logged (ruling: it is not stored).
3. `src/links-api.mjs`: dead branches in `GET /api/comms` (`linked.includes(key)`, `keys.includes(root)`); `kind` falls
   back to `"cli"` for keys not in the registry.
4. `electron/comms-forward.mjs`: ids are marked seen when no window exists (harmless: the renderer refetches on mount);
   add a comment so nobody relies on the forwarder for delivery.
5. `electron/renderer/comms-model.js`:
   - `input.now` is accepted but unused.
   - Events without an id collapse into one (`seen.has(undefined)`).
   - A ghost's name may be undefined when a create card has no name.
   - `avgTaskToReport` is O(children × rows).
   - A non-`cli:` key without a colon could collide with a bare session id.
   - A task-less child still gets `ended-no-report` and `in-progress` (since `createdAt`); only `waiting-report` is
     gated on a task.
   - A `{node}` filter on an outside node shows that node's held total from another tree.
   - `released` is detected only from a task event to a peer that left the tree; an adopted-then-released child (no
     task event) shows as a plain outside node.
6. `electron/renderer/app.js` / `comms-view.js`:
   - `openCard` dedups by kind + id, `closeCard` removes by object.
   - The 1 s ticker is armed for keeper `pinging`/`compacting`, which show no clock.
   - Re-expanding a row whose fetch failed shows the old error next to "loading…"; a filter change drops expanded text.
   - Destroying the panel during a split drag leaves the window listeners until pointerup.
7. `communications.jsonl` is created with the default file mode (0664 here) and holds up to 50 000 full message texts.
   Consider `mode: 0o600` (and the same for `delegations.json`).

## D. Tests and housekeeping

1. Untested or weakly asserted:
   - `comms-log`: the purge debounce test waits 1.3 s of real time (use `mock.timers`); the inode-change assertion was
     verified on Linux only.
   - `comms-broker`: the `setTask` once-guard (a second `setTask` already returns false earlier; needs a re-link case);
     the `#endedNotice` notice event; the no-comms test covers little; `attached` re-asking reopen/link requests under
     a failing log.
   - `comms-api`: the `store.nameOf` fallback; the orphan test sets `parentDeleted` by hand instead of
     `delegation.forget`; no assertion that the real `communications.jsonl` stays untouched.
   - `comms-layout`: the router's straight-line fallback is never asserted.
   - UI checks: `comms-split`'s direction guard is not derived from the real limits (the +60 branch is unchecked); the
     far-up drag does not pin the graph at 120 px; the clock-tick wait passes on any status change; the report preview
     length (300 + `…`) is not asserted; the `comms-switch` comment "the child's view follows the stored choice"
     overclaims (the child shows Communication through the fallback).
   - No UI check for the old-broker hint, node and edge filters, the keeper countdown, context bars, proposed ghosts,
     or approving the held report.
   - The broker-without-log test covers an unreadable path (EISDIR) only, not ENOSPC on the cap rewrite or a log over
     2 GiB (same catch). `comms-split-click` sends a synthetic `dblclick`; a real double click was not tried.
2. Housekeeping:
   - The preview rule is written twice in `comms-log.mjs` (append and load).
   - `comms-layout.js` is ~660 lines; `layout()` mixes four phases (extract placeUnits / fit / treeLines /
     routePairs); a discarded reroute leaves its cost in `used`; unreached in-tree nodes (a parent cycle) are not
     counted as outside for the width; the wrap is greedy (narrower children are never tried).
   - Stale comments: `style.css` (~501, "panel.hidden still means no entry"), the `activityBtn` comment (~437), the
     `layoutPanels` doc ("the activity panel's stored width").
   - Layout cost per panel resize on a large tree is unmeasured (`boxWidth` and the placement choice run several
     layouts per size; results are cached per key).
3. **Not verified:** Windows and macOS (layout, file rename/inode behaviour); a real Copilot tree on this Linux machine
   and on the corp PC (spec "Testing → Manual"); a real old broker (simulated only); keyboard paths (Enter on nodes and
   log rows); reduced motion; the app has no light theme, so only dark was checked.
