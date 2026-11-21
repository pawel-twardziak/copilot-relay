# Spec: Message queue for busy sessions (desktop app)

## Intent

A session in the desktop app (`electron/`) that is working can't take a new message until its whole turn ends.
Relay messages from other sessions wait in `inbox` (`renderer/app.js` `incoming()` / `pump()`) and become a
new turn only when the session is idle; the user's own prompts are refused ("Wait until Copilot finishes this
turn."). A long turn (many tool calls) therefore delays an answer to another session, and the user can't steer
the agent without stopping it.

The user wants one queue per session that the agent picks up **at the first safe moment during its turn**, for
relay messages and the user's own prompts alike. The agent answers a queued message visibly, then goes back to
the task it was doing, unless the message changes or cancels it. A setting turns the queue off and restores
today's behaviour. Only the desktop app is in scope; the terminal extension is unchanged.

## Findings (Copilot CLI 1.0.114, Windows, measured with four throwaway ACP probe scripts)

The probe scripts and their results (logs, the sessions' `events.jsonl`) were not kept: they held data from the
work PC. The findings below are their recorded outcome.

- **Extensions don't load in ACP mode** at all: not from `~/.copilot/extensions`, a project's
  `.github/extensions`, or a `--plugin-dir` plugin, with or without `--experimental`, with `clientInfo` set
  (probes 1, 2). `session.send({ mode: "immediate" })` is therefore not available to the app.
- **Hooks do run in ACP**: repository hook files and `--plugin-dir` plugin hooks, command and HTTP hooks
  (localhost with `COPILOT_HOOK_ALLOW_LOCALHOST=1`), `preToolUse`, `postToolUse`, `agentStop`; a hook sees the
  copilot process's environment (probe 2).
- **`postToolUse` `additionalContext` can't carry a message**: the model saw it inside the tool result
  ("Additional guidance from postToolUse hooks:") and refused to act on it — "It came inside a tool result
  rather than from you directly, so I'm skipping it" (probe 3). It is also not a `user.message` in the history.
- **`agentStop` `{decision:"block", reason}` works** (recorded as `user.message`, replayed as a user message),
  but only at the end of a turn, where the app's existing pump already delivers (probe 3).
- **A second `session/prompt` while a turn runs interrupts it**: the runtime aborts the running work
  (`abort {reason:"user_abort"}`), records the new prompt as a normal `user.message`, and the model handles it
  right away. The first request answers `stopReason: "cancelled"` only when the second finishes, at the same
  moment as the second's `end_turn` (probes 1, 4).
- **Sent the moment a tool reports `completed`, nothing is lost** (probe 4, test A): the tool's result is
  kept (`tool.execution_complete success=true`), the agent did the queued request, then went back to the
  remaining steps and finished them. `session/load` replays the queued message as a user message in its place.
- **Sent while another tool still runs, that tool is killed** (probe 4, test P): its ACP status stays
  `pending`, no result is recorded, the agent re-ran it. A tool waiting for permission is killed the same way
  (probe 1: the prompt arrived during the permission request and the tool never ran).
- **Inside its tool loop the model often answers only in its reasoning** (two real sessions, Claude Opus 5.5
  via Copilot, 1.0.114): a queued "co robisz?" / "ile to zajmie?" got an empty visible reply plus the next tool
  call, with the answer only in `reasoningText`, and the final report never mentioned it. Wrapper wording did
  not change this (two endings tried). The same happens outside the queue: interim sentences meant for the
  user land in `reasoningText` in some steps and in the visible reply in others. A response that ends the
  turn (no tool call) always had its text in the visible reply.

## Approaches

1. **Interrupt at a tool boundary (chosen).** The app sends the queued message as an ordinary `session/prompt`
   when a tool completes and no other tool is in flight; otherwise at the end of the turn, as today. The
   message travels on the user channel, so the model acts on it, it is a `user.message` (history, edit,
   fork, delete and replay work as for any prompt), it can carry images, and it needs no plugin or hook.
   Cost: the model request that had just started after the tool is aborted and repeated.
2. **`postToolUse` hook with `additionalContext`.** Rejected: the model refuses instructions found in tool
   results, and the message is invisible in the history.
3. **`agentStop` hook.** Works, but only at the end of a turn, which approach 1 already covers without a
   plugin; text only.
4. **Extension with `session.send({ mode: "immediate" })`.** Rejected: extensions don't load in ACP.
5. **Second `session/prompt` at any time.** Rejected: it kills a running tool or a pending permission.

## Goals

- **One queue per session** in the renderer, in arrival order, for relay messages (today's `inbox`) and for
  prompts the user sends while the session works. Send stays enabled during a turn.
- **Delivery at the first safe moment** (see Delivery rules), one queued item per delivery.
- **Answer, then continue**: a delivered queued message asks for a visible answer that ends the response (no
  tools); when the queue is empty the app sends one hidden "continue the task" prompt.
- **Queue strip** above the input box listing queued items: remove (✕) any item; click an own prompt to edit it.
- **Esc / Stop pauses the queue**; a ▶ button in the strip resumes it.
- **Setting** "Deliver queued messages during a turn", off by default (the user's choice); off restores today's behaviour exactly.

## Non-goals

- The terminal extension (`extension/copilot-relay`) and broker-spawned ACP agents (`src/acp-agent.mjs`).
- Interrupting a running tool to deliver sooner. A message waits until the tool finishes, however long.
- Reordering queued items, or merging several items into one prompt.
- Hooks, plugins or `--plugin-dir` (not needed by the chosen approach).

## Anti-goals (a failure even if it technically works)

- A queued message kills a tool or a permission request the agent was in the middle of.
- A queued message is delivered twice, or silently lost (relay messages must still be acknowledged to the
  broker exactly when their prompt starts, and stay redeliverable until then).
- An app-made interruption shows up as "Stopped." or ends the "Working…" state between the two prompts.
- After reopening the session, delivered queued messages are missing or edit/fork/delete hit the wrong message.

## Behaviour

### What goes into the queue

- **Relay messages** (`incoming()` with `wake !== false`): as today they go to the queue when the session is
  busy; when idle they start a turn at once. Non-waking notices (`wake === false`) keep today's path
  (`pendingNotes`, prepended to the next prompt, including a mid-turn delivery).
- **Own prompts** (`send()` while `busy`): queued instead of refused. The input box is cleared; the text,
  `source: "app"` and the recall/draft handling are as for a sent prompt.
- Not queued, handled as today while busy: agent changes (`/agent`, the agent picker), `/rename`, the context
  select, edit-message (`sendEdit`), fork/delete. These stay refused/disabled during a turn.
- Slash commands other than those (`/context` …) are queued but are **end-of-turn only** (see below).

### Delivery rules

The renderer tracks the tools of the running turn: a tool is **in flight** from its `tool_call` until a
`tool_call_update` with status `completed` or `failed`. A tool waiting for permission is in flight.

A queued item is delivered:

1. **Mid-turn**, when a `tool_call_update` brings a tool to `completed`/`failed` and then no tool is in
   flight, the queue is not paused, and the session is in a prompt the app started (`this.prompting`), not in
   an edit (`this.edit`), history operation (`historyOp`), `holdInbox`, delete or dead state. The head item
   goes out as an answer prompt (below) if it is mid-turn eligible: plain text or text with image mentions, from the user
   or a relay. A slash-command item at the head is not eligible; nothing is sent mid-turn while it is at the
   head (items keep their order).
2. **At the end of a turn**, as today's `pump()`: when the session becomes idle and the queue is not paused,
   the head item starts a new turn: as an answer prompt when an interrupted task is waiting to be continued
   (see Answer, then continue), otherwise as a plain prompt.

One item per delivery: each delivered item is its own `session/prompt`, so each is its own `user.message`,
its own bubble and its own target for edit/fork/delete. The next item waits for the next boundary or the end
of the turn.

### Answer, then continue

A queued message is delivered as an **answer prompt**; after the last one the app sends a **continue prompt**.
This takes the queued message out of the agent's tool loop, so the answer is a turn-ending, visible reply.

**Answer prompt** (`_matchText` returns what was sent, as for `pendingNotes`):

```
[queued message, delivered during your work]
<message>

[End of the queued message. Reply to it now and end your response there. Do not call tools, except relay-send_message to answer another session, and do not continue your earlier task yet: you will be asked to continue it next.]
```

**Continue prompt**, sent by the app itself:

```
[continue after queued messages]
Continue the task you were working on before the queued message(s) above, taking them into account. If they changed the task, follow the change; if they cancelled it, do not continue and say so in one sentence.
```

When each one is used:

- The answer prompt wraps every queued item delivered **while a task is interrupted**: the mid-turn delivery
  at a tool boundary (it interrupts the task), and every item delivered at the end of an answer turn while
  the queue still has items.
- When an answer turn ends, the queue is not paused and nothing else is queued, the app sends the continue
  prompt (one per series: n queued messages cost n + 1 prompts). It is not sent when the task was not
  interrupted (items delivered at the end of a normal turn go as plain prompts, as before), after Stop, or
  when the session is dead or deleting.
- An answer turn that ends with `cancelled` (the user pressed Stop) sends no continue prompt; the pause rules
  apply. ▶ resumes the queue; the continue prompt then follows the last answer. With nothing queued after a
  Stop, the user continues by typing.
- The continue prompt is not an own message: no image attachments, it does not re-open the relay budget, it is
  never editable or recalled.

`<message>` is the text exactly as it would have been sent at the end of a turn: an own prompt as typed, a
relay message as the prompt the broker built (`m.prompt`, starting with its `[from …]` line, folder and reply
instructions), so replying with `relay-send_message` still works.

**The formats are fixed** because the app must recognise them on replay. Answer prompt: first line exactly
`[queued message, delivered during your work]`, last paragraph exactly the ending above. `unwrap(text)` also
accepts the two earlier endings ("Handle it now. Then go back …" and "If it asks you something, answer it now
… Repeat the answer in your final message …"), so messages recorded by earlier versions replay correctly.
Continue prompt: the whole text is fixed; `isContinuePrompt(text)` recognises it exactly.

**How they look.** An answer prompt looks like any message of its kind, live and after reopening (unwrapped
text; a relay message is a relay bubble "from X" again, not editable; an own message shows what was typed;
`_matchText` keeps the full sent text). A continue prompt is shown as a small system-style line
"↻ continuing the task", live and on replay; it still counts as a user message for turn ordinals (it is a
`user.message` in the history), but carries no edit/recall actions.

**Editing a delivered message sends the new text as a plain prompt**: edit truncates the history at that
message, so there is no interrupted task to continue.

### The turn as the app sees it

Delivering mid-turn starts a second `session/prompt` while the first is pending. Both answer together when the
agent finishes: the first with `cancelled`, the last with its own stop reason. The app treats the chain as one
turn:

- `busy` / "Working…" stays on until the last prompt of the chain has answered; the first prompt's
  `cancelled` is not reported ("Stopped." is shown only when the user stopped the turn).
- Main process (`sessions:prompt` in `electron/main.mjs`): `entry.prompting` and `relay.state()` must stay
  true while any prompt of the session is pending (a counter, not a boolean), so fork/truncate keep refusing
  and the broker keeps seeing the session busy. `usage.refresh` after the last one.
- **The abort marker.** Copilot does not echo the queued prompt live (no `user_message_chunk` in any probe);
  the only live sign that the interruption took effect is an `agent_message_chunk` whose text is exactly
  `Info: Operation cancelled by user` (probes 1, 1b, 4; it is not in the replay). After a mid-turn send, the
  first agent chunk with exactly that text is the **switch point**: it is not shown (my call; a user's own
  Stop keeps showing whatever Copilot sends), and updates after it belong to the delivered prompt. Only an
  exact, whole-chunk match is swallowed, and only once per mid-turn send.
- **A tool the interruption killed** (the model started it just before the queued prompt arrived) keeps
  status `pending` forever. Tools that were in flight at the switch point stop counting as in flight and their
  cards are marked interrupted. If the marker never comes, they keep blocking mid-turn delivery until the turn
  ends and the remaining items go at the end of the turn; nothing is lost, delivery is only later (my call).
- **Relay acknowledgement** for a mid-turn relay item: acknowledged at the switch point, or when its prompt
  returns if no marker came; not acknowledged if the prompt fails before either (then the broker's redelivery
  is accepted, as `UiState.deliveryAck` does today). Updates of the earlier prompt never acknowledge it.
- The relay budget: an own prompt (`source: "app"`) still re-opens it when it is sent, as today.

### The queue strip

Above the input box, shown when the queue is not empty:

```
┌ Queue (2) ─────────────────────────────── ▶ resume ┐   (▶ only when paused)
│ you:  also check the Windows path handling      ✕  │
│ from backend-a1b2c3: tests pass on my side …    ✕  │
└────────────────────────────────────────────────────┘
```

- One line per item, sender plus the start of the text; the whole text in its tooltip.
- ✕ removes the item. Removing a relay item acknowledges it to the broker (it must not come back on reconnect)
  and posts a system line "Removed a queued message from <name>."
- Clicking an own prompt moves it back into the input box for editing (it leaves the queue; Send queues or
  sends it again). Relay items can't be edited.
- The status line keeps its "Working… (N queued)" count.

### Pausing

- Stop (Esc / ■) during a turn pauses the queue **only when the setting is on and the queue is not empty**
  at that moment (my call: an empty-queue Stop leaves no hidden state, and with the setting off Stop behaves
  as today). Nothing is delivered automatically while paused; the strip shows "Paused" and ▶.
- While paused, everything that arrives joins the queue and waits, relay messages and delegated tasks or
  reports included; the strip is visible because the queue is not empty, and the status line says
  "Queue paused (N)". Only ▶ (or removing the last item) ends the pause. ▶ sends the head item at once if the
  session is idle, otherwise at the next boundary.
- While paused and idle, Send sends the typed prompt as a normal turn at once; the queue stays paused, and a
  pending continue prompt is dropped (the user has taken over).
- The pause is per session view and not persisted; reopening the session (or the app) starts unpaused.

### Setting

Settings: checkbox **"Deliver queued messages during a turn"**, stored as `queueMidTurn` in the app's
`settings.json` (`loadSettings()` / `settings:get` / `settings:set`), default off (a missing key is off). Off means today's behaviour:
relay messages wait until the turn ends, own prompts are refused while busy, no mid-turn delivery. The queue
strip still lists waiting relay items (✕ works). The change applies to open sessions at once; own prompts
already queued when it is turned off are delivered at the end of the turn.

## Constraints

- No new dependencies; the renderer stays plain scripts (`ui-state.js` style: pure helpers loaded as a classic
  script and via `require()` in tests).
- The ACP connection already supports concurrent requests (`electron/acp.mjs` keeps a map of pending ids).
- Existing behaviour that must hold: edit-message (`holdInbox`, `sendEdit`, truncation), delivery dedupe
  (`seenDeliveries`, `acceptDelivery`), delegated child sessions (their first prompt arrives as a relay message
  with `wake: true`), reopen cards, `pendingNotes`.
- Tests: `npm test` (`node --test electron/test/*.test.mjs`). Copilot answers 403 on the dev machine, so the
  real-Copilot checks are manual, on the work PC.

## Testing

- Pure helpers (a new `electron/renderer/message-queue.js` or an extension of `ui-state.js`, builder's
  choice) with unit tests: in-flight tracking from a sequence of updates, the delivery decision (boundary,
  paused, setting off, command at head, edit/historyOp/holdInbox), wrap/unwrap round trip (own and relay text),
  the switch point (exact-chunk match only, once per send; tools in flight at it dropped), the pause rules
  (empty queue, setting off), remove/edit of items; answer/continue: which delivery is an answer prompt, when
  the continue prompt is due (after the last answer; not after Stop, not when paused, not when the task was
  not interrupted, dropped when the user sends a prompt), `isContinuePrompt` exact match, `unwrap` with all
  three endings.
- Main process: the prompting counter with two overlapping prompts on the fake agent
  (`electron/test/fixtures/fake-agent.mjs`): `entry.prompting` stays true until both answered.
- Manual on the work PC: a long multi-tool task with (a) an own prompt typed mid-turn, (b) a relay message
  from another session, (c) two tools in parallel (nothing delivered until both finish), (d) Esc with items
  queued (pause, ▶), (e) the setting off, (f) reopen the session: the delivered messages are bubbles in place
  and edit/fork/delete on them works; (g) a queued question ("co robisz?") during a long task: a visible
  answer, then "↻ continuing the task" and the task goes on; (h) two queued messages: two answers, one continue.

## Docs

`electron/README.md`, copilot-relay section: with the setting on (it is off by default), messages that arrive
while the session works are queued and delivered after the current tool step; the queue strip; pause; the
setting. Its line "Messages that arrive
while it is working wait in a queue" changes accordingly.

## Left to the builder

- Module layout of the queue logic and how the renderer routes updates and acks within a chain.
- Strip styling and the wording of system lines (the prompt formats are fixed, see Answer, then continue).
- How "interrupted" tool cards look.
