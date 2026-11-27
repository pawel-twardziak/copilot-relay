# Reply fallback for sessions without relay tools — design

## Intent

Some sessions run a custom agent (`.github/agents/*.agent.md`, `~/.copilot/agents`, or an organisation agent) whose
`tools:` list does not include the relay MCP server. Copilot then hides `relay-report_result` and
`relay-send_message` from the model: the session receives relay messages (they arrive as prompts) but cannot answer,
so its parent waits forever or gets "I don't have a report_result tool". The owner cannot change those agents, and a
warning would not help. The app must notice that a session cannot answer and carry its answer to the sender itself,
so the communication with the parent keeps working.

## Goals

1. Detect, before each prompt, that the session's current agent lacks the relay tool it would need to answer.
2. Tell such a session in its prompt that its last message of the turn is forwarded as its answer, so the model ends
   the turn with the report itself instead of complaining about a missing tool.
3. After a turn started by a relay message, forward the session's last message of that turn to the sender of that
   message: to the parent as its report (first time) or as a message from the child (after that); to any other session
   as a message, like `send_message`.
4. An unreported child (delegated or adopted) whose agent lacks `report_result` also gets a report forward after a turn
   the owner started in its view, until its first report. After that only relay-started turns forward.
5. The forward waits for the owner's approval in the child's view. The approval can be switched off per session (the
   `Approve:` bar) and by default for all sessions (Settings → Sessions). Switched off, the forward goes at once.

## Non-goals

- Changing agent files, warning about them, or offering to fix them.
- Forwarding turns the owner started, except goal 4.
- Sessions outside the desktop app: broker-spawned ACP sessions (`server.mjs`) and terminal sessions with the
  extension (`kind "cli"`).
- Editing the forwarded text before it goes (Send or Don't send only).
- Messages from the broker itself (`from "relay"` notices): never answered by a forward.

## Anti-goals (a failure even if it works)

- Any change for sessions whose current agent has the relay tools — the default agent always does: their prompts,
  turns, permission auto-approval and reports stay exactly as today.
- A forward of something the session already sent with the relay tool in the same turn (a double report).
- A forward to anyone but the sender of the message that started the turn (or the parent, goal 4).
- A forward after a cancelled or failed turn.

## Facts

### Verified in this repo

- Relay messages reach an app session as `relay:message` (main → renderer; `onMessage` in `electron/main.mjs` drops the
  broker's `fromKey` today), are queued/sent by the renderer and run as `sessions:prompt(sessionId, text, source)` with
  `source = "relay"`. Main receives no sender. The child's first prompt is built in main (`childPrompt`, `from:
  parentName` only).
- Mid-turn delivery (`queueMidTurn`): a queued message is sent as a second prompt (`deliverMidTurn`, `runPrompt` with
  `midTurn`); the interrupted prompt returns `cancelled`, the queued one `end_turn`, then the renderer sends the
  continue prompt (`sendContinue`, also `source "relay"`). Mid-turn prompts are wrapped by the renderer; replay
  needs the exact wrapper ending (`MessageQueue.unwrap`).
- Every relay prompt already carries the broker's note (`relayPrompt`, "(Relay note: …)", plus `familyBlock`) naming
  `relay_send_message`; the wrapper's `END` names `relay-send_message`.
- The adopted-child notice (`linkedChild`, `src/delegation.mjs`) comes with `wake: false`: it starts no turn, the
  renderer puts it in `pendingNotes` in front of the next prompt, usually one the owner types (`source "app"`).
- `isRelayTool` (`electron/delegation.mjs`) matches `^relay-…` on the tool-call title (the permission request carries
  only the bare name; main maps it through `entry.toolTitles`). It drives auto-approval.
- Reports go through `Delegation.report(callerKey, text)` (stored, redelivered until acknowledged, not charged to the
  message budget); messages through `Registry.send` / the delegation service for app recipients. The app talks to the
  broker over `/api/peer/*` with a per-session `RelayClient`. The app can run against a separately installed broker
  (`relayConfig().brokerScript`).
- Per-session approval switches exist for incoming held messages (`electron/held-replies.mjs`, the `Approve:` bar in
  `electron/renderer/app.js`); Settings has a Sessions card (`docs/superpowers/specs/2026-11-26-settings-page-design.md`).
- The agent is a session config option (`id "agent"`, `currentValue` `""` = default Copilot agent), changeable between
  turns (the picker in the composer, `/agent`); changes arrive as `config_option_update`.

### Verified on the live Copilot CLI (1.0.117-5, ACP, 2026-11-27)

Probe: scratch repo with `limited.agent.md` (`tools: ["read"]`) and `relayok.agent.md` (`tools: ["read", "relay/*"]`),
a fake `relay` MCP server with the broker's tool names.

- `session/set_config_option agent=<name>` writes `subagent.selected {agentName, agentDisplayName, tools}` before any
  prompt, but not at once: about 500 ms after the call answers (measured on CLI 1.0.117). So `fallback:note` waits for
  it, re-reading the history every 100 ms for up to 2 s, but only when the app itself set this agent less than 2 s
  ago (a delegated child's first prompt); otherwise it reads once. `tools` is the agent's `tools:` list as written
  (`["read"]`, `["read","relay/*"]`).
  Switching back to the default writes `subagent.deselected {}`.
- The next turn writes `session.tool_baseline` with `surface: "responses:capi:none:agent=<name>"` (empty name for the
  default) and the model's actual tools. A turn with no change since the last baseline writes none.
- `limited`: 3 tools (`view`, `skill`, `sql`), no relay tools; the model answered `NO_REPORT_TOOL`. `relayok` and the
  default: `relay-list_sessions`, `relay-report_result`, `relay-send_message`, and the model called
  `relay-report_result`.
- `session/load` keeps `currentValue` (`limited`); no new `subagent.selected` is written; the first turn after the load
  writes a new baseline (`agent=limited`, no relay tools).
- A new session with `limited` set before its first prompt (how a delegated child starts) behaves the same.
- Older logs show `relay_send_message` (underscore) in baselines of CLI 1.0.115; this CLI uses `relay-`.

## Approaches

- **A. Approval in the child's view (chosen).** A card under the child's last reply asks to send it; a new
  per-session `fallback` switch in the child's `Approve:` bar and a default in Settings → Sessions. The approval sits
  where the reply is visible and belongs to the session that cannot answer.
- **B. Approval at the recipient.** Deliver the forward as a held message and reuse the parent's `child` / `other`
  cards and switches. Less code, but no switch of its own, the decision depends on the parent's settings, and the
  forwards mix with ordinary held replies. Rejected by the owner.

Detection by behaviour (a relay-started turn ending without a relay call) was considered as a fallback and dropped:
the probe showed a reliable signal before the prompt.

## Design

### Detection (`electron/relay-tools.mjs`, pure)

`agentRelayTools(agent, events)` → `{ report_result, send_message }`, each `true` (has it) or `false`:

- `agent` is the session's live `agent` option `currentValue`; no option or `""` → both `true` (the default agent).
- Otherwise two events count: the last `subagent.selected` with `agentName === agent`, and the last
  `session.tool_baseline` that is this agent's. The option value and `agentName` are the agent's `name:` ("Poeta
  wspomnień"), but a baseline's `surface` carries the agent's file name (`agent=poeta-wspomnien`; verified on CLI
  1.0.117, 2026-11-27). So a baseline is the agent's when it comes after the agent's own `subagent.selected` with no
  other `subagent.selected`/`deselected` since (and its surface does not end in an empty `agent=`), or when its
  surface ends with `agent=<agent>` or `agent=<file-style name>` (`agentSlug`: lower case, no diacritics, other
  characters as `-`; an empty slug is never used) (v0.38.2). A sub-agent's events (`agentId` on the envelope) never
  count. The order rule trusts that every agent switch writes `subagent.selected` or `deselected` (unverified for
  `/agent` typed in the prompt and a CLI `--agent` flag). Whichever of the two comes later in the history
  decides: a stale selection does not beat a newer baseline (an agent file that gained `relay/*`, then a
  `session/load`, which writes a new baseline but no new `subagent.selected`), and a newer selection beats an older
  baseline.
  - From `subagent.selected`: a tool is `true` when its `tools` contains `"*"`, `"relay/*"`, `"relay/<tool>"`, or a
    `relay-`/`relay_` spelling of the tool name.
  - From the baseline: `true` when a tool named `relay-<tool>` or `relay_<tool>` is listed.
  - A `tools` that is not a list (an agent file without a `tools:` key) → both `true`.
- Neither found → both `true` (unknown is treated as today's behaviour). *(builder's call)*

Main reads `events.jsonl` (`electron/history.mjs`) when it needs the answer: before a prompt and at a turn's end. No
cache that could go stale after an agent change.

`isRelayCall(title, tool)` — a separate matcher for "this turn already called the tool", both spellings. `isRelayTool`
stays unchanged (auto-approval must not change).

### Turns and senders

A **chain** is what the renderer runs for one relay message: the prompt, any messages delivered into it mid-turn, and
the continue prompt that follows. It ends when its last prompt ends.

- The renderer passes main the chain's origin with each prompt: `{ fromKey, fromName, chainId, first }` for a
  relay-started chain, nothing for an owner-started one. `fromKey` comes from the broker payload (main stops dropping
  it). The child's first prompt (built in main) uses the parent's key.
- Sender `from "relay"` (broker notices) → no origin: never forwarded.
- The forward goes when the chain's last prompt ends with `end_turn`, to the chain's origin (the sender of the first
  message). Senders of messages delivered mid-turn get no forward of their own. *(builder's call)* An interrupted
  prompt inside a chain (`cancelled` because of a mid-turn delivery) does not end the chain; a chain whose last prompt
  is cancelled or fails forwards nothing.

### The tool a reply needs

- Origin is the session's parent and the session has not reported → `report_result`.
- Owner-started turn of an unreported child (goal 4) → `report_result`, to the parent.
- Otherwise → `send_message`.

The session "cannot answer" when `agentRelayTools(...)[tool]` is `false`.

### Prompt

When the session cannot answer, its prompt gets a note (wording the builder's, meaning fixed):

> You cannot use the relay tools in this session. Your last message of this turn is sent to "<S>" as your report
> (or: as your reply), so end the turn with the result itself, or a short summary.

- One mechanism for every prompt that starts a chain (relay-started, the child's first prompt, and owner-typed turns of
  an unreported child, goal 4): the renderer asks main for the note (main decides with the detection) and appends it
  to the prompt text after the pending notes and before the mid-turn wrapper is applied, so `MessageQueue.unwrap`
  still finds its exact ending. The note starts with a fixed marker line so the bubble (live and replayed) can strip
  it; fork/delete/edit matching uses what was sent, as today.
- The note says the relay-tool instructions elsewhere in the prompt (`REMINDER` in `childPrompt`, the broker's
  `relay_send_message` sentence, the wrapper's `relay-send_message`) do not apply here; those texts stay unchanged.
  *(builder's call: one mechanism instead of replacing `REMINDER`)*
- Sessions that can answer: every text unchanged (no note).

### Turn end (main)

A forward is prepared when all hold:

- the chain (or the owner-started turn, goal 4) ended with `end_turn`; not a keeper turn;
- the needed tool is `false` for the agent at the turn's end (checked again: the agent cannot change during a turn,
  but can between the prompt and a queued continue);
- no `isRelayCall(title, tool)` ran in the chain;
- the last assistant message of the turn (the text after the last tool call, as shown in the chat) is not empty.

### Approval

- Switch on (default): main keeps a pending forward per session (`{ id, toKey, toName, kind: "report" | "message",
  text }`) and sends `relay:fallback` to the window; the child's view shows a card under the last reply:
  `This session has no relay tools. Send this reply to "<S>" as its report? [Send] [Don't send]`
  ("as a message" for a non-report). Send → forward; Don't send → drop; a system line says which.
- Switch off: forward at once; a system line `Sent this reply to "<S>" (no relay tools).`
- Several pending forwards each have their own card.
- Pending forwards live in main memory per session, kept on disk (`fallback-pending.json` in the app's data folder) and
  shown again when the session's view reopens, also after a restart (like the held
  cache). A lost report leaves the existing "ended without reporting" notice path in
  place. *(builder's call)* Pending forwards are dropped by an answer, when the session's history is cut (delete from a message,
  an edit) or the session is deleted.

### Switches

- Settings → Sessions: `Approve forwarded replies of sessions without relay tools` — default on, stored in the app
  settings.
- `Approve:` bar of the session: a `fallback` switch, shown when the session's current agent cannot answer or it has a
  pending forward. Its value lives in a small per-session JSON map (`jsonFileMap`, a file of its own, not the
  held-replies file); no entry means "follow the Settings default". Fork copies it, delete removes it.

### Broker (`/api/peer/fallback`)

`POST /api/peer/fallback { key, to, text }` from the child's `RelayClient`, `to` a peer key:

- `to` is the caller's parent and the caller has not reported → `Delegation.report(key, text)` (same storage,
  redelivery and budget rules as `report_result`).
- otherwise → the path `send_message` takes from that key, addressed by key.
- Unknown or offline `to` → the same answer the tools give in that case.
- Returns the result text the tool would return; the app shows it in a system line. The communication log entry
  carries `fallback: true`.
- An older broker without the route (404): nothing is sent another way; the card stays with a line that the broker
  needs updating (Settings → Relay → Update and restart).

### Tests

- Unit: `agentRelayTools` on the probe's real event shapes (`["read"]`, `["read","relay/*"]`, `["*"]`,
  `relay/report_result` only, both spellings, deselected, load without `subagent.selected`, baseline-only, nothing);
  `isRelayCall`; the needed-tool rule; prompt notes on and off (and unchanged texts for sessions with tools); the
  turn-end qualification table (each condition false once); chain handling with a mid-turn delivery and the continue
  prompt; the per-session switch store; the broker route (report, after report, to another session, unknown peer).
- UI checks (`scripts/ui-check`): card appears, Send, Don't send, switch off sends at once, switch hidden for a session
  with tools, Settings toggle saved, a mid-turn bubble replays unchanged with the note.
- Regression: full `npm test` and UI suites green; a session with the default agent shows no switch, no card and an
  unchanged prompt.
- Live (local Copilot, the probe repo's two agents): delegate a task to a `limited` child, see the note, the card,
  the parent's report; repeat with `relayok` and see no card.

## Left to the builder

- Exact wording of the note, the card and the system lines; the switch's label and hint.
- Where in the renderer the card lives (a sibling of the held cards is expected).
- How the turn's last assistant message is taken (renderer segments or main's update stream).
- Not verified: organisation agents on the corp PC (expected to write the same events), Windows, CLI versions other
  than 1.0.117.
