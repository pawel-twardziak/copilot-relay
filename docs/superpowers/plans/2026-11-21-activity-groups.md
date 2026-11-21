# Activity Groups (phase 1, inline) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the main agent's tool calls and thinking as collapsed "work" groups, and every subagent as its own
collapsed group, inline in the chat log of the Electron app.

**Architecture:** A pure module `electron/renderer/activity.js` decides where each ACP update goes (main text, the
current work group, or a subagent group) and emits group changes (created, status, merged). `SessionView` in
`app.js` renders groups as top-level `<details class="group">` elements, routes `stream()` and `toolCall()` into a
target container, and keeps one `StreamRuns` per container. The queue's tool tracker ignores subagent tools.

**Tech Stack:** Electron renderer, plain DOM, classic-script modules (`globalThis.X` + `module.exports`), `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-21-activity-groups-design.md`

## Global Constraints

- No framework, no bundler. A new renderer module is a classic script loaded in `electron/renderer/index.html` before
  `app.js`, sets `globalThis.<Name>`, and exports via `module.exports` for tests, like `stream-runs.js`.
- Owner of an update: `ToolCalls.agentOf(u)` (`_meta["github.com/copilot"].agentId`); null = main agent.
- A `task` call: a main-agent tool update whose `rawInput` has both `agent_type` and `prompt`.
- Background link: `/agent_id:\s*([0-9a-f-]{36})/i` on the task's result text (`content[].content.text`, else
  `rawOutput.content`).
- `read_agent` status: the same `agent_id` regex plus `/status:\s*(idle|completed)\b/i` on its result text.
- A subagent failure: an `agent_message_chunk` with an owner, no `messageId`, text starting `Error:`.
- Group statuses: `"running"` ●, `"completed"` ✓, `"failed"` ✗, `"interrupted"` ⊘, `"quiet"` ○. No timers, no durations.
- Standalone subagent groups are titled `subagent` and never take a turn mark.
- UI copy in English.
- Full suite: `npm test` from the repo root (477 tests pass before this plan).

## Review Focus

- Main agent text arriving between two subagent chunks must stay in the log, not in a group (test in Task 1).
- Two subagents failing back to back must produce two error lines in two groups (test in Task 2 + StreamRuns per
  container in Task 4).
- A Stop during a sync subagent: the task group shows ⊘, then ● and ✓ when the subagent's late updates arrive (test
  in Task 2).
- Replay where a subagent tool's update precedes its `tool_call` must land in the subagent group, not the work group
  (test in Task 1).
- A late background update after the turn (no prompt running) must update its group and the "N subagents running"
  line, without changing the busy state (Task 5, manual check in Task 6).

---

### Task 1: Activity routing: owners, work, task groups, linking

**Files:**
- Create: `electron/renderer/activity.js`
- Create: `electron/test/activity.test.mjs`
- Modify: `electron/renderer/index.html` (script tag after `tool-calls.js`)

**Interfaces:**
- Consumes: `ToolCalls.agentOf(u)` from `electron/renderer/tool-calls.js` (in tests: `require("../renderer/tool-calls.js")`
  before `activity.js`; in the module: `globalThis.ToolCalls ?? require("./tool-calls.js")`).
- Produces:
  - `Activity.create()` → tracker with:
    - `route(u, { replaying = false } = {})` → `{ to: "main" | "work" | "group", groupId?: string, task?: true, changes: Change[] }`
    - `group(groupId)` → `{ id, title, prompt, mode: "sync" | "background" | null, anchored: boolean, agentId: string | null, taskToolCallId: string | null, status, lastText }`
  - `Change`: `{ type: "created", groupId, title, prompt, anchored, replacesTool: string | null }` · `{ type: "status", groupId, status }` · `{ type: "merged", from, into }`
  - Group ids: `"g1"`, `"g2"`, … in creation order.

Routing rules (spec "Rules" 1–4 and 7, without status, which is Task 2):
- Main `agent_message_chunk` → `main`. Main `agent_thought_chunk` and main non-task tool updates → `work`.
- First update of a task `toolCallId` → a `created` change (anchored true, title = `u.title`, prompt = `rawInput.prompt`,
  mode = `rawInput.mode`). That update and every later one for that id → `{ to: "group", groupId, task: true }`.
  If the id was earlier routed to `work` (replay order), `replacesTool` is that id.
- Owned update: the owner's group; if unknown: link to the only anchored sync group with no `agentId`, else create a
  standalone group (anchored false, title `subagent`, prompt null).
- Background task result with an `agent_id` → that group's `agentId`.
- Tool updates keep the destination of their `toolCallId`'s first update; owner-less updates for a `toolCallId` first
  seen with an owner stay in that owner's group.

- [ ] **Step 1: Write the failing tests** in `electron/test/activity.test.mjs`, with helpers
  `chunk(type, messageId, text, agentId?)`, `call(id, fields, agentId?)`, `update(id, fields, agentId?)` that build ACP updates.

```js
test("main text goes to the log, main tools and thoughts to the work group", () => {
  const a = Activity.create();
  assert.equal(a.route(chunk("agent_message_chunk", "m1", "Hi")).to, "main");
  assert.equal(a.route(chunk("agent_thought_chunk", "m2", "hm")).to, "work");
  assert.equal(a.route(call("t1", { title: "ls", rawInput: { command: "ls" } })).to, "work");
});

test("a task call creates an anchored subagent group and owns its later updates", () => {
  const a = Activity.create();
  const r = a.route(call("task1", { title: "Summarize a.txt", rawInput: { agent_type: "explore", prompt: "Read a.txt", mode: "sync" } }));
  assert.deepEqual(r.changes, [{ type: "created", groupId: "g1", title: "Summarize a.txt", prompt: "Read a.txt", anchored: true, replacesTool: null }]);
  assert.deepEqual([r.to, r.groupId, r.task], ["group", "g1", true]);
  assert.equal(a.route(update("task1", { status: "completed" })).groupId, "g1");
});

test("background: the agent_id in the task result links the subagent", () => {
  const a = Activity.create();
  a.route(call("task1", { title: "B", rawInput: { agent_type: "explore", prompt: "p", mode: "background" } }));
  a.route(update("task1", { status: "completed", content: [{ type: "content", content: { type: "text", text: "Agent started in background with agent_id: 545ca39a-d731-47a0-aac7-dc4b29d53701. You'll be notified" } }] }));
  const r = a.route(chunk("agent_message_chunk", "s1", "x", "545ca39a-d731-47a0-aac7-dc4b29d53701"));
  assert.deepEqual([r.to, r.groupId, r.changes.length], ["group", "g1", 0]);
});

test("one unlinked sync task takes the first new agentId; two make standalone groups", () => {
  const a = Activity.create();
  a.route(call("t1", { title: "One", rawInput: { agent_type: "explore", prompt: "p", mode: "sync" } }));
  assert.equal(a.route(chunk("agent_message_chunk", "s1", "x", "A")).groupId, "g1");
  const b = Activity.create();
  b.route(call("t1", { title: "One", rawInput: { agent_type: "explore", prompt: "p", mode: "sync" } }));
  b.route(call("t2", { title: "Two", rawInput: { agent_type: "explore", prompt: "q", mode: "sync" } }));
  const r = b.route(chunk("agent_message_chunk", "s1", "x", "B"));
  assert.deepEqual(r.changes, [{ type: "created", groupId: "g3", title: "subagent", prompt: null, anchored: false, replacesTool: null }]);
});

test("main text between subagent chunks stays in the log", () => {
  const a = Activity.create();
  a.route(call("t1", { title: "One", rawInput: { agent_type: "explore", prompt: "p", mode: "sync" } }));
  const to = [chunk("agent_message_chunk", "s1", "a", "A"), chunk("agent_message_chunk", "m1", "main"), chunk("agent_message_chunk", "s1", "b", "A")]
    .map((u) => a.route(u).to);
  assert.deepEqual(to, ["group", "main", "group"]);
});

test("replay: a subagent tool's update before its tool_call goes to the subagent group", () => {
  const a = Activity.create();
  a.route(chunk("agent_message_chunk", "s1", "x", "A")); // standalone g1
  assert.equal(a.route(update("v1", { status: "completed" }, "A")).groupId, "g1");
  assert.equal(a.route(call("v1", { title: "Viewing /tmp", status: "pending" }, "A")).groupId, "g1");
});

test("replay: a task recognised late replaces the badge already routed to work", () => {
  const a = Activity.create();
  assert.equal(a.route(update("t9", { status: "completed" })).to, "work");
  const r = a.route(call("t9", { title: "Late", rawInput: { agent_type: "explore", prompt: "p", mode: "sync" } }));
  assert.equal(r.changes[0].replacesTool, "t9");
  assert.deepEqual([r.to, r.task], ["group", true]);
});
```

- [ ] **Step 2: Run** `node --test electron/test/activity.test.mjs` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `electron/renderer/activity.js` per the rules above. State: `tools: Map<toolCallId, {to, groupId?}>`,
  `groups: Map<id, group>`, `byAgent: Map<agentId, groupId>`.
- [ ] **Step 4: Run** `node --test electron/test/activity.test.mjs` — Expected: PASS. Then `npm test` — all pass.
- [ ] **Step 5: Commit** `feat(desktop): Activity module routes updates to the log, work and subagent groups`

### Task 2: Activity status, read_agent, failures, settle, merge of parallel sync

**Files:**
- Modify: `electron/renderer/activity.js`
- Modify: `electron/test/activity.test.mjs`

**Interfaces:**
- Consumes: Task 1 tracker.
- Produces (added to the tracker):
  - `status` changes from `route()`.
  - `settle()` → `Change[]`: every background group still `"running"` becomes `"quiet"`. Called by the view at chain
    end and after a replay.
  - `running()` → `string[]` of group ids whose status is `"running"`.
  - `group(id).lastText`: the text of the group's latest message, built from its `agent_message_chunk`s per `messageId`.

Rules (spec rule 6 and the sync merge of rule 4):
- Created groups start `"running"`; creation emits no status change.
- Sync task status: `completed` / `failed` / `interrupted` from the task's update. A later owned update of an
  `"interrupted"` sync group sets `"running"`. A completed task's own completion sets `"completed"`.
- Background: an owned update of a group that is not `"running"` sets `"running"` (no change emitted when already running).
  `read_agent` (main tool) result with `status: idle|completed` → that group `"completed"`.
- A failure chunk (owner, no `messageId`, text starts `Error:`) → `"failed"`.
- Sync task completion with result text equal (after `trim()`) to a standalone group's `lastText` →
  `{ type: "merged", from: standaloneId, into: taskGroupId }`, and the standalone group's `agentId` now routes to the
  task group. No match: nothing merges.
- With `replaying: true`, no `"running"` changes for background groups; `settle()` gives their final status.

- [ ] **Step 1: Write the failing tests**

```js
const A = "545ca39a-d731-47a0-aac7-dc4b29d53701";
const statuses = (r) => r.changes.filter((c) => c.type === "status").map((c) => [c.groupId, c.status]);
const syncTask = (id, title = "T") => call(id, { title, rawInput: { agent_type: "explore", prompt: "p", mode: "sync" } });
const bgTask = (a, id, agentId) => {
  a.route(call(id, { title: "B", rawInput: { agent_type: "explore", prompt: "p", mode: "background" } }));
  a.route(update(id, { status: "completed", content: [{ type: "content", content: { type: "text", text: `Agent started in background with agent_id: ${agentId}.` } }] }));
};

test("sync: the task's status is the group's; interrupted, then late updates run again and complete", () => {
  const a = Activity.create();
  a.route(syncTask("t1"));
  assert.deepEqual(statuses(a.route(chunk("agent_message_chunk", "s1", "x", A))), []);
  assert.deepEqual(statuses(a.route(update("t1", { status: "interrupted" }))), [["g1", "interrupted"]]);
  assert.deepEqual(statuses(a.route(chunk("agent_message_chunk", "s1", "y", A))), [["g1", "running"]]);
  assert.deepEqual(statuses(a.route(update("t1", { status: "completed" }))), [["g1", "completed"]]);
});

test("background: quiet after settle without evidence, running on a new update, completed by read_agent", () => {
  const a = Activity.create();
  bgTask(a, "t1", A);
  assert.deepEqual(a.settle(), [{ type: "status", groupId: "g1", status: "quiet" }]);
  assert.deepEqual(statuses(a.route(chunk("agent_message_chunk", "s2", "z", A))), [["g1", "running"]]);
  a.route(call("r1", { title: "read_agent", rawInput: { agent_id: A } }));
  const r = a.route(update("r1", { status: "completed", rawOutput: { content: `Agent is idle (waiting for messages). agent_id: ${A}, agent_type: explore, status: idle` } }));
  assert.equal(r.to, "work");
  assert.deepEqual(statuses(r), [["g1", "completed"]]);
});

test("two subagents failing back to back mark their own groups failed", () => {
  const a = Activity.create();
  a.route(syncTask("t1"));
  a.route(syncTask("t2"));
  const fail = (agentId) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Error: Execution failed: 400" }, _meta: { "github.com/copilot": { agentId } } });
  const ra = a.route(fail("A"));
  const rb = a.route(fail("B"));
  assert.notEqual(ra.groupId, rb.groupId);
  assert.deepEqual(statuses(ra), [[ra.groupId, "failed"]]);
  assert.deepEqual(statuses(rb), [[rb.groupId, "failed"]]);
});

test("parallel sync: a finished task takes the standalone group whose last message equals its result", () => {
  const a = Activity.create();
  a.route(syncTask("t1", "One"));
  a.route(syncTask("t2", "Two"));
  a.route(chunk("agent_message_chunk", "sa", "alpha", "A")); // g3
  a.route(chunk("agent_message_chunk", "sb", "be", "B")); // g4
  a.route(chunk("agent_message_chunk", "sb", "ta", "B"));
  const r = a.route(update("t2", { status: "completed", rawOutput: { content: "beta\n" } }));
  assert.ok(r.changes.some((c) => c.type === "merged" && c.from === "g4" && c.into === "g2"));
  assert.deepEqual(statuses(r), [["g2", "completed"]]);
  assert.equal(a.route(chunk("agent_message_chunk", "sb2", "more", "B")).groupId, "g2");
  assert.ok(!a.route(update("t1", { status: "completed", rawOutput: { content: "no match" } })).changes.some((c) => c.type === "merged"));
});

test("replaying: background groups get no running phase; settle gives quiet", () => {
  const a = Activity.create();
  bgTask(a, "t1", A);
  a.settle(); // quiet
  assert.deepEqual(statuses(a.route(chunk("agent_message_chunk", "s3", "x", A), { replaying: true })), []);
  assert.deepEqual(a.settle(), []); // already quiet
});

test("running() lists running groups", () => {
  const a = Activity.create();
  a.route(syncTask("t1"));
  bgTask(a, "t2", A);
  assert.deepEqual(a.running(), ["g1", "g2"]);
  a.route(update("t1", { status: "completed" }));
  assert.deepEqual(a.running(), ["g2"]);
});
```

- [ ] **Step 2: Run** `node --test electron/test/activity.test.mjs` — Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the rules in `activity.js`.
- [ ] **Step 4: Run** `node --test electron/test/activity.test.mjs` then `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): subagent group status, read_agent evidence and parallel sync merge`

### Task 3: Queue tracks only the main agent's tools

**Files:**
- Modify: `electron/renderer/message-queue.js` (`createToolTracker().update`)
- Modify: `electron/test/message-queue.test.mjs`

**Interfaces:**
- Produces: `createToolTracker().update(u)` returns `false` and changes nothing for an update with
  `u._meta?.["github.com/copilot"]?.agentId` (inline check; `message-queue.js` must not depend on `tool-calls.js`).

- [ ] **Step 1: Write the failing test** `"the tracker ignores subagent tools"`: a subagent `tool_call` (pending) then a
  main `tool_call` + completed update → the completion returns `true` and `size()` is `0`; a subagent tool in flight
  never appears in `drop()`.
- [ ] **Step 2: Run** `node --test electron/test/message-queue.test.mjs` — Expected: FAIL.
- [ ] **Step 3: Implement** the early return; update the JSDoc of `createToolTracker` ("main agent's tools").
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `fix(desktop): the queue's tool boundaries ignore subagent tools`

### Task 4: View: group elements, containers, routing

**Files:**
- Modify: `electron/renderer/app.js` (`SessionView`: constructor, `stream`, `flush`, `queueRender`, `onUpdate`, `toolCall`,
  `switchPoint`, `chainEnded`, `markTurn`, `openSession` replay end)
- Modify: `electron/renderer/style.css`

**Interfaces:**
- Consumes: Tasks 1–2 (`Activity.create()`, `route`, `settle`, `running`, `group`), `StreamRuns.create()`, `ToolCalls`.
- Produces (used by Task 5):
  - `this.activity` (tracker), `this.groupEls: Map<groupId, el>`, each group element with `el._body`, `el._runs`
    (StreamRuns), `el._kind` (`"work"` | `"subagent"`), `el._info` (counts and status for the header), `el._renderHeader()`.
  - `this.applyTool(u)`: the single entry for every tool update, including the synthetic
    `{ toolCallId, status: "interrupted" }` from `switchPoint`/`chainEnded` (they call it instead of `toolCall`).
  - `this.workGroup()`: `this.log.lastElementChild` when it is a work group, else a new work group appended via `append()`.

Decisions:
- A group element: `<details class="group work|subagent">` with `<summary>` holding `.mark`, `.title` (single line,
  `text-overflow: ellipsis`), and the Fork/Delete actions after `.title`; body `<div class="group-body">`.
  Subagent body starts with `<details class="task-prompt"><summary>Prompt</summary><pre>…</pre></details>`, and a
  failed task adds a `.msg.error` line with `rawOutput.message`.
- Top-level elements go through `append()`; group-body items are appended directly and never get turn marks.
  When the log follows the bottom, call `toBottom()` after a group-body append.
- `stream(type, text, messageId, container = null)`: `container` null = the log with the view's own `StreamRuns`;
  else the group's `el._runs` and `el._body`. `flush()` finishes touched runs of every container (one `touched` set
  across containers is fine).
- `route.task === true`: merge into the group's task data with `ToolCalls.merge`, re-render the prompt/error, set status
  via the change list; no tool badge.
- Changes: `created` → group element (anchored: appended now at the log end; `replacesTool` removes that badge from
  its work group); `status` → header; `merged` → move `from`'s body children into `into`'s body after its prompt,
  remove `from`, update `this.groupEls`.
- `markTurn`: the reply test also accepts `.group`, except a group with `_anchored === false`.
- Replay end (`openSession`, after `api.openSession` resolves) and `chainEnded`: apply `this.activity.settle()`.
- Route calls pass `{ replaying: this.resuming }`.

- [ ] **Step 1: Implement** the view changes above.
- [ ] **Step 2: Run** `npm test` — Expected: PASS (no renderer DOM tests; the pure modules stay green).
- [ ] **Step 3: Verify in the app** with a fake ACP agent (`COPILOT_PATH=<script>`, `XDG_CONFIG_HOME` and `COPILOT_HOME`
  in a scratch folder, `COPILOT_RELAY_PORT=1`) that sends: a main chunk, a thought, two main tools, a sync task, three
  owned chunks interleaved with a main chunk, an owned tool, the task completion, a main chunk. Expected in the DOM
  (`[...log.children].map(e => e.className)`): `msg user`, `msg agent`, `group work`, `group subagent`, `msg agent`, …;
  the subagent text only inside `group subagent`; all groups closed. Take a screenshot and look at it.
- [ ] **Step 4: Commit** `feat(desktop): tool calls, thinking and subagents in collapsed groups`

### Task 5: Header, plan, copy thread, permission mark, running line

**Files:**
- Modify: `electron/renderer/activity.js` (pure header text), `electron/test/activity.test.mjs`
- Modify: `electron/renderer/app.js` (`plan`, `permission`, group `_md`, status line), `electron/renderer/style.css`
- Modify: `electron/README.md` (the chat bullet at line 12)

**Interfaces:**
- Produces: `Activity.headerText({ kind, title, tools, thoughts, runningTitle, lastLine, waiting })` → string, and
  `Activity.MARKS = { running: "●", completed: "✓", failed: "✗", interrupted: "⊘", quiet: "○" }`.

Decisions:
- Work header: `3 tools · 1 thought`, then ` · <runningTitle>` while a tool runs. Counts: `1 tool`/`N tools`,
  `1 thought`/`N thoughts`, zero parts omitted.
- Subagent header: `subagent · <title> · N tools`, then ` · <lastLine>` while running, ` · ⏸ permission` while
  `waiting` (overrides lastLine).
- `permission()`: when the card's tool lives in a group, set that group's `_info.waiting = true` until the card closes.
- `plan()`: update in place when every element after `this.planEl` is a `.group` and no user/relay message came after it.
- Group `_md`: work = its items' `_md` joined by blank lines; subagent = `**Subagent: <title>** (<status>)`, then
  `> <prompt>` (each line quoted), then its items' `_md`.
- Status line: a `<span class="bg-running">` after `this.statusEl` with `N subagent(s) running` when
  `this.activity.running()` is non-empty; click scrolls to the first running group (`scrollIntoView({ block: "nearest" })`).
  Refreshed on every status change; never touches `setBusy`.
- README: the chat bullet mentions that tool calls and thinking collapse into groups, and each subagent has its own
  collapsed group.

- [ ] **Step 1: Write the failing tests** for `headerText`: work `{tools:3,thoughts:1}` → `"3 tools · 1 thought"`;
  with `runningTitle:"grep"` → `"3 tools · 1 thought · grep"`; subagent `{title:"Summarize a.txt", tools:2, lastLine:"writing"}`
  → `"subagent · Summarize a.txt · 2 tools · writing"`; `waiting:true` → ends with `" · ⏸ permission"`; `tools:1` → `"1 tool"`.
- [ ] **Step 2: Run** `node --test electron/test/activity.test.mjs` — Expected: FAIL.
- [ ] **Step 3: Implement** `headerText`, `MARKS`, and the view decisions above.
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): group headers, plan in place, copy thread and running subagents line`

### Task 6: End-to-end check with real Copilot

**Files:** none (verification only; fix in the owning task's files if something fails, with its own commit).

- [ ] **Step 1:** Run the app against real Copilot (scratch `XDG_CONFIG_HOME`, real `COPILOT_HOME`, `COPILOT_RELAY_PORT=1`)
  in a scratch folder with `a.txt`, `b.txt`, `notes.txt`, and send the probe prompts: three background subagents
  (`model "auto"`), two parallel sync subagents, a sync subagent with Stop after 15 s.
  Expected: each subagent's text only in its own group; work groups single-row; ⊘ then ✓ for the stopped sync subagent;
  "N subagents running" appears and disappears; copy thread lists `**Subagent: …**` sections.
- [ ] **Step 2:** Close and reopen the session (replay). Expected: the same groups, final statuses, no ● left on
  background groups without evidence (○ instead).
- [ ] **Step 3:** Delete the test sessions from `~/.copilot/session-state` (match by the scratch folder in `workspace.yaml`).
- [ ] **Step 4: Commit** any fixes; report results with screenshots.
