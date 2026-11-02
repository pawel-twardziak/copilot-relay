// Electron main process: owns the `copilot --acp` processes and bridges them to the window over IPC.
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpConnection } from "./acp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
let win = null;
let lister = null; // one long-lived connection used for session/list
const open = new Map(); // sessionId -> { conn, cwd, permissions: Map<reqId, rpcId>, relay }
let permSeq = 0;

// relay-client.mjs is copied from ../extension by `npm start` / `npm run dist`; without it the relay is off
const { RelayClient } = await import("./relay-client.mjs").catch(() => ({}));

// ---------- environment ----------

// Apps started from Finder / the Dock / a desktop launcher get a minimal PATH, so `copilot`
// (Homebrew, npm global, ~/.local/bin) would not be found. Take PATH from the user's login shell.
function fixPath() {
  if (process.platform === "win32") return;
  const sh = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  try {
    const out = execFileSync(sh, ["-ilc", 'printf "__PATH__%s__PATH__" "$PATH"'], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = out.match(/__PATH__(.*)__PATH__/s);
    if (m?.[1]) {
      const merged = new Set([...m[1].split(":"), ...(process.env.PATH ?? "").split(":")].filter(Boolean));
      process.env.PATH = [...merged].join(":");
    }
  } catch {
    /* keep the inherited PATH */
  }
}

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
function loadSettings() {
  try {
    return JSON.parse(readFileSync(settingsFile(), "utf8"));
  } catch {
    return {};
  }
}
function saveSettings(s) {
  mkdirSync(path.dirname(settingsFile()), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}
const copilotCommand = () => loadSettings().copilotCommand || process.env.COPILOT_PATH || "copilot";

function friendly(err) {
  const msg = String(err?.message ?? err);
  if (/ENOENT|not recognized|not found/i.test(msg) && !/session/i.test(msg))
    return `Could not start "${copilotCommand()}". Install GitHub Copilot CLI or set its full path in Settings. (${msg})`;
  if (/auth|login|unauthor/i.test(msg)) return `${msg}\n\nRun \`copilot login\` in a terminal, then try again.`;
  return msg;
}

// ---------- copilot-relay ----------
//
// ACP sessions don't load Copilot CLI extensions, so the app does what the extension does in a terminal:
// it registers each open session with the relay broker under the same key (cli:<sessionId>, so the session
// keeps its relay name) and gives Copilot the relay tools as an MCP server. The MCP URL needs the identity
// before session/new returns the session ID, so it carries a random alias that the broker maps to the key.

function relayConfig() {
  const home = process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(path.join(home, "extensions", "copilot-relay", "config.json"), "utf8"));
  } catch {}
  const devScript = path.join(here, "..", "server.mjs"); // running from the repo
  return {
    enabled: Boolean(RelayClient) && loadSettings().relay !== false,
    url: (process.env.COPILOT_RELAY_URL || cfg.url || `http://127.0.0.1:${process.env.COPILOT_RELAY_PORT || 7777}`).replace(/\/$/, ""),
    brokerScript: [cfg.brokerScript, devScript].find((p) => p && existsSync(p)) ?? null,
    nodePath: cfg.nodePath && existsSync(cfg.nodePath) ? cfg.nodePath : null,
  };
}

/** MCP servers for session/new|load, plus the alias to register later. */
function relayPrepare() {
  const cfg = relayConfig();
  if (!cfg.enabled) return { cfg, alias: null, mcpServers: [] };
  const alias = `app:${randomUUID()}`;
  return { cfg, alias, mcpServers: [{ type: "http", name: "relay", url: `${cfg.url}/mcp?peer=${encodeURIComponent(alias)}`, headers: [] }] };
}

function relayStart(sessionId, cwd, { cfg, alias }) {
  if (!alias) return null;
  const status = (extra = {}) => send("relay:status", { sessionId, name: client.name, connected: client.connected, ...extra });
  const client = new RelayClient({
    url: cfg.url,
    key: `cli:${sessionId}`,
    alias,
    cwd,
    brokerScript: cfg.brokerScript,
    nodePath: cfg.nodePath,
    onMessage: (m) => send("relay:message", { sessionId, from: m.from, text: m.text, prompt: m.prompt }),
    onRegistered: () => status(),
    onRenamed: () => status(),
    log: (note) => status({ note }),
  });
  client.start();
  return client;
}

const send = (channel, payload) => win && !win.isDestroyed() && win.webContents.send(channel, payload);

// ---------- connections ----------

async function connect(cwd) {
  const conn = new AcpConnection({ command: copilotCommand(), cwd });
  await conn.start();
  return conn;
}

async function getLister() {
  if (lister && !lister.exited) return lister;
  lister = await connect(os.homedir());
  lister.on("exit", () => (lister = null));
  return lister;
}

/** Wire a session's connection to the window. */
function attach(sessionId, conn, cwd, relay) {
  const entry = { conn, cwd, permissions: new Map(), relay: relayStart(sessionId, cwd, relay), toolTitles: new Map() };
  open.set(sessionId, entry);
  conn.on("notification", (method, params) => {
    if (method !== "session/update" || params?.sessionId !== sessionId) return;
    const u = params.update;
    if (u?.sessionUpdate === "tool_call" && u.title) entry.toolTitles.set(u.toolCallId, u.title);
    send("acp:update", { sessionId, update: u });
  });
  conn.on("request:session/request_permission", (rpcId, params) => {
    // the relay's own tools run without asking, as with the terminal extension. The tool_call update carries
    // the server-prefixed name ("relay-send_message"), the permission request only the bare tool name.
    const title = entry.toolTitles.get(params.toolCall?.toolCallId) ?? params.toolCall?.title;
    if (entry.relay && /^relay-(send_message|list_sessions)$/.test(title ?? "")) {
      const opt = params.options?.find((o) => o.kind === "allow_once");
      if (opt) return conn.respond(rpcId, { outcome: { outcome: "selected", optionId: opt.optionId } });
    }
    const reqId = `p${++permSeq}`;
    entry.permissions.set(reqId, rpcId);
    send("acp:permission", { sessionId, reqId, toolCall: params.toolCall, options: params.options });
  });
  conn.on("exit", ({ code, signal, stderr }) => {
    entry.relay?.stop();
    if (open.get(sessionId)?.conn !== conn) return;
    open.delete(sessionId);
    send("acp:exit", { sessionId, code, signal, stderr: stderr?.trim().slice(-800) });
  });
  return entry;
}

function requireDir(cwd) {
  if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`Folder does not exist: ${cwd}`);
}

function getOpen(sessionId) {
  const e = open.get(sessionId);
  if (!e) throw new Error("This session is not open.");
  return e;
}

// IPC handlers return { ok, value } / { ok:false, error } so errors reach the renderer as readable text
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      return { ok: false, error: friendly(err) };
    }
  });
}

handle("sessions:list", async () => {
  const conn = await getLister();
  const all = [];
  let cursor;
  for (let page = 0; page < 50; page++) {
    const res = await conn.request("session/list", cursor ? { cursor } : {});
    all.push(...(res.sessions ?? []));
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  return all;
});

handle("sessions:new", async (cwd) => {
  requireDir(cwd);
  const conn = await connect(cwd);
  const relay = relayPrepare();
  try {
    const res = await conn.request("session/new", { cwd, mcpServers: relay.mcpServers });
    attach(res.sessionId, conn, cwd, relay);
    return { sessionId: res.sessionId, cwd, configOptions: res.configOptions ?? [] };
  } catch (e) {
    conn.kill();
    throw e;
  }
});

handle("sessions:open", async (sessionId, cwd) => {
  if (open.has(sessionId)) return { sessionId, cwd, configOptions: null, alreadyOpen: true };
  requireDir(cwd);
  const conn = await connect(cwd);
  const relay = relayPrepare();
  // the agent replays the history as session/update notifications before answering session/load
  const entry = attach(sessionId, conn, cwd, relay);
  try {
    const res = await conn.request("session/load", { sessionId, cwd, mcpServers: relay.mcpServers });
    return { sessionId, cwd, configOptions: res?.configOptions ?? [] };
  } catch (e) {
    entry.relay?.stop();
    open.delete(sessionId);
    conn.kill();
    throw e;
  }
});

handle("sessions:prompt", async (sessionId, text, human = true) => {
  const { conn, relay } = getOpen(sessionId);
  if (human) relay?.human(); // a human prompt re-opens the relay's agent-to-agent message budget
  const res = await conn.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  return res?.stopReason ?? "end_turn";
});

handle("sessions:cancel", async (sessionId) => {
  const e = getOpen(sessionId);
  // pending permission questions must be answered as cancelled
  for (const rpcId of e.permissions.values()) e.conn.respond(rpcId, { outcome: { outcome: "cancelled" } });
  e.permissions.clear();
  e.conn.notify("session/cancel", { sessionId });
});

handle("sessions:close", async (sessionId) => {
  const e = open.get(sessionId);
  if (!e) return;
  open.delete(sessionId);
  e.relay?.stop();
  await Promise.race([e.conn.request("session/close", { sessionId }).catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
  e.conn.kill();
});

handle("sessions:setConfig", async (sessionId, configId, value) => {
  const { conn } = getOpen(sessionId);
  const res = await conn.request("session/set_config_option", { sessionId, configId, value });
  return res?.configOptions ?? null;
});

handle("permission:answer", async (sessionId, reqId, optionId) => {
  const e = getOpen(sessionId);
  const rpcId = e.permissions.get(reqId);
  if (rpcId == null) return false;
  e.permissions.delete(reqId);
  e.conn.respond(rpcId, optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
  return true;
});

handle("relay:rename", async (sessionId, name) => {
  const { relay } = getOpen(sessionId);
  if (!relay) throw new Error("This session is not connected to copilot-relay.");
  return relay.rename(name);
});

handle("dialog:pickDir", async () => {
  const r = await dialog.showOpenDialog(win, { title: "Folder for the new session", properties: ["openDirectory", "createDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});

handle("settings:get", async () => ({
  copilotCommand: loadSettings().copilotCommand ?? "",
  effective: copilotCommand(),
  platform: process.platform,
  relay: loadSettings().relay !== false,
  relayAvailable: Boolean(RelayClient),
  relayUrl: relayConfig().url,
}));
handle("settings:set", async (s) => {
  saveSettings({ ...loadSettings(), copilotCommand: String(s.copilotCommand ?? "").trim(), relay: s.relay !== false });
  lister?.kill();
  lister = null;
  return true;
});

handle("shell:openPath", async (p) => {
  requireDir(p);
  return shell.openPath(p);
});

// ---------- window ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 480,
    title: "Copilot Sessions",
    backgroundColor: "#0d1117",
    autoHideMenuBar: true,
    icon: path.join(here, "build", "icon.png"), // window/taskbar icon on Windows and Linux (macOS uses the bundle icon)
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // links in agent output open in the system browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
  win.loadFile(path.join(here, "renderer", "index.html"));
  win.on("closed", () => (win = null));
}

function killAll() {
  for (const { conn, relay } of open.values()) {
    relay?.stop();
    conn.kill();
  }
  open.clear();
  lister?.kill();
}

fixPath();
app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on("window-all-closed", () => {
  killAll();
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", killAll);
