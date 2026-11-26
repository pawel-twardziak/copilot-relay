# Context meter on load, tool definitions: deferred findings

**Sources:** the final whole-branch review (fable, medium) of `fix/context-on-load-tools`. The branch is a single fix
without a plan, so there were no task reviews.

**The fix:** a reopened session showed 138.9k on the corp PC where the next turn sent 56.5k. `currentTokens` of
`session.shutdown` includes `toolDefinitionsTokens` of every available tool, the deferred MCP tools behind tool search
too (178 tools, 155 deferred: 105.5k), while each model call sends 22.2k of tools (`toolTokenCount`).
`readLastContext` (`electron/usage.mjs`) now takes `inputTokens` and `maxPromptTokens` of the last main model call. If
a successful compaction follows that call, it takes `systemTokens + conversationTokens` of the first shutdown after
the newest such compaction, plus the call's `toolTokenCount`.

**Measured on 2026-11-26** with `scripts/sdk-probe/context-on-load.mjs` on 100 corp-PC sessions (Windows, Copilot CLI
1.0.116), 77 reopens:

- Against the first call after each reopen, the old figure had a median error of 62%. The last call's
  `inputTokens` has a median error of 1.1% (p90 11%).
- It missed by more than 20% only after a compaction that followed the last call. That case now uses the formula
  above, which stayed within about 10% there.
- Session `9eb48a2b`: 56.5k on open instead of 138.9k. The live meter showed 53.2k after the next turn.

**Fixed on the branch after the review, so not listed below:**

- The compaction formula takes the first shutdown after the newest compaction. Before, it took the newest shutdown,
  and a later run without a turn reports smaller system and conversation figures.
- Events with `agentId` (sub-agents) are skipped.
- A record without `usage` no longer throws.
- An unusable newest call (no `inputTokens` or `maxPromptTokens`) falls back to an earlier one.
- The doc comment lists every null case.
- Tests were added for each of the above and for the whole-file pass after a tail that holds the compaction but not
  the call.

## A. Worth doing first

- None.

## B. Window and wording

1. **The file figure is a few percent above the live meter** (`readLastContext`). `inputTokens` is the API's count;
   the live `usage_update` is the CLI's own count. In session `9eb48a2b` they were 56.5k and 53.2k for the same turn,
   so the meter drops about 6% at the first turn after a reopen.
   - *Proposal:* none unless someone notices.

## C. Small behaviour

1. **`conversation-user` and other `interactionType` values are not main calls** (`isMainCall`,
   `electron/usage.mjs`).
   - The schema lists `conversation-agent`, `conversation-subagent`, `conversation-sampling`, `conversation-user`,
     `conversation-background` and `conversation-compaction`. All records seen so far, locally and in the corp
     session, are `conversation-agent`, for initiator user and agent alike.
   - If a CLI version records main calls as `conversation-user`, they are skipped silently and an older call is used.
   - *Proposal:* run the probe on the corp PC after the next CLI update, and count the `interactionType` values.
2. **The compaction formula is not verified on disk**, because there are no compactions in local sessions.
   - The figure is null when no shutdown follows the compaction. That is the case for a crash, or a `/compact` whose
     run is still open in another process.
   - The schema also gives `session.compaction_complete` its own post-compaction `systemTokens` and
     `conversationTokens`. If they are on disk, they could replace the shutdown figures and remove that null.
   - A shutdown of a run without a turn that held the compaction (`/compact` and close) reports smaller system figures.
   - *Proposal:* check a corp-PC `compaction_complete` line for these fields.
3. **Sub-agent events in the parent's `events.jsonl` are not verified.** The skip on `agentId` follows the schema;
   no local or corp line has `agentId`.
4. **The size can be stale after a model change** (`readLastContext`). It comes from the last call, so a
   `session.model_change` after it, or a reopen on another tier, shows the old window until the first live update.
   The old code had the same limit.
5. **A first message much larger than the history** (sessions `47548193`, `ac3d0c95`, `c94bf554` in the corp report:
   −23% to −30%). The meter cannot know the next prompt.

## D. Tests and housekeeping

1. **Manual check on the corp PC (Windows):** reopen session `9eb48a2b` or another one with company MCP servers. The
   header meter should show about the figure of the last turn, not 130k+.
