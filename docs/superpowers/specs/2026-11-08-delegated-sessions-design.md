# Spec: Delegated sessions (a session creates another session)

## Objective

In the desktop app (`electron/`), a Copilot session can ask for a new session dedicated to one topic, optionally
with a specific custom agent and model. After the user approves it, the new session (the *child*) appears in the
sidebar and starts on its task while the creating session (the *parent*) keeps working. The child reports its
result back to the parent.

Why: subagents are invisible and disposable. A delegated session is an ordinary session: the user can open it,
read what it did, and keep talking to it. The expected use is mostly analysis, with occasional code changes.

## Goals

- A parent can request a child with a name, a task, and optionally an agent and a model.
- Every creation needs a click from the user.
- The child is a normal, visible, resumable session in the same working directory as the parent.
- The child can return its result to the parent reliably, even if the relay budget is spent or the parent is closed.
- A model can never widen its own permissions, approve its own requests, or start an unbounded chain of sessions.

## Non-goals (first version)

- Creating sessions from terminal Copilot sessions (the extension) or from broker-spawned sessions and the web GUI.
- Worktree or any other file isolation.
- Sharing the parent's conversation history with the child.
- Children creating children.
- An "always allow" setting for creation.
- Automatically reopening a closed child when the parent messages it.
- Aggregated cost figures across a parent and its children.

## Anti-goals

The feature has failed, even if it technically works, if:

- a session starts, or gains tool permissions, without a human action in the app window;
- a child's result is silently lost;
- a child hangs waiting for an approval that nobody can see.

## Decided by the user

- A click-to-approve on every creation, at least to start with.
- The child's working directory is the parent's. The tool has no `cwd` parameter.
- Desktop app only.
- The child may be given an agent and a model.
- Quitting the app asks for confirmation while any child has not reported. Children are never resumed automatically.
- Only outcomes wake the parent (see "Notices"). Informational notices never start a billed turn on their own.

## Design calls (proposed in conversation, not contradicted; the last five were made while writing this)

- `create_session` and `report_result` are new tools on the existing relay MCP server, next to `send_message`.
- The child gets only its task, not the parent's history; the parent must put the needed context in the task.
- At most one level of children. Limits: 3 live children per parent and 5 in the app, configurable in settings.
- If `model` is omitted, the child inherits the parent's current model.
- A pair budget for parent–child messages (12 by default), outside the global budget.
- `report_result` is outside every budget and works once per child.
- A child idle for 15 minutes loses its process but stays in the sidebar and can be resumed.
- Children keep running when the parent is closed.
- **`create_session` is asynchronous.** It returns a request ID at once, and the outcome arrives later as a message.
  A blocking call would freeze the parent's turn until the user clicks and could hit a tool timeout.
- **The approval is the app's own card**, not Copilot's permission prompt. It does not depend on what Copilot sends
  for MCP tools, can show every field, and can only be answered from the window.
- If `agent` is omitted, the child uses the default Copilot agent; the parent's agent is not inherited.
- Relay notices come from a reserved sender name, `relay`, so a session cannot pose as the system.
- Reports and waking notices stay on disk until the parent's prompt actually starts (at-least-once delivery). A rare
  duplicate is acceptable; a lost result is not.

## Current code this builds on

- `electron/main.mjs`: `sessions:new` (session/new, `attach`), `relayPrepare`/`relayStart`, `sessions:setConfig`,
  and the auto-approve regex for relay tools in `attach` (line 183).
- `src/mcp.mjs`: per-request `buildServer`; desktop sessions connect with `?peer=app:<uuid>`.
- `src/registry.mjs`: peers, global budget, `#deliver`. A peer offline longer than the 30 s grace period is removed
  **with its in-memory inbox**.
- `extension/copilot-relay/relay-client.mjs`: the SSE stream (`registered`, `renamed`, `message`) used by the app.
- `server.mjs`: `GET /api/peer/stream`, `pickName`, `persist`. `src/name-store.mjs` persists name and role.
- `electron/renderer/app.js`: `newSession` (line 1264) opens and focuses a view; `incoming` handles relay messages;
  the GUI owns the prompt queue, because Copilot's ACP does not queue prompts.

Two constraints from this code:

1. The MCP servers are passed in `session/new`, before `relayStart` registers the alias. At that moment the broker
   does not know who the caller is, so **tool visibility cannot depend on the parent/child relation**. Both tools are
   listed for every `app:` alias, and the handlers refuse invalid callers with a readable message.
2. `NameStore.set` rebuilds each entry from name and role only, so a new field must be added there explicitly.

## Behaviour

### Tools

Registered only when the `?peer=` value starts with `app:`.

`create_session({ name, task, agent?, model? })`
- Refused if the caller is a child, or if the relay connection to the app is down.
- Otherwise sends a request to the parent's app connection and returns at once: "Request `<id>` sent; the user must
  approve it. The outcome arrives as a message from relay. Do not wait for it."

`report_result({ text })`
- Takes no recipient: the broker finds the parent through the caller's `parentKey`.
- Refused if the caller is not a child or has already reported. Later exchanges use `send_message`.

Both are added to the auto-approve regex in `attach`. For `create_session` that only skips Copilot's prompt; the app's
card remains the gate.

### Request flow

1. The broker emits a new SSE event (`session_request`) on the parent's stream. `RelayClient` passes it to a new callback.
2. `main` checks the limits. Over the limit: no card, and the parent gets a notice saying why.
3. `main` sends the request to the renderer, which shows a card in the parent's view: name, full task, agent, model
   (or "inherited"), working directory, with Approve and Reject. The parent is marked in the sidebar, and an OS
   notification fires if the window is unfocused.
4. Approve goes through a new IPC handler, reachable only from the window. Reject sends the parent a notice. If the
   parent closes while the card is open, the request is dropped.
5. `main` creates the child: `connect`, `relayPrepare`, `session/new`, `attach` with the requested name and the
   `parentKey`, then applies agent and model with `session/set_config_option`.
6. If the requested agent or model is not among the `configOptions`, the child is killed and the parent gets a notice
   listing the valid values. An `agent` option does not exist at all when no custom agents are available.
7. The renderer adds the child to the sidebar without switching to it.
8. After the broker's `registered` event gives the final name, the parent gets a non-waking notice with it. The child
   receives its first prompt: who created it, the task, and the instruction to finish with `report_result`. The prompt uses
   source `relay`, so it neither re-opens the budget nor attaches local files.

### Names and identity

Names are for the model; the link is by key (`cli:<sessionId>`).
- The broker may change a requested name (normalization, `-2` on collision), so the notice carries the final one.
- `relayStart` must pass the requested name, and `parentKey` on the stream URL, on the first connection.
- The child's peer record has `parentKey`, persisted with the name so it survives broker restarts and resumes.
- `list_sessions` marks "your parent" and "your child" with current names, so a stale name can be looked up.

### Permissions

A child starts with no automatic approvals beyond the relay tools. Prompts use the existing per-session flow. While a
child waits, it has a sidebar marker and fires an OS notification if the window is unfocused. Nothing is auto-answered
or auto-rejected. The parent is not told a child is waiting, since it has no means of answering.

### Budget

- `registry.send` charges messages between a linked parent and child to their pair budget, not the global one.
- A human prompt in either session refills that pair. Pair budgets may live in memory only.
- Notices and `report_result` are charged to nothing.

### Report delivery

- The broker writes every report and waking notice to disk before attempting delivery.
- Parent online: delivered as a normal relay message (`[from <child>]`), through the GUI's in-memory queue.
- Parent offline or removed from the registry: delivered when the parent's key next registers.
- An item is removed from disk only when the renderer acknowledges that its prompt has started. A successful SSE write
  does not count, because the GUI queue is lost on view close, app quit or a dead parent process. Items not yet
  acknowledged are redelivered on the parent's next registration.

### Notices

| Notice | Delivery |
|---|---|
| `report_result` | Wakes the parent |
| Request rejected | Wakes the parent |
| Over limit | Wakes the parent |
| Invalid agent or model | Wakes the parent |
| Child ended without reporting | Wakes the parent |
| Child's final name | Shown in the parent's chat, and passed to the model with its next prompt; no turn of its own |

A non-waking notice needs a second delivery mode in the renderer and the message format. It does not need to survive
restarts, because `list_sessions` gives the same information.

### Child lifecycle

- 15 minutes with no running turn and no pending permission closes the child's process using the existing close path.
- If a child's process exits or is closed without having reported, the parent gets a notice saying so.
- Quitting the app (including closing the last window, which also calls `killAll`) asks for confirmation while any
  child has not reported.
- `killAll` and crashes bypass `main`'s exit handler, so ended-without-report detection must also work from durable
  state: the broker keeps each link's `reported` flag, and when a parent registers, every unreported child that is
  not online and not re-registering produces one notice. The notice is sent once per child. The check must allow for
  children the user reopens at about the same time as the parent.
- The parent's view has a "stop all children" action.
- After a process is closed, `send_message` to the child fails with the existing "no session" text. The user can
  reopen it from the sidebar.

## Must be verified on the live Copilot CLI early in the build

- The model's config option: its ID and whether setting it right after `session/new`, before the first prompt, takes
  effect. If it doesn't, fall back to the CLI's `--model` flag, which requires an `args` option on `AcpConnection`.
- The same check for `agent`.
- Whether a child's MCP tools work when the alias is registered after `session/new` (this is how desktop sessions
  behave today, so it should hold).

## Testing

- Unit tests with `node --test`: registry (link, refusal for children, pair budget and refill, one-shot report),
  persistence of `parentKey`, disk retention until acknowledgement, redelivery, one-time ended-without-report notice,
  reserved `relay` name, limit checks.
- Manual run in the app: approve, reject, invalid model, over limit, parent closed before the report, report queued
  while the parent is busy and the view is then closed, quit confirmation, crash of the app with a running child,
  broker restart, child waiting for a permission while another session is on screen.

## Left to the builder

Card and marker styling, file layout, the on-disk format for pending reports, settings UI for limits, the task length
cap, and how `main` tracks the parent's current model.
