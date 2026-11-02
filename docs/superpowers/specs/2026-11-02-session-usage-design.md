# Session usage & context display — Design

Date: 2026-11-02 · Status: draft for approval · Area: desktop app (`electron/`)

The Windows relay registration problem from the same request is **deferred** (broker started working on the user's laptop); it is out of scope here.

## 1. Intent

The user wants to see, in the desktop app ("Copilot Sessions"), for each session, the current usage the way Copilot CLI shows it (`/usage`: AI credits, requests, tokens) and the context window size and how much of it is used (`/context`: e.g. `22k/200k tokens (11%)`). Why: the app is the user's main way of working with several Copilot sessions; today they are blind to cost and to how close a session is to a full context (compaction, degraded answers).

## 2. Findings (verified on Linux, Copilot CLI 1.0.106-2, by probing `copilot --acp --stdio` and reading `~/.copilot`)

| What | Source | Shape / example |
|---|---|---|
| Context used / size | ACP `session/update` notification, sent during every turn (not before the first prompt) | `{"sessionUpdate":"usage_update","used":22899,"size":200000}` |
| AI credits (session) | `$COPILOT_HOME/session-state/<sessionId>/events.jsonl`, last `session.usage_checkpoint` event (one per turn) | `data.totalNanoAiu = 3863730000` → **3.86 AI credits** (identical to `/usage`) |
| Premium requests (session) | same event | `data.totalPremiumRequests = 1` |
| Tokens (session) | same event, summed over `data.accountingSnapshot.modelMetrics[<model>].usage` | `inputTokens 31081, outputTokens 4, cacheReadTokens 16293, cacheWriteTokens 14784, reasoningTokens 0` (= `/usage`: `input 31.1k, output 4, cached 16.3k`) |
| Code changes (session) | same event, `data.accountingSnapshot.codeChanges` | `linesAdded, linesRemoved` (= `/usage` `Changes: +0 -0`) |
| Monthly premium quota (account) | some events in any session's `events.jsonl` (seen on `model.model_call_success`), `data.quotaSnapshots.premium_interactions` | `entitlementRequests 1500, usedRequests 109, remainingPercentage 92.7, resetDate "2026-12-01T00:00:00Z", isUnlimitedEntitlement false` — not in every session; newest one wins |

`$COPILOT_HOME` defaults to `~/.copilot` (Windows `%USERPROFILE%\.copilot`). The `usage` object in the `session/prompt` result is ignored (unclear if per turn or cumulative). Sending `/usage` or `/context` as hidden prompts is rejected: it would pollute the session history.

## 3. Goals

- G1. Each open session shows live context usage: used / size, percentage, warning colour near full.
- G2. Each open session shows session usage: AI credits; details (premium requests, tokens, lines changed) on hover.
- G3. Numbers match `/usage` and `/context` of Copilot CLI for the same session (context within CLI rounding).
- G4. The app shows the account's monthly premium quota (used / total, % left, reset date) when Copilot has recorded it.
- G5. Works on Linux and Windows (paths, `COPILOT_HOME`, non-ASCII user folders).

## 4. Non-goals

- Fetching quota from GitHub APIs or using auth tokens — only local Copilot files.
- Usage history, charts, money cost, per-model breakdown.
- Usage in the broker's web GUI or in terminal sessions.
- Usage for sessions in the sidebar list that are not open.

## 5. Anti-goals

- Invented or estimated numbers shown as Copilot's: unknown → `—`.
- Anything that adds messages to the user's Copilot session history.
- The app hanging, crashing or spamming errors when `events.jsonl` is missing, huge or half-written, or when Copilot changes the file format (fields missing → `—`).
- Noticeable UI lag while streaming because of usage reads.

## 6. Design

### 6.1 Reader + formatter (`electron/usage.mjs`, pure Node, no Electron imports)

- Reads per-session usage from the session's `events.jsonl`: last `session.usage_checkpoint`; reads the file tail first, the whole file only as a capped fallback. Malformed lines skipped; missing file/data → `null`.
- Reads account quota from the tails of the few most recently modified `session-state/*/events.jsonl`; newest `quotaSnapshots.premium_interactions` wins; none → `null`.
- Turns context + session usage + quota into display strings, so formatting is unit-tested:
  - context `22.9k / 200k · 11%`; level `ok` < 80 %, `warn` ≥ 80 %, `full` ≥ 95 %; percentage clamped 0–100; size 0/unknown → no context.
  - credits `3.86 AI credits` (2 decimals).
  - tooltip `Requests: 1 premium · Tokens: input 31.1k, output 4, cached 16.3k · Changes: +0 −0`.
  - quota `Premium: 109 / 1500 used · 92.7% left · resets Dec 1`, or `Premium: unlimited`.
  - token numbers: `4`, `22.9k`, `200k`, `1.25M`.

### 6.2 Wiring (`electron/main.mjs`, `preload.cjs`)

- Main keeps the latest `used/size` per open session from `usage_update`.
- Main pushes an updated view to the window after each `usage_update`, after every prompt finishes (typed in the app, from the relay web GUI, or from another session; also on cancel/error), and after a session is opened or created. Debounced per session; quota cached ≈ 60 s.

### 6.3 UI (`electron/renderer/`)

- Session header, next to the relay chip: small meter bar + `22.9k / 200k · 11%` + `· 3.86 AI credits`; `context: —` until the first `usage_update`; credits part hidden until known; details in the tooltip.
- Sidebar footer: the quota line (account-wide), hidden when unknown.

### 6.4 Tests and CI

- `npm test` at repo root (`node --test test/`), covering the reader (incl. half-written last line, missing file, large file, path with spaces and `ł`, `COPILOT_HOME`) and all formatting rules above. Fixtures: trimmed real `events.jsonl` lines.
- New workflow running `npm test` on `ubuntu-latest` and `windows-latest` on push/PR.

## 7. Constraints

- Node ≥ 22 ESM, Electron 45, `node:test`; no new dependencies.
- UI copy in English.
- New file `electron/usage.mjs` must be added to `build.files` in `electron/package.json`.

## 8. Calls made by me — please check

- Data from Copilot's local `events.jsonl` (internal format, may change → `—`).
- Thresholds 80 % / 95 %, quota cache 60 s.
- Placement: header next to relay chip; quota in sidebar footer.
- Context shows `—` after opening an existing session until the next turn (Copilot sends no context figure before that).

## 9. Left to the builder

Function names, exact CSS, tail-read sizes and caps, debounce timing, fixture layout.
