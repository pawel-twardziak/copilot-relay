# Reply fallback for sessions without relay tools: deferred findings

**Sources:** the task reviews and fix-round re-reviews (Opus 5.5, high) of Tasks 1–7, the final whole-branch review
(Fable 5.2, medium) and the re-review of its fix wave (Opus 5.5, high) of `feat/relay-fallback`. Execution was
subagent-driven.

Spec: `docs/superpowers/specs/2026-11-27-relay-fallback-design.md`. Plan: `docs/superpowers/plans/2026-11-27-relay-fallback.md`.

None of these blocked the merge. Line numbers were taken at the review and may drift.

**Fixed on the branch, so not listed below:**
- A missing `tools` list in an agent event means "all tools", not "none".
- A report to a parent that left the registry is stored, not lost.
- `readEvents`' `{ events, lines }` shape (the detection threw for every custom-agent session).
- A chain runs through pumped answers to queued messages; no note request (and no await) for the default agent; a
  Stop during the note request skips the prompt.
- Pending forwards survive a close and are dropped by a delete or a cut of the history.
- `fallback:list` returns the `old` / `error` flags, so the "broker too old" line comes back after a reopen (v0.38.1).
- A baseline is matched to the agent by order after its own selection and by its file-style name, so an agent whose
  `name:` differs from its file name ("Poeta wspomnień" / `poeta-wspomnien`) is seen with its new tools after a
  restart (v0.38.2).
- Pending forwards are kept on disk (`fallback-pending.json`) and survive an app restart; a forward stays on disk
  until its send succeeded, and a send failing during a close or restart keeps it (v0.38.1).
- The note waits up to 2 s for `subagent.selected` after the app set the agent (Copilot writes it ~500 ms late).
- Don't send works in a dead view; no collecting between chains; a newer tool baseline beats an older agent
  selection; a Stop during the note request keeps the pending notes.

## A. Worth doing first

1. **The first prompt after a reload can still carry the note for an agent that has gained relay tools.**
   - Where: `agentRelayTools` (`electron/relay-tools.mjs`), `relayToolsFor` (`electron/fallback.mjs`).
   - Copilot writes no new `subagent.selected` on `session/load`, and the new `session.tool_baseline` only during the
     first turn after it. So if an agent file gained `relay/*`, the first chain after a reopen still reads the old
     selection and gets the note (it tells the model to ignore `report_result`). The turn-end check sees the new
     baseline, so no card follows; later prompts get no note.
   - Proposal: live check first (edit the agent file, reopen, look at the events). If Copilot re-reads agent files on
     load, read the agent file's `tools:` (repo `.github/agents`, `~/.copilot/agents`) as a third, newer source.
2. **A subagent's relay call is not seen, so a double send is possible.**
   - Where: `createChainState.update` records top-level `tool_call` titles only (`electron/fallback.mjs`);
     `reported` is captured at the chain's start.
   - If a subagent of a limited custom agent still gets the relay MCP tools and calls `relay-report_result`, the chain
     end still forwards the reply, and the broker delivers it as a message: a second send to the parent.
   - Proposal: live check whether subagents get relay tools; if they do, skip the forward when `entry.reported` turned
     true during the chain.
3. **Approval off and an error after the broker received the forward: Send can double a message.**
   - Where: `fallback:chainEnded` / `sendForward` (`electron/main.mjs`).
   - A timeout or reset on the way back keeps the forward with `error`; Send posts it again. A report is deduplicated
     by the broker, a message is not.
   - The same at-least-once gap since v0.38.1: a quit between the broker accepting a forward and its `settle`
     leaves it on disk, and Send after the restart posts it again.
   - Proposal: an id per forward that the broker remembers for a while (idempotent `/api/peer/fallback`).
4. **A blocked pump can leave a chain open.**
   - Where: `chainEnded` / `Fallback.chainEnds` (`electron/renderer/app.js`, `electron/renderer/fallback.js`).
   - If the pump is blocked at "pump" time (`edit`, `historyOp`, `holdInbox`), the chain stays open until the next
     prompt, whose start then ends it and forwards an answer text to the origin. With `sendEdit` the old view's seq is
     never ended.

## B. Window and wording

1. Two pending cards both say "report"; after the first is sent, the broker delivers the second as a message (label
   wrong, delivery right) — `fallback:chainEnded` captures `reported` per chain.
2. A recipient name containing `"` breaks the note's quoting (`fallbackNote`, `electron/relay-tools.mjs`).

## C. Small behaviour

1. The switch shows once a note was given in this view or a forward waits, not by the current agent: a reopened
   limited session shows no switch until its next chain; it stays after switching to a relay agent
   (`showSwitch`, `electron/renderer/fallback.js`; `fbCannot` in app.js). Proposal: a `fallback:canAnswer` asked on
   open and on agent change.
2. Once a session's switch is touched there is no way back to "follow Settings" (`fallback:setApproval` coerces to a
   boolean, `electron/main.mjs`).
3. `approveFallback` is always written by the settings save (`s.approveFallback !== false`); a form that omits it
   resets it to true. "Only when sent" (like `cacheKeeper`) would be more robust.
4. A cut of the history drops every pending forward of the session, also those whose reply survives the cut. Unknown
   whether a dropped report leads to the parent's "ended without reporting" notice.
5. A failed `fallbackNote` IPC is swallowed (`.catch(() => null)` in `runPrompt`) without a trace.
6. A Stop during the note request acknowledges a relay message Copilot never saw (`runPrompt`, app.js ~3046).
7. A custom-agent session before its `agent` option arrives gets no note; main may still forward.
8. Stored pending records are checked only for a string `id` (`createPending`, `electron/fallback.mjs`); a hand-edited or damaged record with other fields missing reaches the card as is.
9. Forwards of a session that is never opened again stay in `fallback-pending.json`; they are dropped only when the session is listed (`fallback:list`), not at start-up.
10. The `old` / `error` flags of a forward are covered by the UI check `fallback-restart-flags` only through an edited file; no check makes the broker refuse a forward (no 404 or failing post can be provoked), so the store of the flags in `offerForward` and the release in `fallback:answer` are unverified by a live run.
11. After a Stop that pauses the queue and a later ▶, the resumed answers and the continue are not forwarded (ruling:
    a Stop is the owner taking over).
12. A failed mid-turn send (before its switch point) suppresses the forward of a task that finished
    (`stopped("failed", n)` in `createChainState`).
13. A relay message delivered mid-turn into an owner-started turn is never answered by a forward (spec: mid-turn
    senders get no forward of their own).
14. A mid-turn delivery could overtake the first prompt during the note request (`toolBoundary` /
    `canDeliverMidTurn`), only with a background subagent tool update inside that window.
15. A Stop racing a natural `end_turn` still offers a card (or sends at once with approval off).
16. A command answered inside a follow-up carries the chain's meta (harmless while the continue follows).
17. The wait in `relayToolsAfterSet` stops at any `subagent.selected` of the agent, including an old one (X → default
    → X); no worse than before, both are stale for ~500 ms.
18. Agent changes through Copilot's own `/agent` get no 2 s wait (only app-set ones): the note can be missing, the
    card still appears.
19. Only `relay/*` is a wildcard, not `relay-*` / `relay_*`; a bare `relay` entry in `tools:` reads as "cannot answer"
    (unverified whether Copilot grants the server's tools for it).
20. The message path of `Delegation.fallback` resolves the key to a name; a reused name could reach another peer.
21. The budget-blocked line in `messageClosed` has no `fallback: true` flag (`src/delegation.mjs` ~381).
22. Synchronous full read of `events.jsonl` in main at chain start and end (custom-agent sessions only).
23. `prompt()` clears the chain text at a mid-turn start; it relies on the continue prompt always following.

24. `fallback:list` drops a session's forwards when `sessionDir` says ENOSESSION, the session-state root exists and
    the session folder does not; an unreadable folder (EACCES) still reads as missing. Valid JSON that is not an
    object in `fallback-pending.json` reads as empty without a log, and a garbled file is overwritten without a copy.
25. A forward released after a failed send, while its session's view was reopened during the send, shows no card
    until the view is opened again (`fallback:answer` release paths; `fallback:list` hides claimed forwards). Fix:
    emit `relay:fallback` after a release with a patch.
26. A failed write of `fallback-pending.json` leaves older content on disk: a forward sent or dropped in memory can
    come back after a restart and be sent again (a report is deduplicated by the broker, a message is not).

27. The name / file-style-name match of a baseline ignores order and switches: if another agent's file name equals
    this agent's slug (agent "Reviewer" in `strict.agent.md`, another agent in `reviewer.agent.md`), the other one's
    baseline counts for "Reviewer" while it is later than Reviewer's own selection (in practice only in the ~500 ms
    lag). `agentSlug` turns letters NFD does not split (ø, ß, đ) into `-`; only `ł`/`Ł` are mapped.

## D. Tests and housekeeping

1. No automated test of main's wiring (`chainPrompt`, `fallback:chainEnded`, `fallback:answer`) beyond the UI checks.
2. The mid-turn UI checks use a loose emulation (the scripted agent does not cancel the interrupted prompt and sends
   no abort marker); the cancelled-then-`end_turn` chain is unit-tested in `fallback.test.mjs`.
3. The scripted agent's `session/load` resets config options (the header shows the default agent after a reopen).
4. The negative UI assertions rely on a fixed 600 ms `settle()`.
5. `fallback-truncate` writes Copilot's `events.jsonl` turn by hand; no live cut was checked.
6. Small test gaps: `tools: null`; an agent `tools` entry with `relay_` spelling; the message branch to a parent that
   left the registry after reporting; `RelayClient.fallback`'s network-error and non-404 branches; the
   "copy and delete only log" test in `fallback-store.test.mjs` never reaches a write.
7. Tidiness: `#inFallback` declared after its first use (`src/delegation.mjs`); the agent lookup duplicated in
   `main.mjs` (`fallback:note` vs `relayToolsOf`); preload's fallback methods split the hold pair; the comment above
   the non-array rule in `relay-tools.mjs`; `relay-tools.mjs` `stripNote` is used only by tests (the renderer copy is
   the live one); the renderer load test swallows `ReferenceError` per script.
8. `scripts/ui-check/driver.mjs` `launch()` leaves its broker running if it throws before its try block.
9. `settle` in `createPending` calls `this.take(...)` (breaks if the object is destructured).
10. A live check with the real `COPILOT_HOME` must set `COPILOT_RELAY_URL`: the extension's `config.json` url beats
   `COPILOT_RELAY_PORT`.

### Manual checks still open

- Whether Copilot writes `subagent.selected` / `deselected` for an agent chosen with `/agent` in the prompt, a CLI
  `--agent` flag, or a resume that falls back to the default after the agent file was deleted: since v0.38.2 a
  baseline counts for the agent selected last with no switch since, so a switch without an event would let another
  agent's baseline count. Also whether sub-agents write `session.tool_baseline` (their events with `agentId` are
  skipped since v0.38.2).

- A delegated `limited` child with a model whose first prompt goes out at once, after the 2 s wait fix (verified only
  with a no-prompt probe: the note came after 102 ms).
- Organisation agents on the corp PC (expected to write the same events); Windows; CLI versions other than 1.0.117.
- Live check of A1 and A2.

### Live check done (Copilot CLI 1.0.117, Linux, 2026-11-27)

- `limited` child (`tools: ["read"]`): note in the prompt, card, Send → the parent holds `PONG-LIMITED`, comms log
  `{kind:"report", fallback:true}` (own test broker).
- `relayok` child (`tools: ["read","relay/*"]`): no note, no card, no switch; it reported with `relay-report_result`.
- Older broker without the route: the card stays with the "too old" line, nothing sent.
- 8 premium requests. Test sessions live in `~/.copilot/session-state` (folder `probe-repo`):
  `e7d8b799…`, `550c17e7…`, `b150d5e1…`, `a5d932e9…`, `8dd60813…`, `0861804c…`, `284d5b1d…` and the run-3 sessions
  listed in the task-7 report.

### Left in the owner's broker on 127.0.0.1:7777 by live runs 1–2 (to clean up)

- Registered test peers `cli:e7d8b799…` (`amber-wolf-7c5f11`), `cli:550c17e7…` (`kid-limited-99bf9e`),
  `cli:b150d5e1…` (`amber-bison-fd9e46`), `cli:a5d932e9…` (`kid-limited-fbcd15`), `cli:8dd60813…` (`kid-relayok-…`),
  `cli:0861804c…`, `cli:284d5b1d…`.
- Delegation links with tasks `e7d8b799 → 550c17e7`, `b150d5e1 → a5d932e9`, `b150d5e1 → 8dd60813`; their task and
  notice entries; a held `PONG-RELAYOK` report to `cli:b150d5e1…` that would be delivered again if that session is
  opened; two unreported limited children.
- None of the owner's own sessions received anything.
