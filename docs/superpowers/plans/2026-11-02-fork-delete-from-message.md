# Plan: Fork / Delete from a message

Spec: `docs/superpowers/specs/2026-11-02-fork-delete-from-message.md` (approved 2026-11-02).

## Components and order

```
T1 history.mjs (pure file logic) ──► T2 tests ──► T3 IPC in main + preload ──► T4 renderer turn tracking
                                                                              └► T5 renderer actions/flows ──► T6 docs + manual test
```

T1/T2 are built test-first together; T3 depends on T1; T4 and T5 are sequential in `app.js`.

### Key design decisions

- **One location for format knowledge**: only `history.mjs` reads/writes `events.jsonl` and `workspace.yaml`.
  If Copilot changes the format, the fix is in one file and tests describe the expected shape.
- **Cut target sent by the renderer**: `{ ordinal, text, where }`, `where` ∈ `beforeUser | afterReply | beforeReply`
  (fork-from-user = `beforeUser`, fork-from-reply = `afterReply`, delete-from-user = `beforeUser`,
  delete-from-reply = `beforeReply`).
- **Turn tracking in `SessionView.append(el)`**: the single place every log element passes through. A user/relay
  bubble increments `this.turn` and gets user actions; the first `msg agent` or `tool` card after it gets reply
  actions. Elements before the first user message get none.
- **Delete orchestration in main**: `sessions:truncate` closes the entry (same code as `sessions:close`, extracted
  to `closeEntry()`), edits files, and returns; the renderer then calls the existing `openSession` flow to rebuild
  the view. If editing throws, nothing was written (atomic), the renderer reopens anyway and shows the error.
- **Path safety**: session id must match a UUID regex; dir = `realpath(session-state)/<id>`, must not be a symlink.
  `COPILOT_HOME` env respected (same as `relayConfig`).

## Risks

| Risk | Mitigation |
|---|---|
| Copilot changes `events.jsonl` format | validation (first event `session.start`, every line JSON with `type`), clear error, tests pin the shape |
| UI ordinal drifts from events (rejected prompt, compaction) | text check + unique-text fallback, else error and no change |
| Session also open in terminal CLI | warning in confirm text; `.bak` for delete |
| Truncate during an in-flight write by Copilot | delete closes and kills the process first; actions disabled while busy |
| Relay registration after delete/reopen | reopen goes through `sessions:open`, which re-registers under the same `cli:<id>` key |

## Tasks

- [ ] **T1 – `electron/history.mjs`**
  - `sessionDir(id)` (UUID check, inside `session-state`, no symlink), `readEvents(dir)` (validated),
    `cutIndex(events, { ordinal, text, where })`, `forkSession(id, target, now)` → `{ sessionId, cwd, name, prefill }`,
    `truncateSession(id, target)` → `{ removed }` (count of dropped user messages; `.bak` + temp-file rename).
  - `countFrom(events, target)` for the confirm dialog ("N messages").
  - Acceptance: no Electron imports; pure `node:fs`/`node:path`/`node:crypto`.
  - Files: `electron/history.mjs`
- [ ] **T2 – tests** (written first, red → green with T1)
  - Fixture builder writing a fake `session-state/<uuid>/` with `events.jsonl` (3 turns, a relay turn, tool events,
    a `session.shutdown`/`resume` pair) and `workspace.yaml`; `COPILOT_HOME` pointed at a temp dir.
  - Cases: four cut kinds; afterReply on last turn = EOF; beforeReply on last turn; text mismatch → unique fallback;
    ambiguous/absent → throws; fork dir has new id in first event + `workspace.yaml`, original byte-identical;
    truncate writes `.bak`, result parses; invalid id / symlinked dir / missing dir → throws.
  - Verify: `node --test 'electron/test/*.test.mjs'` green.
  - Files: `electron/test/history.test.mjs`
- [ ] **T3 – IPC**
  - `main.mjs`: extract `closeEntry(sessionId)` from `sessions:close`; add `sessions:fork(sessionId, target)` and
    `sessions:truncate(sessionId, target)` (refuses if the session is mid-prompt: track `entry.prompting` in
    `sessions:prompt`); `sessions:countFrom(sessionId, target)`.
  - `preload.cjs`: `forkSession`, `truncateSession`, `countFrom`.
  - Verify: tests still green; app starts; `api.forkSession` from devtools on an open session creates a dir.
  - Files: `electron/main.mjs`, `electron/preload.cjs`
- [ ] **T4 – renderer turn tracking**
  - `SessionView`: `this.turn = 0`; in `append(el)`: user/relay bubble → `turn++`, `el._turn`, `el._matchText`
    (getter: replayed run text / bubble text / relay `m.text`); first agent text or tool card of the turn →
    `el._turn`, reply flag. Reset on view rebuild (new view object, so automatic).
  - Verify: devtools – every bubble/first reply has the right `_turn` after a resume and after new prompts.
  - Files: `electron/renderer/app.js`
- [ ] **T5 – renderer actions and flows**
  - Small "Fork" / "Delete" buttons next to Copy on marked elements (hover-revealed like Copy); disabled via a
    `.session-view.busy` class while busy/dead.
  - Fork: `api.forkSession` → `refresh()` → `openSession(res)` → prefill input with `res.prefill` (user case).
  - Delete: `api.countFrom` → `confirm(...)` → `api.truncateSession` → rebuild view via `openSession` (remove old
    view first) → on error reopen + `error()`.
  - Verify: manual in app on a scratch session (all 4 actions + relay message).
  - Files: `electron/renderer/app.js`, `electron/renderer/style.css`
- [ ] **T6 – docs + full manual check**
  - `electron/README.md`: feature + limitations (files not reverted, `.bak`, terminal CLI warning).
  - Manual: run spec Success Criteria 1–5 with real Copilot; prompt in each result to check model context; restart
    app and confirm fork persists.
  - Files: `electron/README.md`

## Checkpoints

1. After T1+T2: tests green → show you the test list.
2. After T3: IPC smoke test.
3. After T5/T6: manual test results in the real app; then you decide on commit / tag.
