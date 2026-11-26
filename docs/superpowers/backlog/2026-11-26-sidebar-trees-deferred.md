# Sidebar trees: deferred findings

**Sources:** the final whole-branch review (fable, medium) of `feat/sidebar-trees`. The branch ran inline (native
execution), so there were no task reviews.

Spec: `docs/superpowers/specs/2026-11-26-sidebar-trees-design.md`. Plan: `docs/superpowers/plans/2026-11-26-sidebar-trees.md`.

None of these blocked the merge. Line numbers were taken at the review that found them and may drift.

**Fixed on the branch, so not listed below:**
- **Folder of open sessions:** Open in app rows had no folder in their meta line (before, the session was also listed
  under its project header). Now Open in app shows every row's folder, as Pinned does.
- **A just-created session:** an open view Copilot did not list yet had no date, so it sorted to the bottom of Open in
  app and jumped to the top at the next refresh. Now a dateless row counts as the newest. The sort comparator also
  survives an invalid date (NaN), which the old `newestFirst` did not.

## A. Worth doing first

- None. A.1 (a project's header and "+" disappeared when all its trees were open or pinned) was decided by the owner
  on 2026-11-26 — the header stays — and fixed on `fix/sidebar-project-headers`.

## B. Window and wording

- None.

## C. Small behaviour

1. **A cycle with a tail can split the tail from its parent** (`listModel`, `electron/renderer/ui-state.js:43`, the
   "cycle members" loop).
   - For links a→b→a plus c→a, with c listed first, the output is `c:0, a:0, b:1`. c is its own tree labelled "child
     of a", and pinning c does not pull a and b into Pinned. Nothing hangs and nothing is listed twice;
     `SessionTree.nest` behaved the same.
   - *Proposal:* in the second loop, start only from members that lie on a cycle, so the tail is emitted under its
     parent.

## D. Tests and housekeeping

1. **UI check does not exercise an unlisted open child under a listed parent** (`scripts/ui-check/checks.mjs:3859`,
   `sidebar-trees`). Its unlisted open view (`scripted-work`) has no link to a listed parent, so the `renderList` merge
   (`electron/renderer/app.js:3730`) is covered only by the unit test.
2. **"child of X" on a root whose parent is absent is asserted nowhere.** The check only asserts that a nested child
   does not show it.
3. **The cycle unit test** ("a cycle lists each member once", `electron/test/ui-state.test.mjs`) asserts neither the
   depths nor the tail case of C.1.
4. **No unit test that a query hides a non-matching Open in app tree.** This behaviour is new with this branch.
5. **Not verified:** a manual visual check of the indent and branch marks in Pinned and Open in app on a real machine
   (only the xvfb UI check ran), and Windows/macOS.
