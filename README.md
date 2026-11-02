# copilot-relay

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
the name per Copilot session ID in `~/.local/state/copilot-relay/names.json`, so it survives broker restarts
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
| `GET /api/peer/stream?key=&name=&cwd=` | extension: register + receive pushes (SSE) |
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
