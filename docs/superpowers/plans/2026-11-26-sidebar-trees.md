# Sidebar trees Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The sidebar lists session trees (a root and all its descendants) in three sections — 📌 Pinned, Open in app,
projects — with every session exactly once.

**Architecture:** `UiState.listModel` (pure, `electron/renderer/ui-state.js`) builds the trees from the rows and the
link index, assigns each tree to a section, filters and sorts, and returns flat rows with depth. `renderList` in
`electron/renderer/app.js` only merges the rows and draws the model. `SessionTree.nest` becomes unused and is removed.

**Tech Stack:** plain JS (classic `<script>` + `require()` in tests), `node:test`, the UI check harness
(`scripts/ui-check`, xvfb + scripted agent).

**Spec:** `docs/superpowers/specs/2026-11-26-sidebar-trees-design.md`

## Global Constraints

- Section order: `📌 Pinned`, `Open in app`, then one group per project folder. Titles unchanged.
- Every session id appears at most once in `#session-list`.
- Pinned wins over Open in app; a tree with any pinned member is in Pinned, else with any open member in Open in app,
  else in the group of its root's `cwd`.
- Tree order, newest first, by the newest `UiState.activityAt` of any member; groups ordered by their newest tree.
- Children under their parent in `tree.childrenOf` order (link `createdAt`), depth-first.
- Search keeps a whole tree when any member matches (`title`, `cwd` or `sessionId`, lower-cased); groups expanded while
  filtering; the stored `collapsed` set untouched.
- No change to storage of pins, collapsed folders or links.

## Review Focus

1. An open view whose session Copilot does not list (a child just created) and whose parent is listed: it must sit
   under that parent, not as its own tree. → Task 1 test "an unlisted open child sits under its listed parent"
   (rows are passed in already merged) and the UI check in Task 2.
2. A child whose parent is neither listed nor open: it is a root and keeps its "child of X" label. → Task 1 test
   "a child of an absent parent is a root"; Task 2 keeps `item()`'s label logic for `depth === 0`.
3. A link cycle (a→b→a) must not hang and must list each member once. → Task 1 test "a cycle lists each member once".
4. A session that is both listed and open must not be drawn twice. → Task 2 merge dedupes by id; UI check asserts no
   duplicate `title` lines.
5. A stale pinned id (deleted session) must not create an empty Pinned section. → Task 1 test "stale pinned ids are
   ignored" (kept from the old tests).

---

### Task 1: Tree model in `listModel`

**Files:**
- Modify: `electron/renderer/ui-state.js:11-36` (`listModel` and its comment)
- Test: `electron/test/ui-state.test.mjs` (the `listModel` tests, lines 9-~75)

**Interfaces:**
- Produces:
  `listModel(rows, { pinned = new Set(), open = new Set(), collapsed = new Set(), query = "", tree = { parentOf: new Map(), childrenOf: new Map() } } = {})`
  → `{ pinned: Row[], open: Row[], groups: { cwd, rows: Row[], count, collapsed }[] }`,
  `Row = { s, depth, showProject }`. `rows`: `{ sessionId, cwd, title, updatedAt, lastActivityAt? }[]`, ids unique.
  `tree`: a `SessionTree.index(links)` result (only `parentOf` and `childrenOf` are read). `count` = number of rows in
  the group. The group field is renamed from `sessions` to `rows`.

- [ ] **Step 1: Rewrite the `listModel` tests for the new shape and add the tree tests**

In the test file add `const SessionTree = createRequire(import.meta.url)("../renderer/session-tree.js");`, a link helper
`L(id, parent, createdAt)` as in `session-tree.test.mjs`, `const ids = (rows) => rows.map((r) => r.s.sessionId);` and
`const flat = (rows) => rows.map((r) => \`${r.s.sessionId}:${r.depth}\`);`. Keep the existing seven tests, adapted to
`groups[i].rows` and `ids(m.pinned)`. New tests (`tree = SessionTree.index([...])`):

- "a child stays under its parent across folders": rows `p` (/a), `c` (/b), links `c→p`; `groups` = one group `/a`,
  `flat` = `["p:0","c:1"]`, `c` row `showProject === true`, `p` row `false`, `count === 2`.
- "a pinned child pulls its tree into Pinned": rows `p`,`c`,`x`; `c→p`; `pinned {c}`; `flat(m.pinned)` = `["p:0","c:1"]`;
  every `showProject` in Pinned is `true`; no group contains `p` or `c`.
- "an open child pulls its tree into Open in app": `open {c}`; `flat(m.open)` = `["p:0","c:1"]`; groups without them.
- "Pinned wins over Open in app": `pinned {p}`, `open {c}`; `m.open` empty, `flat(m.pinned)` = `["p:0","c:1"]`.
- "a closed child of an open parent stays under it": `open {p}`; `flat(m.open)` = `["p:0","c:1"]`.
- "grandchildren nest depth-first in link order": `a→p` (t1), `b→p` (t2), `g→a`; `flat` = `["p:0","a:1","g:2","b:1"]`.
- "search on a child shows the whole tree": `c` titled "needle"; `query "needle"` → group `/a` `flat` = `["p:0","c:1"]`.
- "trees are ordered by their newest member": tree `p`(old)+`c`(newest overall) and tree `q`(middle), same folder →
  `ids(group.rows)` = `["p","c","q"]`.
- "an unlisted open child sits under its listed parent": rows include `c` built from a view (`{ sessionId: "c", cwd: "/a", title: "c" }`, no dates), `open {c}`, `c→p` → `flat(m.open)` = `["p:0","c:1"]`.
- "a child of an absent parent is a root": rows `c` only, `c→gone` → one group, `flat` = `["c:0"]`.
- "a cycle lists each member once": links `a→b`, `b→a`, rows `a`,`b` → total rows over all sections = 2, ids unique.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test electron/test/ui-state.test.mjs`
Expected: FAIL (old shape: `rows` undefined, `m.open` undefined).

- [ ] **Step 3: Implement `listModel` in `electron/renderer/ui-state.js`**

Algorithm (keep the existing `time`/`newestFirst` helpers):
1. `byId` = map of rows. A row is a root when `tree.parentOf.get(id)` is null, equals `id`, or is not in `byId`.
2. Build trees: for each root (in row order) emit depth-first over `tree.childrenOf` (only ids in `byId`, each id
   once via a `done` set); then, for rows still not done (cycle members), emit from each the same way. A tree is
   `{ root, rows: [{ s, depth }], latest }`, `latest` = max `time()` of its members.
3. Drop trees where `query` is set and no member matches.
4. Section: any member in `pinned` → pinned; else any in `open` → open; else group `root.cwd`.
5. `showProject`: `true` for every Pinned row; elsewhere `s.cwd !== root.cwd`.
6. Sort trees in each section newest `latest` first; groups by their first tree's `latest`; flatten each section's
   trees into rows. `collapsed: collapsed.has(cwd) && !query`, `count` = rows in the group.
Update the comment above `listModel` to state the three sections and the tree rule.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test electron/test/ui-state.test.mjs`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add electron/renderer/ui-state.js electron/test/ui-state.test.mjs
git commit -m "feat(sidebar): list model builds session trees, each session once"
```

### Task 2: Draw the model; UI check

**Files:**
- Modify: `electron/renderer/app.js` — `renderList` (~3722-3741), `groupBlock` (~3679, uses `g.sessions`),
  `nestedItems` (~3716, removed), `item()` (~3252, comment on `showProject`)
- Modify: `electron/renderer/session-tree.js` (remove `nest`, ~64-81, and from the export object line 115)
- Modify: `electron/test/session-tree.test.mjs` (remove the `nest` tests and `nest` from the destructuring)
- Modify: `scripts/ui-check/checks.mjs` (new check `sidebar-trees`)

**Interfaces:**
- Consumes: `UiState.listModel` and `Row` from Task 1.
- Produces: `rowItems(rows)` in `app.js` — `rows.map(({ s, depth, showProject }) => item(s, views.get(s.sessionId), { depth, showProject }))`.

- [ ] **Step 1: Write the UI check `sidebar-trees` in `scripts/ui-check/checks.mjs`**

`modes: ["off"]`, default scenario. In one `app.ev` (synchronous, so no refresh interleaves): set the page's
`sessions` to listed rows `P` (cwd `/x/a`, newest), `C` (cwd `/x/b`), `Q` (cwd `/x/a`), `R` (cwd `/x/a`); call
`setLinks([{ key: "cli:C", parent: "cli:P", createdAt: 1, parentDeleted: false }])`; `ui.pinned` = `new Set(["Q"])`;
`renderList()`; return, for every `#session-list` child, `group-title` text or the row's session id (from the
`.item` `title`'s third line) with its `--depth`. The scripted agent's own open session (`scripted-work`) is the only
open view. Assert, with exact arrays:
- order: `📌 Pinned`, `Q`, `Open in app`, `scripted-work`, then the `/x/a` group title, `P` (depth 0), `C` (depth 1), `R`;
- no session id twice;
- `C`'s meta line (`.m`) contains `b` (its folder) and no `child of`.
Then pin `C` (`ui.pinned.add("C"); renderList()`) and assert `P`, `C` moved under `📌 Pinned` and are gone from the group.
Restore `ui.pinned` to its old value at the end of the `ev`.

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/ui-check/run.mjs sidebar-trees`
Expected: `FAIL  sidebar-trees [off]` (today `C` is a root in `/x/b` and Open in app duplicates).

- [ ] **Step 3: Rewrite `renderList` and `groupBlock`**

`renderList`: rows = `sessions` plus, for each view not in `sessions`, `{ sessionId, cwd: v.cwd, title: v.title }`
(as `openOnes` builds today); `open = new Set(views.keys())`; `model = UiState.listModel(rows, { pinned: ui.pinned, open, collapsed: ui.collapsed, query: q, tree })`;
push `📌 Pinned` + `rowItems(model.pinned)`, then `Open in app` + `rowItems(model.open)` (each only when non-empty),
then `groupBlock(g)` per group. Keep the relation-bar loop and the "No matches" / "No sessions yet" line.
`groupBlock`: `rowItems(g.rows)` instead of `nestedItems(g.sessions)`. Remove `nestedItems`. Remove `nest` from
`session-tree.js` and its tests. Update `item()`'s comment: `showProject` = the row's folder differs from its tree's
root, or the row is in Pinned.

- [ ] **Step 4: Run the checks**

Run: `node scripts/ui-check/run.mjs sidebar-trees && npm test`
Expected: `ok    sidebar-trees [off]`; `npm test` all pass, 0 fail.

- [ ] **Step 5: Run the whole UI suite**

Run: `npm --prefix electron run copy-relay && node scripts/ui-check/run.mjs`
Expected: every line `ok`, exit code 0.

- [ ] **Step 6: Commit**

```bash
git add electron/renderer/app.js electron/renderer/session-tree.js electron/test/session-tree.test.mjs scripts/ui-check/checks.mjs
git commit -m "feat(sidebar): draw session trees in Pinned, Open in app and projects"
```
