# Local app parent-child sessions (part A) and GitHub Copilot CLI / ACP capabilities (part B)

State: 2026-11-23. Part A was read from the repository at `main` = `6d0ee83`, latest tag `v0.22.0` (held child
replies merged). Nothing was run. Part B was read from the web on 2026-11-23.

Citation convention. Part A cites `path` + symbol inside the repository (no URLs exist for it); paths are relative
to the repository root. "Unverified" marks anything not confirmed in code. Part B cites URLs; where a page carries
no date it is "accessed 2026-11-23". Items taken only from a search-result summary (page not opened) are marked
"(search summary, page not opened)".

Terms used by the app: "delegated session" / "sub-session" / "child" are the same thing; "broker" is the local
relay process (`server.mjs`, `src/*`); "app" is the Electron desktop app (`electron/*`).

---

## A1. How is a child session created, and what tool surface does the parent agent see?

### Takeaway
A child is created only by the parent agent calling the MCP tool `create_session(name, task, agent?, model?)`, and
every call needs one human click on **Approve** in the parent's view; the user has no own "create a child" control,
but can ask a session to link an already open session as its child (`adopt_session`), which also needs a click.

### Cited Findings
- The delegation tools are registered only for desktop-app sessions (MCP URL identity starting with `app:`):
  `create_session`, `adopt_session`, `release_session`, `report_result`, next to `list_sessions` and `send_message`
  — `src/mcp.mjs`, `buildServer` and `delegationToolsAllowed`.
- Exact schema of `create_session`: `name: string` ("Name for the new session"), `task: string` ("The task the new
  session should work on"), `agent?: string` ("Optional agent to use"), `model?: string` ("Optional model to use").
  No folder, mode, permission or context parameter — `src/mcp.mjs`, `buildServer`.
- Tool description shown to the model: "Ask the user to approve a new delegated Copilot session that works on a
  task and reports back to you. The user must approve; the outcome arrives later as a message from relay. Do not
  wait for it. Delegated sessions may delegate further." — `src/mcp.mjs`, `buildServer`.
- The MCP server is passed to Copilot as `{ type: "http", name: "relay", url: "<broker>/mcp?peer=<alias>" }` in
  `session/new` and `session/load`, so Copilot shows the tools as `relay-create_session`, `relay-report_result`
  etc. — `electron/main.mjs`, `relayPrepare`, `createSession`, `openSession`; `electron/delegation.mjs`,
  `isRelayTool`.
- Flow of a request: `Delegation.requestCreate` (`src/delegation.mjs`) sends the control event `session_request`
  on the parent's app stream → `sessionRequested` (`electron/main.mjs`) stores it in `pendingRequests`
  (`PendingRequests`, in memory) and sends `delegation:request` to the window → `SessionView.delegationCard`
  (`electron/renderer/app.js`) shows Name, Agent, Model, Folder and the full task with **Approve** / **Reject** →
  IPC `delegation:answer` → `createChild(req)` (`electron/main.mjs`).
- The tool returns at once with "Request <id> sent; the user must approve it. The outcome arrives as a message
  from relay. Do not wait for it." — `src/delegation.mjs`, `Delegation.requestCreate`.
- No model or message can answer the card: `delegation:answer` is "reachable only from the window (preload)" —
  `electron/main.mjs`, comment above `handle("delegation:answer", …)`; `electron/README.md`, "Delegated sessions"
  ("Every creation needs your click: there is no 'always allow'").
- Outcome messages to the parent: `created` is an inform that does not wake the parent and is not stored; `rejected`,
  `invalid` (bad agent or model) and `failed` are durable notices that wake it — `electron/main.mjs`, `tellParent`,
  `createChild`; `src/delegation.mjs`, `Delegation.outcome`, `#inform`, `#notice`.
- Child setup has a 30 s deadline (`CHILD_SETUP_TIMEOUT_MS`), 10 s to register with the broker
  (`REGISTER_TIMEOUT_MS`); a child that fails setup is closed and its link forgotten — `electron/main.mjs`,
  `createChild`, `discard`.
- `adopt_session(name)` / `release_session(name)`: the model is told to use them "only when the user has explicitly
  asked"; each shows a card (**Link sessions** / **Unlink sessions**) the user must approve — `src/mcp.mjs`,
  `buildServer`; `src/delegation.mjs`, `Delegation.requestLink`, `answerLink`; `electron/main.mjs`, `linkRequested`,
  `handle("link:answer", …)`.
- Adoption rules: the target must be online, a desktop-app session, without a live parent, not the caller and not
  one of the caller's ancestors; the caller's app must advertise `caps=links` — `src/delegation.mjs`,
  `#linkRefusal`, `#isAncestor`.
- The four delegation tools exist only for sessions opened in the app, not for terminal sessions (extension) or
  sessions started from the broker's web GUI — `electron/README.md`, "Delegated sessions" (last bullet); `README.md`,
  "Tools available to the agent".
- The window's IPC surface has no channel for a user-initiated child: the relevant channels are
  `delegation:answer`, `link:answer`, `reopen:answer`, `sessions:new` — `electron/preload.cjs`.

### Inferences
- An orchestrator agent can fan out by calling `create_session` several times in one turn (the tool does not
  block), but the human pays one click per child at every level of the tree.
- The parent cannot learn the child's final name from the tool result; it arrives in the `created` message
  ("Session "<base>-<6 hex>" was created…") and in `list_sessions`.

### Gaps
- Whether real Copilot reliably calls `create_session` unprompted for an orchestration prompt was not tested here
  (nothing was run).
- A link can also be written without a card by a local process calling `GET /api/peer/stream?...&parent=` directly
  (`docs/superpowers/backlog/2026-11-23-link-sessions-deferred.md`, A2); the app itself only does this in
  `createChild`.

---

## A2. Can a child have a different working directory (another repository) from its parent?

### Takeaway
Not through `create_session`: a delegated child always starts in the parent's folder, on the same branch, with no
isolation, and the tool has no folder parameter. The only existing route to a child in another repository is
manual: the user starts a session in that folder and the parent adopts it (`adopt_session`), which has no folder
restriction.

### Cited Findings
- `createChild` calls `createSession(parent.cwd, { name, parentKey }, deadline, tier)`: the child's cwd is the
  parent's cwd — `electron/main.mjs`, `createChild`.
- "No isolation. A child works in the same folder and on the same branch as its parent. There is no worktree or
  sandbox, and the tool has no folder parameter. Children that edit files can get in each other's way or in the
  parent's." — `electron/README.md`, "Delegated sessions".
- Design decisions: "The child's working directory is the parent's. The tool has no `cwd` parameter." and non-goal
  "Worktree or any other file isolation." — `docs/superpowers/specs/2026-11-08-delegated-sessions-design.md`.
- The approval card shows the folder read-only (`field("Folder", cwd)`); the user cannot change it there —
  `electron/renderer/app.js`, `SessionView.delegationCard`.
- A user-created session can be in any existing directory: the only check is `requireDir` (exists and is a
  directory) — `electron/main.mjs`, `requireDir`, `createSession`, `handle("sessions:new", …)`.
- `adopt_session` has no cwd condition; the link card shows the child's folder (`childCwd`) —
  `src/delegation.mjs`, `#linkRefusal`, `#askLink`; `electron/delegation.mjs`, `linkCardOf`.
- The tree UI already handles a child in another folder: "a child sits indented under its parent when both are in
  the same folder group, otherwise it shows 'child of …'" — `electron/README.md`, "The tree";
  `electron/renderer/app.js` (the `relation` label near `child of ${parentLabel(parent)}`).
- An adopted child "was given no task, so it owes no report": no "ended without reporting" notice, not counted at
  quit; it may still call `report_result` — `electron/README.md`, "Linking existing sessions";
  `src/delegation.mjs`, `Delegation.died`; `electron/delegation.mjs`, `unreportedChildren`.
- Every relay message carries the sender's folder as a header line `[folder "<cwd>"]` so relative paths can be
  resolved — `src/registry.mjs`, `relayPrefix`, `relayPrompt`; `electron/delegation.mjs`, `childPrompt`.
- Each session runs in its own `copilot --acp --stdio` process spawned with the session folder as cwd, "so the
  repo's `.github` agents, skills and MCP config apply as in the terminal" — `electron/acp.mjs`,
  `AcpConnection.start`; `electron/README.md` (feature list, last bullet).
- The app sends only `{ cwd, mcpServers }` in `session/new` and `{ sessionId, cwd, mcpServers }` in
  `session/load`; no `additionalDirectories` appears anywhere in the code — `electron/main.mjs`, `createSession`,
  `openSession` (grep of `electron/`, `src/`, `server.mjs` for `additionalDirectories` and `add-dir`: no hits).
- The broker's web GUI can start separate sessions with a `cwd` (`POST /api/sessions { name, role?, cwd?, model? }`,
  resolved against the configured default folder), but these are `acp` peers outside the tree and without
  delegation tools — `server.mjs`, `createAcpSession`; `README.md`, "HTTP API".

### Inferences
- Today's cross-repository tree is: user opens one session per repository (N manual starts), asks the orchestrator
  to adopt each (N cards), and the orchestrator hands out tasks with `send_message` (charged to the pair budget,
  see A3). The child then owes no report unless told to report in the message.
- A `cwd` (or "repository") argument on `create_session`, validated and shown on the approval card, is the single
  missing capability for agent-driven cross-repository delegation; `createSession(cwd, …)` already accepts any
  directory, and the child process would pick up that repository's own instructions, agents and MCP config.
- Because children of one parent share one checkout, parallel implementers in the same repository can overwrite
  each other; the app offers no worktree per child.

### Gaps
- Whether Copilot's `/add-dir` or `/cwd` slash commands work inside an app session (sent as a prompt over ACP) is
  unverified; the app does not call them.
- The pending spec `docs/superpowers/specs/2026-11-23-session-prompts-design.md` changes adopted children to owe a
  report (v0.23.0); it is not implemented (no `electron/session-prompts.mjs`, no `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`
  in code).

---

## A3. Depth, number of children, parallelism, and how the parent receives results

### Takeaway
Depth and count are unlimited and children run in parallel as separate Copilot processes; results come back as
durable, at-least-once messages, but by default every reply from a direct child waits for a human **Approve** in
the parent (one at a time, no "approve all"), and parent-child chatter is capped at 12 messages per pair between
human prompts.

### Cited Findings
- "It can create children of its own, to any depth; there is no limit on their number." — `electron/README.md`,
  "Delegated sessions"; decisions "Depth: Unlimited tree", "Limits: Removed entirely" —
  `docs/superpowers/specs/2026-11-20-subsession-tree-design.md` (the first version had one level and 3 per parent /
  5 in the app: `docs/superpowers/specs/2026-11-08-delegated-sessions-design.md`).
- One Copilot process per open session — `electron/main.mjs`, `connect`, `createSession`; `electron/README.md`
  ("Several sessions can be open at once. Each runs in its own `copilot --acp` process").
- `report_result(text)`: no recipient (the broker knows the parent), once per child; a second call answers "You
  have already reported. Use send_message for further exchanges." — `src/mcp.mjs`, `buildServer`;
  `src/delegation.mjs`, `Delegation.report`.
- A report is written to disk before any delivery attempt and redelivered until the parent's app acknowledges it
  (`POST /api/peer/ack`), "so it survives a parent that is busy or closed, a broker restart and an app restart. A
  rare duplicate is possible; a lost report is not." — `src/delegation.mjs`, `Delegation.report`, `#deliver`,
  `attached`, `ack`; `src/delegation-store.mjs`, `enqueue`, `pending`; `electron/README.md`.
- Held replies (v0.22.0): `report_result` and a child's `send_message` to its parent are marked `fromChild: true`
  by the broker and do not start a turn in the parent; they wait in a strip above the message box. **Approve**
  moves one reply to the parent's queue, **✕** discards it. — `src/delegation.mjs`, `Delegation.report`,
  `childMessage`; `src/registry.mjs`, `Registry.send`; `electron/main.mjs`, `relayStart` (`onMessage`),
  `createHeldCache`; `electron/README.md`, "Replies from sub-sessions wait for you".
- The hold is a per-chat switch, "Approve replies from sub-sessions", on by default, stored per session; off =
  replies are delivered at once — `electron/main.mjs`, `holds` (`createHoldStore`, `held-replies.json`),
  `handle("held:get" / "held:set", …)`; `electron/README.md`.
- "An 'approve all' button" is an explicit non-goal; only direct children are held, not grandchildren, and not
  messages from the parent, from non-relatives or relay notices —
  `docs/superpowers/specs/2026-11-23-held-child-replies-design.md`, "Non-goals".
- The sidebar shows `⏸ N` next to a parent with waiting replies (`GET /api/links` answers `{ links, held }`) —
  `src/delegation.mjs`, `Delegation.heldCounts`; `README.md`, "HTTP API".
- Delivery timing: by default a relay message becomes a new turn once the session is idle. With **Settings →
  Deliver queued messages during a turn** (`queueMidTurn`, off by default) messages are delivered after the
  current tool step, answered first, then the app sends one "↻ continuing the task" prompt — `electron/README.md`,
  "copilot-relay" (Queue bullet); `electron/renderer/message-queue.js`.
- Budgets: messages between a parent and its child are charged to a pair budget, default 12
  (`maxAgentMessagesPerPair`), refilled by a human prompt in either session; reports and relay notices are charged
  to nothing; messages between non-relatives use a global budget, default 12 (`maxAgentMessagesPerUserTurn`). On
  exhaustion the tool answers "Not delivered: the relay message budget is exhausted. Finish your work and report
  to the user." — `src/registry.mjs`, `Registry.chargePair`, `humanPrompt`, `send`, `BUDGET_EXHAUSTED`;
  `relay.config.json`; `README.md`, "Loop protection".
- Only prompts typed by a person refill budgets: `sessions:prompt` calls `relay.human()` for source `app` or
  `human`, not `relay`; an approved held reply is a queue item with `human: false`, sent as source `relay` —
  `electron/main.mjs`, `handle("sessions:prompt", …)`; `electron/renderer/app.js` (`source: item.human ? "human" :
  "relay"`).
- What the parent can see about its children: `list_sessions` appends a family block (each child: open working /
  open idle / closed, reported, first line of its task up to 120 characters, number of its own children; plus the
  parent), and every relay prompt to a linked session is decorated with the same block — `src/delegation.mjs`,
  `Delegation.familyBlock`, `decorate`; `src/mcp.mjs`, `formatList`.
- A child whose Copilot process dies while open and that has not reported produces one durable notice to the
  parent: "Session "<name>" ended without reporting a result. You can ask the user to reopen it." A deliberately
  closed child sends nothing — `src/delegation.mjs`, `Delegation.died`, `#endedNotice`; `electron/main.mjs`,
  `attach` (`conn.on("exit", …)`).
- There is no blocking "wait for children" tool for app sessions: `wait_for_message` and `read_inbox` are
  registered only for stateful MCP mailbox peers (`mailbox: true`), and the server instructions say "never wait
  for a reply in the same turn unless using wait_for_message" — `src/mcp.mjs`, `buildServer`, `createMcpHandler`.

### Inferences
- With the default switch, an orchestrator never continues on its own after a child reports: each report costs
  one human click; with the switch off, reports arrive as consecutive turns in arrival order (the "burst" the hold
  was built to stop).
- A fully autonomous multi-level pipeline is bounded by the pair budget (12 messages per pair per human prompt) and
  by approvals; reports themselves are free, so "one task in, one report out" per child fits the design, while
  iterative parent-child dialogue does not.
- A parent's turn ends after it delegates; it is woken by the (approved) report as a new turn, so the orchestrator
  must keep its own state in its context or in files.

### Gaps
- The real-Copilot manual check "two children report close together → two held rows, nothing runs until Approve"
  is still open (`docs/superpowers/backlog/2026-11-23-held-child-replies-deferred.md`, "Known limitations and open
  manual checks").
- Budgets are in-memory fields of `Registry` (`budget`, `pairBudgets`); that a broker restart resets them is an
  inference from the constructor, not a tested statement.

---

## A4. What the child receives, what the parent gets back, and shared state

### Takeaway
The child gets only a fixed three-line wrapper plus the task text the parent wrote (no parent history, no
files); the parent gets the child's full report text as one relay message. There is no shared state between
sessions besides messages and the common folder on disk.

### Cited Findings
- The child's first prompt is built by `childPrompt({ parentName, task, folder })`:
  `[from <parent>]`, `[folder "<parent cwd>"]`, then "You were started by the session "<parent>" to do the task
  below. <parent> cannot see this session's chat, so when you are done, send the result with the report_result
  tool, exactly once." followed by a blank line and the task — `electron/delegation.mjs`, `childPrompt`;
  sent from `electron/main.mjs`, `createChild` (as a `relay:message` with `wake: true`).
- "The child gets only its task, not the parent's history, so the parent has to put the context it needs in the
  task." — `electron/README.md`, "Delegated sessions".
- Before the first prompt the app sets model and agent (`session/set_config_option`), stores the task with the
  link (`setTask`, once) and renames the session with Copilot's `/rename` — `electron/main.mjs`, `createChild`,
  `setConfigOption`, `slashRename`; `src/delegation-store.mjs`, `setTask`.
- The parent receives the report as `relayPrompt(child.name, child.cwd, text)`: `[from <child>]`,
  `[folder "<child cwd>"]`, the full text, and a relay note telling it to answer with `send_message`; plus the
  family block — `src/registry.mjs`, `relayPrompt`; `src/delegation.mjs`, `Delegation.report`, `#deliver`.
- The report is plain text (`z.string().min(1)`), with no length limit, summary step or attachment in the tool —
  `src/mcp.mjs`, `buildServer`. "relay messages never [attach images], whoever sent them" — `electron/README.md`.
- After the report, `send_message` works between parent and child like between any sessions — `electron/README.md`,
  "Delegated sessions".
- Durable state the app and broker keep: links, tasks, report flags, undelivered reports/notices and reopen
  requests in `delegations.json` (`src/delegation-store.mjs`, `DelegationStore`); names in `names.json`
  (`README.md`, "Session names"); the app's `links-cache.json`, `held-replies.json`, `context-tiers.json` in
  Electron `userData` (`electron/main.mjs`, `linksCacheFile`, `holds`; context tier spec). None of it is exposed
  to the agents as a shared workspace.
- The changes browser keeps records per session, and "A parent session showing the changes of its delegated child
  sessions" is a non-goal — `docs/superpowers/specs/2026-11-22-changes-browser-design.md`.
- Planned, not implemented (spec only, targeted v0.23.0): a system prompt per session = default part + child part
  + the session's own part, written to a per-process directory and passed with
  `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`; the user (not the parent model) writes a child's own part on the approval
  card; reusable templates in Settings; non-goal "A prompt for the parent's request in `create_session` (the
  parent model writing the child's prompt)" — `docs/superpowers/specs/2026-11-23-session-prompts-design.md`.

### Inferences
- Shared artefacts (refined requirements, spec, plan, a progress ledger) must live in files that every session can
  reach by absolute path; the app gives no directory for them and passes no extra directory to Copilot, so a child
  in another repository would need path permission for a shared folder outside its cwd.
- Role prompts ("you are the spec writer") can today only be delivered inside `task`, or through a custom agent
  that exists in the child's folder (see A5).

### Gaps
- None for the implemented behaviour. The session-prompts feature is a design only; its plan
  (`docs/superpowers/plans/2026-11-23-session-prompts.md`) was not read in detail.

---

## A5. Model, context tier, custom agent, permission mode; how a child's permission requests surface

### Takeaway
The parent agent can choose the child's model and custom agent only. The context tier is inherited from the
parent, and mode (Agent / Plan / Autopilot), reasoning effort and approval settings can only be changed by the
user in the child's own view. A child's permission requests appear as cards in the child's view, with a `!` marker
and an OS notification; they are not routed to the parent.

### Cited Findings
- `resolveConfig(options, { agent, model, inheritedModel })` handles exactly two options: `model` and `agent`.
  An omitted model inherits the parent's current model when the child offers it; an omitted agent means the
  default Copilot agent (the parent's agent is not inherited) — `electron/delegation.mjs`, `resolveConfig`;
  `electron/main.mjs`, `createChild`.
- Invalid values create no child and the parent is told the valid ones: `Unknown model "x". Valid models: …`,
  `Unknown agent "x". Valid agents: …`, `Cannot use agent "x": there are no custom agents available.` —
  `electron/delegation.mjs`, `resolveConfig`.
- The `agent` option exists only when the session folder has custom agents (`.github/agents/*.agent.md` or
  `~/.copilot/agents`); its values are `""` (default) plus one per custom agent; verified on Copilot CLI 1.0.106-9
  on 2026-11-08 — `docs/superpowers/specs/2026-11-08-delegated-sessions-design.md`, "Verified on the live Copilot
  CLI".
- The child inherits the parent's effective context tier as an override (`sessionTier(parentSessionId)`,
  `tiers.set`); the tier is a process flag (`--context long_context` for 1M) — `electron/main.mjs`, `createChild`,
  `connect`; `docs/superpowers/specs/2026-11-20-context-tier-design.md`.
- Copilot's ACP config options seen by the app are `mode`, `model`, `reasoning_effort`, `agent`, `allow_all`
  (CLI 1.0.115) — `docs/superpowers/specs/2026-11-20-context-tier-design.md`, "Findings"; the user can "Switch mode
  (Agent / Plan / Autopilot), model, reasoning effort and approval settings per session" — `electron/README.md`.
- "A child starts with no automatic approvals beyond the relay tools, and asks like any other session… Nothing is
  answered for you." — `electron/README.md`, "Permissions".
- Permission handling: `session/request_permission` for a relay tool is answered `allow_once` automatically
  (`isRelayTool`); every other request becomes an `acp:permission` card in that session's view; when the session
  is a child the app fires the notification "A delegated session needs permission" — `electron/main.mjs`, `attach`
  (`conn.on("request:session/request_permission", …)`).
- The app's OS notifications are exactly five: "A sub-session replied", "A delegated session needs permission",
  "A session asks to start a new session", "A session wants to reopen another one", "A session asks to change a
  session link" — `electron/main.mjs` (`notifyIfUnfocused` call sites).
- The app declares no client file-system or terminal capability to Copilot (`fs.readTextFile: false`,
  `fs.writeTextFile: false`, `terminal: false`) — `electron/acp.mjs`, `AcpConnection.start`.

### Inferences
- Per-role personas are possible today only as custom agents present in the child's folder (repository
  `.github/agents` or the user's `~/.copilot/agents`); user-level agents are the only ones that follow a child
  into any repository.
- An "implementer on autopilot, reviewer in plan mode" split cannot be set by the orchestrator; a human must open
  each child and switch it. Adding `mode` (and possibly `allow_all`, `reasoning_effort`) to `create_session`
  would reuse the existing `resolveConfig` / `setConfigOption` path.
- With many children, permission prompts are spread over many views; there is no single inbox of pending
  approvals beyond the `!` markers in the session list.

### Gaps
- Whether the `agent` option lists user-level agents in every folder was verified by the spec's author only for
  the presence rule quoted above; not re-run here.
- No code path was found that lets an approval in the parent cover its children; treated as absent.

---

## A6. Routing of human questions from a child or grandchild; can a child ask its parent and wait?

### Takeaway
There is no question-routing mechanism. A child that needs the human simply asks in its own chat (the user must
notice and open that session); a child can message its parent with `send_message`, but that is asynchronous, held
for the user's approval by default, and never a blocking wait.

### Cited Findings
- The only parent-child channels are `send_message(to, text)` and `report_result(text)` — `src/mcp.mjs`,
  `buildServer`. `send_message` is described as "Asynchronous: the reply arrives later as a new message prefixed
  with [from <name>]."
- A child's `send_message` to its app parent is stored like a report, marked `fromChild`, and therefore held in
  the parent until the user approves it (default switch) — `src/registry.mjs`, `Registry.send`;
  `src/delegation.mjs`, `Delegation.childMessage`.
- A parent's message to its child is not held (only child → parent is marked) and starts a turn in the child when
  it is idle — `docs/superpowers/specs/2026-11-23-held-child-replies-design.md`, section 1 ("Parent to child…: no
  mark").
- App sessions have no `wait_for_message`; it exists only for stateful MCP mailbox peers — `src/mcp.mjs`,
  `buildServer` (`if (mailbox) …`).
- The parent "cannot see this session's chat" (stated in the child prompt and in every relay note) —
  `electron/delegation.mjs`, `childPrompt`; `src/registry.mjs`, `relayPrompt`.
- No notification exists for "a child ended its turn with a question"; the five notifications are listed in A5 —
  `electron/main.mjs`.
- The app does not handle ACP elicitation: there is no listener for it, and any agent request without a listener
  is answered with JSON-RPC error `-32601` "Method not supported" — `electron/acp.mjs`, `AcpConnection.#onMessage`
  (grep for `elicitation` in `electron/`, `src/`: no hits).
- A message to a closed parent or child raises a reopen card in the sender's view; approved → the session is
  resumed and the queued messages delivered; rejected → dropped and the sender told — `src/delegation.mjs`,
  `Delegation.messageClosed`, `answerReopen`; `electron/README.md`, "Messages to a closed relative".
- Any session can address any other online session by name (`list_sessions` lists them); messages between
  non-relatives are not held and use the global budget — `src/registry.mjs`, `Registry.send`; `src/mcp.mjs`,
  `formatOnline`.

### Inferences
- A grandchild's question reaches the root only hop by hop (grandchild → child held for approval → child decides
  to forward → root held for approval), or by the grandchild messaging the root by name, which bypasses the hold
  and the tree.
- For a refinement / brainstorming phase that depends on human answers, the practical options today are: keep that
  phase in the root session the user talks to, or have the user answer inside the child's view. A "question to the
  user" card surfaced at the root would be a new capability.
- A child that asks its parent and then ends its turn is resumed by the parent's reply as a new turn; a child that
  must not proceed without the answer has to stop and say so, since nothing blocks it.

### Gaps
- Whether Copilot CLI sends `elicitation/create` (or an `ask_user` tool rendered through ACP) to a client that
  does not advertise the capability is unknown; not observed in the repository's notes.

---

## A7. What survives a restart, and recorded limitations that affect long-running orchestration

### Takeaway
The tree, tasks, report flags, undelivered reports and reopen requests survive broker and app restarts, and each
session's history is Copilot's own and is replayed on reopen; but children are never resumed automatically,
pending creation and link requests are memory-only, a window reload stops all children, and several delivery and
security gaps are recorded in the backlog.

### Cited Findings
- Durable in the broker: `{ links, outbox, reopens }` in `$XDG_STATE_HOME/copilot-relay/delegations.json`, written
  atomically (tmp + rename); a corrupt file is moved aside and the store starts empty —
  `src/delegation-store.mjs`, `DelegationStore`.
- On every registration the broker redelivers unacknowledged items, restores the link and re-asks pending reopen
  and link requests — `src/delegation.mjs`, `Delegation.attached`.
- Session history is Copilot's (`~/.copilot/session-state/<id>/events.jsonl`); opening a session replays it through
  `session/load` — `electron/README.md` (Resume, Fork/Delete bullets); `electron/main.mjs`, `openSession`.
- "Closing a session closes its open children with it, at every depth… They all stay resumable and nothing closes
  by itself. Reopening a parent does not reopen its children." and "Children are never resumed automatically." —
  `electron/README.md`, "Closing", "Quitting".
- "Reloading the window (View → Reload, Ctrl+R) stops delegated sessions, after a confirmation… Waiting requests
  for a new session are dropped too." — `electron/README.md`; `electron/main.mjs`, `confirmedReload`;
  `electron/delegation.mjs`, `reloadWarning`.
- Quitting while a child has not reported asks for confirmation — `electron/main.mjs` (`before-quit` handler,
  `unreportedChildren`).
- Memory-only state: pending `create_session` requests (`PendingRequests`, dropped when the parent closes:
  `dropForParent`) and pending adopt/release requests (`#linkRequests`, "in memory only") — `electron/delegation.mjs`;
  `src/delegation.mjs`.
- Broker limitations: "No persistence, apart from names and delegated-session links and reports. Restarting the
  broker forgets peers… ordinary messages sent while the broker is down are lost."; "Every delivered message is a
  new agent turn and consumes premium requests."; "No authentication on the local port." — `README.md`,
  "Limitations (prototype)".
- "Update and restart broker" updates the broker without closing sessions (six steps: Check, Update, Install,
  Stop, Start, Reconnect) — `electron/README.md`, "copilot-relay"; `electron/broker-restart.mjs`.
- Platform status: "ACP support in Copilot CLI is a preview feature. Tested with Copilot CLI 1.0.106." —
  `electron/README.md`, "Notes"; "Don't use the same session in the app and in a terminal at the same time."
- Backlog, held replies (`docs/superpowers/backlog/2026-11-23-held-child-replies-deferred.md`):
  A1 a lost ack is never repeated (`RelayClient.ack` swallows errors), so after "Update and restart broker" a reply
  can come back held and the sidebar count stay too high; A2 a parent view whose process died shows no `⏸` mark
  although the broker holds replies; A3 a terminal parent's marked report is counted in `held`; A4 `Registry.send`
  answers "delivered" when the item was only stored. Open: real-Copilot check with two children, real window
  reload, Windows, packaged build.
- Backlog, sub-session tree (`docs/superpowers/backlog/2026-11-21-subsession-tree-deferred.md`): A1
  `pruneCandidates` never prunes a small tree whose sessions were deleted outside the app; A2 `forget(sender)`
  leaks `awaiting` outbox items in `delegations.json`; A3 stale reopen card replayed after a reload; A4 terminal
  peers do not see their relatives in `relay_list_sessions`; C10–C11 budget edge cases on messages to a closed
  relative.
- Backlog, link sessions (`docs/superpowers/backlog/2026-11-23-link-sessions-deferred.md`): A1 the relay chip
  never shows "offline" during a broker outage; A2 the stream route writes any link without a card; A3 a pending
  adopt request can disappear (30 s after a session leaves the registry, or at a broker restart) without the model
  being told; A5 the local HTTP API is unauthenticated, so "a process on the machine, including a model with a
  shell tool" can read a pending `requestId` and answer link or reopen cards. "Not verified": Windows and macOS,
  and the real-Copilot manual checks.
- Backlog, broker restart (`docs/superpowers/backlog/2026-11-22-broker-restart-deferred.md`): A1 a slow broker is
  taken for no broker and the run can report success over old code; A2 a broker that crashes at start leaves no
  reason; A5 `reconnectClients` reconnects sessions that are already back, "a small chance of losing a message in
  flight".
- Backlog, changes browser (`docs/superpowers/backlog/2026-11-22-changes-browser-deferred.md`): A4 a fork starts
  with an empty changes browser; A3 a worktree whose git folder is on a network location passes the path rule.

### Inferences
- A multi-day pipeline survives an app restart as data (tree, tasks, reports, histories) but not as running work:
  after a restart the user must reopen each session that should continue, and nothing re-prompts a child that was
  mid-task (it resumes only when it gets a new message or prompt).
- Durable delivery covers reports, child → parent messages, relay notices and messages awaiting a reopen;
  parent → child `send_message` to an online child and messages between non-relatives are not stored, so a broker
  outage can lose a task handed out by message (relevant for adopted cross-repository children, whose task arrives
  that way).
- The approval cards are a UI convention, not a security boundary, while the local HTTP API stays unauthenticated
  (link-sessions A5): an agent with shell access could approve link or reopen requests; `delegation:answer` itself
  is IPC-only and not reachable that way.

### Gaps
- The exact behaviour of `Registry.#deliver` for a parent → child message when the child's stream is briefly
  offline (30 s grace inbox, `OFFLINE_GRACE_MS`) versus a broker restart was read but not tested.
- Corp-PC manual checks for v0.12.0, v0.16.0 and v0.17.0 are listed as pending in the owner's notes; their results
  are not in the repository.

---

## A8. Does anything in the app already address multiple repositories?

### Takeaway
Only passively: sessions can live in any folder, the session list groups by folder, and the changes browser tracks
every repository a session edits. There is no worktree support, no multi-root session, no cross-repository task
board, and no aggregation of children's changes in the parent.

### Cited Findings
- The session list "comes from ACP `session/list` and is grouped by folder"; a new session can be started "in any
  folder" — `electron/README.md` (feature list).
- Changes browser, per session: "one group per repository"; a repository is recorded "the first [time] the agent
  edits [a file] in a repository" with a start point (its `HEAD` and the files already changed); `+` adds a
  repository through a folder dialog; files outside any repository are under **No repository** —
  `electron/README.md`, "File links and preview"; `electron/repo-track.mjs`, `createRepoTracker`;
  `electron/repo-records.mjs`.
- Git is only read: "nothing is written to a repository (not even `index.lock`)" — `electron/README.md`.
- Non-goal: "A parent session showing the changes of its delegated child sessions. Each session has its own
  records." — `docs/superpowers/specs/2026-11-22-changes-browser-design.md`.
- No worktree or sandbox for children (A2); worktrees are mentioned only as an edge case of the read-only git
  access — `docs/superpowers/backlog/2026-11-22-changes-browser-deferred.md`, A3.
- The tree marks a cross-folder child with "child of …" (A2) — `electron/README.md`, "The tree".
- No `additionalDirectories`, `--add-dir` or `/add-dir` use in the code (A2).

### Inferences
Capability summary for an orchestrator + sub-agents structure (derived from A1–A8; "new" = not in `v0.22.0`):

| Need | Today | Evidence |
|---|---|---|
| Orchestrator spawns a child with a task | Supported, one human click per child | A1 |
| Tree of any depth, any number of children | Supported | A3 |
| Children run in parallel | Supported (one process each) | A3 |
| Child in a different repository, chosen by the orchestrator | New (needs a folder argument on `create_session`) | A2 |
| Child in a different repository, set up by hand | Supported through `adopt_session` (user starts it, user approves the link); adopted child owes no report | A2 |
| Isolation of parallel children in one repository (worktrees) | New | A2, A8 |
| Durable result hand-back | Supported (`report_result`, at-least-once) | A3, A7 |
| Unattended continuation after a report | Only with the per-chat hold switched off; otherwise one click per reply | A3 |
| Orchestrator picks child model | Supported | A5 |
| Orchestrator picks child persona | Supported only as a custom agent available in the child's folder | A5 |
| Orchestrator picks mode / approvals / reasoning effort / context tier | New (tier is inherited; the rest is user-only) | A5 |
| Per-session system prompt, role templates | Designed, not implemented (v0.23.0 spec; written by the user, not the parent) | A4 |
| Shared artefact store or ledger between sessions | New (only the file system; no extra directory passed to Copilot) | A4 |
| Child asks the human through the root | New (child's own chat only) | A6 |
| Child asks parent and blocks | New (async `send_message`, held, budget 12 per pair) | A3, A6 |
| Central view of pending permissions across the tree | New (`!` markers per session only) | A5 |
| Parent sees children's diffs | New (changes browser is per session) | A8 |
| Automatic resume of the tree after restart | New (data survives, processes do not) | A7 |

### Gaps
- No design document in `docs/superpowers/specs` or `plans` proposes a folder argument, worktrees or a
  multi-repository workspace; whether the owner has considered them is not recorded.

---

## B1. What Copilot CLI supports for delegation and subagents, and what its ACP server exposes

### Takeaway
Copilot CLI has in-session subagents (built-in and custom agents in separate context windows), `/fleet` for
parallel subagents under one orchestrator, and `/delegate` to hand work to the cloud agent as a pull request; all
of these live inside one session and one filesystem. Its ACP server (public preview since 2026-01-28) exposes
sessions with a client-chosen working directory and MCP server list, streaming updates, permission requests,
cancel and session lifecycle; the official ACP page does not list modes, models, sub-sessions or extra
directories.

### Cited Findings
- `/fleet [PROMPT]`: "Enables parallel subagent execution of parts of a task"; `/delegate [PROMPT]`: "Delegates
  changes to a remote repository with an AI-generated pull request"; `/cwd`, `/cd [PATH]` change or show the
  working directory; `/tasks` opens a tasks dialog where one can view or "teleport into a subagent's session",
  kill, remove or background a task and "toggle nested levels" —
  [CLI command reference, accessed 2026-11-23](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)
- With `/fleet`, "the main Copilot agent analyzes the prompt and determines whether it can be divided into smaller
  subtasks"; if so it acts as orchestrator; "Each subagent has its own context window"; "Where possible, the
  orchestrator agent will run the subagents in parallel"; "You can assign work to custom agents or models that are
  suited to particular tasks"; "Using `/fleet` in a prompt may therefore cause more GitHub AI Credits to be
  consumed"; "If your request is inherently sequential, using `/fleet` may not provide any benefit" —
  [Running tasks in parallel with /fleet, accessed 2026-11-23](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/fleet)
- The orchestration pattern documented: break the goal into tasks, identify dependencies, assign each task with
  its context and tools, run independent tasks in parallel, review and combine the results; `/fleet` is available
  in the GitHub Copilot app and Copilot CLI —
  [Delegating and parallelizing work with agents, accessed 2026-11-23](https://docs.github.com/en/copilot/concepts/agent-capabilities/choosing-and-delegating-agent-work/delegating-and-parallelizing-work-with-agents)
- `/fleet` mechanics: the orchestrator breaks the task into work items with dependencies, "Dispatches independent
  items as background sub-agents simultaneously", polls for completion, dispatches the next wave, then verifies
  and synthesizes; "Each sub-agent gets its own context window but shares the same filesystem"; there is no file
  locking — if two agents write the same file "the last one to finish wins—silently"; subagents cannot talk to
  each other and cannot see the orchestrator's history; non-interactive form
  `copilot -p "/fleet <task>" --no-ask-user` —
  [GitHub Blog, "Run multiple agents at once with /fleet in Copilot CLI", 2026-04-01, updated 2026-04-14](https://github.blog/ai-and-ml/github-copilot/run-multiple-agents-at-once-with-fleet-in-copilot-cli/)
- Custom agent vs subagent: a custom agent is "a definition of a specialist", a subagent is "an agent doing
  delegated work" in a separate context window; the main agent can delegate to a built-in agent or run a
  specialist from a custom profile. Built-in agents in Copilot CLI: `explore`, `task`, `general-purpose`,
  `code-review`, `research`, `rubber-duck`, `security-review` —
  [About custom agents (Copilot CLI), accessed 2026-11-23](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-custom-agents)
- `/delegate` (or a prompt prefixed with `&`) hands work to Copilot cloud agent, which works "in the background on
  your behalf" and creates a pull request; cloud sessions appear in the Sessions tab and can be resumed and steered
  locally; "`/delegate` only works if you are also signed in to GitHub" —
  [Work with multiple sessions, accessed 2026-11-23](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/work-with-multiple-sessions);
  [Best practices for Copilot CLI, accessed 2026-11-23](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-best-practices)
- Several local sessions can run side by side ("You're not limited to one session at a time"), keep running when
  switched away from, have no inactivity timeout, can be named (`copilot --name`), and resumed by id, prefix or
  name; the page does not describe any communication between sessions —
  [Work with multiple sessions, accessed 2026-11-23](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/work-with-multiple-sessions)
- ACP in Copilot CLI: public preview announced 2026-01-28; clients can "Create isolated sessions with custom
  working directories", send prompts with text, images and context resources, receive streaming updates, "Respond
  to permission requests for tool execution", cancel operations and manage session lifecycle; named use cases
  include "Multi-agent systems" —
  [GitHub Changelog, 2026-01-28](https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/)
- ACP server reference: still "public preview and may change"; start with `copilot --acp` plus `--stdio` (default,
  one client, NDJSON) or `--port N` (TCP, binds `127.0.0.1`, serves multiple connections); `session/new` takes
  `cwd` and `mcpServers`; permission requests reach the client's `requestPermission` handler; slash commands and
  user-invocable skills are advertised through `available_commands_update`, while commands that need the
  interactive terminal (`/diff`, `/resume`, `/settings`, `/login`, `/help`) do not work over ACP —
  [ACP server reference, accessed 2026-11-23](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)
- Server-wide options (`--available-tools`, `--excluded-tools`, `--effort`, sandbox settings) are set when the
  server starts, apply to every session it creates or loads, and "Clients cannot override them through
  `session/new`" —
  [ACP server reference, accessed 2026-11-23](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)
- Local observation, not from GitHub's docs: over ACP, Copilot CLI 1.0.106–1.0.115 returned `configOptions` with
  `mode`, `model`, `reasoning_effort`, `agent`, `allow_all`, accepted `session/set_config_option` right after
  `session/new`, and honoured `--context long_context` as a process flag; Copilot does not load CLI extensions in
  ACP mode — repository files `docs/superpowers/specs/2026-11-08-delegated-sessions-design.md`,
  `docs/superpowers/specs/2026-11-20-context-tier-design.md`, `electron/README.md` (no URL; see part A).

### Inferences
- Copilot's own subagents and `/fleet` are intra-session: one orchestrator, one filesystem, results folded back
  into the parent's context. They are not inspectable, resumable sessions, which is the gap the local app's
  session tree fills.
- Because server-wide ACP options cannot be changed per session, a client that wants a different tool set or
  effort per child needs one Copilot process per child; the local app already runs one process per session.
- Inside any app session (root or child) the model can still use Copilot's built-in subagents; the app displays
  them as collapsed groups (`electron/README.md`), so "session tree" and "in-session subagents" compose.

### Gaps
- The official ACP server page does not state which optional ACP capabilities Copilot CLI advertises
  (`loadSession`, `sessionCapabilities.resume/close/additionalDirectories/systemPrompt`, elicitation, subagent
  child sessions). No reliable source found; it has to be read from the `initialize` response of the installed CLI.
- Default model of `/fleet` subagents: the GitHub Blog post says agents "will use the current default model",
  while a search summary of GitHub docs said subagents use "a low-cost AI model" by default (search summary, page
  not opened). Conflict not resolved.
- No documented maximum number of subagents or nesting depth was found.
- The 2025-10-28 changelog "GitHub Copilot CLI: Use custom agents and delegate to Copilot coding agent" was seen
  only as a search result title (page not opened).

---

## B2. Documented limits: working directory, extra directories, instructions, per-repo agents, MCP per session

### Takeaway
A Copilot CLI session has one working directory plus an allow-list of extra directories (`/add-dir`); repository
instructions and custom agents are resolved from the working directory's repository (plus user-level files), are
loaded at session start, and custom subagents do not get repository instructions by default. Over ACP the MCP
server list is per session, while tool restrictions and effort are per server process.

### Cited Findings
- `/add-dir PATH`: "Allow file access to a directory and load its skills" (its agents are also loaded as trusted
  configurations; with sandboxing it also grants sandbox access for the session); `/cwd` / `/cd` changes the
  working directory —
  [CLI command reference, accessed 2026-11-23](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)
- `/add-dir` "requires full paths"; `/list-dirs` shows the allowed directories —
  [Best practices for Copilot CLI, accessed 2026-11-23](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-best-practices)
- Instruction files Copilot CLI reads: `$HOME/.copilot/copilot-instructions.md`,
  `$HOME/.copilot/instructions/**/*.instructions.md`, `.github/copilot-instructions.md`,
  `.github/instructions/**/*.instructions.md` (path-specific through `applyTo`), `AGENTS.md`, `CLAUDE.md` (also
  `.claude/CLAUDE.md`), `GEMINI.md`; the "standard locations" include "the repository root, the current working
  directory, intermediate directories between them" —
  [Adding custom instructions for Copilot CLI, accessed 2026-11-23](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions)
- `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`: a comma-separated list of additional directories whose `AGENTS.md` and
  `*.instructions.md` files are read —
  [Adding custom instructions for Copilot CLI, accessed 2026-11-23](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions);
  contradicted in part by a local test on Copilot CLI 1.0.115 (2026-11-23), where only
  `<dir>/.github/instructions/*.instructions.md` was listed and `AGENTS.md` at the directory root was not read —
  repository file `docs/superpowers/specs/2026-11-23-session-prompts-design.md`, "Approaches considered".
- User-level and repository instructions are combined; no general precedence order is defined, so conflicting
  instructions should be avoided; edits are not picked up by active sessions (exit and `copilot --continue`, or
  `/new`) —
  [Adding custom instructions for Copilot CLI, accessed 2026-11-23](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions)
- Agent profiles are Markdown files with YAML frontmatter that can restrict tools and, in supported environments,
  configure MCP servers for that agent; they can be shared at repository, organization and enterprise level, and
  Copilot CLI also supports personal profiles —
  [About custom agents (Copilot CLI), accessed 2026-11-23](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-custom-agents)
- "In Copilot CLI, repository instructions are included for the session agent but not for a custom subagent by
  default. An opt-in setting exists." (as summarised from the page) —
  [About custom agents (Copilot CLI), accessed 2026-11-23](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-custom-agents)
- Custom agents can be defined in `.github/agents/` with their own model, tools and instructions and referenced in
  a `/fleet` prompt as `@technical-writer.md` —
  [GitHub Blog, 2026-04-01](https://github.blog/ai-and-ml/github-copilot/run-multiple-agents-at-once-with-fleet-in-copilot-cli/)
- Personal agents live in `~/.copilot/agents` (search summary of the 2025-10-28 changelog, page not opened;
  consistent with the local verification on CLI 1.0.106 quoted in A5).
- Over ACP, `mcpServers` is a parameter of `session/new` (per session), while `--available-tools`,
  `--excluded-tools`, `--effort` and sandbox settings are per server process —
  [ACP server reference, accessed 2026-11-23](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)
- In the ACP specification `cwd` must be an absolute path, is the base for relative paths, and together with
  `additionalDirectories` forms the root set that "SHOULD serve as a boundary" for file-system tool operations;
  `additionalDirectories` needs the agent capability `sessionCapabilities.additionalDirectories` and must be
  resent in full on `session/load` and `session/resume` —
  [ACP v1, Session Setup, accessed 2026-11-23](https://agentclientprotocol.com/protocol/v1/session-setup.md)

### Inferences
- A child session started with another repository as its `cwd` automatically gets that repository's instructions,
  custom agents, skills and MCP config; an orchestrator session rooted in one repository does not get the others'
  instructions unless they are added (extra directories, or a parent folder as cwd).
- Role agents meant for every repository (orchestrator, spec writer, planner, implementer, reviewer) fit the
  user-level location; repository-specific specialists fit `.github/agents` of that repository.
- Since instruction edits apply only to new or restarted sessions, role or prompt changes mid-pipeline need a
  session restart (the local session-prompts spec reached the same conclusion experimentally).

### Gaps
- The command-line flag form (`--add-dir`), trusted-folder rules and MCP configuration file locations were not
  reached: the command reference page is about 478k characters and only its first 200k were read. No claim is made
  about them.
- Whether Copilot CLI accepts `additionalDirectories` over ACP is not documented on the ACP server page (see B1
  gaps).
- Exact frontmatter fields and precedence of custom agents are in the "Custom agents configuration" reference,
  which was not opened.

---

## B3. Does the ACP specification define sub-sessions or agent-to-agent delegation?

### Takeaway
Yes, but only in one direction: ACP now has stable "subagent sessions", child sessions that the agent creates,
owns and merely exposes to the client for observation (and permission answers). The client cannot create a child,
prompt it, load it or reconfigure it, and the specification has no client-driven or agent-to-agent delegation; an
orchestrator made of separate sessions remains entirely the client's job.

### Cited Findings
- The documentation index lists "Subagents" pages for v1 and v2, an RFD "Subagent Sessions" and the announcement
  "Subagent sessions are stabilized" (stable in v1 and the v2 baseline); v1 is the stable protocol and v2 is in
  Preview —
  [ACP documentation index, accessed 2026-11-23](https://agentclientprotocol.com/llms.txt)
- A subagent is exposed as a child session with its own `sessionId` "that the Agent creates and owns"; exposure is
  optional (an agent may use subagents without exposing them); the spec defines no client method to request a
  child —
  [ACP v1, Subagents, accessed 2026-11-23](https://agentclientprotocol.com/protocol/v1/subagents.md)
- The agent announces a child with a `session/update` on the parent whose `sessionUpdate` is `subagent_update`
  (fields `sessionId`, `title`, `description`, `capabilities`, `state`, `cwd`, `additionalDirectories`); it "MUST
  NOT send `subagent_update`, `session_message`, or `session_message_chunk`" unless the client advertised
  `clientCapabilities.subagents` —
  [ACP v1, Subagents, accessed 2026-11-23](https://agentclientprotocol.com/protocol/v1/subagents.md)
- The client may observe the child's updates and must answer its `session/request_permission` (and elicitation,
  file-system, terminal) requests, which carry the child's `sessionId`; it may cancel only when the child's
  `capabilities.cancel` is present; it cannot prompt the child, set its mode or config, close or delete it, and
  "Clients MUST NOT send `session/load` or `session/resume` for a child"; `session/list` does not return children —
  [ACP v1, Subagents, accessed 2026-11-23](https://agentclientprotocol.com/protocol/v1/subagents.md)
- A child may run in a different directory: `cwd` and `additionalDirectories` are reported on `subagent_update`,
  and "The Agent MUST report a value that differs from the parent's"; an unset value is inherited from the parent —
  [ACP v1, Subagents, accessed 2026-11-23](https://agentclientprotocol.com/protocol/v1/subagents.md)
- Sessions "can nest to any depth"; a child has exactly one parent and cannot be moved; the agent "MUST NOT use a
  child to get around a restriction the Client placed on the parent session" —
  [ACP v1, Subagents, accessed 2026-11-23](https://agentclientprotocol.com/protocol/v1/subagents.md)
- Session setup defines only independent sessions (`session/new`, `session/load`, `session/resume`,
  `session/close`), with optional `additionalDirectories` and a client-provided `systemPrompt` (modes `append` and
  `override`, behind `sessionCapabilities.systemPrompt`); nothing about parent or child relations —
  [ACP v1, Session Setup, accessed 2026-11-23](https://agentclientprotocol.com/protocol/v1/session-setup.md)
- Related stabilized features in the index: Elicitation (structured user input), Session Config Options, Session
  List / Resume / Close / Delete, Additional Workspace Roots, Client-Provided System Prompt; RFDs exist for session
  fork and for "Agent Extensions via ACP Proxies" —
  [ACP documentation index, accessed 2026-11-23](https://agentclientprotocol.com/llms.txt)

### Inferences
- ACP subagent sessions describe an agent's internal delegation (for example Copilot's own subagents) and make it
  visible; they are a different thing from the local app's tree, where each node is a top-level ACP session of a
  separate agent process and the links live in the client and broker.
- The local app does not advertise `clientCapabilities.subagents` (`electron/acp.mjs`), so a compliant agent will
  not send it `subagent_update`; the app reconstructs Copilot's subagents from tool-call updates instead.
- Two stabilized ACP features map onto gaps found in part A, if Copilot CLI advertises them: `additionalDirectories`
  (a session rooted in one repository with read access to shared artefacts or sibling repositories) and
  `systemPrompt` (per-session role prompt without the environment-variable route). Elicitation would be the
  protocol-level route for agent questions to the user.

### Gaps
- Whether Copilot CLI (as of November 2026) implements ACP subagent sessions, `additionalDirectories`,
  `systemPrompt` or elicitation is not stated in GitHub's ACP page; no reliable source found.
- Dates of the ACP stabilization announcements were not read (index only).

---

## B4. Documented practice for running Copilot CLI against several repositories for one feature

### Takeaway
GitHub documents no orchestration pattern for one feature across several repositories. The documented options are:
start Copilot in a parent directory of the repositories, add other repositories with `/add-dir`, keep separate
focused sessions per repository, or push work for other repositories to the cloud agent with `/delegate`.

### Cited Findings
- Running from a parent directory: "Copilot can now access and work across all child repositories simultaneously";
  other repositories can be added with `/add-dir` (full paths) —
  [Best practices for Copilot CLI, accessed 2026-11-23](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-best-practices)
- The same page advises focused sessions (`/clear` or `/new` between unrelated tasks) and using `/delegate` for
  tangential tasks, documentation and separate-module refactors while keeping core feature work local; a search
  summary of this page also mentions offloading "changes to other repositories" to the cloud agent (search summary;
  the fetched text listed the task types above) —
  [Best practices for Copilot CLI, accessed 2026-11-23](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-best-practices)
- Plan mode is recommended for complex multi-file work: Copilot asks clarifying questions, writes a checklist plan
  to `plan.md` and "Waits for your approval" before implementing —
  [Best practices for Copilot CLI, accessed 2026-11-23](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-best-practices)
- Multiple named sessions can run in parallel and be resumed by name; the sessions sidebar shows "recent sessions
  for your current directory"; the page describes no cross-session messaging —
  [Work with multiple sessions, accessed 2026-11-23](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/work-with-multiple-sessions)
- `/new worktree` starts an empty session in a new Git worktree —
  [CLI command reference, accessed 2026-11-23](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)
- For `/fleet`, the GitHub Blog recommends scoping each track to its own files or directories ("No changes outside
  assigned directories") because subagents share one filesystem without locking; it does not discuss several
  repositories —
  [GitHub Blog, 2026-04-01](https://github.blog/ai-and-ml/github-copilot/run-multiple-agents-at-once-with-fleet-in-copilot-cli/)

### Inferences
- The "parent directory as cwd" option gives one session access to all repositories but resolves repository
  instructions and agents relative to that cwd, so per-repository `.github` configuration of the children is not
  the session's primary configuration; one session per repository keeps each repository's configuration in force.
  This favours an orchestrator at a neutral or parent folder with one implementer session per repository.
- Cross-session coordination (who works on what, hand-offs, shared spec) is not a Copilot CLI feature; it has to
  come from the client (as in the local app) or from files and pull requests.

### Gaps
- No official GitHub guidance was found for a refinement → spec → plan → implementation pipeline spanning several
  repositories, or for a shared specification repository; third-party posts (worktrees with tmux, VS Code
  multi-root workspaces, Copilot Spaces) appeared in search results but were not opened and are not CLI
  documentation.
- Whether instructions of a repository added with `/add-dir` are loaded (the command reference says the directory's
  skills and agents are) was not confirmed.
