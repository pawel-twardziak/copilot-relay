// Electron main process: owns the `copilot --acp` processes and bridges them to the window over IPC.
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from "electron";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
    // `human` is set by the broker (true only for messages typed by a person in the relay GUI), not by the sender's name
    // human: true/false from this broker, undefined from an older one (the renderer then falls back to the sender name)
    onMessage: (m) => send("relay:message", { sessionId, from: m.from, human: m.human, text: m.text, prompt: m.prompt }),
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
  try {
    await conn.start();
  } catch (e) {
    conn.kill();
    // installed but signed out: friendly() adds the login hint (the command path is left out of the test,
    // so a missing /home/author/bin/copilot is still reported as "could not start")
    if (/auth|login|unauthor/i.test(e.message.replaceAll(copilotCommand(), ""))) throw e;
    // any other failure to start or initialize (not found, "command not found", missing interpreter, crash)
    throw new Error(`Could not start "${copilotCommand()}": ${e.message}\n\nInstall GitHub Copilot CLI or set its full path in Settings.`);
  }
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

// ---------- images ----------

// The one table of image types the models accept: pasted images are saved in one of these formats, and
// `@path` mentions of these files are attached to prompts.
const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
/** "3.7 MB" / "512 KB": the one byte formatter (notes in the chat and the Settings dialog). */
const fmtBytes = (b) => (b < 1024 * 1024 ? `${Math.round(b / 1024)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

// mime → file extension for saving pasted images (derived, so the two can't drift apart)
const EXT_FOR_MIME = Object.fromEntries(Object.entries(IMAGE_TYPES).filter(([ext]) => ext !== "jpeg").map(([ext, mime]) => [mime, ext]));

/** "~/x" and "~\\x" mean the home folder, as in a shell. */
const expandHome = (p) => (p === "~" ? os.homedir() : /^~[\\/]/.test(p) ? path.join(os.homedir(), p.slice(2)) : p);
// Model APIs reject images over about 5 MB *after* base64 encoding (4/3 of the file size), and an oversized
// image fails the whole turn. Files are checked against the encoded size, and the prompt has a total budget.
const MAX_IMAGE_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4) - 64 * 1024; // ≈3.7 MB file → <5 MB base64
const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024; // all images of one prompt together
const MAX_IMAGE_SIDE = 2048; // pasted images larger than the byte limit are scaled down to this

// Pasted images are saved here and an @path mention is put into the prompt. The temp dir is per-user on Windows
// and macOS. On Linux /tmp is shared, so the folder name carries the user ID and the folder is private (0700).
const PASTE_DIR = path.join(
  os.tmpdir(),
  process.platform === "win32" || process.platform === "darwin" ? "copilot-sessions" : `copilot-sessions-${process.getuid()}`,
  "pastes",
);

/** Refuse a paste folder (or its parent) that someone else created, that others can access, or that is a symlink. */
async function assertPrivate() {
  for (const dir of [path.dirname(PASTE_DIR), PASTE_DIR]) {
    const st = await lstat(dir); // ENOENT if it doesn't exist yet
    if (process.platform === "win32") continue;
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0)
      throw new Error(`Refusing to use ${dir}: it is not a private folder owned by you. Delete it and try again.`);
  }
}

/** The paste folder, created if needed (for saving). */
async function pasteDir() {
  await mkdir(PASTE_DIR, { recursive: true, mode: 0o700 });
  await assertPrivate();
  return PASTE_DIR;
}

/** The paste folder if it already exists (for listing / deleting), or null. Never follows a planted symlink. */
async function existingPasteDir() {
  try {
    await assertPrivate();
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  return PASTE_DIR;
}

/** Names of the pasted images (the same set is counted in Settings and deleted by "Delete pasted images"). */
async function listPastes() {
  if (!(await existingPasteDir())) return [];
  return (await readdir(PASTE_DIR)).filter((f) => f.startsWith("paste-"));
}

// `@path` / `@"path with spaces"` mentions. The terminal UI expands them itself; over ACP the agent only sees
// the text, so images are attached here as ACP image blocks. Other files stay as text: the agent reads them with its tools.
const MENTION_RE = /(?:^|\s)@(?:"([^"]+)"|(\S+))/g;

/** Build the ACP prompt. Returns the blocks plus notes about mentioned images that could not be attached. */
async function promptBlocks(text, cwd, { attachImages, imagesSupported }) {
  const blocks = [{ type: "text", text }];
  const notes = [];
  if (!attachImages) return { blocks, notes };
  const files = new Set();
  for (const m of text.matchAll(MENTION_RE)) {
    const file = path.resolve(cwd, expandHome(m[1] ?? m[2].replace(/[.,;:!?)]+$/, "")));
    if (IMAGE_TYPES[path.extname(file).slice(1).toLowerCase()]) files.add(file);
  }
  if (files.size && !imagesSupported) {
    notes.push("This Copilot CLI does not accept images over ACP; image mentions were sent as text only.");
    return { blocks, notes };
  }
  const NOT_FOUND = -1;
  const NOT_A_FILE = -2;
  const sizes = await Promise.all([...files].map((f) => stat(f).then((s) => (s.isFile() ? s.size : NOT_A_FILE), () => NOT_FOUND)));
  const chosen = [];
  let total = 0;
  [...files].forEach((file, i) => {
    const size = sizes[i];
    if (size === NOT_FOUND) return notes.push(`${file} was not found, so the image was not attached.`);
    if (size === NOT_A_FILE) return notes.push(`${file} is not a file, so it was not attached.`);
    if (size > MAX_IMAGE_BYTES) return notes.push(`${path.basename(file)} (${fmtBytes(size)}) is over the ${fmtBytes(MAX_IMAGE_BYTES)} image limit and was not attached.`);
    if (total + size > MAX_TOTAL_IMAGE_BYTES) return notes.push(`${path.basename(file)} was not attached: the images of one prompt are limited to ${fmtBytes(MAX_TOTAL_IMAGE_BYTES)} together.`);
    total += size;
    chosen.push(file);
  });
  const read = await Promise.all(
    chosen.map(async (file) => {
      try {
        const mimeType = IMAGE_TYPES[path.extname(file).slice(1).toLowerCase()];
        return { type: "image", mimeType, data: (await readFile(file)).toString("base64"), uri: pathToFileURL(file).href };
      } catch (e) {
        notes.push(`${path.basename(file)} could not be read (${e.code ?? e.message}), so it was not attached.`);
        return null;
      }
    }),
  );
  blocks.push(...read.filter(Boolean));
  return { blocks, notes };
}

handle("sessions:prompt", async (sessionId, text, source = "relay") => {
  // source: "app"   – typed in this app: re-opens the relay budget and attaches mentioned images
  //         "human" – typed by a person in the relay web GUI: re-opens the budget only
  //         "relay" – sent by another session: neither
  // Images are only ever attached for "app": the broker can't prove who is behind a relay message, and reading
  // local files must never be triggered from outside this window.
  const { conn, relay, cwd } = getOpen(sessionId);
  if (source === "app" || source === "human") relay?.human();
  const { blocks, notes } = await promptBlocks(text, cwd, {
    attachImages: source === "app",
    imagesSupported: conn.init?.agentCapabilities?.promptCapabilities?.image === true,
  });
  for (const note of notes) send("acp:notice", { sessionId, text: note });
  const res = await conn.request("session/prompt", { sessionId, prompt: blocks });
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

// ---------- links ----------

const WEB_LINK = /^(https?|mailto):/i;

// File types that default apps display rather than run. Everything else (installers, scripts, shortcuts,
// app bundles, unknown types…) is only shown in the file manager: an allowlist, because a list of dangerous
// extensions is never complete.
const SAFE_TO_OPEN = new Set(
  (
    // Deliberately small. Not here: source code and scripts (an installed interpreter may run them: .py, .lua, .mjs…),
    // html/svg/xml (script in the browser), Office/RTF/OpenDocument (macros, OLE/DDE). Those are revealed instead.
    "txt text md markdown rst adoc log csv tsv json jsonc json5 ndjson yaml yml toml diff patch " +
    "png jpg jpeg gif webp bmp ico tif tiff avif heic pdf"
  ).split(" "),
);

// folders with these extensions are app/plugin packages that the OS launches instead of browsing
const PACKAGE_DIRS = new Set(
  "app bundle framework plugin kext prefpane appex xpc workflow action saver qlgenerator mdimporter component pkg mpkg".split(" "),
);

function openWeb(url) {
  if (WEB_LINK.test(url)) shell.openExternal(url);
}

/** UNC paths and file://host URLs would make Windows contact a remote SMB server (and send the user's NTLM hash). */
function isRemote(p) {
  return /^(\\\\|\/\/)/.test(p);
}

/** Resolve a link target from agent output to an existing local path: file:// URL, absolute or relative to the session folder. */
function resolveTarget(cwd, target) {
  const raw = String(target ?? "").trim();
  let candidates;
  if (/^file:/i.test(raw)) {
    const url = new URL(raw);
    if (url.host && url.host !== "localhost") throw new Error(`Remote file links are not opened: ${raw}`);
    url.hash = "";
    candidates = [fileURLToPath(url)]; // decodes %xx once
  } else {
    // Markdown links come percent-encoded (marked encodes spaces and non-ASCII); plain paths may contain a
    // literal '%' or '#'. Try the text as is and decoded, each with and without an editor-style line suffix.
    const noLine = (x) => x.replace(/#L\d+(-L?\d+)?$/, "").replace(/(:\d+){1,2}$/, "");
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {}
    candidates = [...new Set([raw, noLine(raw), decoded, noLine(decoded)])];
  }
  const abs = candidates.map((c) => path.resolve(cwd || os.homedir(), expandHome(c)));
  if (candidates.some(isRemote) || abs.some(isRemote)) throw new Error(`Network paths are not opened: ${raw}`);
  for (const c of abs) {
    const real = localRealpath(c);
    if (real) return real;
  }
  throw new Error(`File not found: ${abs[1] ?? abs[0]}`);
}

/**
 * realpath that never touches the network: every symlink (or Windows junction) on the way is read with readlink
 * and refused if it points to a UNC / network path, before anything follows it. (fs.realpath or existsSync would
 * already open the SMB connection, which leaks the user's NTLM hash on Windows.) Returns null if the path doesn't exist.
 */
function localRealpath(p, depth = 0) {
  if (depth > 32) throw new Error(`Too many symbolic links: ${p}`);
  const { root } = path.parse(p);
  let cur = root;
  for (const part of p.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    const next = path.join(cur, part);
    let st;
    try {
      st = lstatSync(next);
    } catch {
      return null;
    }
    if (!st.isSymbolicLink()) {
      cur = next;
      continue;
    }
    let target = readlinkSync(next);
    if (/^\\\\\?\\UNC\\/i.test(target)) throw new Error(`Network paths are not opened: ${next} → ${target}`);
    target = target.replace(/^\\\\\?\\/, ""); // \\?\C:\x (Windows long-path form) is local
    const resolved = path.resolve(cur, target);
    if (isRemote(target) || isRemote(resolved)) throw new Error(`Network paths are not opened: ${next} → ${target}`);
    cur = localRealpath(resolved, depth + 1);
    if (!cur) return null;
  }
  return cur;
}

/** One entry point for every link click: web links go to the browser, safe files open, anything else is revealed. */
handle("open:link", async (cwd, target) => {
  const t = String(target ?? "");
  if (WEB_LINK.test(t)) return void (await shell.openExternal(t));
  // other URI schemes are refused; "main.mjs:42" (file:line) and "C:\\x" (drive) are paths, not schemes
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(t) && !/^file:/i.test(t) && !/^[a-z]:[\\/]/i.test(t)) throw new Error(`Unsupported link: ${t}`);
  // decide on the real target: a symlink named notes.txt may point at an app or a program
  // resolveTarget returns the real local path: symlinks resolved (a "notes.txt" link may point at an app), none remote
  const file = resolveTarget(cwd, t);
  const st = statSync(file);
  // Windows ignores trailing dots and spaces ("payload.exe." runs payload.exe), so drop them before reading the extension
  const name = process.platform === "win32" ? path.basename(file).replace(/[. ]+$/, "") : path.basename(file);
  const ext = path.extname(name).slice(1).toLowerCase();
  let safe;
  if (st.isDirectory()) safe = !PACKAGE_DIRS.has(ext); // "v1.2" or "conf.d" open; "Tool.app" would launch
  else if (ext) safe = SAFE_TO_OPEN.has(ext);
  else safe = false; // no extension: the OS would pick a handler by sniffing the content (.desktop, scripts…)
  if (!safe) {
    shell.showItemInFolder(file);
    return "revealed";
  }
  const err = await shell.openPath(file);
  if (err) throw new Error(err);
  return "opened";
});

handle("paste:saveImage", async (bytes, mime) => {
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error("Empty image");
  if (bytes.length > 50 * 1024 * 1024) throw new Error("Image is larger than 50 MB");
  const ext = EXT_FOR_MIME[mime]; // the renderer converts other image types to PNG first
  if (!ext) throw new Error(`Unsupported image type: ${mime}`);
  const dir = await pasteDir();
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const file = path.join(dir, `paste-${stamp}-${randomUUID().slice(0, 6)}.${ext}`);
  await writeFile(file, bytes, { mode: 0o600, flag: "wx" }); // wx: never follow or overwrite an existing file
  return file;
});

async function pasteStats() {
  const files = await listPastes();
  const sizes = await Promise.all(files.map((f) => stat(path.join(PASTE_DIR, f)).then((s) => s.size, () => 0)));
  return { dir: PASTE_DIR, count: files.length, size: fmtBytes(sizes.reduce((a, b) => a + b, 0)) };
}

handle("images:config", async () => ({ mimes: Object.keys(EXT_FOR_MIME), maxBytes: MAX_IMAGE_BYTES, maxSide: MAX_IMAGE_SIDE }));

handle("storage:get", async () => ({ pastes: await pasteStats(), settingsFile: settingsFile() }));

handle("storage:openPastes", async () => {
  const err = await shell.openPath(await pasteDir());
  if (err) throw new Error(err);
});

handle("storage:clearPastes", async () => {
  const files = await listPastes();
  const results = await Promise.allSettled(files.map((f) => rm(path.join(PASTE_DIR, f), { force: true })));
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length) throw new Error(`${failed.length} of ${files.length} file(s) could not be deleted: ${failed[0].reason?.message}`);
  return files.length;
});

handle("clipboard:write", async (text) => clipboard.writeText(String(text ?? "")));

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
  // The renderer handles link clicks (it knows the session folder) through open:link. These are the fallback for
  // anything that still tries to navigate: web links use the same allowlist, everything else is blocked.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openWeb(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault();
      openWeb(url);
    }
  });
  // Electron has no context menu of its own: offer the usual edit actions for the selection / text fields
  win.webContents.on("context-menu", (_e, p) => {
    const items = [];
    if (p.isEditable) items.push({ role: "cut", enabled: p.editFlags.canCut });
    if (p.selectionText || p.isEditable) items.push({ role: "copy", enabled: p.editFlags.canCopy });
    if (p.isEditable) items.push({ role: "paste", enabled: p.editFlags.canPaste });
    if (p.linkURL && WEB_LINK.test(p.linkURL)) items.push({ label: "Copy link", click: () => clipboard.writeText(p.linkURL) });
    items.push({ type: "separator" }, { role: "selectAll" });
    Menu.buildFromTemplate(items).popup({ window: win });
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
