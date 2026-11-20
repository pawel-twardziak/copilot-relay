# Spec: Context window 200k / 1M (desktop app)

## Intent

Copilot in VS Code lets you switch a model's context window from 200k to 1M tokens. Copilot CLI has the same
choice (the "context tier": `default` or `long_context`), but the desktop app (`electron/`) has no way to pick
it. Long sessions hit 200k and get compacted; for those the user wants the 1M window, and only for those,
since the long tier may cost more.

## Findings (Copilot CLI 1.0.115, measured with `scripts/probe-context.mjs`)

- ACP exposes no context option: `configOptions` are only `mode`, `model`, `reasoning_effort`, `agent`,
  `allow_all`, and `session/set_config_option` rejects unknown ids.
- The CLI flag works in ACP mode: `copilot --acp --stdio --context long_context` gives Claude Sonnet 5.5 a
  936k window (`usage_update.size: 936000`, `/context` shows `40k/936k`), against 200k without it.
- ACP doesn't say which models have a long tier. For models without one the flag is expected to be ignored;
  the context meter shows the real size either way (it reads `usage_update.size`).

## Goals

- **Global default** in Settings: "Default context window: 200k / 1M", stored in the app's `settings.json`
  (next to `copilotCommand`). Default: 200k.
- **Per-session choice**: a "Context" select next to the model select with *Default (200k|1M)*, *200k*, *1M*.
  *Default* follows Settings; *200k* / *1M* is an override for that session, kept across app restarts.
- A session's Copilot process starts with `--context long_context` when its effective tier is 1M.
- Changing the select restarts that session's process and reloads the session (`session/load`), so the
  history stays. Disabled while a turn runs, like the agent select.
- A delegated child session inherits its parent's effective tier (as an override), as it inherits the model.

## Non-goals

- Restarting open sessions when the Settings default changes: it applies to new sessions and to sessions on
  *Default* the next time their process starts.
- Detecting which models support 1M, or hiding the select for the others.
- Setting the tier for Copilot's own (non-app) sessions or its persisted `contextTier` setting.

## Approaches

1. **Synthetic config option + process flag (picked).** `main.mjs` appends a `context_tier` select to every
   session's `configOptions` and handles `setConfig("context_tier", …)` itself (restart + reload) instead of
   forwarding it to Copilot. The renderer already draws every select in `configOptions`, so the UI work is
   small; the start flag is the only lever Copilot offers.
2. **Write Copilot's persisted `contextTier` setting.** Global for all Copilot sessions (CLI too), no
   per-session choice, and not verified to apply in ACP mode. Rejected.
3. **Separate UI control and IPC channel.** Same behaviour as 1 with more renderer code. Rejected.

## Design

- **Storage**: overrides in `userData/context-tiers.json` (`{ [sessionId]: "default" | "long_context" }`); a
  missing entry means *Default*. Entry removed when the session is deleted.
- **Effective tier**: `override ?? settings.contextTier ?? "default"` — a pure function, unit-tested.
- **Spawn**: `AcpConnection` takes extra args; `connect()` passes `["--context", "long_context"]` for 1M. Both
  `session/new` and `session/load` paths (and delegated children) go through it.
- **Switch**: save the override, close the session's process as the app does today before a reopen, start a
  new one with the new flag and `session/load` it; the view gets fresh `configOptions`. A failure leaves an
  error in the log and the old override restored.
- **Config option**: `{ id: "context_tier", name: "Context", category: "_context", type: "select",
  currentValue, options }` with values `inherit` / `default` / `long_context`, labels *Default (…)*, *200k*,
  *1M*. Merged into every `configOptions` that main sends to the window (create, open, update, delegation).

## Left to the builder

- Exact reuse of the existing close/reopen code for the restart, and how the view shows the reconnect.
- Where the Settings field sits in the Settings dialog.
