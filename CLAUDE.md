# Rules for agents working in this repository

These are the owner's standing rules. They apply to every session and every subagent, in the main checkout and in
worktrees.

## Review findings go to the backlog

Every review finding that is not fixed (deferred, parked, or left out of a fix wave) is written to a backlog file
in the repo. A scratch ledger, a worktree or the conversation is not a backlog: they disappear.

- Where: `docs/superpowers/backlog/YYYY-MM-DD-<topic>-deferred.md`, in the layout of the files already there:
  A. worth doing first (with analysis and a proposal for each), B. window and wording, C. small behaviour,
  D. tests and housekeeping.
- When: while finishing the branch, before its worktree or scratch workspace is removed. Commit it on the feature
  branch, so it merges with the feature. Do not ask first.
- What: each finding with its file and symbol (line numbers while they are still valid), known limitations, and
  anything a reviewer could not verify (a platform that was not run, a manual check that is still open).

## Version tags

A version tag (`vX.Y.Z`, annotated, message = the tag name) goes on the merge commit on `main`
(`git merge --no-ff`), never on a commit of a feature or fix branch. Pushing a `v*` tag starts the "Desktop app"
release workflow.

## Reviews

Review subagents (design reviews, task reviews, re-reviews, whole-branch reviews) run on the strongest available
model with high reasoning effort. Implementers may use cheaper models.
