// Electron main process: owns the `copilot --acp` processes and bridges them to the window over IPC.
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from "electron";
import { isInside, lexicalPath } from "./paths.mjs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { lstat, mkdtemp, open as openFile, readdir, readlink, rm, rmdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AcpConnection } from "./acp.mjs";
import {
  countUserMessages,
  deleteSession,
  describeCut,
  forkSession,
  isSessionId,
  isSideQuestion,
  purgeDeleted,
  purgeSideQuestions,
  sessionDir,
  snapshotSession,
  truncateSession,
} from "./history.mjs";
import { createUsagePusher } from "./usage.mjs";
import { dropAsides, listAsides, pruneAsides, removeAside, saveAside } from "./asides.mjs";

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

// Sign-in problems are recognized by ACP's auth_required error code, not by guessing from the wording (Copilot
// uses other codes for other errors: -32002 resource not found, -32602 invalid params…).
const ACP_AUTH_REQUIRED = -32000;
const LOGIN_HINT = "Run `copilot login` in a terminal, then try again.";

/** auth_required, or Copilot's own instruction to run `copilot login` (an exact phrase, not a guess from words). */
const needsLogin = (err) => err?.code === ACP_AUTH_REQUIRED || /\bcopilot login\b/i.test(String(err?.message ?? err));

function friendly(err) {
  const msg = String(err?.message ?? err);
  if (err?.startFailure) return msg; // connect() already explained it
  if (needsLogin(err) && !msg.includes(LOGIN_HINT)) return `${msg}\n\n${LOGIN_HINT}`;
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
    // A start can fail because Copilot is missing (wrong path), crashed, or is signed out and quit; the error text
    // doesn't reliably say which, so unless Copilot answered auth_required both remedies are shown.
    const detail = String(e?.message ?? e);
    const hint =
      needsLogin(e)
        ? LOGIN_HINT
        : e?.code === "ENOENT" // spawn: no such program
          ? "GitHub Copilot CLI was not found. Install it, or set its full path in Settings."
          : "If GitHub Copilot CLI is installed, check that you are signed in (`copilot login` in a terminal). " +
          "Otherwise install it, or set its full path in Settings.";
    const err = new Error(`Could not start "${conn.command}": ${detail}\n\n${hint}`);
    err.startFailure = true;
    throw err;
  }
  return conn;
}

async function getLister() {
  if (lister && !lister.exited) return lister;
  lister = await connect(os.homedir());
  lister.on("exit", () => (lister = null));
  return lister;
}

// context/credits/quota figures for the window, debounced per session
const usage = createUsagePusher({ send: (sessionId, view) => send("usage:update", { sessionId, view }) });

/** Wire a session's connection to the window. */
function attach(sessionId, conn, cwd, relay) {
  const entry = { conn, cwd, permissions: new Map(), relay: relayStart(sessionId, cwd, relay), toolTitles: new Map() };
  open.set(sessionId, entry);
  // one path for live and replayed updates (see sessions:new)
  entry.update = (u) => {
    if (u?.sessionUpdate === "tool_call" && u.title) entry.toolTitles.set(u.toolCallId, u.title);
    if (u?.sessionUpdate === "usage_update" && open.get(sessionId) === entry) usage.context(sessionId, { used: u.used, size: u.size });
    // /rename answers with a chat line ("Session renamed to: …"); the new title arrives as session_info_update
    if (entry.renaming && u?.sessionUpdate === "agent_message_chunk") return;
    send("acp:update", { sessionId, update: u });
  };
  conn.on("notification", (method, params) => {
    if (method === "session/update" && params?.sessionId === sessionId) entry.update(params.update);
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
    usage.forget(sessionId);
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

let purging = Promise.resolve(); // leftovers of failed deletes are removed before the first list (briefly waited for:
// they have no workspace.yaml/events.jsonl left, so a slow purge of a big one must not hold up the sidebar)

handle("sessions:list", async () => {
  await Promise.race([purging, new Promise((r) => setTimeout(r, 1000))]);
  const conn = await getLister();
  const all = [];
  let cursor;
  for (let page = 0; page < 50; page++) {
    const res = await conn.request("session/list", cursor ? { cursor } : {});
    all.push(...(res.sessions ?? []));
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  // temporary side-question copies are not sessions of yours (the title check keeps the disk lookups rare)
  return all.filter((s) => !sideCopies.has(s.sessionId) && !isSideQuestion(s.sessionId));
});

handle("sessions:new", async (cwd) => {
  requireDir(cwd);
  const conn = await connect(cwd);
  const relay = relayPrepare();
  // the agent may send updates (available_commands_update…) before it answers session/new: keep them
  const early = [];
  const hold = (method, params) => {
    if (method === "session/update") early.push(params);
  };
  conn.on("notification", hold);
  try {
    const res = await conn.request("session/new", { cwd, mcpServers: relay.mcpServers });
    const entry = attach(res.sessionId, conn, cwd, relay);
    conn.off("notification", hold);
    for (const p of early) if (p?.sessionId === res.sessionId) entry.update(p.update);
    usage.refresh(res.sessionId);
    return { sessionId: res.sessionId, cwd, configOptions: res.configOptions ?? [] };
  } catch (e) {
    conn.kill();
    throw e;
  }
});

// sessions being opened (id -> number of opens in flight) / deleted: a delete must not race a resume that hasn't
// registered the session in `open` yet
const opening = new Map();
const deleting = new Set();
const historyBusy = new Set(); // a truncate is closing the session and rewriting its files
const lingering = new Map(); // id -> connection whose Copilot would not exit: may still write the session's files

handle("sessions:open", async (sessionId, cwd) => {
  if (open.has(sessionId)) return { sessionId, cwd, configOptions: null, alreadyOpen: true };
  refuseWhileDeleting(sessionId);
  // a truncate closed it and is rewriting events.jsonl: a resume now would load (and write) a half-done history
  if (historyBusy.has(sessionId)) throw new Error("Wait until the delete of a message has finished.");
  opening.set(sessionId, (opening.get(sessionId) ?? 0) + 1);
  try {
    return await openSession(sessionId, cwd);
  } finally {
    const n = opening.get(sessionId) - 1;
    if (n > 0) opening.set(sessionId, n);
    else opening.delete(sessionId);
  }
});

async function openSession(sessionId, cwd) {
  requireDir(cwd);
  const conn = await connect(cwd);
  const relay = relayPrepare();
  // the agent replays the history as session/update notifications before answering session/load
  const entry = attach(sessionId, conn, cwd, relay);
  try {
    const res = await conn.request("session/load", { sessionId, cwd, mcpServers: relay.mcpServers });
    if (open.get(sessionId) === entry) usage.refresh(sessionId);
    return { sessionId, cwd, configOptions: res?.configOptions ?? [] };
  } catch (e) {
    entry.relay?.stop();
    open.delete(sessionId);
    usage.forget(sessionId);
    conn.kill();
    throw e;
  }
}

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

// Pasted images are saved in the system temp folder (Copilot CLI may read it without asking) and an @path mention
// is put into the prompt. The folder is created once with mkdtemp: a random name, created atomically with mode 0700,
// so on a shared /tmp nobody can create or replace it beforehand. Its path is remembered in the settings; if the
// system cleans its temp folder, a new one is created on the next paste.
let pasteDirCache = null;
let pasteDirPending = null;

/** A real (non-symlink) folder owned by this user; with `private`, also not accessible to others (mode 0700). */
async function ownDir(dir, { private: priv = false } = {}) {
  try {
    const st = await lstat(dir);
    if (!st.isDirectory()) return false; // lstat: a symlink is never a directory here
    if (process.platform === "win32") return true;
    return st.uid === process.getuid() && (!priv || (st.mode & 0o077) === 0);
  } catch {
    return false;
  }
}
const isPrivateDir = (dir) => ownDir(dir, { private: true });

/** The paste folder, created if needed. Concurrent pastes share one creation (one folder, one settings write). */
async function pasteDir() {
  if (pasteDirCache && (await isPrivateDir(pasteDirCache))) return pasteDirCache;
  pasteDirPending ??= (async () => {
    const saved = loadSettings().pasteDir;
    if (saved && (await isPrivateDir(saved))) return (pasteDirCache = saved);
    const dir = await mkdtemp(path.join(os.tmpdir(), "copilot-sessions-"));
    // re-read right before writing, so a Settings change (or another app window's folder) saved in the meantime is
    // kept. Replaced folders are remembered (images left in them are still listed); folders that are gone are dropped.
    const fresh = loadSettings();
    const previous = [...new Set([...(fresh.previousPasteDirs ?? []), saved, fresh.pasteDir])].filter((d) => d && d !== dir && existsSync(d));
    try {
      saveSettings({ ...fresh, pasteDir: dir, previousPasteDirs: previous });
    } catch (e) {
      await rm(dir, { recursive: true, force: true }); // not recorded anywhere: don't leave it behind
      throw e;
    }
    return (pasteDirCache = dir);
  })().finally(() => (pasteDirPending = null));
  return pasteDirPending;
}

// v0.1.1 used a fixed name; images left there are still counted and deleted
const LEGACY_PASTE_DIRS = [
  path.join(os.tmpdir(), process.platform === "win32" || process.platform === "darwin" ? "copilot-sessions" : `copilot-sessions-${process.getuid()}`, "pastes"),
];

/** The current paste folder if it exists (without creating one), or null. */
const currentPasteDir = async () => (await pasteFolders()).current;

/** The current paste folder (or null) and the older ones that may still hold images: replaced folders, the saved
 *  one when it is no longer private (it is replaced on the next paste), and the v0.1.1 fixed-name folder. */
async function pasteFolders() {
  const settings = loadSettings();
  const saved = pasteDirCache ?? settings.pasteDir;
  const current = saved && (await isPrivateDir(saved)) ? saved : null;
  const older = [...new Set([settings.pasteDir, ...(settings.previousPasteDirs ?? []), ...LEGACY_PASTE_DIRS])].filter((d) => d && d !== current);
  return { current, older };
}

/** Paths of the pasted images (the same set is counted in Settings and deleted by "Delete pasted images").
 *  Older folders that aren't ours are skipped, never followed. */
async function listPastes() {
  const { current, older } = await pasteFolders();
  const files = [];
  for (const dir of [current, ...older]) {
    if (!dir) continue;
    // older folders: only if they are still ours (owner checked, never following a symlink); a mode change by the
    // user doesn't hide them, someone else's folder is never touched
    if (dir !== current && !(await isOwnPasteDir(dir))) continue;
    for (const f of await readdir(dir).catch(() => [])) if (f.startsWith("paste-")) files.push(path.join(dir, f));
  }
  return { current, older, files };
}

/** An older paste folder we may list and empty: ours, and inside a parent that is ours or a sticky temp folder. */
async function isOwnPasteDir(dir) {
  if (!(await ownDir(dir))) return false;
  if (process.platform === "win32") return true;
  const parent = await lstat(path.dirname(dir)).catch(() => null);
  // a sticky folder protects our entries only if root owns it (like /tmp); otherwise its owner could swap them
  return Boolean(parent?.isDirectory() && (parent.uid === process.getuid() || (parent.mode & 0o1000 && parent.uid === 0)));
}

// `@path` / `@"path with spaces"` mentions. The terminal UI expands them itself; over ACP the agent only sees
// the text, so images are attached here as ACP image blocks. Other files stay as text: the agent reads them with its tools.
const MENTION_RE = /(?:^|\s)@(?:"([^"]+)"|(\S+))/g;

// Open flags: non-blocking, so a FIFO swapped in for the image can't hang the prompt.
const OPEN_FLAGS = process.platform === "win32" ? "r" : fsConstants.O_RDONLY | fsConstants.O_NONBLOCK;

/**
 * Read one mentioned image, all checks on what is actually read:
 * stat the path first (devices, FIFOs and folders are never opened), open it, check the opened handle again,
 * read at most `limit` bytes into a buffer sized to the file, and take the type from those bytes.
 * Returns { block, bytes } or { problem }.
 */
async function readImage(file, limit) {
  let fh;
  try {
    // like links: never touch a network path, also not through a symlink/junction (on Windows that alone sends the
    // user's NTLM hash to the server). localRealpath reads every link without following it into the network.
    if (isRemote(file)) return { problem: "is on a network path" };
    const real = await localRealpath(file);
    if (!real) return { problem: "was not found" };
    if (!(await stat(real)).isFile()) return { problem: "is not a file" };
    fh = await openFile(real, OPEN_FLAGS);
    const st = await fh.stat();
    if (!st.isFile()) return { problem: "is not a file" };
    if (st.size > limit) return { problem: null, tooBig: st.size };
    const buf = Buffer.allocUnsafe(st.size + 1); // +1: notices a file that grew since stat
    let len = 0;
    for (let n; len < buf.length && (n = (await fh.read(buf, len, buf.length - len, len)).bytesRead) > 0; ) len += n;
    if (len > limit || len > st.size) return { problem: "changed while being read" };
    const data = buf.subarray(0, len);
    // the type comes from the bytes that are sent: a ".png" that is really a JPEG would fail the whole turn
    const mimeType = sniffImage(data);
    if (!mimeType) return { problem: "is not a PNG, JPEG, GIF or WebP image" };
    return { bytes: len, block: { type: "image", mimeType, data: data.toString("base64"), uri: pathToFileURL(file).href } };
  } catch (e) {
    if (/^Network paths/.test(e.message)) return { problem: "leads to a network path through a link" };
    return { problem: e.code === "ENOENT" || e.code === "ENOTDIR" ? "was not found" : `could not be read (${e.code ?? e.message})` };
  } finally {
    await fh?.close().catch(() => {}); // a failing close must not fail the whole prompt
  }
}

/** Image type from the first bytes of the file (PNG, JPEG, GIF, WebP), or null. */
function sniffImage(buf) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString("latin1", 0, 6))) return "image/gif";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** Build the ACP prompt. Returns the blocks plus notes about mentioned images that could not be attached. */
async function promptBlocks(text, cwd, { attachImages, imagesSupported }) {
  const blocks = [{ type: "text", text }];
  const notes = [];
  if (!attachImages) return { blocks, notes };
  const files = new Set();
  for (const m of text.matchAll(MENTION_RE)) {
    const raw = m[1] ?? m[2].replace(/[.,;:!?)]+$/, "");
    if (!IMAGE_TYPES[path.extname(raw).slice(1).toLowerCase()]) continue;
    // network paths are refused before resolving (on Linux path.resolve turns "//server/x" into "/server/x")
    if (isRemote(raw)) {
      notes.push(`${raw} is on a network path, so it was not attached.`);
      continue;
    }
    files.add(path.resolve(cwd, expandHome(raw)));
  }
  if (files.size && !imagesSupported) {
    notes.push("This Copilot CLI does not accept images over ACP; image mentions were sent as text only.");
    return { blocks, notes };
  }
  // one file after another, so the total limit is enforced against what was actually read
  let total = 0;
  for (const file of files) {
    const name = path.basename(file);
    const room = Math.min(MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES - total);
    const r = await readImage(file, Math.max(room, 0)); // still checked when the total is used up: a typo is reported as such
    // "not found" shows the resolved path (it may have been resolved against an unexpected folder)
    if (r.problem) notes.push(`${r.problem === "was not found" ? file : name} ${r.problem}, so it was not attached.`);
    else if (r.tooBig && r.tooBig > MAX_IMAGE_BYTES)
      notes.push(`${name} (${fmtBytes(r.tooBig)}) is over the ${fmtBytes(MAX_IMAGE_BYTES)} image limit and was not attached.`);
    else if (r.tooBig) notes.push(`${name} was not attached: the images of one prompt are limited to ${fmtBytes(MAX_TOTAL_IMAGE_BYTES)} together.`);
    else {
      total += r.bytes;
      blocks.push(r.block);
    }
  }
  return { blocks, notes };
}

handle("sessions:prompt", async (sessionId, text, source = "relay") => {
  // source: "app"   – typed in this app: re-opens the relay budget and attaches mentioned images
  //         "human" – typed by a person in the relay web GUI: re-opens the budget only
  //         "relay" – sent by another session: neither
  // Images are only ever attached for "app": the broker can't prove who is behind a relay message, and reading
  // local files must never be triggered from outside this window.
  const entry = getOpen(sessionId);
  const { conn, relay, cwd } = entry;
  if (source === "app" || source === "human") relay?.human();
  const { blocks, notes } = await promptBlocks(text, cwd, {
    attachImages: source === "app",
    imagesSupported: conn.init?.agentCapabilities?.promptCapabilities?.image === true,
  });
  for (const note of notes) send("acp:notice", { sessionId, text: note });
  // a side question asked during this turn sees the history up to here: the turns finished before it
  try {
    entry.turnUsers = countUserMessages(sessionId);
  } catch {
    entry.turnUsers = null;
  }
  // fork/truncate refuse while a turn is running: the agent is still writing the history
  entry.prompting = true;
  try {
    const res = await conn.request("session/prompt", { sessionId, prompt: blocks });
    return res?.stopReason ?? "end_turn";
  } finally {
    entry.prompting = false;
    if (open.get(sessionId) === entry) usage.refresh(sessionId); // not after a close/truncate mid-turn
  }
});

// Count of user messages Copilot recorded in events.jsonl (0 before the first turn).
handle("sessions:userMessages", async (sessionId) => countUserMessages(sessionId));

// Copilot's own /rename command: it runs no model turn and isn't stored in the history, so turn numbers
// used by fork/delete stay right. Copilot saves the name in workspace.yaml (user_named: true).
handle("sessions:rename", async (sessionId, name) => {
  const entry = getOpen(sessionId);
  if (entry.prompting) throw new Error("Wait until Copilot finishes this turn.");
  name = String(name ?? "").replace(/\s+/g, " ").trim();
  if (!name) throw new Error("The name can't be empty.");
  if (name.length > 200) throw new Error("The name is too long (200 characters at most).");
  entry.prompting = entry.renaming = true;
  try {
    await entry.conn.request("session/prompt", { sessionId, prompt: [{ type: "text", text: `/rename ${name}` }] });
  } finally {
    entry.prompting = entry.renaming = false;
  }
  return name;
});

/** Stop the session's turn: pending permission questions are answered as cancelled, then session/cancel. */
function cancelTurn(sessionId, e) {
  for (const rpcId of e.permissions.values()) e.conn.respond(rpcId, { outcome: { outcome: "cancelled" } });
  e.permissions.clear();
  e.conn.notify("session/cancel", { sessionId });
}

handle("sessions:cancel", async (sessionId) => cancelTurn(sessionId, getOpen(sessionId)));

/** Close an open session and stop its agent; returns the stopped connection (undefined if it wasn't open). */
async function closeEntry(sessionId) {
  const e = open.get(sessionId);
  if (!e) return;
  // removed from `open` first, so the connection's exit handler stays silent (no acp:exit)
  open.delete(sessionId);
  usage.forget(sessionId);
  e.relay?.stop();
  stopAsides(sessionId);
  await Promise.race([e.conn.request("session/close", { sessionId }).catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
  e.conn.kill();
  return e.conn;
}

handle("sessions:close", async (sessionId) => {
  await closeEntry(sessionId);
});

// ---------- side questions ----------
// A question about a session whose agent is busy: asked in a temporary copy of the session (the turns finished
// before the running one), run by a second Copilot process that may only read. The original is never touched and
// its agent never sees the question; the copy is deleted when the answer is in.

const asides = new Map(); // asideId -> { parent, conn, copyId, stopped }
// ids of this run's copies, kept after they are deleted: Copilot's session list may still name one for a while
const sideCopies = new Set();

/** Stop a side question: before its prompt it just won't start, during it session/cancel ends the answer. */
function stopAside(a) {
  a.stopped = true;
  if (a.prompting) a.conn.notify("session/cancel", { sessionId: a.copyId });
}

function stopAsides(parent) {
  for (const a of asides.values()) if (a.parent === parent) stopAside(a);
}

/** Close a side question's process, then delete its copy (left for purgeSideQuestions() if the process won't exit). */
async function disposeAside(a) {
  if (a.conn) {
    await Promise.race([a.conn.request("session/close", { sessionId: a.copyId }).catch(() => {}), new Promise((r) => setTimeout(r, 1000))]);
    a.conn.kill();
    await exited(a.conn);
  }
  if (a.copyId && (!a.conn || a.conn.exited)) {
    const res = await deleteSession(a.copyId, { missingOk: true }).catch((err) => ({ leftover: err.message }));
    if (res.leftover) console.warn(`[aside] could not remove ${res.leftover}`);
  }
}

handle("aside:ask", async (sessionId, asideId, text) => {
  if (typeof asideId !== "string" || !asideId || asides.has(asideId)) throw new Error("Invalid side question id.");
  text = String(text ?? "").trim();
  if (!text) throw new Error("The question is empty.");
  const entry = getOpen(sessionId);
  refuseWhileDeleting(sessionId);
  if (historyBusy.has(sessionId)) throw new Error("Wait until the delete of a message has finished.");
  // during a turn: the turns finished before it; otherwise the whole history
  const keep = entry.prompting ? entry.turnUsers : countUserMessages(sessionId);
  if (!Number.isInteger(keep)) throw new Error("Could not read this session's history.");

  const a = { parent: sessionId, conn: null, copyId: null, stopped: false, prompting: false };
  asides.set(asideId, a);
  const emit = (payload) => send("aside:update", { sessionId, asideId, ...payload });
  try {
    emit({ phase: "copy" });
    a.copyId = snapshotSession(sessionId, keep).sessionId;
    sideCopies.add(a.copyId);
    if (a.stopped) return "cancelled";
    emit({ phase: "start" });
    a.conn = await connect(entry.cwd);
    // read-only: every tool that needs a permission is refused
    a.conn.on("request:session/request_permission", (rpcId) => a.conn.respond(rpcId, { outcome: { outcome: "cancelled" } }));
    if (a.stopped) return "cancelled";
    // the copy's history is replayed before session/load answers; only what comes after it is the answer
    await a.conn.request("session/load", { sessionId: a.copyId, cwd: entry.cwd, mcpServers: [] });
    if (a.stopped) return "cancelled";
    a.conn.on("notification", (method, params) => {
      if (method !== "session/update" || params?.sessionId !== a.copyId) return;
      const u = params.update;
      if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") emit({ text: u.content.text });
      else if (u?.sessionUpdate === "tool_call") emit({ tool: u.title ?? "tool" });
    });
    emit({ phase: "ask" });
    a.prompting = true;
    const res = await a.conn.request("session/prompt", { sessionId: a.copyId, prompt: [{ type: "text", text }] });
    return res?.stopReason ?? "end_turn";
  } finally {
    a.prompting = false;
    asides.delete(asideId);
    disposeAside(a).catch((err) => console.warn(`[aside] cleanup failed: ${err.message}`));
  }
});

// the cards of finished side questions, kept by the app (Copilot's history doesn't have them)
const asideDir = () => path.join(app.getPath("userData"), "side-questions");
handle("aside:list", async (sessionId) => listAsides(asideDir(), sessionId));
handle("aside:save", async (sessionId, entry) => saveAside(asideDir(), sessionId, entry));
handle("aside:remove", async (sessionId, id) => removeAside(asideDir(), sessionId, String(id)));

handle("aside:cancel", async (asideId) => {
  const a = asides.get(asideId);
  if (a) stopAside(a);
});

// ---------- history: fork / delete from a message ----------

const CUT_POSITIONS = ["beforeUser", "beforeReply", "afterReply"];

/** The renderer's cut target, checked before it reaches history.mjs. */
function cutTarget(target) {
  const { ordinal, text, where } = target ?? {};
  if (!Number.isInteger(ordinal) || ordinal < 1) throw new Error("Invalid message position.");
  if (typeof text !== "string") throw new Error("Invalid message text.");
  if (!CUT_POSITIONS.includes(where)) throw new Error(`Unknown cut position: ${where}`);
  return { ordinal, text, where };
}

function refuseWhilePrompting(sessionId) {
  if (open.get(sessionId)?.prompting) throw new Error("Wait until Copilot finishes this turn.");
}

/** Resolves once `conn`'s process has exited, or after `ms` (kill() escalates to SIGKILL after 3 s). */
function exited(conn, ms = 4000) {
  if (!conn || conn.exited) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    conn.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// how many messages a delete would remove, for the confirm dialog
handle("sessions:countFrom", async (sessionId, target) => describeCut(sessionId, cutTarget(target)));

/** Close a session's process and wait until it is gone: until then the agent may still write to its files, and
 *  could recreate a deleted session dir. One that outlives the SIGTERM→SIGKILL of kill() is killed again. */
async function closeAndWait(sessionId) {
  const conn = await closeEntry(sessionId);
  await exited(conn);
  if (!conn || conn.exited) return;
  // on Windows the process is a shell wrapper: kill() runs taskkill /T /F on the whole tree again
  if (process.platform === "win32") conn.kill();
  else conn.proc?.kill("SIGKILL");
  await exited(conn, 2000);
  if (conn.exited) return;
  // until it is really gone, nothing may open, rewrite or delete the session (a second agent on the same files)
  lingering.set(sessionId, conn);
  conn.once("exit", () => lingering.get(sessionId) === conn && lingering.delete(sessionId));
  throw new Error("Copilot did not exit, so its files were left as they were. The session was closed; try again later.");
}

const LINGERING = "Copilot is still running for this session (it did not exit). Try again in a moment.";

function refuseWhileDeleting(sessionId) {
  if (deleting.has(sessionId)) throw new Error("This session is being deleted.");
  if (lingering.has(sessionId)) throw new Error(LINGERING);
}

/** Run a truncate of `sessionId` marked in historyBusy, so a delete of the same session is refused meanwhile
 *  (a fork is synchronous: nothing can run in between). */
async function historyOp(sessionId, fn) {
  refuseWhileDeleting(sessionId);
  // a resume in flight isn't in `open` yet: closeAndWait would miss it and the history be rewritten under it
  if (opening.has(sessionId)) throw new Error("This session is still opening. Try again when it has loaded.");
  historyBusy.add(sessionId);
  try {
    return await fn();
  } finally {
    historyBusy.delete(sessionId);
  }
}
// copy of the history up to the target under a new session id; the source stays as it is (open or not)
handle("sessions:fork", async (sessionId, target) => {
  target = cutTarget(target);
  refuseWhilePrompting(sessionId);
  refuseWhileDeleting(sessionId);
  return forkSession(sessionId, target);
});

// cut the history in place; the session is closed first and the renderer reopens it via sessions:open
handle("sessions:truncate", async (sessionId, target) => {
  target = cutTarget(target);
  refuseWhilePrompting(sessionId);
  return historyOp(sessionId, async () => {
    describeCut(sessionId, target); // throws for a target that doesn't match, before anything is closed
    await closeAndWait(sessionId);
    const res = truncateSession(sessionId, target);
    try {
      pruneAsides(asideDir(), sessionId, countUserMessages(sessionId)); // the cards of the removed turns go too
    } catch (err) {
      console.warn(`[aside] could not prune saved side questions: ${err.message}`);
    }
    return res;
  });
});

// the whole session, for good: its process is closed first (the agent may write to its files until it is gone)
handle("sessions:delete", async (sessionId) => {
  // refusals leave the session untouched (still open if it was): the window must not reopen it
  if (!isSessionId(sessionId)) return { refused: `Invalid session id: ${sessionId}` };
  if (opening.has(sessionId)) return { refused: "This session is still opening. Try again when it has loaded." };
  if (historyBusy.has(sessionId)) return { refused: "Wait until the delete of a message has finished." };
  if (deleting.has(sessionId)) return { refused: "This session is already being deleted." };
  if (lingering.has(sessionId)) return { refused: LINGERING };
  // an entry that isn't a plain session dir (a file, a link) can't be deleted here: say so before closing anything
  try {
    sessionDir(sessionId);
  } catch (err) {
    if (err.code !== "ENOSESSION") return { refused: err.message };
  }
  deleting.add(sessionId);
  try {
    const e = open.get(sessionId);
    if (e?.prompting || e?.permissions.size) cancelTurn(sessionId, e); // a running turn would delay session/close
    try {
      await closeAndWait(sessionId);
    } catch (err) {
      return { stuck: err.message }; // the window must not reopen it while the old process lives
    }
    // missingOk: a session that never wrote its dir (or is already gone) just has its store rows removed
    const res = await deleteSession(sessionId, { missingOk: true });
    try {
      dropAsides(asideDir(), sessionId);
    } catch (err) {
      console.warn(`[aside] could not remove saved side questions: ${err.message}`);
    }
    if (res.leftover) console.warn(`[delete] could not remove ${res.leftover}`);
    if (res.store.error) console.warn(`[delete] session-store.db: ${res.store.error}`);
    return res;
  } finally {
    deleting.delete(sessionId);
  }
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
    "bmp ico tif tiff avif heic pdf"
  )
    .split(" ")
    .concat(Object.keys(IMAGE_TYPES)), // every attachable image type can also be opened
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
async function resolveTarget(cwd, target) {
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
    // "README.md#usage": strip a "#anchor" after "name.ext", except a bare number ("v1.2#3"); tried after the literal
    // name, so "C#note.md" still opens
    const noFragment = (x) => x.replace(/(\.[A-Za-z0-9]+)#(?!\d+$)[^\s\\/#]+$/u, "$1");
    candidates = [...new Set([raw, noLine(raw), decoded, noLine(decoded), noFragment(decoded), noFragment(noLine(decoded))])];
  }
  const abs = candidates.map((c) => path.resolve(cwd || os.homedir(), expandHome(c)));
  if (candidates.some(isRemote) || abs.some(isRemote)) throw new Error(`Network paths are not opened: ${raw}`);
  for (const c of abs) {
    const real = await localRealpath(c);
    if (real) return real;
  }
  throw new Error(`File not found: ${abs[0]}`); // the path as clicked
}

/**
 * realpath that never touches the network: every symlink (or Windows junction) on the way is read with readlink
 * and refused if it points to a UNC / network path, before anything follows it. (fs.realpath or existsSync would
 * already open the SMB connection, which leaks the user's NTLM hash on Windows.) Returns null if the path doesn't exist.
 */
async function localRealpath(p, depth = 0) {
  if (depth > 32) throw new Error(`Too many symbolic links: ${p}`);
  const { root } = path.parse(p);
  let cur = root;
  for (const part of p.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    const next = path.join(cur, part);
    let st;
    try {
      st = await lstat(next); // async: a slow mount must not freeze the main process
    } catch {
      return null;
    }
    if (!st.isSymbolicLink()) {
      cur = next;
      continue;
    }
    let target = await readlink(next);
    if (/^\\\\\?\\UNC\\/i.test(target)) throw new Error(`Network paths are not opened: ${next} → ${target}`);
    target = target.replace(/^\\\\\?\\/, ""); // \\?\C:\x (Windows long-path form) is local
    const resolved = path.resolve(cur, target);
    if (isRemote(target) || isRemote(resolved)) throw new Error(`Network paths are not opened: ${next} → ${target}`);
    cur = await localRealpath(resolved, depth + 1);
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
  // resolveTarget returns the real local path: symlinks resolved (a "notes.txt" link may point at an app), none remote
  const file = await resolveTarget(cwd, t);
  const st = await stat(file);
  // Windows ignores trailing dots and spaces ("payload.exe." runs payload.exe), so drop them before reading the extension
  const name = process.platform === "win32" ? path.basename(file).replace(/[. ]+$/, "") : path.basename(file);
  const ext = path.extname(name).slice(1).toLowerCase();
  let safe;
  // "v1.2" or "conf.d" open; "Tool.app" would launch, and on Windows "x.{GUID}" is a shell object, not a folder
  if (st.isDirectory()) safe = !PACKAGE_DIRS.has(ext) && !ext.startsWith("{");
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
  const { current: dir, files } = await listPastes();
  const sizes = await Promise.all(files.map((f) => stat(f).then((s) => s.size, () => 0)));
  return { dir: dir ?? `${path.join(os.tmpdir(), "copilot-sessions-…")} (created on the first paste)`, count: files.length, size: fmtBytes(sizes.reduce((a, b) => a + b, 0)) };
}

// Images shown in the chat (thumbnails and the viewer). Larger than the attach limit: a full-size screenshot should
// still preview. Shown without a click only from the session folder or our paste folders: a path can also come from
// a relay message or from an agent reply quoting one, and reading local files must not be triggered from outside
// this window. `clicked` (the user clicked "Click to load") lifts that folder rule, nothing else.
const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;
handle("images:load", async (cwd, src, { clicked = false } = {}) => {
  const t = String(src ?? "");
  const fallbackName = path.basename(t.replace(/[?#].*$/, "")) || "image";
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^file:/i.test(t) && !/^[a-z]:[\\/]/i.test(t)) return { problem: "is not a local file", name: fallbackName };
  let roots;
  if (!clicked) {
    const { current, older } = await pasteFolders();
    const own = [current];
    for (const d of older) if (d && (await isOwnPasteDir(d))) own.push(d);
    roots = [cwd, ...own].filter(Boolean).map((d) => path.resolve(d));
    // first by the text alone, before anything on that path is touched (a mapped drive or automount would contact
    // the remote host), with and without %xx decoding as resolveTarget tries both
    const home = os.homedir();
    const lexical = [lexicalPath(t, cwd, home), lexicalPath(t, cwd, home, process.platform, { decode: false })];
    if (lexical.some((c) => !c || !roots.some((r) => isInside(c, r)))) return { outside: true, name: fallbackName };
  }
  let real;
  try {
    real = await resolveTarget(cwd, t); // refuses network paths (also through links), resolves file:, ~ and relative
  } catch (e) {
    return { problem: e.message, name: fallbackName };
  }
  const name = path.basename(real);
  if (!clicked) {
    // then by the real path: a symlink inside the folder may point anywhere
    const realRoots = [];
    for (const d of roots) {
      const r = await localRealpath(d).catch(() => null);
      if (r) realRoots.push(r);
    }
    if (!realRoots.some((r) => isInside(real, r))) return { outside: true, name };
  }
  const r = await readImage(real, MAX_PREVIEW_BYTES);
  if (r.problem) return { problem: r.problem, name };
  if (r.tooBig) return { problem: `is too large to preview (${fmtBytes(r.tooBig)})`, name };
  return { dataUrl: `data:${r.block.mimeType};base64,${r.block.data}`, name };
});

handle("images:config", async () => ({ mimes: Object.keys(EXT_FOR_MIME), maxBytes: MAX_IMAGE_BYTES, maxSide: MAX_IMAGE_SIDE }));

handle("storage:get", async () => ({ pastes: await pasteStats(), settingsFile: settingsFile() }));

handle("storage:openPastes", async () => {
  const dir = await currentPasteDir(); // viewing must not create a folder
  if (!dir) throw new Error("There is no paste folder right now (none yet, or the system cleaned it). It is created on the next paste.");
  const err = await shell.openPath(dir);
  if (err) throw new Error(err);
});

handle("storage:clearPastes", async () => {
  const { older, files } = await listPastes();
  const results = await Promise.allSettled(files.map((f) => rm(f, { force: true })));
  const failed = results.filter((r) => r.status === "rejected");
  // older folders that are now empty are removed (rmdir only removes empty ones) and forgotten; for the legacy
  // fixed-name folder its "copilot-sessions-<uid>" parent too
  for (const d of older) {
    if (!(await isOwnPasteDir(d))) continue;
    await rmdir(d).catch(() => {});
    if (LEGACY_PASTE_DIRS.includes(d)) await rmdir(path.dirname(d)).catch(() => {});
  }
  // (folders removed here drop out of previousPasteDirs the next time a paste folder is saved; rewriting the
  // settings here could race with that save)
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
  // no zoom of the whole window (pinch, Ctrl+wheel): the renderer scales only the chat text
  // set once the page has loaded (and again after a reload): before that it rejects ("Render frame was disposed")
  win.webContents.on("did-finish-load", () => win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {}));
  win.webContents.on("zoom-changed", () => win.webContents.setZoomFactor(1));
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
  for (const a of asides.values()) a.conn?.kill(); // their copies are purged at the next start
  for (const { conn, relay } of open.values()) {
    relay?.stop();
    conn.kill();
  }
  open.clear();
  lister?.kill();
}

// One instance at a time: two would share (and clean up) the same paste folder and settings file.
// Starting the app again focuses the open window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit(); // and nothing else: no login-shell PATH lookup, no window
} else {
  app.on("second-instance", () => {
    if (!win) return app.isReady() && createWindow(); // e.g. macOS with the window closed but the app running
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  fixPath();
  app.whenReady().then(() => {
    // the default menu without its zoom items: Ctrl + +/-/0 belong to the chat text size (see the renderer)
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
        { role: "fileMenu" },
        { role: "editMenu" },
        { label: "View", submenu: [{ role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "togglefullscreen" }] },
        { role: "windowMenu" },
      ]),
    );
    // what an earlier delete could not remove, and side-question copies left by a crash
    purging = Promise.all([purgeDeleted(), purgeSideQuestions()]).catch(() => {});
    createWindow();
    app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
  });
  app.on("window-all-closed", () => {
    killAll();
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", killAll);
}
