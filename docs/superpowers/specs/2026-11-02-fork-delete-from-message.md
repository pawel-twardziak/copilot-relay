# Spec: Fork / Delete from a message (desktop app)

## Objective

In the Electron app (`electron/`), a user can take any message of an open session and either

- **Fork from here** – start a new session that contains the conversation up to that point, leaving the
  original untouched, or
- **Delete from here** – cut the original session's history at that point, permanently dropping that message
  and everything after it.

Copilot CLI's ACP (v1.0.106) has no fork/truncate method and does not expose `/fork` or `/rewind`, so the app
edits Copilot's own session files (`~/.copilot/session-state/<id>/events.jsonl`). A spike (2026-11-02) showed a
copied + truncated session is listed by `session/list`, replays only the kept turns on `session/load`, and the
model sees only the kept history.

### Semantics

The cut point is always an index into `events.jsonl`; everything from that index on is dropped.

| Action on                 | Fork from here                                                                     | Delete from here                                                        |
|---------------------------|------------------------------------------------------------------------------------|-------------------------------------------------------------------------|
| user/relay message **N**  | new session with turns 1…N−1; message N's text is put in the new session's input   | drops message N and all later events                                    |
| agent reply to turn **N** | new session with turns 1…N (reply included); input empty                           | drops the reply and everything later; message N stays without an answer |

- "Turn N" = the N-th `user.message` event. Cut indexes:
  - before user message N → index of the N-th `user.message`
  - after reply N → index of the (N+1)-th `user.message`, or end of file if there is none (fork only;
    deleting "from" the last reply = cut right after user message N)
  - before reply N → index of the N-th `user.message` + 1
- An agent reply in the UI = all agent text, thoughts, tool calls and plans between two user bubbles.
  The actions sit on the first agent text block of a turn (and on tool-only turns, on the first tool card).
- Relay messages (`[from …]`) are ordinary `user.message` events and behave the same.

### Fork details

- New UUID directory in `session-state`, copied from the original (`checkpoints/`, `files/`, `research/`,
  `rewind-file-snapshots/` copied as-is), `events.jsonl` truncated, first event's `data.sessionId` set to the new id.
- `workspace.yaml`: `id` = new id, `name` = `Fork of <original name>` (quoted YAML string), `user_named: true`,
  `created_at`/`updated_at` = now. Other lines kept.
- The fork is opened in the app right away (new tab, active) and the session list refreshes.
- The original session stays open and untouched.

### Delete details

- Confirmation dialog: "Delete this message and everything after it? (N messages). This cannot be undone in the
  app. Files changed by the agent are not reverted."
- Steps: close the session (`session/close` + kill process) → back up `events.jsonl` to `events.jsonl.bak`
  (overwriting an older backup) → write the truncated file atomically (temp file + rename) → reopen the
  session (view is rebuilt from the replay).
- On failure after closing, the session is reopened unchanged and the error is shown.

### Matching a UI bubble to an event

Every user/relay bubble (replayed or sent in this run, including hidden empty ones) gets a turn ordinal. The
renderer sends `{ ordinal, text }`; main verifies the N-th `user.message`'s `data.content` contains `text`
(whitespace-normalized). If not (e.g. a prompt rejected before it reached Copilot), it looks for the only
`user.message` containing `text`; zero or several matches → error "Could not find this message in the session
history", nothing changed.

### Availability

- Buttons only on user/relay bubbles and on agent replies, not on system/error notes or permission prompts.
- Disabled while the session is busy (prompting) or dead.
- A bubble whose prompt never reached Copilot (rejected in the app) keeps its buttons; using them gives the
  matching error above.

## Tech Stack

Electron app, plain ES modules (`electron/main.mjs`, `electron/renderer/app.js`, `electron/preload.cjs`), Node ≥ 20
built-ins only. No new dependencies.

## Commands

```
Run app:   npm run app                     (repo root)
Tests:     node --test 'electron/test/*.test.mjs'     (new, node:test, no deps)
Package:   npm --prefix electron run dist:linux
```

## Project Structure

```
electron/history.mjs        NEW  pure file logic: read events, find cut index, fork dir, truncate in place
electron/test/history.test.mjs  NEW  node:test tests on temp fixture dirs
electron/main.mjs           IPC handlers sessions:fork / sessions:truncate (close → edit → reopen orchestration)
electron/preload.cjs        api.forkSession / api.truncateSession
electron/renderer/app.js    turn ordinals on bubbles, message action buttons, flows
electron/renderer/style.css action button styling (same look as Copy)
electron/README.md          short feature note + limitations
```

## Code Style

Match existing code: small functions, JSDoc one-liners, `h()` DOM helper, IPC through `handle(channel, fn)`
returning readable errors.

```js
/** Index in `events` where history is cut, or throw if the bubble can't be matched. */
export function cutIndex(events, { ordinal, text, where }) { … }
```

## Testing Strategy

- Unit (`node --test`): `history.mjs` on fixture `events.jsonl` built in a temp `COPILOT_HOME`:
  cut indexes for all four cases, text matching fallback/ambiguity, fork dir contents + `workspace.yaml`,
  atomic truncate + `.bak`, refusal on a missing/invalid session dir.
- Manual in app (real Copilot): fork from user msg, fork from reply, delete from user msg, delete from reply,
  relay message, then send a prompt in each result and check the model's view of history.

## Boundaries

- Always: work on copies or with a `.bak`; validate the session id is a UUID and the dir is inside
  `session-state` (no symlink escape); write atomically.
- Ask first: reverting files from `rewind-file-snapshots`; touching `session-store.db`.
- Never: edit a session that is busy in the app; delete session directories.

## Success Criteria

1. Fork from user message N → new session with N−1 user turns, input prefilled, original unchanged.
2. Fork from reply N → new session with N turns.
3. Delete from user message N / reply N → after reopen the view and the model's context end at the cut.
4. The forked session appears in the list as `Fork of …` and survives an app restart.
5. Mismatched bubble → error, no files changed.
6. `node --test 'electron/test/*.test.mjs'` passes.

## Assumptions / Open Questions

1. Only one `.bak` is kept per session (latest delete). — OK?
2. Fork name `Fork of <name>`. — OK?
3. If the session is also open in a terminal Copilot CLI, the app can't detect it; the confirmation text warns.
4. Images attached to a forked user message are not re-attached (only the text goes to the input).
5. `session-store.db` (Copilot's search index) is not updated; it does not affect listing or resuming.
