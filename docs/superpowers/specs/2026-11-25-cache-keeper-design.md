# Spec: Keep an idle session's prompt cache warm, then compact it before the cache expires (`cache-keeper`)

Implementation starts from `main` (after v0.28.0, `c1ee6d8`). The version is decided at the merge.

## Intent

The owner pays for Copilot in AI credits (AIU), by tokens. A Claude session keeps its prompt cache for 5 minutes
after its last model request. After a longer pause, the next prompt writes the whole context to the cache again, at
1.25× the input price. A pause in a large Opus session therefore costs about 80 AIU. The owner wants the app to
spend less:

1. While a session waits for the user, the app keeps its cache warm with a few cheap keep-alive prompts.
2. When the user stays away, the app compacts the session just before the cache expires, so the next prompt only
   writes the short summary.

The user can see this coming and stop it.

### Measured facts this design rests on (2026-11-25)

Measured with `scripts/sdk-probe/cache-ttl.mjs` on the owner's company PC (129 sessions, Copilot CLI 1.0.116) and
with live tests on the Linux machine.

- **TTL.** The CLI records the cache lifetime per model in every `session.usage_checkpoint` of `events.jsonl`:
  `data.modelCacheState[] = { modelId, cacheExpiresAt, cacheTtlSeconds }`. Claude Opus 5.5, Sonnet 5.5 and Fable 5.2
  have 300 s; GPT models have 1800 s. `cacheExpiresAt` is about checkpoint time + TTL, so it counts from the end of
  the turn. The real lifetime counts from the start of the last model request, so it can be shorter. Some
  checkpoints are written late: the smallest fresh margin seen was 14 s. Some are stale: `cacheExpiresAt` already
  lies in the past.
- **Billing.** The account pool `premium_interactions` counts AI credits: 110 750 of 125 000 were used, and the
  November history sums to 104 233 AIU against 23 056 premium requests. Opus 5.5 prices, in nano-AIU per 1M tokens:
  input 400 G, cache read 20 G (0.05×), cache write 500 G (1.25×), output 2000 G (5×). 1 AIU is about $0.01.
- **Compaction.**
  - Sending `/compact` as an ordinary `session/prompt` over ACP compacts the session. The CLI answers with an
    `agent_message_chunk` ("Compacted conversation history and removed N messages and M tokens.") and writes
    `session.compaction_start` and `session.compaction_complete` (`trigger: "manual"`, `messagesRemoved`, token
    usage).
  - It adds no `user.message` to the history.
  - It costs no premium request: all 8 clean manual compactions on the company PC had premium Δ 0. It does cost AIU:
    about 10–17 AIU on Opus while the cache is warm, and 35–360 AIU when the cache was already cold.
  - `/compact <focus text>` takes focus instructions.
- **What compaction keeps.** A manual compaction removes the whole conversation. The model then sees only the system
  prompt, a "The conversation history has been summarized…" user message with the summary, and the environment
  reminder. No recent message is kept verbatim. The summary is also saved under
  `session-state/<id>/checkpoints/NNN-*.md`, and the system prompt tells the model it may read it.
- **Keep-alive cost.** A ping on an Opus session with 160k of context costs about 3.5–4 AIU: a cache read of the
  context, a little input, and some output (thinking cannot be turned off on Opus 5.5). The ping refreshes the cache
  for another TTL.

Rough costs for a 160k Opus session (about 25k after compaction):

| Pause | Without the feature | With 6 pings, then compaction |
|---|---|---|
| user back before the 6th ping | ~80 AIU | 4–24 AIU, full context kept |
| user away for good | ~80 AIU when they return | ~24 + ~15 + ~12 (next prompt) ≈ 50 AIU, summary only |
| user never returns | 0 | ~40 AIU wasted |

## Goals

1. For every session open in the app, the cache keeper watches the session once a turn has ended. Its rules:
   - **Ping.** While the session is idle, it sends up to N keep-alive pings, each 60 s before the session's
     `cacheExpiresAt`.
   - **Countdown.** After the last ping it shows a countdown 120 s before `cacheExpiresAt`.
   - **Compact.** It sends `/compact` 60 s before `cacheExpiresAt`.
   - With N = 6 and Claude this gives: pings at about 4, 8, …, 24 min of the pause, countdown at about 27 min, and
     compaction at about 28 min. With N = 0, the countdown starts at about 3 min and compaction runs at about 4 min.
2. **Settings** (Settings dialog, global):
   - "Keep idle sessions' prompt cache warm, then compact them", off by default.
   - "Keep-alive prompts before compacting", default 6. 0 or empty means no pings, compaction only.
   - "Minimum context", default 50k tokens. Below it the keeper does nothing.
3. **Per-session switch.** A per-session "Don't keep this session's cache" switch turns off pings and compaction for
   that session only. It is remembered with the session.
4. **What the user sees.** The session header shows what is going on, with a **Not now** button:
   - during pings: "♻ Keeping the cache warm (3/6)";
   - during the countdown: "⏳ Compacting in 0:42".
   - The session list shows ⏳ next to a session in its countdown.
5. **Not now** stops pings and compaction for the current pause only. The next turn starts a new pause.
6. **Anything that is not the keeper's own action** ends the current pause and resets the count: a prompt from the
   user, the relay web GUI or another session, a turn of any kind, a permission request, or a change of the session's
   model, agent, context tier or prompts. Counting starts again once the next turn ends. After a config change with no
   turn since, the keeper waits for a turn: the new model has no fresh cache entry.
7. **Pings leave no trace the user sees.** They do not appear in the chat, live or on replay. They do not change
   message numbering: fork, cut, edit, the user-message count and message times. They do not update the session's
   last activity, do not mark it unread, and do not notify.
8. **A compaction leaves one grey line in the chat**: "Compacted automatically before the prompt cache expired (−N
   messages)". The CLI's own reply line is hidden. A failed compaction leaves a grey note with the reason, and the
   session goes on unchanged.
9. **Focus instructions.** `/compact` always carries focus instructions that keep the last exchange verbatim. A
   parent with children that have not reported back yet gets longer ones that also keep each delegation verbatim
   (section 3).
10. **Nothing gets lost.** Every user action that today checks `entry.prompting` waits for a running ping or
    compaction and then goes on, instead of failing with "Wait until Copilot finishes this turn.", because the window
    shows the session as idle. That covers:
    - a prompt;
    - fork, cut and edit (`refuseWhilePrompting`);
    - rename;
    - context tier and prompt changes (`restartGuards`);
    - model and agent changes (`sessions:setConfig`).

    Delete and close cancel the action, as they cancel a turn today. A `/compact` cut off this way leaves the session
    as the CLI leaves it: compacted or not.

## Non-goals

- Sessions that run in a terminal (`copilot` with the relay extension) and are not opened in the app.
- The SDK backend. The keeper's two actions sit behind one small interface, so `history.compact()` can replace
  `/compact` after a migration, but this spec only builds the ACP path.
- Changing the CLI's own threshold compaction (80% / 95% of the window).
- Per-model price calculation. The threshold is a token count, not a cost estimate.
- Showing the compaction line again on replay. It is live only (Known limitations).

## Anti-goals

- A compaction that starts after the cache has expired. It costs more than doing nothing. A stale or missing
  `cacheExpiresAt` means: do nothing.
- A ping that makes the agent work: a tool call, or the agent continuing an interrupted task.
- A ping that shifts message numbering, so that fork, cut or edit hit the wrong message.
- Any keeper action while a turn runs, a permission question waits, a queued message waits, or the user has text in
  the message box.
- A compaction the user could not see coming in a session they are looking at.

## Decisions (the owner's)

- All open sessions are covered, with a global setting and a per-session opt-out (option "B").
- A countdown with **Not now** before compaction. Its timing counts from `cacheExpiresAt`: the countdown starts 2 min
  before it and compaction 1 min before it.
- Keep-alive pings before compaction, configurable, default 6. 0 or empty disables them.
- A parent with active (unreported) children is treated like any session: pings, then compaction, with the longer
  focus instructions.
- The keeper lives in the main process (approach A).

## Approaches

- **A. A keeper in the main process (chosen).** A pure rules module decides the next step from the session's state;
  thin wiring in `main.mjs` runs timers and sends the prompts the way `slashRename` sends `/rename`. The window only
  shows the state and reports what only it knows (queue, draft). Works for background sessions and survives a window
  reload. The rules sit next to the session state they read (`entry.prompting`, permissions, children, the ACP
  connection).
- **B. Timers in the renderer.** Closer to the queue and the editor, but a window reload loses the timers, and the
  main process would still have to guard turns and permissions, so the rules would be split across two places.
- **In the relay CLI extension.** Would cover terminal sessions, but it is unverified whether an extension can prompt
  or compact its own session, and the countdown would still have to reach the window.
- **Wait for the SDK migration** (`history.compact()`, live checkpoint events). Cleaner, but the migration is not
  decided. A leaves room for it.

## Design

### 1. The rules (`electron/cache-keeper.mjs`, new, pure)

No Electron, no timers, no file access, so it is unit-testable like `renderer/message-queue.js` and
`prompt-count.mjs`.

Constants:
- `PING_LEAD_MS = 60_000`
- `COUNTDOWN_LEAD_MS = 120_000`
- `COMPACT_LEAD_MS = 60_000`
- `KEEPALIVE_MARKER = "[keep-alive]"`

Per-session state, kept by main: `{ expiresAt, pingsSent, skipped, phase }`. `phase` is one of
`idle | pinging | countdown | compacting | done | off`.

`next({ state, now, settings, facts })` returns `{ action, at }`:
- `action` is one of `none | ping | countdown | compact`;
- `at` is the time to act or wake up again.

`facts` is what main knows:
- `enabled`: the setting and the per-session switch;
- `busy`: `entry.prompting`, open permissions, the keeper's own action in flight, an open card of this session (a
  new-session request it made in `pendingRequests`, a reopen or link card in `reopenCards` or `linkCards`). Held relay
  messages do not make a session busy: they can wait for hours, and the cache would only expire meanwhile.
- `held`: the window reported a non-empty queue or draft;
- `contextUsed`: the last `usage_update.used`;
- `replaying`: the session is replaying its history;
- `hasActiveChildren`: a child counts until its report has reached the parent. That is an open child with
  `parentSessionId` equal to this session and `reported === false`, or a child whose report is still held for the
  parent in `heldCache`. `entry.reported` turns true as soon as the child reports, even when the report itself is held
  for the user's approval, so `unreportedChildren()` alone is not enough.

Rules, in order:
1. Phase `done`, not enabled, `skipped`, `busy`, `held`, `replaying`, `contextUsed < threshold`, or `expiresAt` missing →
   `none`.
2. `expiresAt - now < COMPACT_LEAD_MS`: too late, and the cache may already be cold → `none`. The pause ends without
   a compaction; the next turn starts a new one.
3. `pingsSent < settings.pings` → `ping` at `expiresAt - PING_LEAD_MS`.
4. Otherwise → `countdown` at `expiresAt - COUNTDOWN_LEAD_MS` (immediately if that is already past, as long as
   rule 2 does not apply), then `compact` at `expiresAt - COMPACT_LEAD_MS`.
5. After a compaction, successful or not, the phase is `done` until the next `turnEnded`. The keeper never pings or
   compacts a session twice in one pause, so an abandoned session costs at most N pings and one compaction.

Events that change the state:
- `turnEnded(expiresAt)`: a turn of the user or the relay → `pingsSent = 0`, `skipped = false`.
- `pingEnded(expiresAt)`: `pingsSent += 1`.
- `notNow`: `skipped = true`.
- `activity`: anything in Goal 6 → back to `idle` and wait for `turnEnded`.
- `compactEnded`: phase `done`. The ending of the keeper's own ping or compaction is not a `turnEnded`.

The module also builds the two prompt texts:
- `keepAliveText()`: `[keep-alive] The user is away. Reply with a single dot. Do not use any tool and do not continue
  any task.` The builder may tune the wording; it must start with `KEEPALIVE_MARKER`.
- `compactText({ parent })`: `/compact Quote verbatim the last user message and your last answer.` For a parent with
  active children (`hasActiveChildren`), also: ` For each delegated child session, keep verbatim what you asked it to do and how you
  planned to check its result.`

`isKeepAlive(text)` tests the marker, for history and replay (section 3).

### 2. Main (`electron/main.mjs`)

**Where `cacheExpiresAt` comes from.** After every turn of a session ends (where `endPrompt` returns true), main
reads the last `session.usage_checkpoint` of its `events.jsonl`:
- Take the `modelCacheState` entry of the session's current model (from its config options). If the current model has
  no entry, there is no `expiresAt`: the entry of another model, e.g. the model before a switch or a subagent's
  model, says nothing about this cache. Only when the session's current model can't be identified at all, e.g. `auto`
  with no resolved model, take the entry with the latest `cacheExpiresAt`.
- `usage.mjs` already scans checkpoints (`scan`, `readSessionUsage`): extend it with a reader that returns
  `{ expiresAt, ttlSeconds, modelId, checkpointId }`.
- The checkpoint can land a moment after `session/prompt` resolves. If the newest checkpoint is the same as before
  the turn, read again a few times, e.g. 3 × 1 s. If nothing new arrives, there is no `expiresAt` and the keeper does
  nothing.

**Timers.** One timer per open session, set from `next()`. It is cleared on close, on activity, and when the
connection exits.

**Ping.**
- Sent the way `slashRename` sends `/rename`: `beginPrompt`/`endPrompt`, relay state busy, and a flag
  `entry.keeping = "ping"`.
- While the flag is set, the session's updates do not reach the window (`acp:update`), do not reach the change
  tracker, do not update last activity, and do not notify.
- If a `tool_call` arrives during a ping, main cancels the turn (`cancelTurn`), the keeper sets `skipped`, and the
  window gets the notice "Keep-alive stopped: the agent started working." A permission request during a ping is
  answered as cancelled with the turn.
- After the ping, main reads the new `expiresAt` and calls `pingEnded`.

**Compaction.**
- Sent the same way, with `entry.keeping = "compact"` and `compactText({ parent })`. `parent` is
  `hasActiveChildren` (section 1).
- Children that run in a terminal are known only from the broker's links (`links-cache.mjs`, `refreshLinks()`).
  Whether those carry a "reported" fact is left to the builder. Without it, only children open in the app count.
- The CLI's reply is not shown. Main sends `acp:notice` with the grey line of Goal 8. N comes from the reply text
  ("removed N messages") or from `compaction_complete.messagesRemoved`.
- A failed compaction is a JSON-RPC error, a reply without "Compacted", or `compaction_complete.success === false`.
  It gives a notice with the reason; `skipped` is set for this pause.

**User actions while the keeper acts.** Every path that starts a turn and every handler that today refuses while
`entry.prompting` is set first await the keeper's in-flight action: `sessions:prompt`, the relay delivery,
`refuseWhilePrompting` (fork, truncate, edit), `sessions:rename`, `restartGuards`, `sessions:setConfig`. That is at
most the action's own time, about 10–20 s. Then they go on as today. A shared helper, e.g.
`await keeperIdle(sessionId)`, keeps this in one place. This counts as activity (Goal 6). Delete and close cancel
the action like a turn.

**IPC.**
- Main → window: `keeper:state { sessionId, phase, pingsSent, pings, compactAt }`, sent on every change.
- Window → main:
  - `keeper:held { sessionId, held }`: the queue is not empty or the message box has text;
  - `keeper:notNow { sessionId }`;
  - `keeper:optOut { sessionId, off }`.
- `preload.cjs` exposes them.

**Settings.** `cacheKeeper: { enabled: false, pings: 6, minContext: 50_000 }` in the settings file, normalised like
`queueMidTurn` and `contextTier`. Empty or 0 pings → 0. The per-session switch is stored with the other per-session
values (the builder picks the existing per-session store, e.g. the one behind `commands` and `tiers`).

### 3. Pings out of the history (`electron/history.mjs`, replay)

A ping is a real `user.message` and `assistant.message` in `events.jsonl`. Everything that numbers or shows messages
must skip it:
- **`history.mjs`:** `isUser` (and so `userIndex`, `cutIndex`, `countFrom`, `countUserMessages`) and
  `messageTimes()` treat a `user.message` whose `data.content` starts with `KEEPALIVE_MARKER` as not a user message.
  The builder checks the exact stored `content`: it may differ from what was sent, e.g. a datetime prefix the CLI
  adds for the model.
- **Cut and fork.** Cutting at a real message removes the pings after it, as part of what follows. A cut never lands
  between a ping and its answer, because pings are never cut targets.
- **Replay.** On `session/load` the CLI replays the history as updates. Main's `entry.update` already handles live
  and replayed updates in one path. There, a `user_message_chunk` whose text starts with the marker starts a
  swallowed span. Every update up to the next `user_message_chunk` is swallowed: the ping's answer and anything it
  did. The renderer needs no change.
- **`/compact`** writes no `user.message` (measured), so it needs no filtering. Whether its reply line comes back on
  replay is left to the builder to check; if it does, swallow it there too.

### 4. The window (`electron/renderer/app.js`, `index.html`, `style.css`)

- **Settings dialog:** a checkbox and two number fields next to the queue setting, with a hint line: "Spends a few
  AI credits per pause to save the cost of rewriting the cache. Compaction replaces the conversation with a summary."
- **Session header:** the status chip of Goal 4 with **Not now**. The countdown ticks every second from `compactAt`.
  The ping chip shows `pingsSent/pings`.
- **Session list:** ⏳ next to a session in `countdown`.
- **Session menu:** "Don't keep this session's cache" (checked = opted out).
- **Activity reports:** the window sends `keeper:held` when a session's queue becomes non-empty or empty, and when
  its message box gets text or becomes empty, debounced.

### 5. Tests

- `electron/test/cache-keeper.test.mjs`, covering the rules:
  - the timeline for N = 0, 1 and 6;
  - every condition of rule 1, stale and late `expiresAt` (rule 2), Not now, and activity resetting the count;
  - the threshold;
  - the parent focus text;
  - `isKeepAlive`.
- `history.test.mjs`: pings are skipped by `countUserMessages`, `cutIndex` (all three positions, a ping right after
  the target), `countFrom` and `messageTimes`.
- `usage.test.mjs`: the new checkpoint reader (current model, fallback to the latest entry, no `modelCacheState`,
  stale entries).
- Main wiring, where the existing fake-ACP harness allows:
  - a ping is invisible to the window and cancels on a `tool_call`;
  - a user prompt during a ping waits and is then sent;
  - compaction sends the notice;
  - the replay swallows a ping span.
- A UI check (`scripts/ui-check`) for the chip, the countdown and Not now.

## Calls made after the builder check

These were settled by the author, not by the owner:
- Other user actions wait for a running keeper action (Goal 10).
- A config change ends the pause, and the cache entry is taken only for the current model (Goal 6, section 2).
- After a compaction the keeper stops until the next turn (rule 5).
- Open cards make a session busy, held messages do not; a child counts as active until its report reaches the parent
  (section 1).

## Known limitations

- `cacheExpiresAt` counts from the end of a turn, not from the start of its last request. A final answer that took
  more than about 60 s to generate can leave the real cache cold before the keeper acts. The 60 s lead is the margin;
  it is not measured per turn.
- **Compaction loses detail.** The focus instructions keep the last exchange and the delegations as quotes inside
  the summary. That a model quotes them faithfully is not verified.
- **Pings cost AIU** even when the user never comes back (~24 AIU for 6 pings on a 160k Opus session).
- GPT sessions (TTL 1800 s) follow the same rules. Their economics were not measured.
- Terminal sessions are not covered.
- The compaction line is live only; a replay does not show it.
- Not run on Windows or macOS before implementation. The measurements come from the company PC (Windows) and Linux.

## Left to the builder

- The checkpoint re-read after a turn (how often, how long).
- The exact keep-alive wording, as long as it starts with the marker, and the exact stored `content` of a ping.
- How a `tool_call` during a ping is detected and cancelled without a permission card flashing in the window.
- Where the per-session opt-out is stored.
- Whether broker links tell which terminal children have reported (section 2).
- The UI strings beyond those given here, and the chip's styling.
