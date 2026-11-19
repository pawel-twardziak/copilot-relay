# Design: Scheduled scripts (MVP)

## Intent

The desktop app (`electron/`) gets a **Schedules** page where the user defines jobs that run a script on a
schedule while the app is open. When a run ends, the app shows a desktop notification, and a run summary page
shows the script's result. First step towards scheduled Copilot prompts; this MVP runs scripts only.

## Goals

- Define, edit, enable/disable, delete and "Run now" jobs from a simple UI.
- A job = schedule + command line + working folder + fixed environment variables (some marked secret).
- A run ends with a notification (`✓` / `✗` + job name + summary); clicking it opens the run summary.
- The summary shows the script's own result (via `$JOB_RESULT`) or, without one, the tail of stdout, plus
  stderr, exit code and duration.
- Scripts can reach Azure DevOps (or anything else) the way they would from a terminal: inherited user
  environment (`az login` works) or a secret variable such as a PAT.

## Non-goals (MVP)

- Copilot prompts, agents or skills as jobs; any relay session.
- Running while the app is closed: no background OS process, no tray, no autostart.
- Catch-up of runs missed while the app was closed.
- Input asked for at run time (inputs are fixed in the job definition).
- Job chains, dependencies, retries.

## Anti-goals

The feature has failed, even if it works, if:

- a job can be created or changed other than through the app's UI: the app offers no relay, MCP or session path to
  jobs (a process running as the same user can still edit the files in `userData`, like any app setting);
- a secret value shows up in `jobs.json`, in run output, in a summary or in a notification;
- a hung script runs forever or survives the app quitting;
- a run finishes without the user being able to see that it did.

## Decided by the user

- MVP: scripts only, loop runs only while the app is open.
- Output contract: variant 2 (process + optional result file `$JOB_RESULT`).
- Inputs fixed in the job definition.
- Notification after every run by default; per job also "when there is a result or an error", "failure only" and
  "never", and the script may override it per run via `notify` in the result JSON.
- The result contract is explained in the app (form help, hints, summary page) and in the README.
- Approach below, including `croner` and secret variables.

## Approaches

1. **Scheduler in the Electron main process (chosen).** A module in `main.mjs`'s process spawns the scripts,
   keeps state in `userData`, reuses the existing `Notification` and IPC `handle()` patterns. Fits the app as it
   is; nothing new to install on the OS.
2. Run scripts from the renderer: rejected, the renderer has no process access and must not get it.
3. OS scheduler (cron / Task Scheduler / launchd) calling the app or the scripts: rejected, the user excluded
   OS-level processes from the MVP, and results/notifications would need a separate channel back into the app.

Cron expressions: the `croner` package (no dependencies, computes next run times for the form preview). A
hand-written parser was rejected (DST, day-of-week/day-of-month rules).

## Design

### Job definition (`userData/jobs.json`)

```json
{
  "id": "uuid",
  "name": "PR report",
  "enabled": true,
  "schedule": { "kind": "cron", "expr": "0 8 * * 1-5" },
  "command": "python3 report.py --project X",
  "cwd": "/home/me/scripts",
  "env": [
    { "name": "ADO_ORG", "value": "contoso" },
    { "name": "AZURE_DEVOPS_EXT_PAT", "secret": true }
  ],
  "timeoutMinutes": 10,
  "notify": "always"
}
```

- Schedule presets in the UI (every N minutes, daily at HH:MM, chosen weekdays at HH:MM) are stored as cron
  expressions; "Custom" takes a raw cron expression. Local time zone. The form shows the next 3 run times and
  refuses an invalid expression.
- `command` is one command line run by the system shell (`/bin/sh -c` on Linux/macOS, `cmd.exe /d /s /c` on
  Windows), so `python3 x.py --flag` or `./run.sh a b` both work. *(Design call: simpler form than a separate
  program + argument list; secrets go in env, never in the command line.)*
- Secret values are encrypted with Electron `safeStorage` and stored in a separate `userData/job-secrets.json`
  keyed by job id + variable name, never in `jobs.json`. The UI never sends a stored secret back to the renderer;
  it shows "set" and offers "replace". If `safeStorage.isEncryptionAvailable()` is false (e.g. Linux without a
  keyring), secret variables can't be saved and the form says why.
- `notify`: `always` (default) | `result` | `failure` | `never`, see [Notifications](#notifications).

### Scheduler loop (`electron/scheduler.mjs`)

- Starts when the app is ready; ticks every 30 s. For each enabled job, a run is due when the job's next run time
  (computed from its last check) is ≤ now. Several due times passed during one gap (sleep/suspend while the app
  was open) collapse into one run. Times that passed while the app was closed are skipped.
- One run per job at a time: a due time while the previous run is still going is skipped and recorded as
  `skipped` in the history. Different jobs run in parallel.
- "Run now" starts a run immediately (same one-at-a-time rule; the button is disabled while running).
- Editing or disabling a job doesn't touch a run in progress; deleting a job kills its run.

### A run

- Spawn with `cwd`, environment = the app's process environment + the job's variables + `JOB_RESULT` (path to an
  empty file in a private temp folder created per run, mode 0600) + `JOB_NAME`, `JOB_RUN_ID`.
- The child is started in its own process group (POSIX `detached: true`; Windows: kill with `taskkill /T /F`), so
  timeout, delete and app quit kill the whole tree.
- Timeout (`timeoutMinutes`, default 10, max 24 h): kill the tree, status `timeout`.
- App quit: running jobs are killed and recorded as `aborted`. No confirmation dialog in the MVP.
- stdout and stderr are kept separately, each capped at 64 KB (the tail is kept; the summary says it was cut).
- Status: `success` (exit 0), `failed` (exit ≠ 0 or spawn error, e.g. missing folder), `timeout`, `aborted`,
  `skipped`.

### Result contract (`$JOB_RESULT`)

After the process exits, the app reads the file (max 64 KB):

- valid JSON object → `summary` (string, first line used in the notification), optional `details` (string,
  shown as Markdown in the summary page using the renderer's existing Markdown rendering) and optional `notify`
  (boolean, see [Notifications](#notifications)); other keys ignored;
- text whose first non-blank character is `{` but that doesn't parse as a JSON object → treated as text (below),
  and the summary page shows "The result file is not valid JSON" with the parse error, so a typo is easy to spot;
- other non-empty text → the whole text is `details`, its first non-empty line is `summary`;
- empty or missing → `summary` = last non-empty stdout line (or `exit code N` if none), `details` = none, the
  page shows the stdout tail. This counts as "no result".

Exit code still decides success; the result file only provides the text. A script that knows nothing about the
app works unchanged: only scripts that want their own summary or notification control need the contract.

### Notifications

Whether a finished run shows a notification (`skipped` runs never do):

| Job `notify` | success, no result | success with result | failed / timeout / aborted |
|---|---|---|---|
| `always` (default) | yes | yes | yes |
| `result` ("when there is a result or an error") | no | yes | yes |
| `failure` | no | no | yes |
| `never` | no | no | no |

"With result" = the result file was non-empty. The JSON key `notify` overrides the table for that run on success
only: `true` shows a notification, `false` suppresses it. On failure the job setting applies (`never` stays
silent, every other mode notifies). Every run is recorded in the history regardless.

### Secret masking

Every secret value of the job is replaced with `••••` in stdout, stderr, `summary`, `details` and the
notification before anything is stored or shown. Values shorter than 4 characters are refused when saving a
secret (they'd mask ordinary text).

### History

`userData/job-runs.json`: per job the last 20 runs (id, trigger `schedule|manual`, start, duration, status, exit
code, summary, details, stdout tail, stderr tail, truncated flags). Deleting a job deletes its history and secrets.

### UI (renderer)

- A **Schedules** entry in the sidebar opens the page in the main area (the chat view is hidden, sessions keep
  running).
- List: status dot (enabled), name, schedule in words, next run, last run (✓/✗/⏱ + time ago), ▶ Run now,
  ⏸/▶ enable, edit, delete (with confirmation).
- Form: name, schedule (preset or cron + next 3 runs), command, folder (with a folder picker), environment
  variables (name, value, secret checkbox), timeout, notify (the four modes with their labels from the table).
- **Contract help in the form**: a collapsible panel "How a script reports its result" listing the variables the
  app sets (`JOB_RESULT`, `JOB_NAME`, `JOB_RUN_ID`), both result formats (plain text; JSON with `summary`,
  `details`, `notify`) and short copyable examples:
  ```bash
  echo "3 new PRs" > "$JOB_RESULT"
  ```
  ```powershell
  '{"summary":"3 new PRs","notify":true}' | Set-Content $env:JOB_RESULT
  ```
  ```python
  json.dump({"summary": "3 new PRs", "details": "- #12 …"}, open(os.environ["JOB_RESULT"], "w"))
  ```
- When the `result` notify mode is selected, a hint under it: "the script must write to `$JOB_RESULT`, otherwise
  it only notifies about errors", linking to the panel.
- Run summary page: status, trigger, start, duration, exit code, `summary`, `details`, stdout and stderr tails
  (collapsible, with the existing Copy buttons). The job's history lists the previous runs, each opening its summary.
  When the run had no result, the page says "The script wrote no result, showing the last stdout line" with a link
  to the contract help; an invalid JSON result shows the warning described above.
- A notification click focuses the window and opens that run's summary.

### IPC

New `handle()` channels: `jobs:list`, `jobs:save`, `jobs:delete`, `jobs:setEnabled`, `jobs:runNow`,
`jobs:runs`, `jobs:previewSchedule`. Main pushes `jobs:changed` and `jobs:runFinished` events. Jobs are saved
only through these channels; there is no relay or MCP tool for jobs.

### Tests (`electron/test/`)

Unit tests for: due-time calculation (gap collapsing, skip while running, disabled jobs), result-file parsing
(JSON / text / empty / invalid JSON), the notification decision (every cell of the table plus the `notify`
override), secret masking, output capping. A spawn test with a tiny Node script for success,
failure, timeout (tree killed) and `$JOB_RESULT`.

## Left to the builder

Exact page layout and styling (follow the existing sidebar/settings look), names of helper functions, how the
`croner` dependency is added to `electron/package.json`. The README (`electron/README.md`) gets a "Schedules"
section with the same contract description and examples as the in-app help; its wording is the builder's.
