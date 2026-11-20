# Context window 200k / 1M Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the desktop app run a session with Copilot's 1M context window, via a global default in Settings and a per-session "Context" select.

**Architecture:** Copilot only offers the tier as a start flag (`copilot --acp --stdio --context long_context`), so the app picks the flag per process. A new pure module `electron/context-tier.mjs` holds the tier logic and the per-session override store; `main.mjs` passes the flag when it spawns Copilot and appends a synthetic `context_tier` select to the `configOptions` it sends to the window. Changing that select closes the session's process and the renderer reopens the session (the same close → `session/load` path a message delete uses).

**Tech Stack:** Electron (main `electron/main.mjs`, sandboxed renderer `electron/renderer/app.js`, `electron/preload.cjs`), Node ESM, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-20-context-tier-design.md`

## Global Constraints

- Tier values sent to Copilot: `default`, `long_context`. Flag: `["--context", "long_context"]`; no flag for `default`.
- Select values: `inherit` (follow Settings), `default`, `long_context`; labels `Default (200k)` / `Default (1M)`, `200k`, `1M`.
- Settings key: `contextTier` in the app's `settings.json`; missing or invalid means `default` (200k).
- Overrides file: `path.join(app.getPath("userData"), "context-tiers.json")`, shape `{ [sessionId]: "default" | "long_context" }`; no entry means `inherit`.
- Changing the Settings default never restarts open sessions.
- UI copy in English (the app's language).
- Tests: `npm test` from the repo root (`node --test "electron/test/*.test.mjs"`) stays green.

## Review Focus

- **Switch requested during a running turn**: refused with "Wait until Copilot finishes this turn.", the select shows the old value, the process is not restarted. (Task 3, manual check.)
- **Missing, empty or corrupt `context-tiers.json`**: read as "no overrides"; the app starts and sessions open on the Settings default. (Task 1 test.)
- **Close fails during a switch** (`closeAndWait` throws: Copilot won't exit): the previous override is restored and the error is shown in the session. A failed *reopen* afterwards is reported like any failed resume ("Could not resume this session…"); the new override stays (my call: the tier is not why a start fails). (Task 3.)
- **Fork of a 1M session**: the fork keeps the source's override, so a long history isn't loaded into 200k. **Delete** removes the entry. (Task 1 test for `copy`/`delete`, Task 2 wiring.)
- **Stale "Default (…)" label**: after changing Settings, an open view's label updates the next time it gets `configOptions` (reopen, model change). Accepted; not worth a refresh path.

---

### Task 1: Tier logic and override store

**Files:**
- Create: `electron/context-tier.mjs`
- Test: `electron/test/context-tier.test.mjs`

**Interfaces:**
- Produces (all exported from `electron/context-tier.mjs`):
  - `CONTEXT_OPTION_ID = "context_tier"`, `INHERIT = "inherit"`
  - `normalizeTier(value: unknown): "default" | "long_context" | null`
  - `effectiveTier(override: string | null | undefined, globalDefault: unknown): "default" | "long_context"` — a valid override wins, else `normalizeTier(globalDefault) ?? "default"`
  - `tierArgs(tier: string): string[]` — `["--context", "long_context"]` for `long_context`, else `[]`
  - `contextOption(override, globalDefault): object` — the config option below
  - `withContextOption(configOptions: unknown, override, globalDefault): object[]` — `configOptions` (non-array → `[]`) without any existing `context_tier` entry, plus `contextOption(...)` at the end
  - `createTierStore(file: string): { get(id): "default" | "long_context" | null, set(id, value): void, delete(id): void, copy(fromId, toId): void }` — `set` with `inherit`, `null` or an invalid value removes the entry; `copy` with no source entry removes the target's

- [ ] **Step 1: Write the failing tests** in `electron/test/context-tier.test.mjs` (temp dir per test via `fs.mkdtempSync(path.join(os.tmpdir(), "tier-test-"))`, removed in `afterEach`):

```js
test("effectiveTier: override wins, then the Settings default, then 200k", () => {
  assert.equal(effectiveTier("long_context", "default"), "long_context");
  assert.equal(effectiveTier(null, "long_context"), "long_context");
  assert.equal(effectiveTier("inherit", "long_context"), "long_context");
  assert.equal(effectiveTier(undefined, "bogus"), "default");
  assert.equal(effectiveTier("bogus", undefined), "default");
});
test("tierArgs", () => {
  assert.deepEqual(tierArgs("long_context"), ["--context", "long_context"]);
  assert.deepEqual(tierArgs("default"), []);
});
test("contextOption labels the Default entry with the Settings value", () => {
  const o = contextOption(null, "long_context");
  assert.equal(o.id, "context_tier");
  assert.equal(o.type, "select");
  assert.equal(o.currentValue, "inherit");
  assert.deepEqual(o.options.map((x) => [x.value, x.name]), [["inherit", "Default (1M)"], ["default", "200k"], ["long_context", "1M"]]);
  assert.equal(contextOption("default", undefined).currentValue, "default");
  assert.equal(contextOption(null, undefined).options[0].name, "Default (200k)");
});
test("withContextOption appends once and keeps Copilot's options", () => {
  const model = { id: "model", type: "select", options: [] };
  const out = withContextOption([model, { id: "context_tier" }], null, "default");
  assert.deepEqual(out.map((o) => o.id), ["model", "context_tier"]);
  assert.equal(out[1].name, "Context");
  assert.deepEqual(withContextOption(null, null, "default").map((o) => o.id), ["context_tier"]);
});
test("store: set, get, inherit removes, copy, delete, survives a new instance", () => { /* set a→long_context, b→default;
  get(a)==="long_context"; set(b,"inherit") → get(b)===null; copy(a,c) → get(c)==="long_context";
  copy("missing", c) → get(c)===null; delete(a) → get(a)===null; createTierStore(sameFile).get(...) sees the same */ });
test("store: missing, empty or corrupt file reads as no overrides", () => { /* no file → get null;
  write "" → get null; write "{not json" → get null, then set(x,"long_context") works and rewrites valid JSON */ });
```

- [ ] **Step 2: Run** `npm test` from the repo root. Expected: the new file FAILS (module not found); the other suites pass.

- [ ] **Step 3: Implement `electron/context-tier.mjs`.** Option object for `contextOption`:
  `{ id: "context_tier", name: "Context", category: "_context", type: "select", description: "Context window for this session. 1M needs a model with a long-context tier (e.g. Claude Sonnet 5.5) and may cost more. Changing it restarts this session's Copilot.", currentValue: normalizeTier(override) ?? "inherit", options: [...] }`.
  The store reads the JSON file on every call (it's tiny; no cache to go stale), treats any read/parse failure or a non-object as `{}`, and writes with `writeFileSync` to `file + ".tmp"` then `renameSync` (creating the directory with `mkdirSync(..., { recursive: true })`).

- [ ] **Step 4: Run** `npm test`. Expected: all suites PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/context-tier.mjs electron/test/context-tier.test.mjs
git commit -m "feat(desktop): context tier logic and per-session store"
```

### Task 2: Start Copilot with the session's tier and show the select

**Files:**
- Modify: `electron/acp.mjs` (constructor + `start()` spawn args)
- Modify: `electron/main.mjs` (`connect`, `createSession`, `openSession`, `attach` → `entry.update`, `sessions:new`, `sessions:setConfig`, `createChild`, `sessions:fork`, `sessions:delete`, `settings:get`, `settings:set`)

**Interfaces:**
- Consumes: everything from Task 1.
- Produces:
  - `new AcpConnection({ command, cwd, env, args = [] })` — spawns `[..."--acp", "--stdio", ...args]`
  - `connect(cwd, deadline, args = [])`
  - `createSession(cwd, link = {}, deadline, tier = null)` — `tier` null means the Settings default
  - `const tiers = createTierStore(path.join(app.getPath("userData"), "context-tiers.json"))` (module-level in `main.mjs`, created lazily or after `app` is ready — `app.getPath` works before `ready`, as `settingsFile()` already relies on)
  - `viewConfig(sessionId, configOptions)` → `withContextOption(configOptions, tiers.get(sessionId), loadSettings().contextTier)`
  - `settings:get` adds `contextTier: normalizeTier(loadSettings().contextTier) ?? "default"`; `settings:set` stores `contextTier: normalizeTier(s.contextTier) ?? "default"`

- [ ] **Step 1: `AcpConnection` takes `args`.** Add `args = []` to the constructor's options, keep it on `this`, spawn `["--acp", "--stdio", ...this.args]`. On Windows the spawn uses `shell: true`; the values are fixed literals without spaces, so no quoting is needed.

- [ ] **Step 2: Spawn with the tier.**
  - `openSession(sessionId, cwd)`: `connect(cwd, undefined, tierArgs(effectiveTier(tiers.get(sessionId), loadSettings().contextTier)))`.
  - `createSession(...)`: `connect(cwd, deadline, tierArgs(tier ?? effectiveTier(null, loadSettings().contextTier)))`.
  - `createChild`: compute `const tier = effectiveTier(tiers.get(parentSessionId), loadSettings().contextTier)` before `createSession`, pass it, and right after the child exists `tiers.set(child.sessionId, tier)` (an override, so a later reopen keeps it).

- [ ] **Step 3: Send the select with every `configOptions` the window gets.** Keep `entry.configOptions` as Copilot's own list (delegation's `resolveConfig`/`findModelOption` read it). Wrap with `viewConfig` where it leaves main: the `sessions:new` and `openSession` return values, `sessions:setConfig`'s return (when non-null), the `delegation:created` payload, and in `entry.update` send `{ ...u, configOptions: viewConfig(sessionId, u.configOptions) }` for `config_option_update`.

- [ ] **Step 4: Fork, delete, settings.**
  - `sessions:fork`: `const res = forkSession(sessionId, target); tiers.copy(sessionId, res.sessionId); return res;`
  - `sessions:delete`: after `deleteSession(...)` succeeds, `tiers.delete(sessionId)`.
  - `settings:get` / `settings:set`: add `contextTier` as in Interfaces.

- [ ] **Step 5: Run** `npm test`. Expected: all suites PASS.

- [ ] **Step 6: Manual check** (on a machine where Copilot answers; `npm start` in `electron/`): a new session shows a "Context" select with `Default (200k)`; with `"contextTier": "long_context"` added by hand to the app's `settings.json`, a new Claude Sonnet 5.5 session's context meter reads `… / 936k` after the first reply. Open sessions are not affected.

- [ ] **Step 7: Commit**

```bash
git add electron/acp.mjs electron/main.mjs
git commit -m "feat(desktop): start Copilot with the session's context tier"
```

### Task 3: Switch the tier of a session

**Files:**
- Modify: `electron/main.mjs` (new handler `sessions:setContextTier`)
- Modify: `electron/preload.cjs` (`setContextTier`)
- Modify: `electron/renderer/app.js` (`SessionView.setConfig` change handler, new `SessionView.switchContext`)

**Interfaces:**
- Consumes: `tiers`, `INHERIT`, `normalizeTier` (Task 1/2); existing `refuseWhilePrompting`, `historyOp`, `closeAndWait` in `main.mjs`; existing `reopenView(old, error)` in `app.js`.
- Produces: IPC `sessions:setContextTier(sessionId, value: "inherit" | "default" | "long_context") → { reopen: true }`; preload `api.setContextTier(sessionId, value)`.

- [ ] **Step 1: Main handler.** `sessions:setContextTier`:
  - throw `Invalid session id: …` unless `isSessionId(sessionId)`; throw `Unknown context window: …` unless `value === INHERIT || normalizeTier(value)`;
  - `refuseWhilePrompting(sessionId)`, then inside `historyOp(sessionId, …)` (it refuses while deleting / opening and blocks a parallel delete):
    `const prev = tiers.get(sessionId); tiers.set(sessionId, value); try { await closeAndWait(sessionId); } catch (e) { tiers.set(sessionId, prev ?? INHERIT); throw e; } return { reopen: true };`
  - A session that isn't open just has the override saved (closeAndWait is a no-op).

- [ ] **Step 2: Preload.** `setContextTier: (sessionId, value) => call("sessions:setContextTier", sessionId, value),` next to `setConfig`.

- [ ] **Step 3: Renderer.** In `setConfig`'s `change` listener, route `c.id === "context_tier"` to `this.switchContext(sel, c.currentValue)` instead of `api.setConfig`. `async switchContext(sel, previous)`:
  - if `this.busy || this.dead || this.deleting`: `sel.value = previous`, `this.error("Wait until Copilot finishes this turn.")` (for busy) and return;
  - `this.setBusy(true)`, `this.statusEl.textContent = "Restarting Copilot with the new context window…"`;
  - `let failure = null; try { await api.setContextTier(this.sessionId, sel.value); } catch (e) { failure = e; await api.closeSession(this.sessionId).catch(() => {}); }`
  - `await reopenView(this, failure && \`Could not change the context window: ${failure.message}\`);` — the reopen replays the history and brings fresh `configOptions` with the new `currentValue`.

- [ ] **Step 4: Run** `npm test`. Expected: all suites PASS.

- [ ] **Step 5: Manual check:** in a Sonnet 5.5 session with one reply, pick `1M` → status shows the restart, the history is still there, the select shows `1M`, the next reply's meter reads `/ 936k`. Close and reopen the app → the session still shows `1M`. Pick `Default (200k)` → back to `/ 200k`. Pick a value while a reply is streaming → refused, select reverts. Fork a message of the 1M session → the fork's select shows `1M`.

- [ ] **Step 6: Commit**

```bash
git add electron/main.mjs electron/preload.cjs electron/renderer/app.js
git commit -m "feat(desktop): switch a session's context window from its Context select"
```

### Task 4: Default context window in Settings

**Files:**
- Modify: `electron/renderer/index.html` (Settings dialog, after `#set-relay-hint`)
- Modify: `electron/renderer/app.js` (`openSettings`, the `#settings` close handler)

**Interfaces:**
- Consumes: `settings:get` → `contextTier`, `settings:set({ ..., contextTier })` (Task 2).

- [ ] **Step 1: Markup**, styled like the `Copilot CLI command` label:

```html
<label>
  Default context window
  <select id="set-context"><option value="default">200k</option><option value="long_context">1M</option></select>
</label>
<p class="hint">Used by new sessions and by sessions whose Context is "Default", the next time their Copilot starts. Open sessions keep theirs. 1M needs a model with a long-context tier (e.g. Claude Sonnet 5.5) and may cost more.</p>
```

- [ ] **Step 2: Wire it.** `openSettings`: `$("#set-context").value = s.contextTier;`. Close handler: add `contextTier: $("#set-context").value` to the `api.setSettings({...})` object.

- [ ] **Step 3: Run** `npm test`. Expected: all suites PASS.

- [ ] **Step 4: Manual check:** set 1M in Settings, save, reopen Settings → shows 1M; `settings.json` has `"contextTier": "long_context"`; a new session's select reads `Default (1M)` and its meter `/ 936k` after a reply; an already open session is unchanged until reopened.

- [ ] **Step 5: Commit**

```bash
git add electron/renderer/index.html electron/renderer/app.js
git commit -m "feat(desktop): default context window in Settings"
```
