# copilot-relay

> **Unofficial.** This is an independent community project. It is not affiliated with, endorsed by or supported
> by GitHub or Microsoft. "GitHub Copilot" is a trademark of GitHub, Inc. and is used here only to describe what
> the tool works with.

Local broker that lets **any** GitHub Copilot sessions discover and message each other: terminal `copilot`
sessions, sessions started from the web GUI, and any MCP client.

```
                    ┌──────────── broker (server.mjs, 127.0.0.1:7777) ────────────┐
                    │  registry · routing · inboxes · GUI · /mcp · /api/peer/*    │
                    └───────▲──────────────────▲──────────────────────▲───────────┘
          SSE push +        │                  │ ACP (stdio)           │ MCP (HTTP)
          HTTP (extension)  │                  │                       │
   copilot (terminal) ──────┘      copilot --acp (spawned from GUI)    VS Code / other MCP clients
   copilot (terminal) ──────┘
```

| peer kind | how it joins | how it receives messages |
|---|---|---|
| `cli`: terminal / Copilot app session | **copilot-relay extension** (auto-loaded in every session) | **push**: the extension injects the message with `session.send()`, so it works even when the terminal is idle |
| `acp`: session started from the GUI | broker spawns `copilot --acp` | push: new ACP prompt; output is streamed into the GUI |
| `mcp`: any MCP client | connects to `http://127.0.0.1:7777/mcp` | inbox: `read_inbox` / `wait_for_message` (MCP can't push into a chat) |

## Setup

```bash
npm install
npm run install-extension     # → ~/.copilot/extensions/copilot-relay (respects $COPILOT_HOME)
npm start                     # optional: the extension auto-starts the broker if it isn't running
```

Copilot CLI extensions are an **experimental** feature (CLI 1.0.106). Without experimental mode the CLI
does not even launch them, and an unapproved extension is denied:

1. Enable experimental mode once: run `/experimental on` inside `copilot`, or start with `copilot --experimental`.
2. Start a **new** `copilot` session and **approve** the `copilot-relay` extension when prompted (`/extensions` manages it later).
   In `-p` (prompt) mode nobody can approve it, so it is denied (`Extension "user:copilot-relay" was denied permission access`).

The session then shows `copilot-relay: connected as "<dir-name>"`, `/env` lists the extension, and the GUI at
http://127.0.0.1:7777 shows the session. If not, run `grep -i extension ~/.copilot/logs/process-*.log | tail`.

- `npm run install-extension -- --no-autostart` installs without broker autostart.
- `npm run uninstall-extension` removes the extension.
- `COPILOT_RELAY_DISABLED=1 copilot` starts a session that stays out of the relay.

### Session names

Each terminal session gets a random name (e.g. `swift-otter`) the first time it connects. The broker stores
the name per Copilot session ID in `names.json` (paths in the table below), so it survives broker restarts
and `copilot --resume`. To change it:

- type `/relay-name new-name` in the session (`/relay-name new-name | role text` also sets a role, and `/relay-name` alone shows the current name);
- click the session name in the GUI;
- start with `COPILOT_RELAY_NAME=backend copilot`, which wins over the stored name;
- or ask the agent to call `relay_set_name`.

`/relay` shows your name and the other sessions. `/clear` starts a new Copilot session, which gets a new name.

### Tools available to the agent

Terminal sessions (extension) get `relay_list_sessions`, `relay_send_message(to, text)` and `relay_set_name(name, role?)`.
MCP clients get `list_sessions`, `send_message`, `set_name`, `read_inbox` and `wait_for_message(timeout_seconds)`.

### Other MCP clients (e.g. VS Code `mcp.json`)

```json
{ "servers": { "copilot-relay": { "type": "http", "url": "http://127.0.0.1:7777/mcp" } } }
```

Don't add this MCP server to `~/.copilot/mcp-config.json` if the extension is installed: Copilot CLI sessions
would then have two sets of relay tools.

## Desktop app (Electron)

[`electron/`](electron/README.md) contains a standalone desktop app for Windows, macOS and Linux. It resumes any
existing Copilot CLI session, or starts a new one in a chosen folder, over ACP. Copilot doesn't load extensions in
ACP mode, so the app connects its sessions to the broker itself, with the same names and the same tools.

```bash
npm run app:install   # once
npm run app
```

## Installing on a company laptop (Windows / macOS)

### 1. Prerequisites

- **Copilot CLI** installed and signed in (`copilot --version`, `copilot login`). On Business/Enterprise plans
  an admin must have Copilot CLI enabled in the organization's policies.
- **Node.js 18+** (22 LTS recommended) and **Git**. Check with `node -v`.
- Access to the npm registry. Behind a corporate proxy, run
  `npm config set proxy http://proxy:port` and `npm config set https-proxy http://proxy:port`, or point npm at the
  company registry with `npm config set registry <url>`.

### 2. Get the code

The repo has no shared remote. Either push it to a GitHub repo you can reach from the laptop and `git clone` it,
or carry it over as a single file:

```bash
# on the machine that has the repo
git bundle create copilot-relay.bundle --all
# on the laptop
git clone copilot-relay.bundle copilot-relay
```

### 3. Install

```bash
cd copilot-relay
npm install
npm run install-extension
```

`install-extension` writes absolute paths (repo location and the current `node` executable) into the installed
extension's `config.json`. **Run it again after you move the repo or switch Node versions** (nvm, nvm-windows,
fnm, Homebrew upgrade). Otherwise the broker autostart points at a path that no longer exists.

### 4. Enable it in Copilot

1. Inside `copilot`, run `/experimental on` once, because extensions are an experimental feature.
2. Start a **new** `copilot` session and approve the `copilot-relay` extension when asked.
3. Check that it works: `/relay` shows your name and the other sessions, `/env` lists the extension, and
   http://127.0.0.1:7777 shows the GUI. The first session starts the broker automatically.

Setting a name at startup:

| shell | command |
|---|---|
| macOS (zsh/bash) | `COPILOT_RELAY_NAME=backend copilot` |
| Windows PowerShell | `$env:COPILOT_RELAY_NAME="backend"; copilot` (stays set for that PowerShell window) |
| Windows cmd | `set COPILOT_RELAY_NAME=backend && copilot` |

You can also just use `/relay-name backend` inside the session.

### 5. Where things live

| | macOS | Windows |
|---|---|---|
| installed extension | `~/.copilot/extensions/copilot-relay/` | `%USERPROFILE%\.copilot\extensions\copilot-relay\` |
| session names | `~/Library/Application Support/copilot-relay/names.json` | `%LOCALAPPDATA%\copilot-relay\names.json` |
| Copilot logs | `~/.copilot/logs/` | `%USERPROFILE%\.copilot\logs\` |
| managed policy | `/etc/github-copilot/policy.d/*.json` | `C:\ProgramData\GitHub\Copilot\policy.d\*.json`, registry `HKLM\Software\Policies\GitHub\Copilot` |

`$COPILOT_HOME`, if set, replaces `~/.copilot` and `%USERPROFILE%\.copilot`.

### 6. If it doesn't work

- **`Unknown command: /relay-name`** means an old extension version is installed or the session started before
  the install. Run `npm run install-extension` and start a new session.
- **The extension is not listed in `/env`** means experimental mode is off, or a managed policy disables extensions or hooks.
  Look in the policy locations above, or ask IT.
- **`Extension "user:copilot-relay" was denied permission access`** means the extension was never approved. It is always
  denied in `copilot -p` (prompt mode). Approve it in an interactive session.
- **The broker doesn't start by itself.** Start it manually with `npm start` and check that `nodePath` in the installed
  `config.json` points at an existing `node`.
- To read the logs:
  - macOS: `grep -h -i -E "extension|relay" ~/.copilot/logs/process-*.log | tail -20`
  - Windows PowerShell:
    `Select-String -Path "$env:USERPROFILE\.copilot\logs\process-*.log" -Pattern "extension|relay" | Select-Object -Last 20`
- The broker listens on `127.0.0.1` only. If a firewall dialog appears for `node`, you can deny network access,
  because loopback connections still work.

### 7. Optional: start the broker at login

Not required, since the first `copilot` session starts it. Only useful if you want the GUI available before that.

**macOS** (`~/Library/LaunchAgents/com.copilot-relay.plist`, then
`launchctl load ~/Library/LaunchAgents/com.copilot-relay.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.copilot-relay</string>
  <key>ProgramArguments</key>
  <array><string>/usr/local/bin/node</string><string>/Users/YOU/copilot-relay/server.mjs</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
</dict></plist>
```

(Use the output of `which node` and your repo path.)

**Windows** (PowerShell, once):

```powershell
$node = (Get-Command node).Source
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$PWD\server.mjs`"" -WorkingDirectory $PWD
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "copilot-relay" -Action $action -Trigger $trigger -Settings (New-ScheduledTaskSettingsSet -Hidden)
```

Run this from the repo directory. To remove it: `Unregister-ScheduledTask -TaskName copilot-relay`.

## Loop protection

A global agent→agent budget (`maxAgentMessagesPerUserTurn`, default 12) resets whenever a human prompts any
session, whether in a terminal (detected by the extension's `onUserPromptSubmitted` hook) or in the GUI.

## HTTP API

| call | purpose |
|---|---|
| `GET /api/sessions` | all peers |
| `POST /api/sessions` `{ name, role?, cwd?, model? }` | spawn an ACP session |
| `DELETE /api/sessions?name=x` | close an ACP session or forget a peer |
| `POST /api/send` `{ to: "x" \| "*", text }` | human message to a peer |
| `POST /api/permission`, `POST /api/cancel` | ACP permission answers / cancel |
| `GET /events` | GUI SSE stream (with history replay) |
| `GET /api/peer/stream?key=&name=&cwd=&alias=` | extension / desktop app: register + receive pushes (SSE); `alias` maps an MCP `?peer=` token to `key` |
| `POST /api/peer/send` / `rename` / `human`, `GET /api/peer/list` | extension calls |
| `/mcp` | MCP endpoint (stateful; `?peer=<key>` is used internally for ACP sessions) |

## Config (`relay.config.json`, all optional)

`port` (env `COPILOT_RELAY_PORT` wins), `cwd` (default dir for GUI sessions), `maxAgentMessagesPerUserTurn`,
`autoApproveTools`, `startupSessions: [{ name, role?, cwd?, model? }]`.

## Limitations (prototype)

- No persistence. Restarting the broker forgets peers. Extensions reconnect automatically under the same name, but messages sent while the broker is down are lost.
- A terminal peer that disconnects is kept for 30 s, with messages queued, and then removed.
- `/clear` in a terminal reloads the extension, which then registers as a new peer.
- Copilot CLI extensions and ACP are preview features (tested against CLI 1.0.95-3).
- Every delivered message is a new agent turn and consumes premium requests.
- No authentication on the local port. Any local process can read and send messages.
