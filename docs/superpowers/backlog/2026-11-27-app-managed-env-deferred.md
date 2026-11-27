# The extension inside the app's Copilot: deferred findings

**Sources:** the task review (Opus 5.5, high) and the final whole-branch review (Fable 5.2, medium) of
`fix/app-managed-env`. Execution was inline.

The bug, from the corp PC's logs (v0.37.0): the app registered a session as `cli:<id>` on stream s1 (`alias=app:…`,
`caps=links`); half a second later stream s2 opened for the same key without alias or caps (the copilot-relay
extension, loaded by the Copilot the app starts with `--acp`). The broker gives the newest stream the session, so both
`session_request` events went to s2 and no approval card appeared; messages to the session went there too. Which
client won depended on the order of the registrations, which is why a restart could "fix" it.

None of these blocked the merge. Line numbers were taken at the review and may drift.

**Fixed on the branch, so not listed below:**
- Every Copilot the app starts (ACP sessions through `connect()`, the headless quota CLI) gets
  `COPILOT_RELAY_MANAGED=1` (`copilotEnv`, `electron/copilot-command.mjs`); the extension then joins without its relay
  client, as in the broker's own sessions. Tests: unit (`copilot-command`, `copilot-runtime`), a UI check
  (`copilot-env-managed`, fails without the fix).
- The broker names a takeover: WARN when a stream without the app's alias takes an app session from the app's stream
  (naming the old stream's number), INFO for any other new stream of a key whose old stream is still open (a reconnect
  before the old close, or a second client).

## A. Worth doing first

1. **The fix is not verified on the corp PC.**
   - Check: after updating the app (and the broker checkout, Settings → Relay → Update and restart broker), broker.log
     has one `open cli:<id> alias=app:…` per session and no `takes … over from the app's stream` line; approval cards and
     messages reach the app.
   - Not verified: that Copilot on Windows with `--acp` passes its environment to the extension's process, and that the
     installed copy in `~/.copilot/extensions/copilot-relay` has the `COPILOT_RELAY_MANAGED` check
     (`extension/copilot-relay/extension.mjs:32`; `scripts/install-extension.mjs` installs it).
   - If takeovers still show: let the broker refuse (409) a stream without the app's alias while the app's stream of
     that key is online, and let the extension treat 409 as "managed elsewhere" (a long back-off or passive) so its log
     does not fill. Trade-offs (task review): it fixes the symptom even when the variable does not arrive; while both
     run, a real second client (the same session resumed in a terminal) gets no relay; older extensions read 409 as a
     broker outage. A standby stream promoted on the app's close is cleaner but needs new per-key state in the close
     and inbox logic.

## B. Window and wording

(none)

## C. Small behaviour

1. **A `copilot` that the agent runs inside an app session stays off the relay.**
   - Copilot passes its environment on to its children (the agent's shell commands, the user's MCP servers), so a nested
     `copilot` inherits `COPILOT_RELAY_MANAGED=1`. The broker's own sessions already behave this way. Known limitation.

## D. Tests and housekeeping

1. The UI check covers the scripted agent only: it proves what the app passes, not what the real Copilot does with it.
