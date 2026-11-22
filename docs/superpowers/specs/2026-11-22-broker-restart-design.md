# Update and restart the relay broker from the app: design

Date: 2026-11-22. Status: decisions settled with the user on 2026-11-22; what is left under "My calls" stands
unless corrected. Plan: `docs/superpowers/plans/2026-11-22-broker-restart.md`.

## Intent

A fix in the broker (`server.mjs`, `src/`) only takes effect once the long-lived broker process is restarted from
updated files. Today that is manual: pull the repo, reinstall the extension, find and stop the broker, start it
again. The app gets one action in Settings that does all of it, without closing the app or its sessions, on
Windows, Linux and macOS.

## Goals

- One button: bring the repo to the latest `main`, install, restart the broker, confirm the new process answers.
- The app and its open sessions stay open; sessions reconnect on their own.
- Every step is shown with its outcome. On a failure the run stops, names the step and the reason, and leaves
  the old broker running whenever it has not been stopped yet.
- One code path for the three systems: no shell-specific commands, no process hunting.

## Non-goals

- Updating the desktop app itself (it is installed from a release).
- Rolling back to the previous commit, restoring the stash or going back to the previous branch.
- Any branch other than `main`.
- Stopping a broker that predates this feature (it has no shutdown endpoint): that takes one manual restart.
- A broker on another machine; restarts on a schedule.

## Anti-goals

- Stopping a process that is not the broker.
- Losing uncommitted work without saying so: a stash is made, named in the result, never dropped.
- Ending with no broker running and no message saying so.
- A step that can hang: every step has a timeout.

## How it works today

This section describes the state before this feature.

- The broker is a detached `node server.mjs` (port 7777 unless `COPILOT_RELAY_PORT` or `relay.config.json` say
  otherwise). It is started by the first session whose connection is refused (`RelayClient#autostart`, once per
  client), by `npm start`, or by a login service the user set up (README §7).
- The app does not know the broker's pid. The broker has `GET /health` (`{ ok, app, peers }`) and no way to be
  asked to stop; `SIGINT`/`SIGTERM` run `shutdown()`.
- `~/.copilot/extensions/copilot-relay/config.json` (written by `scripts/install-extension.mjs`) holds the broker
  URL, `brokerScript` (the repo's `server.mjs`, or null after `--no-autostart`) and `nodePath` (the Node that ran
  the installer). The app reads it in `relayConfig()`.
- Every route passes `rejectForeign()`: loopback Host, no foreign Origin, JSON POST bodies. Any local process may
  call the API; web pages may not.
- After a broker restart every `RelayClient` reconnects under the same key and name; links and unacknowledged
  reports are on disk. Ordinary messages sent while it is down, inboxes and message budgets are lost. Sessions
  started from the broker's web GUI end with it.
- The reconnect delay never goes back to 1 s: `#connectOnce` always throws, so the reset in `#loop` is never
  reached and the delay doubles with every disconnect, up to 15 s. A session can therefore stay unregistered for
  15 s after the new broker is up.
- Until a session's stream registers again the broker does not know its MCP alias: `send_message` and
  `create_session` answer "You are not registered with the relay broker." and `report_result` answers "You are not
  a delegated session", which a working child can take at its word.

## Approaches

- **A. A shutdown endpoint in the broker (chosen by the user).** The app asks the broker to stop over HTTP. One
  implementation for all systems, and only the broker can be stopped this way. Cost: a broker older than this
  feature cannot be stopped, so the first restart after the feature ships is manual.
- **B. Find the process listening on the port and kill it.** Works on an old broker, but needs three
  implementations (`netstat`, `ss`, `lsof`) and can hit another process on that port.
- **C. A, with B as a fallback for old brokers.** Removes the one manual restart at the price of all of B.

A was picked: the running broker has to be restarted by hand once anyway, to load the pending broker fix.

## Design

### Broker (`server.mjs`)

- `GET /health` also returns `pid`, `startedAt` (epoch ms), `root` (the folder of the running `server.mjs`) and
  `acpSessions` (how many sessions were started from the broker's web GUI).
- `POST /api/shutdown` (JSON body, behind `rejectForeign()` like every route) answers `{ ok: true, pid }` and, once
  the answer is flushed, runs the existing `shutdown()`.

### Setting

- `brokerRepo`: absolute path of the copilot-relay repo. Empty by default; when Settings opens, the field then shows
  the folder of `brokerScript` from the installed `config.json` (or the repo the app runs from, in development) as
  its value, and always shows it as its placeholder. A field the user empties is not replaced by that default: Check
  refuses it.
- Settings gets a "Relay broker" section: the path with a Browse button (existing folder picker), a button
  "Update and restart broker", and the list of steps of the current or last run.

### The run (main process)

Order agreed with the user: git, install, stop, start. Installing before stopping keeps the gap to a second or
two, and a session's own autostart during the gap then starts the new version.

0. **Check.** An empty or non-absolute path fails with "Set the copilot-relay repository folder first (an absolute
   path)." The path is a folder with `server.mjs` and `scripts/install-extension.mjs` and is the top level of a
   git work tree. The broker URL is a loopback address. A Node is found: `nodePath` from `config.json` when that
   Node binary exists, else `node` on PATH. Never Electron's own binary: the installer records the Node it runs under as the
   one that starts the broker.
1. **Update.** `git status --porcelain -z --untracked-files=all` is read; `?? <path>/` entries (nested repositories
   and linked worktrees, which `git stash` leaves alone) do not count. When another entry remains, on any branch,
   `main` included (the user's decision):
   `git stash push --include-untracked -m "copilot-sessions restart <ISO time>"`, so no empty stash entry is ever
   created. The stash command carries its own identity (`Copilot Sessions <copilot-sessions@localhost>`), so a
   machine without a git identity can stash. A stash entry stored by a stash command that then fails is still
   named, with a note that the work tree may be partly cleaned. If the current branch is not `main`:
   `git checkout main`. Then `git pull --ff-only --no-rebase origin main`. The stash is not applied again: the new
   broker runs the committed files. The result names the commit before and after (short hashes), or "already
   up to date", and says when the checkout moved from another branch ("was on <branch>").
2. **Install.** `npm ci` in the repo, then `node scripts/install-extension.mjs`. Both run on every run (the
   user's decision): `npm ci` also when dependencies did not change, and the installer also when Copilot has no
   copilot-relay extension yet, which installs it. A failed `npm ci` says that the dependencies may now be
   incomplete and that the running broker is not affected (it will not start again until this step succeeds).
3. **Stop.** `GET /health`: a refused connection means nothing to stop. An answer that is not a copilot-relay
   broker, or a `/health` that cannot be read (a timeout, a body that is not a JSON object), fails the step with
   "Something else answers at …". Otherwise keep its `pid`, `POST /api/shutdown`, and wait (up to 10 s) until
   `/health` is refused or answers with another pid (an unreadable answer counts as still there). The shutdown
   request is abandoned after 2 s and the polling decides. A 404 means a broker without the endpoint: the run
   stops with "This broker is older than the restart button. Stop it by hand once, then press the button again."
   Another refusal reads "The broker refused to stop: HTTP <n>."
4. **Start.** Spawn the broker as `RelayClient#autostart` does (detached, no stdio, `windowsHide`, cwd = repo),
   then wait (up to 15 s) for `/health` to answer with a pid different from the stopped one and a `root` equal to
   the repo path. A session's autostart or a login service may take the port first; ours then exits (EADDRINUSE)
   and the check reads `/health` all the same. A broker answering from another folder fails the step and names
   that folder.
5. **Reconnect** (part of this feature, the user's decision: without it relay tools give wrong answers for up to
   15 s after the restart). The app tells the relay client of each of its open sessions to reconnect now and
   waits (up to 20 s) until they have registered. The result says how many of them are back; sessions that are
   not back yet are a warning, not a failure. With no relay clients (no sessions, or the relay off in the app)
   the step is skipped with "no sessions to reconnect".

The result line names the broker's pid and the commit; a stash made in step 1 is named with its branch and
message, also when the run fails after making it. On an Update failure the stash sentence appears in both the
step's detail and the summary.

A step that fails ends the run. Steps 0 to 2 leave the old broker running. A failed step 4 ends in one of two
forms: "A different broker is running." or "No broker is running; press the button again to retry."

### Relay client (`extension/copilot-relay/relay-client.mjs`, shared by the app and the extension)

- The reconnect delay goes back to 1 s once a connection has registered.
- A new method reconnects at once (it ends the current wait or stream); the run uses it in step 5.

### In the window

- Before the run, if a session is working, the app asks for confirmation (the user's decision: ask, do not refuse).
  The question also says how many sessions started from the broker's web GUI will end, when the broker reports
  any; it is asked for those alone too, since they end without a way back.
- One run at a time; the button is disabled while it runs. Closing Settings does not cancel it.
- Steps appear as they start and end (pending, running, done, failed, skipped), with one line of detail each.

## My calls (not discussed; correct them if wrong)

- **The installer keeps the current setup:** it is run with `COPILOT_RELAY_PORT` set to the port of the current
  broker URL (and `COPILOT_HOME` when the app has it) and with `--no-autostart` when the installed config had no
  `brokerScript`; the new broker is started with the same port. It always writes `url: http://127.0.0.1:<port>`. With no extension installed there is no setup to keep: the port is the one the app uses
  (`relayConfig()`), and autostart is on.
- **The new broker starts with defaults:** no config-path argument and no state-file variables are carried over
  from the old process, as with today's autostart.
- **`relay.config.json` gets no special handling:** it is tracked, so a changed copy is stashed with everything
  else (the result names the stash) and the new broker starts with the committed copy.
- **Git never prompts:** it runs with terminal prompts off; a remote that needs a password fails step 1 with
  git's message. (The user confirmed that `git pull` works without a prompt on the machine this is for.)
- **Programs:** `git` from PATH; `npm` through the chosen Node (its `npm-cli.js`), else `npm` from PATH. No extra
  path settings. A program that is not found fails its step with its name.
- **Timeouts:** git steps 60 s each, `npm ci` 5 min, installer 30 s, stop 10 s, start 15 s, `/health` reads 2 s,
  the shutdown request 2 s, the `node -p` lookup 10 s, Check's git call 60 s.

## Constraints

- Commands are spawned with argument arrays; the repo path never goes into a shell string. On Windows, when
  `npm-cli.js` is not found next to Node, `npm ci` runs through a shell with fixed text (no path in it).
- The new main-process module must be listed in `electron/package.json` `build.files` (packaging test).
- The shutdown endpoint adds no new trust: local processes can already end sessions through the API.

## Tests

- **Broker, real process over HTTP** (as `broker-stream.test.mjs`): `/health` reports the pid; `POST /api/shutdown`
  answers and the process exits; a request with a foreign Host, Origin or a non-JSON body is refused and the
  broker keeps running.
- **Git step, real git** in a temp repo with a bare remote: on `main` and behind, clean and with changes; on another
  branch, clean and with changes (each time with changes: stash made, named, work tree clean and on `main`); diverged `main` (pull refused, nothing else done).
- **The run, with injected effects:** step order; each failure stops the run at its step and leaves the later
  steps untouched; no broker running (stop skipped); old broker (404); `npm ci` and the installer run every time; the
  installer's port and autostart flag with and without an installed extension; the port taken by another starter still verifies; a broker from another folder
  fails; a start that never answers reports no broker; sessions that do not come back are a warning.
- **Relay client:** the delay is 1 s again after a registration; reconnect-now ends a wait and a live stream.
- **End to end:** a real broker restarted by the run from a temp repo copy, with a connected client that receives
  a message before and after. `npm ci` is recorded, not run, and the clone gets a neutral `{}`
  `relay.config.json`.
- **Window:** the section renders, the confirmation appears when a session works, steps update.

## Left to the builder

- Module layout and names, IPC channel names, the look of the step list.
- How the last run's steps are kept for a reopened Settings dialog.
- How `npm-cli.js` is located next to a Node on each system.

## Not verified yet

- Whether Copilot's MCP client uses the relay tools again after a call failed during the gap, without reopening
  the session. The endpoint is stateless, so once the session has registered again the broker answers as before.
  To be checked during implementation, in the real app.
- macOS: the code is system-neutral, but CI builds and tests only Windows and Linux.
- PATH: the app already takes it from the login shell at start (`fixPath()`), so `git` is normally found; when
  that lookup fails, the step fails with a message naming the program.
