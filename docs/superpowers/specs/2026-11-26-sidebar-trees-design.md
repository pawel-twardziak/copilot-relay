# Spec: Sidebar lists session trees, each session once (`sidebar-trees`)

Implementation starts from `main` (after the cache keeper merge, `a5d26bc`). The version is decided at the merge.

## Intent

The owner wants the sidebar's session list to be orderly. Today a session can show up twice: an open session is in
**Open in app** and also in its project (or in **📌 Pinned**). A child sits under its parent only when both are in the
same group, so a child in another project folder, or a closed child of an open parent, is listed apart from its
parent.

## The owner's rules

1. A session with children always has them under it, whether they are open or not and whatever their project.
2. **Open in app** and **📌 Pinned** never share a session: a session is in one of them or in neither.
3. A pinned parent, or any pinned child, moves the whole tree into Pinned, and then it is not in Open in app.

Accepted proposals (2026-11-26):

- A tree with an open member (only a child, say) goes into Open in app as a whole, like rule 3 for pins.
- Every session is listed exactly once in the whole sidebar: a tree in Pinned or Open in app is not in its project.
- A tree belongs to the project of its root's `cwd`. A member with a different `cwd` shows its folder in its meta
  line.
- Search: when any member matches, the whole tree is shown.
- Trees are ordered by the newest activity of any member (`UiState.activityAt`), newest first.

## Approaches

- **A. One pure tree model in `ui-state.js` (picked).** `listModel` builds the trees, assigns each one to a section,
  filters and sorts; `renderList` only draws it. "Each session once" follows from the model itself, and every rule
  is unit-testable without the DOM.
- B. Patches in `renderList` (sets of pinned and open trees, `SessionTree.nest` widened to children outside the
  group). Smaller diff, but the exclusion rules spread over DOM code and are hard to test.

## Design

**Trees.** A tree is a root and all its descendants by the link index (`SessionTree.index`, `childrenOf` /
`parentOf`). A session is a root when it has no parent, its parent is itself, or its parent is not among the listed
rows (for example a parent that Copilot no longer lists and that is not open). Such a root keeps its "child of X" /
"parent deleted" label, as today. Cycles stay safe: a member is placed once, and a cycle with no root is started from
its first member (as `nest` does now).

**Rows.** The rows are Copilot's session list plus every open view whose session is not in it (built from the view,
as Open in app does now). Linked sessions that are neither listed nor open get no row.

**Sections**, in this order:

1. **📌 Pinned**: trees with at least one pinned member. Every row shows its folder (as today).
2. **Open in app**: other trees with at least one open view.
3. **Projects**: the remaining trees, grouped by the root's `cwd`. The group's count is the number of sessions in its
   trees. Collapsing and the "+" button work as today.

**Within a tree** the rows are depth-first: children under their parent in link creation order (as `nest` does), drawn
with the `└` branch and `--depth` indent. A member whose `cwd` differs from the root's shows its folder.

**Search** keeps a tree when any member matches the query (title, `cwd` or id); groups are shown expanded while
filtering, and the stored collapsed state is untouched (as today). Open in app is filtered too (today it is not).

**Pin button** stays per row and pins only that session. A row that is in Pinned because of another member shows an
unpressed pin. Unpinning the last pinned member moves the tree back to Open in app or its project.

## Model shape (builder's call within this)

`listModel(sessions, { pinned, open, collapsed, query, tree })` returns
`{ pinned: Row[], open: Row[], groups: [{ cwd, rows: Row[], count, collapsed }] }`, with
`Row = { s, depth, showProject }`. `open` is the set of session ids with an open view; `tree` is the
`SessionTree.index` result. `renderList` maps rows to `item()`.

## Non-goals

- No change to how links, pins or collapsed folders are stored.
- No change to the per-view relation bar or to closing and deleting sub-sessions.

## Tests

Unit tests in `electron/test/ui-state.test.mjs` for each rule: no session twice; a pinned child pulls in the tree; an
open child pulls in the tree; Pinned wins over Open in app; a closed child of an open parent stays under it; a child in
another folder stays under its parent and shows its folder; search on a child shows the whole tree; tree order by its
newest member; project count. The existing `listModel` tests are adapted to the new shape.
