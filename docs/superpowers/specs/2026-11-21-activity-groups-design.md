# Activity groups: a separate UI for sub-processes in the chat

Date: 2026-11-21 · Status: revised after review, for approval · App: Electron desktop (`electron/renderer`)

## Intent

The chat log is one flat list. The agent's answer, its thinking, every tool call badge, and everything subagents do
are appended in the order ACP events arrive. Badges change height while text streams below them. Tool calls cut the
answer into pieces. Parallel background subagents mixed their answers into the chat until v0.14.1, which fixed the
routing but kept the subagents' output as ordinary agent messages, indistinguishable from the main agent's.

The user wants the main agent's answer to read as a conversation. The work behind it (tool calls, thinking,
subagents) should sit in its own place: collapsed, stable in height, and openable when needed.

## Scope

- **Phase 1 (this design): groups inline in the chat** (variant A).
- **Phase 2 (later, separate design): a side panel**, switchable in Settings (variant C). Phase 1 must not block it.
  The review's "slot" model is the intended basis: every group keeps a permanent top-level slot in the log, which
  carries the turn mark and `_md`. In panel mode only the group moves to the panel, and the slot shows a one-line
  reference.

## Goals

- The main agent's text reads as continuous messages. Tool calls and thinking between its parts collapse into one
  steady row each, not a stack of growing badges.
- Every subagent gets its own group, holding what it was asked, its text, thinking and tool calls, collapsed by
  default. The header shows what it is doing.
- Works the same for live turns and for history replayed by `session/load`.

## Non-goals

- No change to what is sent to Copilot, to the relay, or to session handling.
- The message queue changes in one point only (see "Queue").
- No new data source: only ACP `session/update`. The Copilot `events.jsonl` file is not read for this.
- No persistence of a group's open or closed state across restarts.

## Anti-goals (a failure even if it works)

- Text of the main agent hidden or harder to reach than today.
- Copy thread, edit, delete from a message, or fork changing behaviour or turn numbering.
- The chat jumping while it streams (group headers must keep a fixed height).
- A subagent's text ending up in the wrong group or in the main answer.

## What ACP sends

Measured on 2026-11-21 against real Copilot CLI 1.0.114 with `scripts/probe-subagents.mjs` and
`scripts/probe-subagents2.mjs` (branch `chore/probe-subagents`).

| Update | Main agent | Subagent |
|---|---|---|
| `agent_message_chunk`, `agent_thought_chunk` | own `messageId`, no `_meta` | own `messageId` and `_meta["github.com/copilot"].agentId` |
| `tool_call`, `tool_call_update` | no `_meta` | `_meta["github.com/copilot"].agentId` |
| `session/request_permission` | no `_meta` | **no `_meta`**; owner known only from the `tool_call` with the same `toolCallId`, which arrives just before |

**Starting a subagent: the `task` tool call (main agent).**
- ACP has no tool-name field. A `task` is recognised by its `rawInput`, which holds `agent_type` and `prompt`, plus
  `name`, `description`, `mode` (`sync` or `background`) and optionally `model`. It is present in the first
  `tool_call` (status `pending`). The call's `title` is the description.
- `background`: the call completes at once. Its result text, `content[].content.text` and `rawOutput.content`, holds
  `Agent started in background with agent_id: <uuid>.` That uuid equals the subagent's `agentId`.
- `sync`: the call stays in progress while the subagent runs. Its result is the subagent's final answer: the same
  text as the subagent's last `agent_message_chunk` message. It does not carry the id.
- `agentId` is a UUID, different for every subagent.

**Talking to a subagent later.**
- `read_agent` and `write_agent` tool calls (main agent). Their `title` is the tool name, and their `rawInput` has
  `agent_id`.
- A `read_agent` result states the subagent's status, e.g. `Agent is idle (waiting for messages). agent_id: <id>,
  agent_type: …, status: idle, …`.

**Order of events.**
- Streams of parallel subagents and the main agent alternate chunk by chunk.
- Parallel sync subagents start in an order unrelated to their `task` calls.
- No ACP update says that a subagent has finished. Its updates just stop.

**Failures.**
- A failing subagent sends one `agent_message_chunk` with no `messageId` (text `Error: Execution failed: …`), but
  with `_meta.agentId`.
- A failing sync `task` then fails, with its error in `rawOutput.message`.

**Stop and interruptions do not stop subagents.** After `session/cancel` the prompt ends (`cancelled`), but sync and
background subagents keep running, finish their tools and send their answers.

**The main agent can act outside a prompt.** After a background subagent finished, with no prompt running (after a
Stop), the main agent called `read_agent` and wrote a message on its own.

**Replay.**
- `session/load` replays the same updates with the same `_meta`, in the order they happened live.
- A background `task`'s result, with its `agent_id`, comes before the subagent's updates.
- Sometimes a subagent tool's update comes before its `tool_call`. This has been handled since v0.14.2 by
  `ToolCalls.merge`.
- Replay has no timestamps.

No subagent starting its own subagent was seen.

## Approaches considered

- **A. Collapsed groups inline (phase 1).** Keeps the order of events. The chat stays one column. A subagent's group
  sits where its `task` was called.
- **B. One activity block per turn, above the answer.** The answer becomes one continuous text, but the link
  "said X, then did Y" is lost, and sentences like "I'll check the file now" glued to the conclusion read badly.
  Rejected.
- **C. Side panel (phase 2).** The cleanest chat, at the cost of width and two places to look. It will be offered
  as a Settings option.

The user chose A first and C as a second phase. Subagent answers are collapsed in their group.

## Design

### Model: one module decides where an update goes

A new pure module `electron/renderer/activity.js` (no DOM; a classic script, `globalThis.Activity`, `require()`d in
tests, like `stream-runs.js`) holds one view's grouping state. It is fed:

- every ACP update;
- the synthetic tool updates the view makes itself (`status: "interrupted"` from `switchPoint`/`chainEnded`);
- two facts from the view: whether the prompt chain is active, and whether the view is replaying history.

For each update it returns where it goes:

- `{ to: "main" }`: the main agent's text, a top-level message in the log.
- `{ to: "work" }`: an item for the main agent's current work group (see rule 3).
- `{ to: "group", groupId }`: an item in a subagent group.
- Group changes for the view to apply: `created` (with kind, title, prompt), `status`, `merged` (rule 4).

**Rules**

1. **Owner.** `ToolCalls.agentOf(u)` (`_meta["github.com/copilot"].agentId`). Present means a subagent, absent means
   the main agent.
2. **A `task` starts a subagent group at once.** Any main-agent tool update whose `rawInput` has `agent_type` and
   `prompt` makes that tool call a `task`, whether it comes in the `tool_call` or, in replay, in an earlier update.
   A subagent group is created in its place. It is titled with the call's `title`, and its body starts with the
   prompt (collapsed). The `task` badge itself is not shown: the group stands for it.

   Every later update of that `toolCallId` goes to the group, including the view's synthetic `interrupted`. The
   update sets the group's status (rule 6). A failed `task` shows its error in the group body.

   Subagent groups are top-level, never nested in work groups.
3. **Main agent work groups.** The open work group is the log's last element, if that element is a main-agent work
   group. This is the same rule the plan uses today. A main-agent tool call (other than a `task`) or thought joins
   it, or starts a new work group when the last element is anything else. Anything else appended to the log closes
   it by being last. Items inside groups are not log elements, so subagent updates never close it.
4. **Linking an `agentId` to its group.**
   - **Background:** the `task`'s result text, matched with `/agent_id:\s*([0-9a-f-]{36})/i`, links that uuid to the
     `task`'s group. It comes before the subagent's first update, live and in replay.
   - **Sync, one unlinked sync `task`:** a new `agentId` is linked to the only sync `task` group created and not yet
     linked.
   - **Sync, several unlinked sync `task`s:** a new `agentId` cannot be told apart by order. It gets its own group,
     placed as a top-level element where its first update arrived, titled `subagent`.

     When one of those sync `task`s completes, its result text is compared with the last message of each such group.
     On an exact match, the group's items move into the `task`'s group and the standalone group is removed
     (`merged`). This is the only case where items move. Text that matches nothing leaves the group standalone.
   - **No link at all:** a standalone group, titled `subagent`.
5. **`read_agent` and `write_agent`** stay ordinary tools in the main agent's work group. A `read_agent` result with
   `status: idle` or `status: completed` for an `agent_id` sets that subagent group's status (rule 6).
6. **Group status**, shown as a mark in the header.
   - **Sync:** the `task`'s status. ● running, ✓ completed, ✗ failed, ⊘ interrupted.
     - Interrupted only means the main agent's turn was cut. The subagent goes on (see "Stop and interruptions"), so
       a later update from it sets ● again, and its end sets ✓.
   - **Background, live:**
     - ● while updates arrive or the prompt chain is active.
     - ✓ after a `read_agent` result reports it idle or completed.
     - ✗ after an error message.
     - After the chain ends with none of those: ○ (no claim that it finished).
     - Any later update from it sets ● again.
   - **Replayed groups** get their final status straight away, using the same evidence, with no ● phase. Replay passes
     the `replaying` fact.
   - There are no timers and no durations.
7. **Updates of an existing tool or message** go wherever their first update went: by `toolCallId` for tools, by
   owner + type + `messageId` for messages.

The module is tested with update sequences shaped like the probes' data:
- sync;
- background;
- two parallel sync with crossed start order;
- three parallel background;
- a failing subagent;
- a `read_agent` status;
- Stop, then late subagent updates;
- the replay order, including an update before its `tool_call`.

### View

- **Group element.** A group is one top-level element in `this.log`: a `<details class="group">` with a single-line,
  fixed-height `<summary>` and a body. The body holds the elements the view makes today: tool badges, message and
  thought blocks.
- **Where updates land.** `stream()` and `toolCall()` take a target container: the log, or a group body.
  - Items in a group body are appended directly, never through `append()`. That way they get no turn mark and do not
    trigger `toBottom()` on their own.
  - Following the output, when the log follows the bottom, still applies to the group as a whole.
- **StreamRuns per container.** Each container has its own `StreamRuns`: the log for the main agent, and one per
  group. A chunk without a `messageId` therefore never continues a block in another group, e.g. two subagents' error
  lines.
- **Header**: single line, text truncated with an ellipsis. The Fork/Delete buttons (`addActions`) sit outside the
  truncating part.
  - Work group: `▸ 3 tools · 1 thought`, the running tool's title while one runs, and a status mark.
  - Subagent group: `▸ subagent · <title> · 2 tools · <mark>`. While running, it also shows the last line of its text.
- **Open or closed.** A group starts collapsed. Opening or closing is the user's choice and lasts until the view is
  rebuilt. Streaming never opens a group.
- **Turn marks** (`markTurn`). Its reply test is extended to `.group`.
  - A work group or a `task`-anchored subagent group can take the turn's `reply` mark, as a tool badge can today.
  - A standalone subagent group never takes it, because it may arrive after the next user message.
  - Elements inside a group are never marked.
  - Fork and Delete anchor on the turn ordinal and its user text, so moving the mark onto a group changes nothing on
    disk.
- **Plan.** The plan is updated in place when, since it was shown, only groups were appended in the same turn.
  Otherwise a new plan is appended as today. A plan updated between tool calls then stays in one place.
- **Copy thread.** The export walks the log in display order, as today.
  - A group's `_md` returns its items' Markdown in order.
  - A subagent group starts with `**Subagent: <title>** (<status>)` and its prompt, in place of the `task` tool line.
  - A subagent's text is therefore no longer interleaved with the main answer.
- **Background work after the turn.** A subagent that is still running, or the main agent acting on its own after a
  subagent finished, keeps updating its group or the log. The status line then shows `N subagents running`. Clicking
  it scrolls to the first running group. The session's busy state is not changed by this.

### Permission cards

Handled since `fix/subagent-permission-cards`.
- A permission card stays top-level in the chat, never inside a collapsed group.
- A subagent's card survives the end of the main turn, because the subagent runs on and main holds the request open.
- A Stop closes every card, because main answers them all as cancelled.
- The header of the group whose tool waits shows `⏸ permission`. The owner comes from the tool call with the
  request's `toolCallId`.

### Queue

The prompt chain's tool tracker (`MessageQueue.createChain`, `createToolTracker`) counts only main-agent tools, so
subagent tool updates are ignored by it.

Subagents survive interruptions, so their tools in flight must not:
- block a mid-turn delivery;
- count as a tool boundary that sends a queued message;
- be marked ⊘ at a switch point.

This is the one change to the queue.

## Constraints

- Plain DOM in `app.js` and classic-script modules; no framework, no bundler.
- Grouping decisions live in the pure module, with node tests (`electron/test/*.test.mjs`).
- DOM wiring is verified in the running app, with a fake ACP agent (`COPILOT_PATH`) and once with real Copilot.
- The 477 existing tests, the queue, edit/delete/fork and copy thread must keep working.

## Left to the builder

- CSS for groups within the existing theme (`style.css`).
- Exact header wording (English, like the rest of the UI).
- How the "N subagents running" line fits the existing status line.
