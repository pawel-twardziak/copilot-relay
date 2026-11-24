# Spec: A Copilot command per session (`session-command`)

Extends `2026-11-20-context-tier-design.md` (a setting that restarts a session's Copilot) and
`2026-11-23-session-prompts-design.md` (the dialog a session is created and edited in). Where the documents disagree,
this one wins.

Implementation starts from `main` (v0.23.1 plus the unreleased Windows test skip); this feature ships as v0.24.0.

## Intent

Today the command that starts Copilot is set once, in Settings, for every session, and it is one program without
arguments. The user wants to set it per session, as an override of the Settings command, and wants the command to
carry arguments. The user did not say what they will run with it; nothing here assumes a particular use.

## Goals

1. A command is a line: a program with arguments, handed to the system shell. This holds for the Settings field and
   for a session's own command.
2. A session can have its own command. It is set when the session is created and can be changed later. An empty own
   command means "the command from Settings". The own command replaces the Settings command as a whole (program and
   arguments).
3. The session's command is used on every start of that session's Copilot process: new, reopened, restarted.
4. A path to another program or script still works (asked by the user), and so does every value that works today: a
   bare name (`copilot`), an absolute path, an absolute path with spaces written without quotes, a quoted path.
5. A fork gets a copy of the own command. Deleting a session removes it. A delegated child starts with its parent's
   own command.
6. Closing a session still ends its Copilot, and the app still knows when Copilot is really gone.
7. A failed start names the command and says where it is set (this session or Settings).
8. A session whose command is broken can be given another command from its view.

## Non-goals

- Fields for environment variables. On POSIX the shell does it (`FOO=1 copilot`); on Windows a wrapper script does.
- Checking the command before the start. The shell and the start report what is wrong.
- The process that lists sessions for the sidebar: it uses the Settings command.
- Scheduled scripts and the broker: they have their own commands.
- A command field on the card that approves a delegated child. The child's command is changed in its view.
- Restarting running sessions when the Settings command changes. It applies from each session's next start, as today.
- A marker in the sidebar for sessions that have their own command.
- Agents other than Copilot. The app still adds `--acp --stdio` (and `--context …`), and nothing else is tested.

## Anti-goals

- A Copilot process left running after its session was closed.
- A session counted as closed while its Copilot still runs (a second agent could then work on the same files).
- A session that cannot be opened and cannot be given another command.
- A Settings value that works today and stops working after the update.
- A command that comes from anywhere but the user's typing in the app. It is run by a shell, so no model, tool call,
  relay message or delegation request may set it. A child takes it only from its parent's stored command.
- A browser `alert`/`confirm` dialog anywhere in the new UI.

## Decisions (made with the user)

- The command is set per session and overrides the Settings command.
- The command may carry arguments ("variant 2"), not only a path.
- The line goes through the shell on both systems ("approach B", below).
- Naming another script as the command must keep working.
- Closing or restarting a session ends Copilot's whole process group, also what its tools left running in it
  (section 3).

## Approaches

**A. The app splits the line into a program and arguments.** Spaces separate, `"…"` groups, `\` is an ordinary
character. Linux keeps starting the program without a shell, so closing and the "program not found" error work as
today. No shell features (`FOO=1 copilot`, `~`, `$VAR`). Recommended by the author; not picked.

**B. The whole line goes through the shell on both systems. Picked by the user.** Everything the shell can do works.
The costs, checked on this Linux machine (`/bin/sh` is dash, Node 22):

| Line | Signal goes to | Result |
|------|----------------|--------|
| `sleep 41` | the shell only | the shell dies, `sleep` stays running |
| `FOO=1 sleep 41` | the shell only | the shell dies, `sleep` stays running |
| `sleep 41`, started `detached` | the process group | nothing stays running |
| `sleep 41 && true`, started `detached` | the process group | nothing stays running |
| `/nonexistent/copilot --acp --stdio` | — | exit code 127, stderr `/bin/sh: 1: /nonexistent/copilot: not found` |

So on POSIX the shell does not replace itself with the program: the process the app holds is the shell, and Copilot
is its child. Sections 2 and 3 are the answer to that.

**C. Two fields: program and arguments.** No doubt about paths with spaces, but two fields in Settings and two per
session. Not picked.

## 1. The command line

A new module, `electron/copilot-command.mjs`, with pure functions (the names are the builder's):

- **Normalize.** A command is a string, trimmed. A value with a line break or a NUL character, or longer than 4000
  characters (author's call), is refused with a readable text. An empty string means "none".
- **Effective command.** The session's own command, else the Settings command, else `$COPILOT_PATH`, else `copilot`.
  `$COPILOT_PATH` is a line like the others.
- **The line for the shell.**
  - If the whole command is an absolute path of an existing regular file, it is quoted for the platform's shell:
    POSIX in single quotes (a `'` inside as `'\''`), Windows in double quotes. This keeps today's values working,
    among them a path with spaces written without quotes. A relative value is never checked this way (author's
    call): it goes as written.
  - On Windows the check also tries the value with each extension of `%PATHEXT%` added, because `cmd` does the
    same: `C:\Program Files\GitHub Copilot\copilot` (no `.exe`) works today and must stay quoted (author's call).
  - Otherwise the command goes as the user wrote it.
  - Then the app's arguments follow, each after one space: `--acp --stdio` and the context tier flag. They are fixed
    words without special characters.

Because the app writes its flags at the end, the line has to be one command that takes them. A pipe, a `;`, a chain
that ends in another program, or a trailing `#` comment breaks the start. The app does not check this; the hints say
it (section 6).

Today's Windows rule ("a value with a space that does not start with `"` is quoted as a whole") is replaced by the
existing-file rule. `copilot --flag` is not a file, so it is not quoted.

## 2. Starting

In `electron/acp.mjs`:

- The process is started with the line as the only command string, `shell: true`, and no argument array (Node warns
  about an argument array with a shell, DEP0190).
- On POSIX it is started `detached`, so it leads a process group of its own. Windows is started as today.
- `conn.command` stays the user's command without the app's flags: error texts show it.

`electron/job-runner.mjs` already starts shell commands this way and has `killTree`. Reuse it (move it to a shared
module or import it), do not write a second one.

## 3. Stopping, and knowing that Copilot is gone

- **Kill.** As today the input is closed first. Windows: `taskkill /T /F` on the tree, as today. POSIX: `SIGTERM` to
  the process group, and `SIGKILL` to the group after 3 seconds if it is not gone.
- **Force kill.** `closeAndWait` in `main.mjs` sends `SIGKILL` to `conn.proc` directly today. It has to go through
  the connection and reach the group.
- **"Exited" on POSIX.** `conn.exited` and the `exit` event are what `lingering`, the removal of the prompt folder
  and the history rewrites wait for, so they must not come before Copilot is gone. Two cases (author's call):
  - *The shell exited with an exit code.* It waited for its command, so Copilot is gone: `exited` at once, as
    today. Nothing else in the group is touched; what Copilot left running stays running, as today.
  - *The shell was ended by a signal* (the app's kill, or anyone else's). A `SIGTERM` to the group ends the shell at
    once, while Copilot may still be shutting down. The connection checks the group (`process.kill(-pid, 0)` fails
    with `ESRCH` when it is empty) and repeats the check until it is; only then it sets `exited` and emits `exit`,
    with the shell's code and signal. If the app did not send the signal itself, it now sends the kill of the
    previous point, so the group does empty.
- **What the group kill reaches.** Everything in Copilot's process group, so also a process that one of Copilot's
  tools started and that stayed in that group (a dev server put in the background). Today on Linux such a process
  gets no signal from the app when the session is closed or restarted. Whether Copilot gives its tools' commands a
  group of their own was not checked. Accepted by the user: a closed session leaves nothing behind, as on Windows,
  where the whole tree is killed already.
- **Windows** is unchanged: the process is the `cmd` wrapper and its exit is the exit, as today.
- **The exit text.** Through a shell, a Copilot killed by a signal arrives as exit code 128+n, not as a signal. The
  text "copilot exited (…)" is kept; it shows that code.

## 4. A failed start

With a shell the start itself no longer fails for a missing program (`ENOENT`); the shell starts and exits.

- The error of an exit carries the exit code.
- POSIX: exit code 127 (not found) or 126 (not runnable) before Copilot answered `initialize` gets the "not found"
  hint. Everything else gets today's general hint. Windows gets today's general hint (its "not found" text depends
  on the system language; today it is not recognised either).
- The message quotes the command as the user wrote it and says where it is set: "this session's command" when the
  session has its own, else "the command in Settings". The remedy follows: change it in the session's dialog, or in
  Settings.
- The login hint (`needsLogin`) stays first, as today.
- **A command that starts and never answers.** Today only a delegated child's start has a deadline (30 seconds);
  a new or reopened session waits for `initialize` without end. With a command per session that is a trap: a line
  that waits for input (`npx …` asking to proceed, `ssh host copilot`) would leave the session "opening" for good,
  where it can be neither closed nor given another command, and a new-session dialog that cannot be closed. So
  every start gets a deadline for the answer to `initialize`: 60 seconds (author's call; a child keeps its 30
  seconds for the whole setup). When it passes, the process group is killed and the start fails with "… did not
  answer within 60 seconds" and the same "where it is set" text. Loading the history (`session/load`) gets no
  deadline: it is long for a long session.
- **A delegated child that fails to start** has no view and no stored command yet. Its error names a third source:
  "the parent session's command", with the remedy "change it in the parent's Setup". It reaches the parent through
  `tellParent`, as every failed child start does today.

## 5. Where the command is kept and used

- **Store.** `session-commands.json` in the app's data folder: `{ [sessionId]: "line" }`, no entry for "none". The
  contract of the prompt store: `set` throws when the file cannot be written, `copy` and `delete` only log a failed
  write. The builder may make one shared store for texts out of `createPromptStore` instead of a third copy.
- **`connect`** takes the command from its caller. The lister passes the Settings command.
- **New session** (`sessions:new`): takes the own command next to the own prompt, starts with it, and saves it after
  `session/new` as the prompt is saved (a failed save fails the start: the next start would lose it).
- **Open and restart** (`openSession`): the session's effective command.
- **Delegated child** (`createChild`): starts with the parent's *stored* own command and gets it saved as its own.
  A parent without one gives a child without one, which follows Settings (author's call: a later change of the
  Settings command then reaches both). An adopted child keeps what it has.
- **Fork** copies the entry; **delete** removes it.
- A session made outside the app, or before this version, has no entry and uses the Settings command.
- **Settings.** `settings:set` normalizes the command as in section 1. `settings:get` keeps returning the effective
  Settings command. Settings saves after its dialog has closed, so a refusal has nowhere to show. It is made
  unreachable instead: both command fields are single-line inputs (no line break can be typed or pasted) with a
  `maxlength` of the limit. If `settings:set` still gets a value it refuses, it keeps the previous command, saves
  the other fields and logs a warning; it does not throw (author's call).

## 6. The window

**Settings.** The field stays. Its hint is rewritten: the command may carry arguments and is run by the system
shell; a path with spaces is quoted, or given alone; the app adds `--acp --stdio` at the end; a session can have its
own command; "Currently used: …" stays.

**The dialog of a session** (the one that opens for a new session and from the session's header) gets one more
field under the prompt editor:

```
New session in /home/you/project
  Template: [— none —            v]
  [ This session's own instructions (optional)         ]
  [                                                    ]
  > Default part

  Copilot command
  [ Settings: copilot                                  ]   <- placeholder: the effective Settings command
  Empty: the command from Settings. May carry arguments; the app adds --acp --stdio at the end.

                                        [Cancel] [Start]
```

- One line, no spell check. A refused value (section 1) shows in the dialog's note and the dialog stays open.
- In a running session the dialog shows the stored own command. "Save and restart" saves the prompt and the command
  together and restarts once. Nothing changed: nothing restarts. The refusals are today's (`restartGuards`); a
  failed close restores both.
- The header button "Prompt" becomes "Setup", with the title "This session's prompt and Copilot command (saving
  restarts its Copilot)", and the dialog's title "Setup: …" (author's call).
- **A dead view** (the start failed, or Copilot exited): the button works there too. Saving stores the values;
  there is nothing to close; the view reopens with them. This is what makes a broken command repairable. It stays
  off while the session is being deleted, is opening, or has a turn running.
- The card that approves a delegated child is unchanged.

## 7. Errors

- New session, start fails: the dialog stays open with the error (as today), nothing is saved.
- Existing session, the new command fails: it is saved, the view is dead and shows the error of section 4, and the
  Setup button is there to change it.
- A command that cannot be saved: the dialog shows the reason, nothing restarts.

## 8. Tests

- Unit tests of the new module: normalize (the refusals), effective command (the four sources), the shell line for
  both platforms (bare name, arguments, quoted path, existing file with spaces, a `'` in the path, a relative value).
- The store (or the shared store): as the prompt store's tests.
- `acp.test.mjs`, against the fake agent:
  - arguments in the command reach the agent before `--acp --stdio`, quoted ones as one argument;
  - POSIX: `FOO=1 …` reaches the agent's environment;
  - an existing file with a space in its path starts unquoted;
  - kill leaves nothing of the group running, also when the agent ignores `SIGTERM` and when it has a child;
  - `exit` comes only when the group is empty;
  - a missing program fails with exit code 127.
- These tests skip Windows today (the fake agent is a shebang script). With a command line the agent can be started
  as `"<node>" "<fake-agent.mjs>"`, so they should run on Windows too, except the POSIX-only cases.
  - a command that never answers `initialize` fails at the deadline (a short one in the test) and leaves no
    process;
  - the shell ended by a signal from outside: `exit` comes after the group is empty.
- Logic of `main.mjs` that needs tests is pulled into modules that `node --test` can load, as `switchTier` and
  `saveAndReopen` are in `context-tier.mjs` (`main.mjs` itself starts Electron when loaded): which command a start
  gets (new, open, child, lister), the save-both-and-restart-once of Setup, and the failed-start texts with their
  three sources.
- UI checks (`scripts/ui-check`): the field in the new-session dialog and in Setup; the agent got the arguments; one
  restart for a change of both; Setup on a dead view repairs a broken command; fork copies and delete removes; the
  Settings hint.
- The existing `dead-view` UI check finds the agent by a command line that contains `scripted-agent.mjs` and expects
  one process. Through a shell that does not replace itself there are two (the shell's command line holds the name
  too). `agentPids` has to pick the agent only, not the shell.

Not runnable here, to check by hand on the Windows machine: `copilot.cmd` at a path with spaces, a command with
arguments, and that closing a session leaves no Copilot process.

## Left to the builder

- Names of functions, IPC channels and files beyond the ones given.
- How often the group is checked after the shell's exit.
- Where `killTree` lives.
- One shared text store, or a separate one.
- The exact wording of hints and errors.

## Known limits

- The line is not validated. What the shell makes of it is the user's.
- Windows: "exited" is the exit of the `cmd` wrapper, as today.
- A program that moves itself to another process group or session is outside the group kill.
- Not verified: whether Copilot runs its tools' commands in a process group of their own (no Copilot was running
  on this machine when the design was written).
- A start slower than 60 seconds to `initialize` now fails, where today it would wait.
