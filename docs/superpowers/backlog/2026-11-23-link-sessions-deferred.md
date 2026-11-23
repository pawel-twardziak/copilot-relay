# Link sessions: deferred findings

Source: the eight task reviews, the whole-branch review of `feat/link-sessions` and the re-review of its fix wave.
Spec: `docs/superpowers/specs/2026-11-23-link-sessions-design.md`. Plan:
`docs/superpowers/plans/2026-11-23-link-sessions.md`. None of these blocked the merge. Line numbers are left out on
purpose: the fix wave moved them; the symbol or test name is given instead.

Two entries (A1, A2) are defects that existed before this branch; its reviews found them.

## A. Worth doing first (analysed below)

1. **The relay chip never shows "offline" during a broker outage** (older than this branch). In
   `RelayClient.#loop` (`extension/copilot-relay/relay-client.mjs`) the catch block calls
   `this.log("relay: disconnected …")` before it sets `this.connected = false`. The app's `status()` in `relayStart`
   (`electron/main.mjs`) builds its payload when `log` calls it, so it sends `connected: true`; later failures log
   nothing. The only offline status ever sent is the one-time auto-start note. Found by the `link-e2e` UI check,
   which therefore waits for the broker's own peer list after a restart and treats the chip as proving nothing.
   *Proposal:* clear `connected` before calling `log`; add a test to `electron/test/relay-client.test.mjs` (stub
   broker drops the stream, the `log` callback sees `connected === false`). Then `link-e2e` step 6 can rely on the
   chip.
2. **The stream route writes any link without a card** (older than this branch). `GET /api/peer/stream` in
   `server.mjs` runs `delegation.link(key, parent)` whenever a stream attaches with `parent=`, with no check: it can
   replace a live link, make a self-link or a cycle. The app sends `parent=` only from `createChild` (first
   connection of a created child), so nothing in the app reaches the bad cases; a local process calling the HTTP API
   does, which the spec's Constraints put out of scope. The new code and the renderer walk the tree cycle-safely.
   *Proposal:* have the route ignore `parent=` when the key already has a live link to another parent or when the
   link would form a cycle (the ancestor walk of `Delegation`'s link validation can be reused).
3. **A pending request can disappear without the model being told** (spec, Known limitations). An `adopt` request
   is dropped when its parent or child leaves the registry (`peer_removed`, 30 s after closing) and every request is
   lost at a broker restart. The card then answers "This request is no longer pending.", but the session that
   asked gets no message.
   *Proposal:* when `Delegation` drops an `adopt` request on `peer_removed` and its parent is still known, send the
   parent a durable notice ("The request to link "<child>" expired: …"). Requests lost at a restart stay lost
   unless they are written to `delegations.json`; not proposed.
4. **An approval can reach the broker before the child's stream close.** The window closes a child's view and the
   card's answer over two connections. If the answer arrives first, the broker still sees the child online and
   links a session that is closed a moment later. The result is a closed child the user can release. `link-e2e`
   step 7 waits for the broker to see the child offline to make its refusal deterministic.
   *Proposal:* none. Recorded as a known limitation of the "child must be open at approval" rule.
5. **The local HTTP API is unauthenticated** (spec, Constraints). A process on the machine, including a model with
   a shell tool, can read a pending `requestId` by attaching to the parent's stream and answer it with
   `POST /api/peer/link-answer`; the same holds for `reopen-answer`. The tool reply and every notice leave the id
   out, so a model using only relay tools cannot.
   *Proposal:* a separate piece of work: the app sends a secret when it attaches its stream and the broker requires
   it on every answer route. It changes `server.mjs`, `src/links-api.mjs`, `RelayClient` and `relayStart`.

## B. Window, wording

6. The reload question (`confirmedReload` in `electron/main.mjs`, `reloadWarning` in `electron/delegation.mjs`)
   counts the open reopen cards of the sessions it stops, not their link cards. A parent that is itself a
   sub-session is closed by the reload and its link card dropped; an adopt request then expires after 30 s (A3).
7. The notification "A delegated session needs permission" (permission handler in `electron/main.mjs`) now also
   fires for an adopted session, which was never delegated. "A sub-session needs permission" fits both.
8. The link card names the child by its relay name and folder only. `childSessionId` is sent in `link:request`
   (`linkCardOf` in `electron/delegation.mjs`) and never read by `SessionView.linkCard`; the sidebar lists sessions
   by title, so showing the title (as `relationChip` does) would help the user see which session they approve.

## C. Behaviour, small

9. A refusal at approval for a child with no registry name, stored name or `nameOf` reads
   `"session" is not one of your children.` (`answerLink` / the link validation in `src/delegation.mjs`). Reached
   only when the link was removed behind the request's back; `forget` drops the request first.
10. `RelayClient.answerLink`: a 200 answer whose body is not JSON rejects with a `SyntaxError` that has no
    `status`, so the caller cannot tell it from an unreachable broker. The card keeps its buttons; the next click
    gets 404.
11. `SessionView.linkCard` (`electron/renderer/app.js`): a `refused` result without `text` would render an empty
    span. The broker always sends `text`.
12. Link cards are not closed when the parent's relay connection drops (the same as reopen cards). A later click
    shows `Could not answer` with the buttons back; the broker asks again when the parent registers anew.
13. An orphan's `registered` payload still carries the deleted parent's key, so `main.mjs` counts it as a child at
    quit and at a reload (older than this branch).
14. A delete that races a just-approved link (`forgetDeleted` in the renderer works on an index taken before the
    link; `deletedIds` are excluded from pruning) can leave a link to a deleted session until the app restarts. The
    same race exists for a just-created child.

## D. Tests and housekeeping (no behaviour impact)

- `delegation-store.mjs` / `delegation-broker.test.mjs`: no test that `link()` to a different parent drops
  `adopted`; `isAdopted` is never asserted false for an ordinary `link()`.
- `Delegation.requestLink` does not validate `kind` (anything but `"adopt"` is handled as a release); its two
  callers pass literals.
- `delegation-broker.test.mjs`, missing tests (the behaviour was probed during the whole-branch review and is
  correct): `forget` dropping a pending request; `attached` re-emitting only the attaching parent's requests; the
  child-to-parent reopen request dropped on release; the no-app and old-app refusals at approval; `linkCards` kept
  on a re-attach that leaves it out, and false by default.
- `"You are not registered with the relay broker."` exists three times (`src/delegation.mjs` twice,
  `src/registry.mjs`).
- An approved release with a reopen request writes `delegations.json` three times (`dropAwaiting`, `removeReopen`,
  `unlink`).
- `links-api.test.mjs` (client tests): the `answerLink` stub does not assert method and path (the e2e test pins
  them); no test that `caps` is sent again when the same client reconnects; no test for `answerLink` against an
  unreachable broker. `answerLink` repeats `answerReopen`'s two error lines.
- `link-sessions-e2e.test.mjs`: the old-app refusal is asserted for `adopt_session` only; no test for a `caps` list
  with several entries; `links-api.test.mjs` tests a missing `key` but not a non-string one.
- `electron/main.mjs`: `dropReopenCards` and `dropLinkCards` are called as a pair at three sites; one `dropCards`
  would keep a fourth site from forgetting one. Its link wiring (`relayStart`, `linkRequested`, `link:answer`) has
  no unit test; only the `link-e2e` UI check executes it, and the UI checks are not in CI.
- `adopted` in the links snapshot (`Delegation.snapshot`) is never read by the app; the field list in the comment
  in `electron/preload.cjs` omits it. Use it in the tree or correct the comment.
- UI check `link-card`: no assertion that the `Folder` row is left out when empty, that a name with markup shows as
  plain text, or that the card is back in the view's open cards after an answer that did not arrive.
  `SessionView.linkRequests` is never pruned (as `reopenRequests`).
- `scripts/ui-check/driver.mjs`: `stopPid` loops while `kill(pid, 0)` succeeds, which never ends for a zombie that
  is not reaped (a container without an init process). `restart()`: after it accepts a broker the app auto-started,
  a second `restart()` stops nothing; on its timeout path its own dying broker can be accepted; an accepted
  auto-started broker reads the repository's `relay.config.json`. `brokersOf` reads `/proc`: Linux only, as
  `xvfb-run` already is.
- Task 4 (tools, route, e2e) was implemented before its tests were seen failing; the reviewer ran them against the
  base commit afterwards (the four new tests fail there for the right reasons).

## Not verified

- **Windows and macOS.** Nothing was run there. The UI checks are Linux-only and not in CI.
- **With real Copilot, by hand** (the UI checks use a scripted agent that calls the tool when the prompt names it):
  - the model calls `adopt_session` / `release_session` when asked to in the chat, and does not on its own;
  - Copilot's own permission prompt does not appear for the two tools (`isRelayTool` matches the titles
    `relay-adopt_session` and `relay-release_session`; the real title was not seen);
  - after an approved adopt: `list_sessions` in the parent shows the child under "Your children" as
    `adopted, no task`; `report_result` in the child reaches the parent; the child does not start a turn;
  - quitting the app with an adopted child open asks nothing about unreported sub-sessions because of it;
  - a window reload stops the adopted child with the other sub-sessions.
- **Tools in a session that was already open.** Whether a Copilot session opened before "Update and restart broker"
  sees the two new tools without being reopened is not known (spec, Known limitations).
- **An old app build with the new broker.** The refusal for a stream without `caps=links` is tested
  (`link-sessions-e2e.test.mjs`); a real v0.19.0 app was not run against this broker.
