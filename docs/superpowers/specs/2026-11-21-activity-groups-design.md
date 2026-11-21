# Activity groups: a separate UI for sub-processes in the chat

Date: 2026-11-21 · Status: draft for approval · App: Electron desktop (`electron/renderer`)

## Intent

The chat log is one flat list. The agent's answer, its thinking, every tool call badge, and everything subagents
do are appended in the order ACP events arrive. Badges change height while text streams below them. Tool calls cut
the answer into pieces. Parallel background subagents mixed their answers into the chat until v0.14.1, which fixed
the routing but kept the subagents' output as ordinary agent messages, indistinguishable from the main agent's.

The user wants the main agent's answer to read as a conversation. The work behind it (tool calls, thinking,
subagents) should sit in its own place: collapsed, stable in height, and openable when needed.

## Goals

- The main agent's text reads as continuous messages. Tool calls and thinking between its parts collapse into one
  steady row each, not a stack of growing badges.
- Every subagent gets its own group, holding its text, thinking and tool calls, collapsed by default. The header shows
  what it is doing.
- Two layouts, switchable in Settings and applied live:
  - **Inline** (variant A, default): groups sit in the chat where they started.
  - **Side panel** (variant C): groups move to a panel on the right, and the chat keeps one-line references to them.
- Works the same for live turns and for history replayed by `session/load`.

## Non-goals

- No change to what is sent to Copilot, to the queue, the relay, or session handling.
- No new data source: only ACP `session/update`. The Copilot `events.jsonl` file is not read for this.
- No per-group persistence of open or closed state across restarts.

## Anti-goals (a failure even if it works)

- Text of the main agent hidden or harder to reach than today.
- Copy thread, edit, delete from a message, or fork changing behaviour or turn numbering.
- The chat jumping while it streams (group headers must keep a fixed height).
- A subagent's text ending up in the wrong group or in the main answer.

## What ACP sends (spike, 2026-11-21, Copilot CLI 1.0.114)

Measured with `scripts/probe-subagents.mjs` (branch `chore/probe-subagents`) against real Copilot:

| Update | Main agent | Subagent |
|---|---|---|
| `agent_message_chunk`, `agent_thought_chunk` | own `messageId`, no `_meta` | own `messageId` and `_meta["github.com/copilot"].agentId` |
| `tool_call`, `tool_call_update` | no `_meta` | `_meta["github.com/copilot"].agentId` |

- A subagent is started by a `task` tool call. ACP has no tool-name field. A `task` is recognised by its `rawInput`,
  present already in the first `tool_call` (status `pending`): it holds `agent_type` and `prompt`, plus `name`,
  `description`, `mode` (`sync` or `background`) and optionally `model`. The tool call's `title` is the description.
- `background`: the `task` call completes at once. Its result text holds the id:
  `Agent started in background with agent_id: <id>.` That id equals the subagent's `agentId`.
- `sync`: the `task` call stays in progress while the subagent runs. Its result is the subagent's answer and does not
  carry the id.
- Other ways to talk to a subagent: `read_agent` and `write_agent` tool calls (main agent). Their `title` is the tool
  name and their `rawInput` has an `agent_id`. A `read_agent` result states the subagent's status, e.g.
  `Agent is idle (waiting for messages). agent_id: <id>, agent_type: explore, status: idle, …`.
- There is **no ACP update that says a background subagent has finished**. The main agent is told internally; ACP
  shows only that its updates stop, and a `read_agent` result if the main agent asks.
- The streams of parallel subagents and of the main agent alternate chunk by chunk.
- A subagent that fails sends one `agent_message_chunk` without a `messageId` (text `Error: Execution failed: …`)
  but with `_meta.agentId`. Its `task` call (sync) then fails.
- `session/load` replays the same updates with the same `_meta`, in the order they happened live (a background
  `task`'s result, with its `agent_id`, comes before the subagent's updates). Sometimes a tool's update comes before
  its `tool_call` (handled since v0.14.2 by `ToolCalls.merge`). Replay has no timestamps.
- No subagent starting its own subagent was seen (`explore` agents have no `task` tool).

## Approaches considered

- **A. Collapsed groups inline (chosen as default).** Keeps the order of events. The chat stays one column. A
  subagent's group sits right under the `task` that started it.
- **B. One activity block per turn, above the answer.** The answer becomes one continuous text, but the link
  "said X, then did Y" is lost, and sentences like "I'll check the file now" glued to the conclusion read badly.
  Rejected.
- **C. Side panel (chosen as the alternative in Settings).** The cleanest chat, at the cost of width and two places to
  look. Offered for users who prefer it.

The user chose A as default with C switchable in Settings, and chose subagent answers collapsed in their group.

## Design

### Model: one place decides where an update goes

A new pure module `electron/renderer/activity.js` (no DOM; loaded as a classic script, `globalThis.Activity`, and
`require()`d in tests, like `stream-runs.js`) holds the grouping state of one view. For each ACP update it answers
where it goes:

- `{ to: "main" }`: the main agent's text, which stays a top-level message in the chat.
- `{ to: "group", groupId, created? }`: an item inside a group. `created` carries what the view needs to create it:
  kind (`work` or `subagent`), the anchor tool call id, and the title.

Rules:

1. **Owner.** `_meta["github.com/copilot"].agentId` present means owner = that subagent. Absent means main agent.
2. **A `task` starts a subagent group at once.** A main-agent `tool_call` whose `rawInput` has `agent_type` and
   `prompt` closes the open work group (rule 3) and creates a subagent group in its place, titled with the call's
   `title`, before any `agentId` is known. The `task` badge itself is not shown: the group's header stands for it.
   Subagent groups are top-level siblings of work groups, never nested in them, so nothing is ever split or moved
   afterwards.
3. **Main agent work groups.** The main agent's other `tool_call`s and its `agent_thought_chunk`s that follow each
   other go into one open "work" group. The main agent's `agent_message_chunk`, a `task` (rule 2), a user or relay
   message, a permission or delegation card, a plan, or a system line close it. The next tool call or thought then
   opens a new one. Subagent updates never close it.
4. **Linking an `agentId` to its group.**
   - Background: the `task`'s result text `agent_id: <id>` links `<id>` to that `task`'s group. Live and in replay
     this result comes before the subagent's first update.
   - Sync: a new `agentId` is linked to the oldest sync `task` group that is still in progress and has no `agentId`.
   - A background link always wins. If an `agentId` was already linked by the sync rule or got a standalone group, the
     background link moves it: a standalone group's items move into the `task`'s group and the standalone one is
     removed, and a wrongly taken sync group is freed for the next new `agentId`. This is not expected to happen
     (see the replay order above); the rule only keeps the state consistent.
   - Not linkable: a standalone subagent group, titled `subagent`, at the place its first update arrived.
   - Nested subagents (a `task` with `_meta.agentId`): not expected. Kept flat: the call is a tool in its owner's
     group, and the child gets its own top-level group by these rules.
5. **`read_agent` and `write_agent`** stay in the main agent's work group. Their title names the subagent's group,
   found by the `agent_id` in `rawInput`. A `read_agent` result with `status: idle` or `status: completed` marks that
   subagent group finished (rule 6).
6. **Group status.**
   - Sync: the `task`'s status (● running, ✓ completed, ✗ failed, ⊘ interrupted).
   - Background: ● while the subagent is running. Running means its last update arrived less than 10 s ago, or the main
     turn is still going. ✓ when a `read_agent` result reports it idle or completed. ✗ when it sends an error
     message (`Error: Execution failed…`, no `messageId`). Otherwise, once the turn has ended and it has been quiet for
     10 s: `○ quiet` (no claim that it finished). A later update makes it ● again.
   - Duration (`12 s`) is shown only for live groups, from the first to the last update. Replayed groups have no
     duration.
7. **Updates of an existing tool or message** go to wherever its first update went. Tool calls are looked up by
   `toolCallId`, messages by `messageId`.

The module is tested with sequences of updates shaped like the spike's: sync, background, three in parallel, a
failing subagent, a `read_agent` status, and the replay order. Timing (rule 6) is passed in as `now`, so tests do
not wait.

### View: groups as top-level log elements

- A group is one top-level element in `this.log`: a `<details class="group">` with a fixed-height `<summary>` and a
  body. The body holds the same elements the view makes today: tool badges (`toolCall`), message and thought blocks
  (`stream`). `stream()` and `toolCall()` take a target container (the log or a group body) instead of always
  appending to the log. `StreamRuns` keeps keying blocks by type and `messageId`. A subagent's blocks live in its
  group body.
- **Header, fixed height, single line, text truncated with an ellipsis:**
  - Work group: `▸ 3 tools · 1 thought` plus the latest tool's title while one runs, and a status mark.
  - Subagent group: `▸ subagent · <title> · 2 tools · ● writing…`, then `✓ 12 s` or `✗` at the end. While it runs,
    the header shows the last line of its text.
- A group is collapsed when created. Opening or closing it is the user's choice and stays until the view is rebuilt.
  Streaming never opens it.
- **Turn marks** (`markTurn`): a work group is a top-level element, so it can take the `reply` mark of its turn as a
  tool badge does today. A subagent group can also take it when it is the first reply element of its turn (the `task`
  badge it replaces could). A standalone subagent group never takes a turn mark, because it may arrive after the next
  user message and would anchor Fork/Delete on the wrong turn. Elements inside a group are never marked. Edit, delete
  and fork keep anchoring on top-level elements.
- **Copy thread** (`_md`): the export walks the log in display order, as today. A group's `_md` returns its items'
  Markdown in order. A subagent group starts with `**Subagent: <title>** (<status>)` in place of the `task` tool line.
  The export follows the new display order, so a subagent's text is no longer interleaved with the main answer. In
  panel mode the export walks the log, and each reference exports its group's Markdown.
- **Plan:** the in-place update of the plan keeps its "last element of the log" rule. Groups count as elements.

### Side panel (variant C)

- A Settings checkbox under the queue option, "Show tool calls and subagents in a side panel", stored like
  `queueMidTurn` (`settings.json` → `activityPanel: boolean`). Default off, which means inline.
- In panel mode each view has a panel to the right of the log (resizable, default ~380 px, hidden below a window
  width of ~900 px, where the view falls back to inline). The group elements live in the panel. In the chat, each
  group leaves a one-line reference at its place (`⧉ subagent · Summarize a.txt ✓`). Clicking it scrolls the panel to
  the group and opens it.
- Switching modes moves the existing group elements between the log and the panel and swaps the references. Nothing
  is re-rendered. The `reply` turn mark sits on the reference in panel mode, so the log keeps the same top-level
  sequence.
- The panel follows new output like the log does (`ScrollFollow`).

### Errors and edge cases

- An update with an `agentId` but no `messageId` (a subagent failure) becomes a block in that subagent's group, and
  the group is marked ✗.
- A subagent that streams after the main turn ended (background) keeps updating its group. Nothing is added to the
  chat.
- `switchPoint` (a mid-turn interruption) marks dropped tools as interrupted wherever they live.
- A permission card for a subagent's tool appears in the chat (top level, as today), so it is never hidden in a
  collapsed group. The group header shows `⏸ waiting for permission`.

## Constraints

- Plain DOM in `app.js` and classic-script modules; no framework, no bundler.
- Grouping decisions live in the pure module with node tests (`electron/test/*.test.mjs`). DOM wiring is verified in
  the running app with a fake ACP agent (`COPILOT_PATH`) and once with real Copilot.
- Must not break the 475 existing tests, the queue (`message-queue.js`), edit/delete/fork, or copy thread.

## Left to the builder

- CSS for the group header and panel within the existing theme (`style.css`).
- How the panel's resize handle is done.
- Exact header wording (English, like the rest of the UI).
