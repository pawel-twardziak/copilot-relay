# Reply fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an app session's current custom agent cannot see the relay tools, tell it so in its prompt and forward
its last message of the turn to the sender (with the owner's approval, switchable per session and in Settings).

**Architecture:** A pure detection module (`electron/relay-tools.mjs`) reads the session's `events.jsonl`. Main keeps
the per-chain state (origin, last top-level assistant text, relay calls, last stop reason), decides at the chain's end,
holds pending forwards and sends them through a new broker route `POST /api/peer/fallback`. The renderer owns the
chain (it already knows mid-turn deliveries and the continue prompt), asks main for the note before each chain's first
prompt, shows the card and the `fallback` switch.

**Tech Stack:** Node ESM (main, broker), classic-script renderer modules loaded via `require()` in tests, `node:test`,
UI checks in `scripts/ui-check` with the scripted ACP agent.

**Spec:** `docs/superpowers/specs/2026-11-27-relay-fallback-design.md`

## Global Constraints

- Sessions whose current agent is the default (`""` / no `agent` option) or has the relay tools: no note, no card, no
  switch, unchanged prompts, unchanged `isRelayTool` auto-approval.
- Relay tool names match `^relay[-_]<tool>$`; agent `tools:` entries `"*"`, `"relay/*"`, `"relay/<tool>"` (and
  `relay-`/`relay_` spellings) mean "has it". Unknown → has it.
- Never forward: after a cancelled/failed last prompt, a keeper turn, a turn whose chain already called the needed
  tool, an empty text, a `from "relay"` notice (no `fromKey`), an owner-started turn except an unreported child's.
- The forward goes to the chain's origin (sender of the first message), or the parent for an owner-started turn of an
  unreported child.
- Settings key `approveFallback` (boolean, default `true`); per-session file `fallback-approval.json` in `userData`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Task reviews: Opus 5.5 (`model: opus`, `effort: high`). Final whole-branch review: Fable 5.2 (`model: fable`,
  `effort: medium`), with an explicit regression brief (the owner asked for a thorough check that nothing existing
  breaks).

## Review Focus

1. Mid-turn delivery into a fallback chain (queue setting on): the interrupted prompt returns `cancelled`, the chain
   goes on, one forward at the end to the first sender — Task 4 test `chain with a mid-turn delivery forwards once`,
   Task 6 UI check `fallback-midturn`.
2. Agent switched between turns (limited → default → limited): the note and the card follow the current agent — Task 1
   test `switch back to default`, Task 4 test `agent changed before the continue`.
3. A replayed (reopened) session: the note does not show in the user bubble, the mid-turn bubble still unwraps —
   Task 5 test `strip keeps unwrap`, Task 6 UI check `fallback-replay`.
4. The child reported once through the fallback, then gets another relay message from the parent: the second forward
   is a message (`kind "message"`), not a second report — Task 2 test `after report it is a message`, Task 4 test.
5. Old broker without the route: the card stays, nothing sent another way — Task 2 test `404 keeps it`, Task 4 test.

---

### Task 1: Detection and note (pure)

**Files:**
- Create: `electron/relay-tools.mjs`
- Test: `electron/test/relay-tools.test.mjs`

**Interfaces:**
- Produces:
  - `RELAY_TOOLS = ["report_result", "send_message"]`
  - `agentRelayTools(agent: string | undefined, events: object[]) -> { report_result: boolean, send_message: boolean }`
  - `isRelayCall(title: string | undefined, tool: "report_result" | "send_message") -> boolean`
  - `neededTool({ origin, parentKey, reported }) -> "report_result" | "send_message" | null` where
    `origin = { kind: "relay", fromKey, fromName } | { kind: "owner" } | null`; owner → `"report_result"` only when
    `parentKey && !reported`, else `null`; relay with `fromKey === parentKey && !reported` → `"report_result"`;
    other relay → `"send_message"`; `null`/missing `fromKey` → `null`.
  - `NOTE_MARK = "[relay fallback]"`
  - `fallbackNote({ toName, kind: "report" | "message" }) -> string` — starts with `NOTE_MARK` on its own line.
  - `stripNote(text: string) -> string` — removes a trailing `"\n\n" + NOTE_MARK + …` block (and nothing else).

- [ ] **Step 1: Write the failing tests** (`node:test`, events copied from the probe output):
  - `default agent has both`: `agentRelayTools("", [])` and `agentRelayTools(undefined, [])` → both `true`.
  - `limited from subagent.selected`: events `[{type:"subagent.selected",data:{agentName:"limited",tools:["read"]}}]`,
    agent `"limited"` → both `false`.
  - `relay/* and *`: `tools:["read","relay/*"]` and `tools:["*"]` → both `true`; `tools:["relay/report_result"]` →
    `{report_result:true, send_message:false}`; `tools:["relay-send_message"]` → `send_message:true`.
  - `last selected of that agent wins`: two `subagent.selected` for `limited` (`["read"]` then `["relay/*"]`) → `true`.
  - `baseline fallback`: no `subagent.selected`, `session.tool_baseline` with `surface:"responses:capi:none:agent=limited"`
    and tools `[{name:"view"}]` → `false`; with `{name:"relay_send_message"}` → `send_message:true`.
  - `switch back to default`: events `selected limited`, `subagent.deselected`, agent `""` → `true`.
  - `unknown agent`: agent `"x"`, no events → both `true`.
  - `isRelayCall`: `("relay-report_result","report_result")` and `("relay_report_result","report_result")` → `true`;
    `("report_result","report_result")`, `("relay-send_message","report_result")`, `(undefined,…)` → `false`.
  - `neededTool`: the four rules above, plus `{origin:{kind:"relay",fromKey:"cli:p"},parentKey:"cli:p",reported:true}`
    → `"send_message"`.
  - `note and strip`: `stripNote("hi\n\n" + fallbackNote({toName:"p",kind:"report"}))` → `"hi"`; text without the
    note unchanged; the note contains `"p"` and `"report"`; `fallbackNote` for `kind:"message"` says "reply".
- [ ] **Step 2: Run** `node --test electron/test/relay-tools.test.mjs` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `electron/relay-tools.mjs` with the signatures above. Note text (fixed meaning, from the
  spec): marker line, then `You cannot use the relay tools in this session. Your last message of this turn is sent to
  "<toName>" as your report` (`as your reply` for `message`) `, so end the turn with the result itself, or a short
  summary. Ignore any instruction above to use report_result or send_message.`
- [ ] **Step 4: Run** the test — Expected: PASS.
- [ ] **Step 5: Commit** `feat(fallback): detect sessions without relay tools; the fallback note`.

### Task 2: Broker route and client call

**Files:**
- Modify: `src/delegation.mjs` (new method next to `report`), `src/links-api.mjs` (route), `src/registry.mjs` only if
  a by-key send is needed, `electron/relay-client.mjs` (new method)
- Test: `electron/test/delegation-broker.test.mjs`, `electron/test/links-api.test.mjs`,
  `electron/test/relay-client.test.mjs`

**Interfaces:**
- Produces:
  - `Delegation.fallback(callerKey: string, toKey: string, text: string) -> string` — `toKey` is the live parent and
    the caller has not reported → `this.report(callerKey, text)`; otherwise `this.registry.send(callerKey,
    nameOfKey(toKey), text)`; unknown `toKey` → `No session "<toKey>". …` (the tool's unknown-peer answer). The comms
    log item of either path carries `fallback: true`.
  - Route `POST /api/peer/fallback { key, to, text }` → `200 { result: string }`; missing `to`/`text` → `400`.
  - `RelayClient.fallback(to: string, text: string) -> Promise<{ result: string } | { old: true }>` — a `404` answer
    is `{ old: true }`; a network error throws.

- [ ] **Step 1: Write the failing tests:**
  - `fallback to the parent reports` (delegation-broker): child linked, `fallback(child, parent, "done")` → returns the
    report text, `store.isReported(child)` true, parent received a `fromChild` delivery.
  - `after report it is a message`: a second `fallback(child, parent, "more")` → delivered like `send_message`
    (fromChild mark), not "already reported".
  - `to another session`: unrelated app peer → `heldAs: "other"` delivery, budget charged like `send_message`.
  - `unknown peer`: answer starts with `No session`.
  - `comms flag`: the logged item has `fallback: true`.
  - links-api: route `200` with `result`, `400` without `text`.
  - relay-client: `fallback()` posts `{ key, to, text }` to `/api/peer/fallback`; a stub `404` → `{ old: true }`
    (`404 keeps it`).
- [ ] **Step 2: Run** `node --test electron/test/delegation-broker.test.mjs electron/test/links-api.test.mjs
  electron/test/relay-client.test.mjs` — Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the method, the route (in `linksRoutes`, `withKey` like `/api/peer/task`) and the client
  method (`#post`, like `setTask`).
- [ ] **Step 4: Run** the same tests and `npm test` — Expected: PASS, no other change.
- [ ] **Step 5: Commit** `feat(fallback): broker route that forwards a session's reply as its report or message`.

### Task 3: Switches (store, Settings, IPC)

**Files:**
- Create: `electron/fallback-store.mjs`
- Modify: `electron/main.mjs` (settings load/save near `queueMidTurn` lines ~1613/1629; fork ~1419 and delete ~1463
  bookkeeping next to `holds`; new IPC), `electron/preload.cjs`
- Test: `electron/test/fallback-store.test.mjs`

**Interfaces:**
- Produces:
  - `createFallbackStore(file) -> { get(id) -> boolean | null, set(id, on: boolean | null), copy(from, to), delete(id) }`
    (`null` = follow Settings; built on `jsonFileMap` like `createHoldStore`; `copy`/`delete` best effort).
  - Main: `fallbackApproval(sessionId) -> boolean` = stored value ?? `loadSettings().approveFallback !== false`.
  - IPC `fallback:getApproval(sessionId) -> boolean`, `fallback:setApproval(sessionId, on: boolean)`; preload
    `api.getFallbackApproval`, `api.setFallbackApproval`.
  - Settings object gains `approveFallback: boolean` (saved as `s.approveFallback !== false`).

- [ ] **Step 1: Write the failing tests:** default `null`; `set(id,false)` stored and read back; `set(id,null)` removes
  the entry; `copy` and `delete`; an unwritable file throws on `set` (as the hold store does).
- [ ] **Step 2: Run** `node --test electron/test/fallback-store.test.mjs` — FAIL.
- [ ] **Step 3: Implement** the store, the settings field, the IPC, fork/delete bookkeeping.
- [ ] **Step 4: Run** the test and `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(fallback): approval switch per session and default in Settings`.

### Task 4: Main — chain state, decision, pending forwards

**Files:**
- Create: `electron/fallback.mjs` (pure decision + pending list, no Electron imports)
- Modify: `electron/main.mjs` (`relayStart` `onMessage` payload adds `fromKey: m.fromKey`; `createChild`'s
  `relay:message` adds `fromKey: \`cli:${parentSessionId}\``; `attach`'s `entry.update`; `sessions:prompt`; new IPC),
  `electron/preload.cjs`
- Test: `electron/test/fallback.test.mjs`, `electron/test/delegation-main.test.mjs` (if it covers the payload)

**Interfaces:**
- Consumes: Task 1 (`agentRelayTools`, `isRelayCall`, `neededTool`, `fallbackNote`), Task 2 (`RelayClient.fallback`),
  Task 3 (`fallbackApproval`), `readEvents(sessionDir(id))` from `electron/history.mjs`.
- Produces:
  - `createChainState() -> { start({ seq, origin }), prompt(), update(u), stopped(reason), snapshot() }` in
    `electron/fallback.mjs`: `update` keeps the last top-level (`_meta["github.com/copilot"].agentId` absent)
    `agent_message_chunk` text since the last top-level `tool_call` (a `tool_call` clears it), ignores the abort
    marker `"Info: Operation cancelled by user"`, records top-level `tool_call` titles; `stopped` records the stop
    reason of the most recently started prompt; `snapshot() -> { seq, origin, text, titles, lastStop }`.
  - `decideForward({ snapshot, tools, parentKey, reported }) -> null | { toKey, kind: "report" | "message" }` —
    implements the spec's Turn end list with `neededTool`/`isRelayCall`.
  - `createPending() -> { add(sessionId, f) -> id, take(sessionId, id) -> f | null, list(sessionId), drop(sessionId) }`.
  - IPC: `fallback:note(sessionId, origin) -> string | null` (note when the needed tool is `false`, `toName` from
    origin or the parent's name); `sessions:prompt(sessionId, text, source, meta)` with
    `meta = { seq: string, first: boolean, origin }` (first → `chain.start`); `fallback:chainEnded(sessionId, seq)`;
    `fallback:answer(sessionId, id, send: boolean) -> { result?: string, old?: true }`; `fallback:list(sessionId)`.
  - Event to the window: `relay:fallback { sessionId, id, toName, kind, text }` (pending) and
    `relay:fallbackSent { sessionId, toName, kind, result }` (sent, switch off or after Send).

- [ ] **Step 1: Write the failing tests** (`electron/test/fallback.test.mjs`, pure):
  - chain: text after the last top-level tool call is kept; a subagent's chunk (with `agentId`) is ignored; the abort
    marker is ignored; titles recorded.
  - `decideForward` table, each condition false once: last stop `cancelled`; needed tool `true`; `relay-report_result`
    in titles; empty text; origin `null`; owner origin with `reported: true`; and the positive cases (relay from
    parent unreported → `report` to parent; relay from another key → `message` to it; owner, unreported child →
    `report` to parent).
  - `chain with a mid-turn delivery forwards once`: start(origin A) → prompt → stopped("cancelled") → prompt (mid-turn)
    → stopped("end_turn") → prompt (continue) → stopped("end_turn") → `decideForward` → one forward to A.
  - `agent changed before the continue`: tools read at the end (`false` then) decide, not at the start.
  - pending: add/take/list/drop; `take` twice → `null` the second time.
- [ ] **Step 2: Run** `node --test electron/test/fallback.test.mjs` — FAIL.
- [ ] **Step 3: Implement** `electron/fallback.mjs`, then wire main: `entry.chain = createChainState()`; `entry.update`
  feeds it (not for keeper turns, not while replaying); `sessions:prompt` takes `meta` and calls `chain.start` on
  `first`, `chain.stopped(stop)` after `session/prompt` returns (or `"failed"` on error); `fallback:chainEnded` reads
  events, decides, then either sends at once (approval off) or adds a pending forward and emits `relay:fallback`;
  `fallback:answer` sends with `entry.relay.fallback(toKey, text)`; `{ old: true }` keeps it pending and returns
  `{ old: true }`.
- [ ] **Step 4: Run** the test and `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(fallback): main tracks the chain and forwards the reply`.

### Task 5: Renderer — chain origin, note, card, switch, Settings

**Files:**
- Create: `electron/renderer/fallback.js` (classic script, sets `globalThis.Fallback`; `NOTE_MARK`, `stripNote`,
  `cardText({ toName, kind })`, `sentLine(...)`, `showSwitch({ cannotAnswer, pending })`)
- Modify: `electron/renderer/app.js` (`incoming`/queue items carry `fromKey`; `runPrompt`; `chainEnded`;
  `shownUserText`; the `Approve:` bar ~456-463; Settings fields ~4082/4217), `electron/renderer/index.html`
  (script tag, Settings → Sessions checkbox `#set-fallback`), `electron/renderer/style.css`
- Test: `electron/test/fallback-renderer.test.mjs`

**Interfaces:**
- Consumes: Task 4 IPC/events; Task 3 approval IPC.
- Produces: in `SessionView`: `this.fbSeq = { id, origin } | null`; queue items gain `fromKey`.
  - `runPrompt`: when the chain starts (not `midTurn`, not the continue prompt): origin from the item (`relay` with
    `fromKey`, or `owner` for `source "app"` non-command), `id = crypto.randomUUID()`; `await api.fallbackNote(...)`;
    a note is appended to `sent` after the pending notes and before `MessageQueue.wrap`; `api.prompt(..., meta)`.
  - `chainEnded`: when `followUp.afterTurn(...)` is not `"continue"` → `api.fallbackChainEnded(sessionId, fbSeq.id)`,
    `fbSeq = null`.
  - Card on `relay:fallback` (and for `api.fallbackList` on open), buttons Send / Don't send → `api.fallbackAnswer`;
    an `{ old: true }` answer keeps the card with the line `The relay broker is too old for this. Update it in
    Settings → Relay.`
  - `fallback` switch in the `Approve:` bar, shown per `Fallback.showSwitch`.

- [ ] **Step 1: Write the failing tests** (`require("../renderer/fallback.js")`): `strip keeps unwrap` —
  `MessageQueue.unwrap(MessageQueue.wrap("hi\n\n" + note))` then `stripNote` → `"hi"`; `NOTE_MARK` equals Task 1's
  (import both); `cardText` for report/message; `showSwitch` false/true cases.
- [ ] **Step 2: Run** `node --test electron/test/fallback-renderer.test.mjs` — FAIL.
- [ ] **Step 3: Implement** the module and the `app.js` wiring; `shownUserText` applies `Fallback.stripNote` after
  unwrap; Settings checkbox saved as `approveFallback`.
- [ ] **Step 4: Run** the test and `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(fallback): card, switch and note in the session view`.

### Task 6: Scripted agent support and UI checks

**Files:**
- Modify: `electron/test/fixtures/acp/scripted-agent.mjs` (on `session/set_config_option` with `configId "agent"`,
  append to the session's `events.jsonl` `subagent.selected { agentName, agentDisplayName, tools }` from the scenario's
  optional `agentTools: { [name]: string[] }`, or `subagent.deselected {}` for `""`)
- Create: `electron/test/fixtures/acp/fallback-scenario.mjs`
- Modify: `scripts/ui-check/checks.mjs`

**Interfaces:**
- Consumes: Tasks 1–5.

- [ ] **Step 1: Write the UI checks** (each a `{ name, scenario, broker: true, run }` like `held-kinds-e2e`):
  - `fallback-card`: parent delegates to a child with agent `limited` (`agentTools: { limited: ["read"] }`); the
    child's prompt bubble shows no note text; the child's view shows the card; Send → the parent receives the report.
  - `fallback-off`: the child's `fallback` switch off → the report reaches the parent with no card, a sent line shows.
  - `fallback-dont`: Don't send → nothing reaches the parent, a line says so.
  - `fallback-default-agent`: a child with the default agent → no switch, no card, the prompt has no note.
  - `fallback-midturn`: queue setting on, a second relay message delivered mid-turn → one card, to the first sender.
  - `fallback-replay`: reopen the child → the bubble shows no note, the mid-turn bubble shows the unwrapped text, a
    pending card shows again.
  - `fallback-settings`: Settings → Sessions checkbox off, saved, a new child sends without a card.
- [ ] **Step 2: Run** `npm --prefix electron run copy-relay` then `node scripts/ui-check/run.mjs` — Expected: the new
  checks FAIL before the fixture change, then PASS; all existing checks PASS.
- [ ] **Step 3: Commit** `test(fallback): UI checks with an agent without relay tools`.

### Task 7: Docs, live check, backlog

**Files:**
- Modify: `electron/README.md` (a "Sessions without relay tools" paragraph under Permissions/delegation), the spec's
  "Left to the builder" only if a call changed.
- Create (at finish): `docs/superpowers/backlog/2026-11-27-relay-fallback-deferred.md` (CLAUDE.md layout A–D).

- [ ] **Step 1: Write** the README paragraph (what the card means, the two switches).
- [ ] **Step 2: Live check** with the probe repo (`limited`/`relayok`, Copilot 1.0.117): a `limited` child gets the
  note and the card, the parent gets the report; `relayok` shows no card. Record the result in the backlog's D part.
- [ ] **Step 3: Run** `npm test` and the UI checks — all PASS.
- [ ] **Step 4: Commit** `docs(fallback): README, live check`.
