# SDK probe

A one-off test: can the Copilot SDK (`@microsoft/copilot-sdk`) replace `copilot --acp --stdio` in copilot-relay
without losing anything the app does today (company agents, permissions, session prompts, MCP relay, queue, fork,
cut, resume, usage)? Run it on the machine and in the repository the app is really used with: company agents,
policies and the proxy only exist there.

## Run

```
cd scripts/sdk-probe
npm install
node probe.mjs --cwd C:\path\to\company\repo
```

- `npm install` downloads the SDK and its bundled runtime (about 220 MB). Node 20.19+ or 22.12+.
- `--cwd` is the repository whose agents, instructions and MCP servers are tested. **The probe never changes it**:
  sessions opened there may only read; everything that writes or runs commands happens in temporary folders.
- A full run takes about 10 minutes and sends about 35 prompts (model requests). `--no-llm` runs only the free
  scenarios (about 1 minute), `--model <id>` picks a cheaper model for the turns.
- `node probe.mjs --list` shows the scenarios; `--only a,b` and `--skip a,b` select them; `--agent <name>` picks
  the company agent for the `agents` scenario.

## Results

`results/<time>/` (ignored by git):

- `report.md`: the summary. PASS and FAIL are verdicts, INFO is a fact to read.
- `report.json`: everything that was recorded.
- `events/*.jsonl`: samples of the session events per scenario (the app's event layer would be built on them).

The report is written after every scenario, so an interrupted run still leaves its results.

**Read the report before it leaves the machine.** Tokens, account names, system prompts and the titles of your
real sessions are cut, long texts are shortened. Names of agents, models, MCP servers, skills and plugins, folder
paths and the first 200 characters of tool arguments stay in it.

## What it covers

| Scenario | In the app today | Hypothetical |
|---|---|---|
| `env`, `runtime-variants` | start `copilot` (also an npm `copilot.cmd`), login | bundled runtime, runtime over TCP, in-process runtime, protocol mismatch between SDK and CLI |
| `acp-baseline` | what ACP offers: agents, models, modes, commands | |
| `discovery` | company agents, MCP servers, skills, instructions of the repository | which session options make the SDK see them; managed (company) settings |
| `inventory` | extensions (the relay extension), plugins, commands | every read-only RPC the SDK has |
| `sessions` | session list, files in `session-state` | several sessions in one runtime process, our own session IDs |
| `models`, `modes` | model, context tier, plan / autopilot, allow-all | context tier without a process restart, reasoning effort |
| `turn` | streaming, usage, `events.jsonl` on disk | |
| `agents` | select a company agent | agents passed inline or from an explicit folder |
| `prompts` | session prompt through `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` | per-session prompt (`instructions.directories`, `systemMessage`) |
| `permissions` | approve, reject, late answer | reject with feedback, remember for the session, answer through RPC, no handler |
| `mcp` | relay MCP over HTTP with headers | |
| `abort`, `queue` | cancel, queue during a turn, take back | steering into a running turn |
| `resume`, `crash` | resume after an app restart | the same session through ACP and the SDK, runtime killed mid-turn |
| `history` | fork and cut (today by editing `events.jsonl`) | native `sessions.fork` and `history.truncate` |
| `attachments`, `subagents` | pasted images, sub-session tree | file attachments |
| `ask-user` | | questions from the agent to the user |
| `cleanup` | delete a session (today by removing files) | native `deleteSession` |

Not covered: client mode `"empty"` (meant for multi-user servers), OAuth for MCP servers, BYOK providers, remote
(cloud) sessions.

## If it stops early

- `Cannot load @microsoft/copilot-sdk`: `npm install` did not finish (registry or proxy).
- `runtime-variants` fails for every variant: the report holds the error of each one. `--runtime bundled` forces
  the runtime that came with the SDK, `--cli <path>` names another CLI.
- A scenario hangs: Ctrl+C once finishes it and runs the cleanup; `--turn-timeout <seconds>` changes the limit.
- Sessions left behind after a hard stop are named in `report.json` under the scenario that created them; the next
  full run does not remove them.
