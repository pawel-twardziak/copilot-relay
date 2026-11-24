# Session command: deferred findings

Source: the six task reviews (opus, high) and the final whole-branch review (fable, medium) of
`feat/session-command`. Spec: `docs/superpowers/specs/2026-11-24-session-command-design.md`; plan:
`docs/superpowers/plans/2026-11-24-session-command.md`. None of these blocked the merge. Line numbers were checked
at the final review's head (`a734335`) and may drift; the symbols are the stable reference.

Fixed during the work, so not listed below: after the app's own kill an exec'd shell that ended with an exit code
made `exit` come before the group was empty (Task 2 review); a `process.on(SIGINT/SIGTERM/SIGHUP)` handler that
Electron never runs (Task 3 review, removed); plain Enter in the command field cancelled the dialog (Task 5
review); and the final review's fix wave: `electron/README.md` still named the "Prompt" button and said nothing of
the new behaviour, the Settings remedy text pointed at a Setup that is not there, "Save and restart" on a dead view
with unchanged values did nothing, stale preload comments and formatting slips.

## A. Worth doing first (analysed below)

1. **The group check never gives up** (`electron/acp.mjs`, `#whenGroupEmpty`, about lines 135-145). After a signal
   ended the shell, the connection repeats `process.kill(-pid, 0)` every 50 ms until it fails with `ESRCH`. On any
   other error it repeats for good: `EPERM` when the only process left in the group belongs to another user (a
   tool's `sudo … &`), or a group of zombies nobody reaps. The timer is not `unref`'d (with `unref` the tests'
   process ended before the exit). For the user: after a restart, a rewind or a delete the session stays
   "Copilot is still running for this session" until the app is restarted, because `lingering` in
   `electron/main.mjs` is cleared only by `exit`.
   *Proposal:* a cap, for example 10 seconds after the `SIGKILL`, then treat the group as gone and log a warning
   that names the pid.

2. **`killAll` does not reach a Copilot that is still starting** (`electron/main.mjs`, `killAll`, `connect`,
   `getLister`). A connection is in `open` only after `attach`; one inside `connect` (waiting for `initialize`, now
   up to 60 seconds) and a lister in mid-start are in no list, so quitting the app in that window leaves them.
   Since this branch Copilot leads its own process group, so a signal to the app's group no longer reaches it
   either; it is left to end on its closed stdin, which was not checked with the real Copilot.
   *Proposal:* keep every connection from `new AcpConnection` to its exit in a set that `killAll` walks.

3. **Whether "a close ends the whole group" applies depends on how the real Copilot ends** (`electron/acp.mjs`,
   the `exit` handler; `electron/main.mjs`, `closeEntry`). `closeEntry` sends `session/close` and waits up to 2
   seconds before `kill()`. If the real Copilot exits by itself on `session/close`, a shell that does not replace
   itself (dash) exits with a code before this connection has killed anything: the group is then left alone, and
   what a tool left running in it survives, against what the owner decided. Not checked with the real Copilot.
   *Proposal:* tell the connection that a stop is meant before `session/close` is sent (a `stopping()` that makes
   the exit handler take the group path), then check with the real Copilot.

4. **Done in `feat/child-card-retry`** (the text of a failed start goes to the child's approval card only, and
   the parent is told nothing until the card is approved or rejected). It was: **a failed child start sends the
   parent's command line to the broker and to the parent's model**
   (`electron/main.mjs`, `createChild`'s catch, `tellParent(req, "failed", … friendly(e))`; the text is
   `startFailureText` in `electron/copilot-command.mjs`). The spec asks for the quoted command, and the spec also
   names `FOO=1 copilot` as the way to set a variable, so a token written that way travels in the text. A setup
   timeout on a loaded machine is enough to trigger it. The model already has that environment; the broker and its
   log are the new recipients. **The owner's decision.**
   *Proposal:* for the source `parent`, leave the quoted command out of the text sent to the parent ("the parent
   session's command could not be started: …"), or accept it and say so in the README.

## B. Window and wording

5. **A signal to the app with unreported children asks the "leaving children" question**, and "Cancel" keeps the
   app running (`confirmLeavingChildren`, `before-quit` in `electron/main.mjs`). Electron's own handling of
   `SIGINT`/`SIGTERM`/`SIGHUP` takes the ordinary quit path; Node's `process.on(signal)` never runs in the main
   process (checked on Electron 45.2.1, Linux). As before this feature.
6. **A cold start slower than 60 seconds to `initialize` now fails** (`START_TIMEOUT_MS` in `electron/main.mjs`),
   where it used to wait: a first `npx` download, a slow machine. Retrying works once the download is cached.
7. **A broken Settings command leaves the sidebar's list empty even when every session has a working command of
   its own**: the lister uses the Settings command (a non-goal of the spec).
8. **On Windows `cmd` expands `%VAR%` also inside double quotes**, so a command that is an existing file whose path
   holds `%…%` is altered (`shellLine` in `electron/copilot-command.mjs`). Already so before this branch for paths
   with spaces.
9. **`COPILOT_RELAY_START_TIMEOUT_MS`** is read by `electron/main.mjs` (about line 315). It exists for the UI check
   `new-session-start-deadline`; it is an undocumented way to change the start deadline and its text.
10. **`session-commands.json` and `settings.json` keep a command in plain text**, with any variable written into
    it. The spec defines the store this way.

## C. Behaviour, small

11. **A failed restore replaces the close error** (`saveSetup` in `electron/session-setup.mjs`, about lines 27 and
    32-36). If writing the previous value back throws, that error is shown and the close error is lost. Catch and
    log the restore's error, rethrow the first.
12. **A parent's stored command that is not valid** (a hand-edited `session-commands.json`: a line break, too
    long) fails the child's start with "The command must be one line.", while the parent itself falls back to
    Settings (`createSession` against `commandFor` in `electron/main.mjs`). Pass the parent's value through the same
    fallback.
13. **A failed `commands.set` after `prompts.set` leaves a prompt row for a session id the window never gets**
    (`createSession` in `electron/main.mjs`). The prompt store alone already left rows this way.
14. **A dead view is not busy while `setPrompt` runs** (`editPrompt` in `electron/renderer/app.js`). A reopen of
    the same session started in that moment (a reopen card approved elsewhere) could run alongside; main's
    `opening` guard refuses one side.
15. **`createSession` takes seven positional parameters** (`electron/main.mjs`); the child's call passes
    `…, tier, own, commands.get(parentSessionId), "parent"`. `connect` got an options object in this branch;
    `createSession` should get one before the next parameter.
16. **`shellLine("")` gives a line with a leading space**, and **`startFailureText` with an unknown source prints
    "undefined"** (`electron/copilot-command.mjs`). Neither is reachable through `resolveCommand` and the three
    call sites.
17. **Present before this branch, seen by the final review:** two `listSessions` calls while no lister exists start
    two listers and one is never killed (`getLister`); `sessions:close` followed at once by `sessions:open` can
    start a second Copilot while the first shuts down; rows of sessions deleted outside the app stay in the stores.

## D. Tests and housekeeping

18. **"Which command a start gets" has no unit test.** The spec (section 8) asks for it in a module `node --test`
    can load; `commandFor`, `createSession` and `createChild` keep it inline in `electron/main.mjs`. The UI checks
    `session-command-new`, `session-command-setup` and `child-command-inherited` cover it, on Linux only.
19. **`saveSetup` re-implements the save, close, restore sequence of `saveAndReopen`**
    (`electron/session-setup.mjs`, `electron/context-tier.mjs`).
20. **`electron/test/session-setup.test.mjs` could assert more:** `commands` after a refusal; that an emptied
    command's key is really gone from the file; a change of only the prompt and of only the command.
21. **`electron/test/copilot-command.test.mjs`:** every test injects `isFile`, so the real `statSync` check has no
    test of its own (a real file with a space is exercised by `acp.test.mjs` on POSIX); no Windows case for an
    absolute path that is not a file; the default of `%PATHEXT%` is never exercised.
22. **The 127 test reads the shell's stderr from the error's message** (`electron/test/acp.test.mjs`, "a missing
    program fails with exit code 127"): stderr may arrive after `exit`. 0 of 70 runs failed, idle and under load.
23. **`scripts/ui-check/checks.mjs`:** the `/proc/*/cwd` walker is written three times (`agentPids`, `leftovers`,
    `inWork`); the dialog-with-command start block is copied in four checks and `app.send`'s body in one (a
    `command` option on the driver's `newSession` would remove both); the `notice` helper exists twice; two
    comments show the shell's argv wrongly (also `scripts/ui-check/driver.mjs`); three checks `return` on `win32`
    and report ok while asserting nothing (`new-session-start-deadline`, `signal-kills-copilots`, and the one next
    to them).
24. **`child-command-broken` pins only part of the failure text** (not the quoted command, `NOT_FOUND`, the remedy
    sentence) and does not assert that no command is stored for the child that never came to be. The full text is
    pinned by the `startFailureText` unit test.
25. **No check for "a parent without an own command gives a child without one"**; it holds by reading
    (`resolveCommand` with an empty `own`; the store drops `""`).
26. **`session-command-fork-delete` calls `api.forkSession` / `api.deleteSession` directly**, not the message's fork
    action (older checks cover the action). **`.pe-command`'s `maxLength`** is asserted only on the unit test's fake
    element; the Settings field's real one is checked in `settings-command-hint`.
27. **`electron/main.mjs`, `connect`:** `Date.now()` is read twice for the start deadline.
28. **`electron/renderer/prompt-editor.js`, the doc comment of `openPromptDialog`** (about line 119): one line is
    125 columns, over the file's wrap width. Found by the re-review of the fix wave.
29. **Process notes:** Task 4 has no captured failing run of its tests before the code.

## Not verified

- **Windows, all of it:** `copilot.cmd` at a path with spaces; a command with arguments; a path without its
  extension (`%PATHEXT%`); that closing a session leaves no Copilot process; the `acp.test.mjs` tests that no longer
  skip Windows (CI runs them); the UI checks with a command line are POSIX only.
- **macOS:** bash as `/bin/sh` (the shell replaces itself with the command; covered here by `exec …` tests only);
  whether `kill(-pgid, 0)` reports `ESRCH` or `EPERM` for a group of zombies; Meta+Enter in the command field.
- **The real Copilot CLI** (the checks use a scripted agent): whether it exits by itself on `session/close` (item
  3); whether it gives its tools' commands a process group of their own, which decides what the group kill reaches;
  whether it ends when its stdin closes (item 2).
- **A wrapper script as the command** with the real Copilot (`exec copilot "$@"`).
