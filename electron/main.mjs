// Electron main process: owns the `copilot --acp` processes and bridges them to the window over IPC.
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, safeStorage, shell } from "electron";
import { allowsAutomaticCheck, checkCandidates, createFileWatcher, createLocationTable, expandHome, isNetworkLocation, isRemote, localRealpath, passesAutomaticCheck, resolvePreview, resolveTarget } from "./file-access.mjs";
import { isInside, lexicalPath } from "./paths.mjs";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { lstat, mkdtemp, open as openFile, readdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AcpConnection } from "./acp.mjs";
import { createCommsForward } from "./comms-forward.mjs";
import { isNotFoundExit, normalizeCommand, resolveCommand, shellLine, startFailureText } from "./copilot-command.mjs";
import { countUserMessages, deleteSession, describeCut, forkSession, isSessionId, messageTimes, purgeDeleted, sessionCreatedAt, sessionDir, truncateSession } from "./history.mjs";
import { createLastActivity } from "./last-activity.mjs";
import { createCopilotRuntime } from "./copilot-runtime.mjs";
import { createQuotaService, createUsagePusher, quotaView, readCacheExpiry, readLiveQuota } from "./usage.mjs";
import { createReplayFilter, normalizeKeeperSettings, TURN_CONTENT } from "./cache-keeper.mjs";
import { createKeeperOptOut, createKeeperRunner } from "./cache-keeper-runner.mjs";
import { JobScheduler } from "./scheduler.mjs";
import { scheduleInfo } from "./jobs.mjs";
import { PendingRequests, answerFields, cardStart, childPrompt, createdText, findModelOption, folderState, isRelayTool, linkCardOf, reloadWarning, resolveConfig, unreportedChildren, withDeadline } from "./delegation.mjs";
import { createHeldCache, createHoldStore, HELD_KINDS, heldKind } from "./held-replies.mjs";
import { readLinksCache, writeLinksCache } from "./links-cache.mjs";
import { listAllPages } from "./session-list.mjs";
import { beginPrompt, endPrompt } from "./prompt-count.mjs";
import { normalizePanelMode } from "./activity-panel.mjs";
import { createTierStore, effectiveTier, nativeContextOption, nativeValueFor, normalizeTier, switchTier, tierArgs, withContextOption } from "./context-tier.mjs";
import { saveSetup } from "./session-setup.mjs";
import { CHILD_PART, DEFAULT_PART, applyPromptSettings, clearPromptDirs, composePrompt, createPromptStore, effectiveChildPart, effectiveDefaultPart, instructionsEnv, migratePromptDefault, normalizeTemplates, writePromptDir } from "./session-prompts.mjs";
import { createRestarter, realEffects, reconnectClients } from "./broker-restart.mjs";
import { runProgram } from "./run-program.mjs";
import { createGit } from "./repo-git.mjs";
import { createRecordStore } from "./repo-records.mjs";
import { createRepoTracker } from "./repo-track.mjs";
import { createChanges } from "./repo-changes.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
let win = null;
let scheduler = null;
let lister = null; // one long-lived connection used for session/list
const open = new Map(); // sessionId -> { conn, cwd, permissions: Map<reqId, rpcId>, relay, configOptions, parentSessionId?, reported?, adopted?, replaying? }
let permSeq = 0;
const pendingRequests = new PendingRequests(); // delegated-session requests waiting for the user's answer
// reopen cards shown and not answered yet (requestId -> the reopen:request payload): the broker asks again only when
// the sender registers anew, so after a window reload main shows them again (see sessions:open)
const reopenCards = new Map();
// link cards (adopt_session, release_session) shown and not answered yet (requestId -> the link:request payload),
// kept like reopenCards: the broker asks again when the parent registers anew
const linkCards = new Map();

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
/** The Settings command, else $COPILOT_PATH, else `copilot`, with where it comes from (see copilot-command.mjs). */
const settingsCommand = () => resolveCommand({ settings: loadSettings().copilotCommand, envPath: process.env.COPILOT_PATH });

// Context window per session (200k / 1M): an override per session, else the Settings default (see context-tier.mjs)
const tiers = createTierStore(path.join(app.getPath("userData"), "context-tiers.json"));
const holds = createHoldStore(path.join(app.getPath("userData"), "held-replies.json"));
const heldCache = createHeldCache();
const HELD_NOTICE = { child: "A sub-session replied", parent: "Your parent session sent a message", other: "Another session sent a message" };
const sessionTier = (sessionId) => effectiveTier(tiers.get(sessionId), loadSettings().contextTier);
/** The config options as the window gets them: Copilot's own plus the Context select. */
const viewConfig = (sessionId, configOptions) => withContextOption(configOptions, tiers.get(sessionId), loadSettings().contextTier);
// The system prompt per session: the Settings parts plus the session's own part, given to each Copilot process in an
// instructions folder of its own under promptRoot/run (see session-prompts.mjs)
const prompts = createPromptStore(path.join(app.getPath("userData"), "session-prompts.json"));
// The session's own Copilot command, kept the same way (see copilot-command.mjs)
const commands = createPromptStore(path.join(app.getPath("userData"), "session-commands.json"), "session-commands");
// Sessions whose prompt cache the keeper leaves alone (see cache-keeper-runner.mjs)
const keeperOptOut = createKeeperOptOut(path.join(app.getPath("userData"), "cache-keeper.json"));
/** The command a start of this session's Copilot uses: its own, else Settings (then $COPILOT_PATH, then `copilot`). */
const commandFor = (sessionId) => resolveCommand({ own: commands.get(sessionId), settings: loadSettings().copilotCommand, envPath: process.env.COPILOT_PATH });
const promptRoot = path.join(app.getPath("userData"), "session-prompts");
const promptProcs = new Set(); // connections whose prompt folder goes when they exit (the app waits for them at quit)

// Changes browser: the repositories each session worked in, recorded from its live tool calls (see repo-track.mjs),
// and what the window reads of them (repo-changes.mjs). Git is read-only; the trigger's calls get 5 s, the window's 10 s.
// The trigger follows the agent's paths, so it has the automatic-check rule; a repository added by hand is the user's
// click through a folder dialog, so it has the click rule of files:read.
const records = createRecordStore(path.join(app.getPath("userData"), "session-repos.json"));
const tracker = createRepoTracker({ store: records, git: createGit(runProgram, { timeoutMs: 5000 }), allow: allowAutomatic });
const changes = createChanges({ store: records, git: createGit(runProgram), createdAt: sessionCreatedAt, allow: allowClicked });

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

// one forwarder for the whole app: every open session's client gets the same pushed event, the window once
const forwardComms = createCommsForward({ send: (channel, payload) => send(channel, payload) }); // `send` is defined further down

function relayStart(sessionId, cwd, { cfg, alias }, { name, parentKey } = {}) {
  if (!alias) return null;
  const status = (extra = {}) => send("relay:status", { sessionId, name: client.name, connected: client.connected, parentSessionId: open.get(sessionId)?.parentSessionId ?? null, ...extra });
  const client = new RelayClient({
    url: cfg.url,
    key: `cli:${sessionId}`,
    alias,
    cwd,
    name,
    parentKey,
    brokerScript: cfg.brokerScript,
    nodePath: cfg.nodePath,
    caps: ["links"], // this app shows link cards (adopt_session, release_session)
    // `human` is set by the broker (true only for messages typed by a person in the relay GUI), not by the sender's name
    // human: true/false from this broker, undefined from an older one (the renderer then falls back to the sender name)
    onMessage: (m) => {
      // fromChild / heldAs are set by the broker: such a message waits for the user's approval
      const payload = { sessionId, from: m.from, human: m.human, text: m.text, prompt: m.prompt, fromCwd: m.fromCwd, deliveryId: m.deliveryId, wake: m.wake, fromChild: m.fromChild === true, heldAs: m.heldAs, redelivered: m.redelivered === true, arrivedAt: Date.now() };
      send("relay:message", payload);
      // cached whatever the switch says; the notification is only for a message that really waits (none for a person's)
      const kind = heldKind(payload);
      if (kind && m.deliveryId && heldCache.add(sessionId, payload) && holds.get(sessionId)[kind] && HELD_NOTICE[kind]) {
        notifyIfUnfocused(HELD_NOTICE[kind], `${m.from} → ${client.name}`);
      }
    },
    onComms: forwardComms,
    onSessionRequest: (req) => sessionRequested(sessionId, req).catch((e) => console.warn(`[delegation] session_request: ${e.message}`)),
    onReported: () => {
      const entry = open.get(sessionId);
      if (entry?.relay === client) entry.reported = true;
    },
    // every registration, also after a reconnect or a resume: the broker's record of the link is the durable one
    onRegistered: (_name, payload) => {
      const entry = open.get(sessionId);
      if (entry?.relay === client) {
        entry.parentSessionId = payload?.parentKey?.replace(/^cli:/, "");
        entry.reported = Boolean(payload?.reported);
        entry.adopted = Boolean(payload?.adopted);
        client.state(Boolean(entry.prompting)); // a restarted broker knows nothing of a turn in progress
      }
      status();
      markRegistered();
      refreshLinks(); // also after a broker restart, whose links_changed this client may have missed
    },
    onRenamed: () => status(),
    onReopenRequest: (req) => reopenRequested(sessionId, req),
    onLinkRequest: (req) => linkRequested(sessionId, req),
    // the user linked or released this session (adopt_session, release_session): parentKey null when released
    onParentChanged: ({ parentKey, adopted } = {}) => {
      const entry = open.get(sessionId);
      if (entry?.relay === client) {
        entry.parentSessionId = parentKey?.replace(/^cli:/, "");
        entry.reported = false;
        entry.adopted = Boolean(adopted);
      }
      status({ parentChanged: true });
      refreshLinks();
    },
    onLinksChanged: () => refreshLinks(),
    log: (note) => status({ note }),
  });
  let markRegistered;
  client.registered = new Promise((resolve) => (markRegistered = resolve));
  client.start();
  return client;
}

const send = (channel, payload) => win && !win.isDestroyed() && win.webContents.send(channel, payload);

// ---------- sub-session tree ----------
//
// The broker owns the links (who started whom, tasks, reports). The window shows them from a cache in userData until
// a fresh GET /api/links answers; every links_changed from any session's relay client fetches them again.

const linksCacheFile = () => path.join(app.getPath("userData"), "links-cache.json");
const LINKS_DEBOUNCE_MS = 200;
let linksTimer = null;
let linksSeq = 0; // a slow answer must not overwrite a newer one

/** Fetch the links soon (debounced), cache them and send them to the window. */
function refreshLinks() {
  clearTimeout(linksTimer);
  linksTimer = setTimeout(() => loadLinks().catch((e) => console.warn(`[links] ${e.message}`)), LINKS_DEBOUNCE_MS);
}

async function loadLinks() {
  const cfg = relayConfig();
  if (!cfg.enabled) return;
  const seq = ++linksSeq;
  const client = [...open.values()].find((e) => e.relay)?.relay;
  const state = client ? await client.fetchLinkState() : await brokerGetLinks(cfg.url);
  if (!Array.isArray(state.links)) throw new Error("the broker answered without a links array");
  if (seq !== linksSeq) return;
  send("links:update", state);
  try {
    writeLinksCache(linksCacheFile(), state); // only the start-up view uses it: a failed write must not block the update
  } catch (e) {
    console.warn(`[links] cache: ${e.message}`);
  }
}

async function brokerGetLinks(url) {
  const r = await fetch(`${url}/api/links`);
  if (!r.ok) throw new Error(`broker answered ${r.status}`);
  const body = await r.json();
  const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  return { links: body.links, held: obj(body.held), heldByKind: obj(body.heldByKind) };
}

/** GET JSON from the broker without an open session; throws an Error with `status` on a non-2xx answer. */
async function brokerGetJson(route) {
  const cfg = relayConfig();
  if (!cfg.enabled) throw new Error("The relay is switched off in this app.");
  let r;
  try {
    r = await fetch(cfg.url + route);
  } catch (e) {
    throw new Error(`The relay broker at ${cfg.url} could not be reached (${e.cause?.message ?? e.message}).`);
  }
  if (!r.ok) throw Object.assign(new Error(`The relay broker answered HTTP ${r.status}.`), { status: r.status });
  return r.json();
}

/** POST to the broker without an open session (forget / missing take `cli:` keys); throws readable text. */
async function brokerPost(route, body) {
  const cfg = relayConfig();
  if (!cfg.enabled) throw new Error("The relay is switched off in this app.");
  let r;
  try {
    r = await fetch(cfg.url + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    throw new Error(`The relay broker at ${cfg.url} could not be reached (${e.cause?.message ?? e.message}).`);
  }
  if (!r.ok) {
    const error = await r.json().then((j) => j?.error, () => null);
    throw new Error(`The relay broker refused the request: ${error ?? `HTTP ${r.status}`}.`);
  }
  return r.json().catch(() => null); // the answer body, null when there is none (204)
}

function linkKeys(keys) {
  if (!Array.isArray(keys) || !keys.every((k) => typeof k === "string")) throw new Error("keys must be an array of strings");
  return keys;
}

/** The session's link to its parent in the cached link tree ({ parent, adopted }), or null: not a child, or the
 *  cache does not know it (missing or unreadable: the session starts without the child part). */
function childLinkOf(sessionId) {
  const link = readLinksCache(linksCacheFile()).links.find((l) => l?.key === `cli:${sessionId}` && l.parent && !l.parentDeleted);
  return link ? { parent: link.parent, adopted: link.adopted === true } : null;
}

/** The default part a session starts with: the Settings text, else the built-in one when the relay is on. */
const defaultPartOf = (s) => effectiveDefaultPart(s.promptDefault, { relay: relayConfig().enabled });

/** The prompt a Copilot process of the session starts with: own defaults to the stored part, isChild to its link. */
function promptFor(sessionId, { own = prompts.get(sessionId), isChild = childLinkOf(sessionId) !== null } = {}) {
  const s = loadSettings();
  return composePrompt({ defaultPart: defaultPartOf(s), childPart: effectiveChildPart(s.promptChild), own, isChild });
}

// the cached snapshot at once; the fresh one follows as links:update
handle("links:get", async () => {
  const cached = readLinksCache(linksCacheFile());
  refreshLinks();
  return cached;
});
// the user removed these sessions from the tree / they no longer exist in Copilot's session list
for (const [channel, route] of [["links:forget", "/api/links/forget"], ["links:missing", "/api/links/missing"]]) {
  handle(channel, async (keys) => {
    await brokerPost(route, { keys: linkKeys(keys) });
    refreshLinks(); // the broker also says links_changed, but only to sessions that are connected
  });
}

// ---------- connections ----------

const START_TIMEOUT_MS = Number(process.env.COPILOT_RELAY_START_TIMEOUT_MS) || 60_000; // the variable is for the UI checks
const START_TIMEOUT_TEXT = `Copilot did not answer within ${START_TIMEOUT_MS / 1000} seconds.`;

/** Start a Copilot process. A non-empty prompt goes into an instructions folder of this process's own (named in its
 *  environment, never on the command line), removed when the process exits; a folder that cannot be made fails the
 *  start, so no session runs without the prompt it was given. `command` is { command, source } (see
 *  resolveCommand); the start ends at `deadline` (the caller's) or after START_TIMEOUT_MS, whichever comes first. */
async function connect(cwd, { deadline, args = [], prompt = "", command = settingsCommand() } = {}) {
  let env = process.env;
  let promptDir = null;
  // never throws: it runs inside the exit event (before the session's own exit handling) and on failed starts, where
  // the start's error must win; a folder that can't be removed now (a Windows lock) goes at the next start
  const removeDir = () => {
    try {
      promptDir.remove();
    } catch (e) {
      console.warn(`[session-prompts] could not remove ${promptDir.dir}: ${e.message}`);
    }
  };
  if (prompt) {
    const failure = (text) => Object.assign(new Error(text), { startFailure: true });
    try {
      promptDir = writePromptDir(promptRoot, prompt);
    } catch (e) {
      throw failure(`Could not write this session's prompt to ${promptRoot}: ${e.message}`);
    }
    try {
      env = instructionsEnv(process.env, promptDir.dir);
    } catch (e) {
      removeDir();
      throw failure(e.message); // the data folder's path contains a comma
    }
  }
  const conn = new AcpConnection({ command: command.command, cwd, args, env });
  const release = () => {
    promptProcs.delete(conn);
    removeDir();
  };
  if (promptDir) {
    promptProcs.add(conn);
    conn.once("exit", release);
  }
  try {
    const callers = deadline !== undefined && deadline <= Date.now() + START_TIMEOUT_MS;
    await withDeadline(conn.start(), callers ? deadline : Date.now() + START_TIMEOUT_MS, callers ? SETUP_TIMEOUT_TEXT : START_TIMEOUT_TEXT);
  } catch (e) {
    conn.kill();
    // a process that never ran (spawn failed) sends no exit; one that runs removes its folder when it is gone
    if (promptDir && (conn.exited || !conn.proc?.pid)) release();
    // A start can fail because Copilot is missing (wrong command), crashed, or is signed out and quit; the error text
    // doesn't reliably say which, so unless Copilot answered auth_required both remedies are shown.
    const err = new Error(
      startFailureText({
        command: conn.command,
        source: command.source,
        detail: String(e?.message ?? e),
        notFound: isNotFoundExit(e),
        stopped: typeof e?.exitCode === "number", // it ended by itself and said why (see startFailureText)
        login: needsLogin(e),
        loginHint: LOGIN_HINT,
        generalHint: "If GitHub Copilot CLI is installed, check that you are signed in (`copilot login` in a terminal). Otherwise install it.",
      }),
    );
    err.startFailure = true;
    throw err;
  }
  return conn;
}

async function getLister() {
  if (lister && !lister.exited) return lister;
  const conn = await connect(os.homedir());
  lister = conn;
  // an exit comes only when the whole group is gone (a moment after a kill): by then a newer lister may have replaced this one
  conn.on("exit", () => lister === conn && (lister = null));
  return conn;
}

// context/credits/quota figures for the window, debounced per session
// The live quota comes from a Copilot CLI the runtime starts on demand (one at a time, stopped on quit)
const runtime = createCopilotRuntime();
const quota = createQuotaService({
  readLive: () => readLiveQuota({ runtime, command: settingsCommand().command }),
  onChange: (state) => send("quota:update", quotaView(state)),
});
const usage = createUsagePusher({ send: (sessionId, view) => send("usage:update", { sessionId, view }), quota: () => quota.get() });

// Session folders seen so far: together with the home folder the only places a file mention is checked without a click
const knownFolders = new Set();

// ---------- cache keeper ----------
//
// Keep-alive pings and an automatic /compact before an idle session's prompt cache expires (see cache-keeper.mjs for
// the rules, cache-keeper-runner.mjs for the timers). Main gives it the facts of an open session and runs its turns.

/** COPILOT_RELAY_KEEPER_LEADS_MS="ping,countdown,compact,late" and COPILOT_RELAY_KEEPER_RETRY_MS: shorter times, for
 *  the UI checks only. A malformed value keeps the defaults. */
function keeperTestTimes(env = process.env) {
  const n = String(env.COPILOT_RELAY_KEEPER_LEADS_MS ?? "").split(",").map((x) => (x.trim() === "" ? NaN : Number(x)));
  const ok = (x) => Number.isFinite(x) && x >= 0;
  const retry = env.COPILOT_RELAY_KEEPER_RETRY_MS?.trim() ? Number(env.COPILOT_RELAY_KEEPER_RETRY_MS) : NaN;
  return {
    leads: n.length === 4 && n.every(ok) ? { ping: n[0], countdown: n[1], compact: n[2], late: n[3] } : undefined,
    retry: ok(retry) ? { ms: retry } : undefined,
  };
}

/** What the keeper's rules need to know of a session. One that is not open counts as busy: nothing is armed for it. */
function keeperFacts(sessionId) {
  const e = open.get(sessionId);
  if (!e) return { busy: true, replaying: false, contextUsed: undefined, modelId: null, parent: false };
  const card = pendingRequests.hasParent(sessionId) || [...reopenCards.values(), ...linkCards.values()].some((c) => c.sessionId === sessionId);
  return {
    busy: Boolean(e.prompting) || e.permissions.size > 0 || card,
    replaying: Boolean(e.replaying),
    contextUsed: e.contextUsed,
    modelId: findModelOption(e.configOptions)?.currentValue ?? null,
    // a child that has not reported back yet: open here, or its reply waits for the user's approval
    parent: [...open.values()].some((c) => c.parentSessionId === sessionId && !c.reported) || heldCache.list(sessionId).some((m) => heldKind(m) === "child"),
  };
}

/** A stray tool call (or permission request) in a keeper turn: the turn is stopped, the user is away. */
function stopKeeperTurn(sessionId, entry, turn) {
  turn.toolCalled = true;
  if (turn.stopped) return;
  turn.stopped = true;
  cancelTurn(sessionId, entry);
}

/** The keeper's own turn (a ping or /compact), sent the way slashRename sends /rename. While `entry.keeping` is set
 *  its updates and permission requests stay out of the window and the changes tracker (see attach). */
async function keeperRun(sessionId, text, kind) {
  const entry = open.get(sessionId);
  if (!entry) return { text: "", toolCalled: false, error: "The session is not open." };
  const turn = { kind, text: "", toolCalled: false, stopped: false };
  entry.keeping = turn;
  if (beginPrompt(entry)) entry.relay?.state(true);
  let error = null;
  try {
    await entry.conn.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  } catch (e) {
    error = friendly(e);
  } finally {
    if (entry.keeping === turn) entry.keeping = null;
    if (endPrompt(entry)) {
      entry.relay?.state(false);
      if (open.get(sessionId) === entry) usage.refresh(sessionId);
    }
  }
  // the CLI answers a /compact it did not do with another line (e.g. too little to compact)
  if (!error && kind === "compact" && !turn.text.includes("Compacted")) error = turn.text.trim().slice(0, 300) || "Copilot did not confirm it.";
  return { text: turn.text, toolCalled: turn.toolCalled, error };
}

/** The keeper is on in Settings and this session is not opted out. */
const keeperOn = (sessionId) => normalizeKeeperSettings(loadSettings().cacheKeeper).enabled && !keeperOptOut.get(sessionId);

const keeper = createKeeperRunner({
  settings: () => normalizeKeeperSettings(loadSettings().cacheKeeper),
  optedOut: (sessionId) => keeperOptOut.get(sessionId),
  facts: keeperFacts,
  readExpiry: (sessionId, modelId) => readCacheExpiry(sessionId, { modelId }),
  run: keeperRun,
  emit: send,
  now: Date.now,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle),
  ...keeperTestTimes(),
});

/** Wire a session's connection to the window. */
function attach(sessionId, conn, cwd, relay, link) {
  if (cwd) knownFolders.add(cwd);
  const entry = { conn, cwd, permissions: new Map(), relay: relayStart(sessionId, cwd, relay, link), toolTitles: new Map(), configOptions: [] };
  open.set(sessionId, entry);
  // one path for live and replayed updates (see sessions:new)
  entry.update = (u) => {
    if (u?.sessionUpdate === "tool_call" && u.title) entry.toolTitles.set(u.toolCallId, u.title);
    if (u?.sessionUpdate === "usage_update") {
      entry.contextUsed = u.used; // for the cache keeper's minimum context
      if (open.get(sessionId) === entry) usage.context(sessionId, { used: u.used, size: u.size });
    }
    if (u?.sessionUpdate === "config_option_update" && Array.isArray(u.configOptions)) {
      entry.configOptions = u.configOptions;
      u = { ...u, configOptions: viewConfig(sessionId, u.configOptions) };
    }
    // a keeper turn leaves no trace: its turn content stays out of the window, nothing reaches the changes tracker,
    // and a tool call stops it. Session state (config, commands, title) still reaches the window.
    const turn = entry.keeping;
    if (turn) {
      if (u?.sessionUpdate === "agent_message_chunk" && typeof u.content?.text === "string") turn.text += u.content.text;
      if (u?.sessionUpdate === "tool_call") stopKeeperTurn(sessionId, entry, turn);
      if (!TURN_CONTENT.has(u?.sessionUpdate)) send("acp:update", { sessionId, update: u });
      return;
    }
    // replayed keep-alive pings and their turns, and the replayed /compact reply line
    if (entry.replaying && !entry.replayFilter.pass(u)) return;
    // /rename answers with a chat line ("Session renamed to: …"); the new title arrives as session_info_update
    if (entry.renaming && u?.sessionUpdate === "agent_message_chunk") return;
    send("acp:update", { sessionId, update: u });
    if (!entry.replaying) tracker.update(sessionId, cwd, u); // a replayed history is not new work
  };
  conn.on("notification", (method, params) => {
    if (method === "session/update" && params?.sessionId === sessionId) entry.update(params.update);
  });
  conn.on("request:session/request_permission", (rpcId, params) => {
    // in a keeper turn: refused at once, no card and no notification, and the turn is stopped
    const turn = entry.keeping;
    if (turn) {
      conn.respond(rpcId, { outcome: { outcome: "cancelled" } });
      return stopKeeperTurn(sessionId, entry, turn);
    }
    keeper.activity(sessionId);
    if (!entry.replaying) tracker.permission(sessionId, cwd, params.toolCall); // the start point before the edit runs
    // the relay's own tools run without asking, as with the terminal extension. The tool_call update carries
    // the server-prefixed name ("relay-send_message"), the permission request only the bare tool name.
    const title = entry.toolTitles.get(params.toolCall?.toolCallId) ?? params.toolCall?.title;
    // adopt_session and release_session too: the app's link card is their approval
    if (entry.relay && isRelayTool(title)) {
      const opt = params.options?.find((o) => o.kind === "allow_once");
      if (opt) return conn.respond(rpcId, { outcome: { outcome: "selected", optionId: opt.optionId } });
    }
    if (entry.parentSessionId) notifyIfUnfocused("A delegated session needs permission", "Open Copilot Sessions to answer.");
    const reqId = `p${++permSeq}`;
    entry.permissions.set(reqId, rpcId);
    send("acp:permission", { sessionId, reqId, toolCall: params.toolCall, options: params.options });
  });
  conn.on("exit", ({ code, signal, stderr }) => {
    tracker.closed(sessionId); // every exit, also of a session the app closed
    // a session closed by the app is no longer in `open` here: only an exit while it is still open is a death
    if (open.get(sessionId)?.conn !== conn) return entry.relay?.stop();
    entry.relay?.died(); // before stop(): the broker notifies the parent of an unreported child
    entry.relay?.stop();
    open.delete(sessionId);
    keeper.closed(sessionId);
    dropReopenCards(sessionId);
    dropLinkCards(sessionId);
    heldCache.drop(sessionId);
    usage.forget(sessionId);
    pendingRequests.dropForParent(sessionId);
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

handle("quota:get", async (o) => quotaView(await quota.get({ force: o?.force === true })));

let purging = Promise.resolve(); // leftovers of failed deletes are removed before the first list (briefly waited for:
// they have no workspace.yaml/events.jsonl left, so a slow purge of a big one must not hold up the sidebar)

const addLastActivity = createLastActivity();

/** Copilot's session list, at most 50 pages; complete is false when it stopped with pages left. Each session also
 *  has lastActivityAt: its last message or tool call (Copilot's updatedAt also moves when a session is only opened). */
async function listSessions() {
  await Promise.race([purging, new Promise((r) => setTimeout(r, 1000))]);
  const conn = await getLister();
  const { sessions, complete } = await listAllPages((method, params) => conn.request(method, params), {
    onPage: (list) => {
      for (const x of list) if (x.cwd) knownFolders.add(x.cwd);
    },
  });
  return { sessions: await addLastActivity(sessions), complete };
}
handle("sessions:list", async () => (await listSessions()).sessions);
// the sidebar's refresh: only a complete list may prune the sub-session tree
handle("sessions:listChecked", listSessions);

const CHILD_SETUP_TIMEOUT_MS = 30_000; // from the approval until the child's agent and model are set
const SETUP_TIMEOUT_TEXT = `Copilot did not answer within ${CHILD_SETUP_TIMEOUT_MS / 1000} seconds.`;

/** Start a Copilot process with a new session and attach it. `link` ({ name, parentKey }) is for delegated sessions;
 *  `tier` is the context tier to start with (null: the Settings default); `own` the session's own prompt part;
 *  `command` its own Copilot command ("" = Settings), `commandSource` where it comes from ("card" for a child: its approval card). */
async function createSession(cwd, link = {}, deadline, tier = null, own = "", command = "", commandSource = "session") {
  requireDir(cwd);
  const typed = normalizeCommand(command);
  if (typed.refused) throw new Error(typed.refused);
  command = typed.command;
  const prompt = promptFor(null, { own, isChild: Boolean(link.parentKey) });
  const conn = await connect(cwd, { deadline, args: tierArgs(tier ?? effectiveTier(null, loadSettings().contextTier)), prompt, command: resolveCommand({ own: command, ownSource: commandSource, settings: loadSettings().copilotCommand, envPath: process.env.COPILOT_PATH }) });
  const relay = relayPrepare();
  // the agent may send updates (available_commands_update…) before it answers session/new: keep them
  const early = [];
  const hold = (method, params) => {
    if (method === "session/update") early.push(params);
  };
  conn.on("notification", hold);
  try {
    const started = conn.request("session/new", { cwd, mcpServers: relay.mcpServers });
    const res = await (deadline ? withDeadline(started, deadline, SETUP_TIMEOUT_TEXT) : started);
    prompts.set(res.sessionId, own); // throws when it can't be saved: the next start would lose it
    commands.set(res.sessionId, command);
    const entry = attach(res.sessionId, conn, cwd, relay, link);
    entry.configOptions = res.configOptions ?? [];
    conn.off("notification", hold);
    for (const p of early) if (p?.sessionId === res.sessionId) entry.update(p.update);
    usage.refresh(res.sessionId);
    return { sessionId: res.sessionId, cwd, configOptions: entry.configOptions, entry };
  } catch (e) {
    conn.kill();
    throw e;
  }
}

handle("sessions:new", async (cwd, own = "", command = "") => {
  if (typeof own !== "string") throw new Error("The session's prompt must be text.");
  const { sessionId, cwd: dir, configOptions } = await createSession(cwd, {}, undefined, null, own, command);
  return { sessionId, cwd: dir, configOptions: viewConfig(sessionId, configOptions) }; // the entry stays here: it can't cross IPC
});

// sessions being opened (id -> number of opens in flight) / deleted: a delete must not race a resume that hasn't
// registered the session in `open` yet
const opening = new Map();
const deleting = new Set();
const historyBusy = new Set(); // a truncate is closing the session and rewriting its files
const lingering = new Map(); // id -> connection whose Copilot would not exit: may still write the session's files

// replayId: the window's id for this open. Every open ends with acp:replayed for it, sent the way the updates are, so
// it cannot overtake a replayed update (the invoke answer can): the window ends the replay on both, also after a
// failed load.
handle("sessions:open", async (sessionId, cwd, replayId) => {
  try {
    return await resumeSession(sessionId, cwd);
  } finally {
    send("acp:replayed", { replayId });
  }
});

async function resumeSession(sessionId, cwd) {
  if (open.has(sessionId)) {
    // after a window reload the view is new: show the reopen and link cards it had again (a live view ignores known ids)
    for (const card of reopenCards.values()) if (card.sessionId === sessionId) send("reopen:request", card);
    for (const card of linkCards.values()) if (card.sessionId === sessionId) send("link:request", card);
    for (const m of heldCache.list(sessionId)) send("relay:message", { ...m, replayed: true });
    return { sessionId, cwd, configOptions: null, alreadyOpen: true };
  }
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
}

async function openSession(sessionId, cwd) {
  requireDir(cwd);
  const conn = await connect(cwd, { args: tierArgs(sessionTier(sessionId)), prompt: promptFor(sessionId), command: commandFor(sessionId) });
  const relay = relayPrepare();
  // the agent replays the history as session/update notifications before answering session/load
  const entry = attach(sessionId, conn, cwd, relay);
  entry.replaying = true; // until session/load settles, also when it fails (see attach: the changes tracker)
  entry.replayFilter = createReplayFilter(); // one per replay, used only while it runs
  try {
    const res = await conn.request("session/load", { sessionId, cwd, mcpServers: relay.mcpServers }).finally(() => (entry.replaying = false));
    entry.configOptions = res?.configOptions ?? entry.configOptions;
    if (open.get(sessionId) === entry) usage.refresh(sessionId);
    return { sessionId, cwd, configOptions: viewConfig(sessionId, res?.configOptions) };
  } catch (e) {
    entry.relay?.stop();
    open.delete(sessionId);
    keeper.closed(sessionId);
    dropReopenCards(sessionId);
    dropLinkCards(sessionId);
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
  await keeper.whenIdle(sessionId); // a running ping or compaction finishes first (Goal 10 of the cache keeper)
  keeper.activity(sessionId); // a prompt of any source ends the keeper's pause
  const entry = getOpen(sessionId);
  const { conn, relay, cwd } = entry;
  if (source === "app" || source === "human") relay?.human();
  const { blocks, notes } = await promptBlocks(text, cwd, {
    attachImages: source === "app",
    imagesSupported: conn.init?.agentCapabilities?.promptCapabilities?.image === true,
  });
  for (const note of notes) send("acp:notice", { sessionId, text: note });
  // the checkpoint before the turn, read before the request: a short turn can write its own before a later read.
  // Not when the keeper can't act here: without a baseline the turn's end takes the first checkpoint it finds.
  if (keeperOn(sessionId)) await keeper.turnStarted(sessionId);
  // fork/truncate refuse while a turn is running: the agent is still writing the history
  if (beginPrompt(entry)) entry.relay?.state(true);
  try {
    const res = await conn.request("session/prompt", { sessionId, prompt: blocks });
    return res?.stopReason ?? "end_turn";
  } finally {
    if (endPrompt(entry)) {
      entry.relay?.state(false);
      // not after a close/truncate mid-turn. Every end (done, cancelled, failed) starts the keeper's pause.
      if (open.get(sessionId) === entry) {
        usage.refresh(sessionId);
        keeper.turnEnded(sessionId);
      }
    }
  }
});

// Count of user messages Copilot recorded in events.jsonl (0 before the first turn).
handle("sessions:userMessages", async (sessionId) => countUserMessages(sessionId));

// Times of the recorded messages, for the chat's message times after a replay (never fails: no history, no times).
handle("sessions:messageTimes", async (sessionId) => messageTimes(sessionId));

// Copilot's own /rename command: it runs no model turn and isn't stored in the history, so turn numbers
// used by fork/delete stay right. Copilot saves the name in workspace.yaml (user_named: true).
handle("sessions:rename", async (sessionId, name) => {
  await keeper.whenIdle(sessionId);
  const entry = getOpen(sessionId);
  if (entry.prompting) throw new Error("Wait until Copilot finishes this turn.");
  name = String(name ?? "").replace(/\s+/g, " ").trim();
  if (!name) throw new Error("The name can't be empty.");
  if (name.length > 200) throw new Error("The name is too long (200 characters at most).");
  await slashRename(sessionId, entry, name);
  return name;
});

// For the cache keeper /rename is no turn (no model request, no checkpoint): its pause goes on, re-planned once the
// session is free again (a timer that fired meanwhile found it busy).
async function slashRename(sessionId, entry, name) {
  await keeper.whenIdle(sessionId);
  entry.renaming = true;
  if (beginPrompt(entry)) entry.relay?.state(true);
  try {
    await entry.conn.request("session/prompt", { sessionId, prompt: [{ type: "text", text: `/rename ${name}` }] });
  } finally {
    entry.renaming = false;
    if (endPrompt(entry)) {
      entry.relay?.state(false);
      if (open.get(sessionId) === entry) keeper.replan(sessionId);
    }
  }
}

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
  keeper.closed(sessionId); // no timer, no state; a running ping's or compaction's result is dropped
  usage.forget(sessionId);
  pendingRequests.dropForParent(sessionId);
  dropReopenCards(sessionId);
  dropLinkCards(sessionId);
  heldCache.drop(sessionId);
  e.relay?.stop();
  await Promise.race([e.conn.request("session/close", { sessionId }).catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
  e.conn.kill();
  return e.conn;
}

handle("sessions:close", async (sessionId) => {
  const e = open.get(sessionId);
  if (e?.keeping) cancelTurn(sessionId, e); // a ping or compaction is cancelled, as delete cancels a turn
  await closeEntry(sessionId);
});

// ---------- delegated sessions ----------

const REGISTER_TIMEOUT_MS = 10_000;
const RENAME_TIMEOUT_MS = 10_000;

/** Tell the requesting session what became of its request. A parent that has closed meanwhile is skipped. */
function tellParent(req, kind, text, name = req.name) {
  open.get(req.parentSessionId)?.relay?.outcome({ requestId: req.requestId, kind, name, text });
}

const isDirectory = (p) => {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** An existing folder, asked without blocking the main process (a slow mount must not freeze it). */
const isDirectoryAsync = async (p) => {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
};

async function sessionRequested(parentSessionId, request) {
  const parent = open.get(parentSessionId);
  if (!parent) return;
  const req = { ...request, parentSessionId };
  pendingRequests.add(req); // before the folder check: a close or a reload meanwhile drops it as any other request
  notifyIfUnfocused("A session asks to start a new session", req.name);
  // the folder is model-written: looked at only as far as the automatic-check rule allows (never a network location)
  const folder = await folderState(req.folder, { allow: allowAutomatic, isDir: isDirectoryAsync });
  // the parent closed (or was reopened) or the window reloaded meanwhile: the request is gone, so is its card
  if (open.get(parentSessionId) !== parent || !pendingRequests.has(req.requestId)) return;
  // the parent's own command, for the card's command field: from the store, never from the request
  const storedCommand = commands.get(parentSessionId) ?? "";
  const start = cardStart(
    req,
    { cwd: parent.cwd, tier: sessionTier(parentSessionId), storedCommand, command: shellLine(commandFor(parentSessionId).command, []), configOptions: parent.configOptions, name: parent.relay?.name },
    { folderState: folder },
  );
  // the card reads only `start` for the child's values: the request's own fields (model-written) are not sent raw
  send("delegation:request", { requestId: req.requestId, parentSessionId, name: req.name, task: req.task, start });
}

/** The broker asks the user (through the sender's view) to reopen a closed relative that a message is waiting for. */
function reopenRequested(sessionId, { requestId, targetKey, targetName, fromName, previews }) {
  if (!reopenCards.has(requestId)) notifyIfUnfocused("A session wants to reopen another one", fromName);
  const card = { sessionId, requestId, targetSessionId: String(targetKey ?? "").replace(/^cli:/, ""), targetName, fromName, previews };
  reopenCards.set(requestId, card); // a re-ask (another queued message) replaces it with the longer preview list
  send("reopen:request", card);
}

/** The session's relay connection is gone: the broker asks again when it registers anew. */
function dropReopenCards(sessionId) {
  for (const [id, card] of reopenCards) if (card.sessionId === sessionId) reopenCards.delete(id);
  keeper.replan(sessionId); // an open card kept the keeper from acting (a closed session has no keeper state left)
}

// reachable only from the window, like delegation:answer. `reason` "missing": the target no longer exists.
handle("reopen:answer", async (sessionId, requestId, approved, reason) => {
  const relay = open.get(sessionId)?.relay;
  if (!relay) throw new Error("The session that asked is no longer connected to copilot-relay.");
  // false: the broker has no such pending request (answered elsewhere, or its target was forgotten)
  try {
    await relay.answerReopen(String(requestId), approved === true, reason == null ? undefined : String(reason));
  } catch (e) {
    if (e.status !== 404) throw e; // not answered: the card stays answerable
    reopenCards.delete(requestId);
    keeper.activity(sessionId); // the user answered the card: they are here, the pause restarts with the next turn
    return false;
  }
  reopenCards.delete(requestId);
  keeper.activity(sessionId);
  return true;
});

/** The broker asks the user (through the parent's view) to approve adopt_session or release_session. */
function linkRequested(sessionId, req) {
  if (!linkCards.has(req.requestId)) notifyIfUnfocused("A session asks to change a session link", req.parentName);
  const card = linkCardOf(sessionId, req);
  linkCards.set(card.requestId, card); // a repeated request comes with the same id
  send("link:request", card);
}

/** The session's relay connection is gone: the broker asks again when it registers anew. */
function dropLinkCards(sessionId) {
  for (const [id, card] of linkCards) if (card.sessionId === sessionId) linkCards.delete(id);
  keeper.replan(sessionId);
}

// reachable only from the window, like reopen:answer. Resolves { result, text } (linked, released, rejected, refused).
handle("link:answer", async (sessionId, requestId, approved) => {
  const relay = open.get(sessionId)?.relay;
  if (!relay) throw new Error("The session that asked is no longer connected to copilot-relay.");
  let answer;
  // false: the broker has no such pending request (answered elsewhere, broker restarted, or a session left)
  try {
    answer = await relay.answerLink(String(requestId), approved === true);
  } catch (e) {
    if (e.status !== 404) throw e; // not answered: the card stays answerable
    linkCards.delete(requestId);
    keeper.activity(sessionId); // the user answered the card: they are here, the pause restarts with the next turn
    return false;
  }
  linkCards.delete(requestId);
  keeper.activity(sessionId);
  return answer;
});

/** Resolves true once the relay client has registered, false after `ms`. */
function waitRegistered(client, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    client.registered.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function setConfigOption(sessionId, entry, configId, value) {
  const res = await entry.conn.request("session/set_config_option", { sessionId, configId, value });
  if (res?.configOptions) entry.configOptions = res.configOptions;
  return res?.configOptions ?? null;
}

/** Create the approved child and link it to its parent. Never throws; resolves to what the card is told:
 *  { outcome: "created" } or { outcome: "failed", text, retry }. With `retry` the child's Copilot never started, the
 *  parent has been told nothing and the request stays open; every other failure ends as an outcome for the parent.
 *  `command`: what the approval card's command field held ("" for the Settings command); without one (undefined,
 *  e.g. an older window) the parent's stored command is used. `fields`: { cwd, tier, agent, model } from the card,
 *  already normalised by `answerFields`; the child starts in that folder and tier and gets that agent and model. */
async function createChild(req, own = "", command = undefined, fields) {
  const { parentSessionId, name, task } = req;
  const parent = open.get(parentSessionId);
  if (!parent) return { outcome: "failed", text: "The session that asked for it is no longer open.", retry: false };
  // a failure after the child's Copilot started: the child is discarded and the parent told, the request is over
  const failed = (kind, text) => {
    tellParent(req, kind, `Session "${name}" was not created: ${text}`);
    return { outcome: "failed", text, retry: false };
  };
  const deadline = Date.now() + CHILD_SETUP_TIMEOUT_MS;
  let child = null;
  let announced = false; // the renderer knows this child and has to be told when it goes away
  const discard = async () => {
    if (!child) return;
    await closeEntry(child.sessionId).catch(() => {});
    if (announced) send("delegation:closed", { sessionId: child.sessionId });
    // its link was made on registration: a child that never came to be must not stay in the tree (best effort)
    await brokerPost("/api/links/forget", { keys: [`cli:${child.sessionId}`] }).then(refreshLinks, (e) => console.warn(`[links] forget: ${e.message}`));
  };
  try {
    const tier = fields.tier; // the card's context window
    try {
      child = await createSession(fields.cwd, { name, parentKey: `cli:${parentSessionId}` }, deadline, tier, own, command ?? commands.get(parentSessionId), "card");
    } catch (e) {
      // The child's Copilot did not come to be (its command, most likely): nothing was made and the parent has been
      // told nothing, so the card takes another answer (delegation:answer keeps the request). The text, which holds
      // the command, goes to the card only.
      if (open.get(parentSessionId) === parent) return { outcome: "failed", text: friendly(e), retry: true };
      // the parent was closed or restarted meanwhile and its requests went with it: there is no card to answer
      // again. A restarted parent is open again and is told, in words that do not hold the command.
      return failed("failed", "the session that asked for it was closed or restarted while its child was starting.");
    }
    const { sessionId, entry } = child;
    tiers.set(sessionId, tier); // as an override, so a later reopen keeps it
    if (!entry.relay) throw new Error("The relay is switched off in this app, so the new session cannot be linked to its parent.");

    const config = resolveConfig(entry.configOptions, { agent: fields.agent, model: fields.model, inheritedModel: findModelOption(parent.configOptions)?.currentValue });
    if (config.error) {
      await discard();
      // the card's choice is not valid for this child: the request stays open for another answer (if its parent is)
      if (open.get(parentSessionId) === parent) return { outcome: "failed", text: config.error, retry: true };
      return failed("invalid", config.error);
    }
    for (const { configId, value } of config.sets) await withDeadline(setConfigOption(sessionId, entry, configId, value), deadline, SETUP_TIMEOUT_TEXT);

    send("delegation:created", { sessionId, cwd: child.cwd, configOptions: viewConfig(sessionId, entry.configOptions), parentSessionId, title: name });
    announced = true;

    if (!(await waitRegistered(entry.relay, REGISTER_TIMEOUT_MS))) {
      await discard();
      return failed("failed", "it did not connect to the relay broker in time.");
    }
    await entry.relay.setTask(task); // the broker keeps the task with the link (shown in the tree); false only costs that
    const finalName = entry.relay.name;
    // Copilot titles a session after its first prompt unless it was named. A failed or unanswered rename only costs the title.
    await Promise.race([slashRename(sessionId, entry, finalName).catch((e) => console.warn(`[delegation] /rename: ${e.message}`)), new Promise((r) => setTimeout(r, RENAME_TIMEOUT_MS))]);
    tellParent(req, "created", createdText({ name: finalName, childCwd: child.cwd, parentCwd: parent.cwd }), finalName);
    // parent's current name; if it closed meanwhile, the last one known (the child still runs and its report is durable)
    const parentEntry = open.get(parentSessionId) ?? parent;
    const parentName = parentEntry.relay?.name;
    const folder = parentEntry.cwd;
    send("relay:message", { sessionId, from: parentName, fromCwd: folder, human: false, text: task, prompt: childPrompt({ parentName, task, folder }), wake: true });
    return { outcome: "created" };
  } catch (e) {
    await discard();
    return failed("failed", friendly(e));
  }
}

// reachable only from the window (preload): nothing the broker or a session sends can answer a request
// (so the child's command is the user's typing on the card, or the parent's stored one)
handle("delegation:answer", async (requestId, approved, own, command, fields) => {
  // taken while it is answered, so a second click cannot start a second child
  const req = pendingRequests.take(requestId);
  if (!req) return false;
  keeper.activity(req.parentSessionId); // the user answered the parent's card: they are here, the pause restarts with the next turn
  if (approved !== true) {
    tellParent(req, "rejected", `The user rejected the request to create session "${req.name}".`);
    return { outcome: "rejected" };
  }
  const reloadsBefore = windowReloads;
  const parent = open.get(req.parentSessionId);
  const card = answerFields(fields, { parentCwd: parent?.cwd, parentTier: parent ? sessionTier(req.parentSessionId) : "default" });
  const result = await createChild(req, String(own ?? ""), typeof command === "string" ? command : undefined, card);
  if (!result.retry) return result;
  // the start failed: the request is open again, for Approve or Reject
  if (windowReloads === reloadsBefore) {
    pendingRequests.add(req);
    return result;
  }
  // the window was reloaded during the start: the card is gone, so nobody could answer again. The request ends,
  // and the parent is told in words that do not hold the command.
  tellParent(req, "failed", `Session "${req.name}" was not created: its start failed and the window was reloaded meanwhile. Ask again.`);
  return { ...result, retry: false };
});

handle("relay:ack", async (sessionId, id, outcome) => {
  const how = outcome === "discarded" ? "discarded" : undefined; // absent = "taken"
  const relay = open.get(sessionId)?.relay;
  if (!relay) {
    // a dead view (the process has exited): the broker's durable item is acknowledged through its HTTP route, so a
    // discarded reply does not come back when the view is closed instead of resumed
    if (!isSessionId(sessionId)) return false;
    try {
      const answer = await brokerPost("/api/peer/ack", { key: `cli:${sessionId}`, id, ...(how ? { outcome: how } : {}) });
      if (answer?.ok !== true) return false;
    } catch {
      return false; // broker down: the renderer keeps the id in its discarded set
    }
    heldCache.ack(sessionId, id);
    return true;
  }
  await relay.ack(id, how);
  heldCache.ack(sessionId, id);
  return true;
});

const checkedSessionId = (sessionId) => {
  if (!isSessionId(sessionId)) throw new Error(`Invalid session id: ${sessionId}`);
  return sessionId;
};
// the communication log of the tree that holds this session: through the open view's client, else straight from the broker
handle("comms:get", async (sessionId) => {
  checkedSessionId(sessionId);
  try {
    const relay = open.get(sessionId)?.relay;
    return relay ? await relay.fetchComms() : await brokerGetJson(`/api/comms?${new URLSearchParams({ key: `cli:${sessionId}` })}`);
  } catch (e) {
    return e.status === 404 ? { unsupported: true } : { error: e.message }; // 404: a broker older than the app
  }
});
handle("comms:text", async (sessionId, id) => {
  checkedSessionId(sessionId);
  try {
    const relay = open.get(sessionId)?.relay;
    const text = relay ? await relay.fetchCommsText(String(id)) : (await brokerGetJson(`/api/comms/text?${new URLSearchParams({ id: String(id) })}`)).text;
    return typeof text === "string" ? { text } : { error: "not found" };
  } catch (e) {
    return { error: e.status === 404 ? "not found" : e.message };
  }
});

handle("held:get", (sessionId) => holds.get(checkedSessionId(sessionId)));
handle("held:set", (sessionId, kind, on) => {
  if (!HELD_KINDS.includes(kind)) throw new Error(`unknown held kind: ${kind}`);
  holds.set(checkedSessionId(sessionId), kind, on !== false);
});

// the cache keeper, from the window: the queue or message box holds text, Not now, the per-session switch
handle("keeper:held", (sessionId, held) => keeper.setHeld(checkedSessionId(sessionId), held === true));
handle("keeper:notNow", (sessionId) => keeper.notNow(checkedSessionId(sessionId)));
handle("keeper:optOut", (sessionId, off) => {
  keeperOptOut.set(checkedSessionId(sessionId), off === true);
  keeper.replan(sessionId);
});
handle("keeper:get", (sessionId) => ({ optedOut: keeperOptOut.get(checkedSessionId(sessionId)), state: keeper.state(sessionId) }));

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

/** Waits for a running ping or compaction of the cache keeper first: the window shows the session as idle. */
async function refuseWhilePrompting(sessionId) {
  await keeper.whenIdle(sessionId);
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
  conn.forceKill();
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
  await refuseWhilePrompting(sessionId);
  refuseWhileDeleting(sessionId);
  const res = forkSession(sessionId, target);
  holds.copy(sessionId, res.sessionId);
  keeperOptOut.copy(sessionId, res.sessionId);
  tiers.copy(sessionId, res.sessionId); // a long history must not land in a smaller window
  prompts.copy(sessionId, res.sessionId);
  commands.copy(sessionId, res.sessionId);
  return res;
});

// cut the history in place; the session is closed first and the renderer reopens it via sessions:open
handle("sessions:truncate", async (sessionId, target) => {
  target = cutTarget(target);
  await refuseWhilePrompting(sessionId);
  return historyOp(sessionId, async () => {
    describeCut(sessionId, target); // throws for a target that doesn't match, before anything is closed
    await closeAndWait(sessionId);
    return truncateSession(sessionId, target);
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
    holds.delete(sessionId);
    keeperOptOut.delete(sessionId);
    tiers.delete(sessionId);
    prompts.delete(sessionId);
    commands.delete(sessionId);
    records.forget(sessionId);
    if (res.leftover) console.warn(`[delete] could not remove ${res.leftover}`);
    if (res.store.error) console.warn(`[delete] session-store.db: ${res.store.error}`);
    return res;
  } finally {
    deleting.delete(sessionId);
  }
});

handle("sessions:setConfig", async (sessionId, configId, value) => {
  await keeper.whenIdle(sessionId);
  const entry = getOpen(sessionId);
  keeper.activity(sessionId); // a new model or agent has no fresh cache entry: the keeper waits for a turn
  const updated = await setConfigOption(sessionId, entry, configId, value);
  return updated && viewConfig(sessionId, updated);
});

// a new context window: live through Copilot's own context option when the open session has one that takes the tier
// ({ configOptions }: no restart); otherwise it takes a new Copilot process: the session is closed here and the
// renderer reopens it (sessions:open starts Copilot with the new flag and replays the history). Refusals come back as
// { refused } with the session untouched: the window must not close and reopen it (a delegated child may still be
// set up).
handle("sessions:setContextTier", async (sessionId, value) => {
  if (!isSessionId(sessionId)) return { refused: `Invalid session id: ${sessionId}` };
  await keeper.whenIdle(sessionId);
  const res = await switchTier({ sessionId, value, tiers, ...restartGuards(sessionId), live: liveTierSwitch(sessionId, value) });
  // a refusal carries the open session's options as they are now: an update during a failed live set may have shown
  // the new tier already
  const entry = open.get(sessionId);
  return res.refused && entry ? { ...res, configOptions: viewConfig(sessionId, entry.configOptions) } : res;
});

const LIVE_TIER_TIMEOUT_MS = 15_000;

/** How the open session switches to the tier `value` stands for without a restart, or null: through Copilot's own
 *  context option, when it has one with a value for that tier. */
function liveTierSwitch(sessionId, value) {
  const entry = open.get(sessionId);
  const native = nativeContextOption(entry?.configOptions);
  const target = nativeValueFor(native, effectiveTier(value, loadSettings().contextTier));
  if (!entry || target == null) return null;
  return async () => {
    keeper.activity(sessionId); // another context window has no fresh cache entry: the keeper waits for a turn
    historyBusy.add(sessionId); // as a restart: a delete or another restart is refused meanwhile
    try {
      const set = target === native.currentValue ? null : setConfigOption(sessionId, entry, native.id, target);
      const updated = set && (await withDeadline(set, Date.now() + LIVE_TIER_TIMEOUT_MS, "Copilot did not answer the context change in time."));
      return viewConfig(sessionId, updated ?? entry.configOptions);
    } finally {
      historyBusy.delete(sessionId);
    }
  };
}

/** What sessions:setContextTier and sessions:setPrompt share: the refusals that leave the session untouched, and the
 *  close (marked as a history op while it runs, so a delete or another restart is refused meanwhile). */
function restartGuards(sessionId) {
  const refusal = () => {
    if (open.get(sessionId)?.prompting) return "Wait until Copilot finishes this turn.";
    if (deleting.has(sessionId)) return "This session is being deleted.";
    if (lingering.has(sessionId)) return LINGERING;
    if (opening.has(sessionId)) return "This session is still opening. Try again when it has loaded.";
    if (historyBusy.has(sessionId)) return "Wait until the delete of a message has finished.";
    return null;
  };
  const close = async () => {
    keeper.activity(sessionId); // a new context window or prompt (the close below also ends the keeper's state)
    historyBusy.add(sessionId);
    try {
      await closeAndWait(sessionId);
    } finally {
      historyBusy.delete(sessionId);
    }
  };
  return { refusal, close };
}

// the parts of a session's prompt, for its editor
handle("sessions:getPrompt", async (sessionId) => {
  if (!isSessionId(sessionId)) throw new Error(`Invalid session id: ${sessionId}`);
  const s = loadSettings();
  return { own: prompts.get(sessionId), command: commands.get(sessionId), settingsCommand: settingsCommand().command, defaultPart: defaultPartOf(s), childPart: effectiveChildPart(s.promptChild), isChild: childLinkOf(sessionId) !== null };
});

// a new own part or command takes a new Copilot process, as a new context window does (the renderer reopens the
// session); the same values change nothing
handle("sessions:setPrompt", async (sessionId, own, command = "") => {
  if (!isSessionId(sessionId)) return { refused: `Invalid session id: ${sessionId}` };
  await keeper.whenIdle(sessionId);
  return saveSetup({ ...restartGuards(sessionId), sessionId, own, command, prompts, commands });
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

handle("dialog:pickDir", async (title, defaultPath) => {
  const r = await dialog.showOpenDialog(win, { title: title || "Folder for the new session", ...(typeof defaultPath === "string" && isDirectory(defaultPath) ? { defaultPath } : {}), properties: ["openDirectory", "createDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});

handle("settings:get", async () => ({
  copilotCommand: loadSettings().copilotCommand ?? "",
  effective: settingsCommand().command,
  platform: process.platform,
  relay: loadSettings().relay !== false,
  relayAvailable: Boolean(RelayClient),
  relayUrl: relayConfig().url,
  contextTier: normalizeTier(loadSettings().contextTier) ?? "default",
  queueMidTurn: loadSettings().queueMidTurn === true,
  activityPanel: normalizePanelMode(loadSettings().activityPanel),
  brokerRepo: loadSettings().brokerRepo ?? "",
  brokerRepoDefault: defaultBrokerRepo(),
  promptDefault: typeof loadSettings().promptDefault === "string" ? loadSettings().promptDefault : null,
  promptChild: typeof loadSettings().promptChild === "string" ? loadSettings().promptChild : null,
  promptTemplates: normalizeTemplates(loadSettings().promptTemplates),
  defaultPartDefault: DEFAULT_PART,
  defaultPart: defaultPartOf(loadSettings()), // the one a session starts with now (for the prompt editors)
  childPartDefault: CHILD_PART,
  cacheKeeper: normalizeKeeperSettings(loadSettings().cacheKeeper),
}));
handle("settings:set", async (s) => {
  // a refused command keeps the stored one; the rest of the form is still saved
  const typed = normalizeCommand(s.copilotCommand ?? "");
  if (typed.refused) console.warn(`[settings] the Copilot command was not saved: ${typed.refused}`);
  const next = { ...loadSettings(), ...(typed.refused ? {} : { copilotCommand: typed.command }), relay: s.relay !== false, contextTier: normalizeTier(s.contextTier) ?? "default", queueMidTurn: s.queueMidTurn === true, activityPanel: normalizePanelMode(s.activityPanel), brokerRepo: String(s.brokerRepo ?? "").trim() };
  // the keeper's settings only when sent, as the prompt parts
  if (s.cacheKeeper !== undefined) next.cacheKeeper = normalizeKeeperSettings(s.cacheKeeper);
  // the prompt parts only when sent (a form without them keeps them); null: back to the built-in text
  saveSettings(applyPromptSettings(next, s));
  keeper.replan();
  lister?.kill();
  lister = null;
  return true;
});

// ---------- broker restart ----------

const restarter = createRestarter({
  fx: realEffects({ reconnect: (ms) => reconnectClients([...open.values()].map((e) => e.relay).filter(Boolean), ms) }),
  notify: (s) => send("broker:restart", s),
});
const defaultBrokerRepo = () => {
  const script = relayConfig().brokerScript;
  return script ? path.dirname(script) : "";
};

handle("broker:status", async () => {
  const working = [...open.values()].filter((e) => e.prompting || e.permissions.size).length;
  let acpSessions = 0;
  try {
    const health = await (await fetch(`${relayConfig().url}/health`, { signal: AbortSignal.timeout(2000) })).json();
    acpSessions = Number.isInteger(health?.acpSessions) ? health.acpSessions : 0;
  } catch {}
  return { ...restarter.snapshot(), working, acpSessions };
});
// The folder in the field, as shown: no fallback to the default here (the window fills the field with it), so an empty
// field is refused by Check instead of running in a folder the field does not show.
handle("broker:restart", async (repo) =>
  restarter.start({ repo: String(repo ?? "").trim(), url: relayConfig().url, copilotHome: process.env.COPILOT_HOME || undefined }),
);

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

// Network locations (mounts, mapped drives), read at most every 30 s. `mount` can hang on a dead NFS server: it is
// killed after 5 s and a failure gives a null table (then only the trusted roots are checked automatically).
// powershell by absolute path: a search can include the working directory on Windows
const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const locations = createLocationTable({
  platform: process.platform,
  powershell,
  timeoutMs: 5000, // also when the killed process never reports back (uninterruptible I/O)
  readFile: (p) => readFile(p, "utf8"),
  exec: (file, args) =>
    new Promise((resolve, reject) => execFile(file, args, { timeout: 5000, killSignal: "SIGKILL", windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))))),
});
const isNetwork = async (real) => {
  const table = await locations.get();
  return table ? isNetworkLocation(real, table) : false;
};

/** Where a path the agent decides may be looked at on disk without a click: a local path and (without a location
 *  table) one inside the home or a session folder. Resolves the rule as a predicate for the current table. */
async function automaticCheckRule() {
  const home = os.homedir();
  const table = await locations.get();
  // real paths too, so a symlinked home is not refused at its first hop. Only needed without a table, where just home
  // is trusted enough to resolve (resolving touches the disk); the session folders stay as text.
  const trustedRoots = new Set([home, ...knownFolders]);
  if (!table) {
    const real = await localRealpath(home).catch(() => null);
    if (real) trustedRoots.add(real);
  }
  return (p) => allowsAutomaticCheck(p, { table, trustedRoots: [...trustedRoots], platform: process.platform });
}

/** One path against that rule, applied as files:check applies it (every component and link target on the way): the
 *  changes browser's trigger, which runs git where the path leads. */
async function allowAutomatic(abs) {
  return passesAutomaticCheck(abs, await automaticCheckRule());
}

/** A folder the user picked (changes:add): its real local path exists and is not a network location (as files:read:
 *  allowed when there is no location table). */
async function allowClicked(dir) {
  if (isRemote(dir)) return false; // a UNC start is refused by its text, before anything touches it
  const real = await localRealpath(dir).catch(() => null);
  return Boolean(real) && !(await isNetwork(real));
}

// Which file mentions of a message exist? Agent text decides the paths, so nothing is looked at on disk unless the
// rule above allows it.
handle("files:check", async (base, candidates) => {
  const allow = await automaticCheckRule();
  const list = (Array.isArray(candidates) ? candidates : []).map(String);
  return checkCandidates(list, { base: base ? String(base) : null, home: os.homedir(), allow, platform: process.platform });
});

// ---------- changes browser ----------

/** The session id of a changes:* call: a Copilot session id or a session open in this app. */
function knownSession(sessionId) {
  if (typeof sessionId !== "string" || !(isSessionId(sessionId) || open.has(sessionId))) throw new Error("Unknown session");
  return sessionId;
}

handle("changes:list", async (sessionId) => changes.list(knownSession(sessionId)));
handle("changes:commits", async (sessionId, root, rel) => changes.commits(knownSession(sessionId), root, rel));
handle("changes:diff", async (sessionId, root, rel, version) => changes.diff(knownSession(sessionId), root, rel, version));
// null when the dialog is cancelled, else { root } or { message }
handle("changes:add", async (sessionId) => {
  knownSession(sessionId);
  const r = await dialog.showOpenDialog(win, { title: "Repository to add", properties: ["openDirectory"] });
  return r.canceled ? null : changes.add(sessionId, r.filePaths[0]);
});
handle("changes:remove", async (sessionId, root) => {
  await changes.remove(knownSession(sessionId), root); // a failure reaches the window; the reset below runs only on success
  tracker.forgetSeen(sessionId); // the agent's next edit there records the repository again, with a new start point
});

// Real paths files:read has returned in this run: the only ones files:watch accepts.
const readablePaths = new Set();
// A click on a file link: the text for the preview pane, { outside } until confirmed for files outside the viewing folder
handle("files:read", async (baseCwd, target, { viewingCwd, confirmed = false } = {}) => {
  const r = await resolvePreview({ baseCwd, target, viewingCwd, confirmed: confirmed === true }, { isNetwork });
  if (r.path && !r.outside) readablePaths.add(r.path);
  return r;
});

// A file opened from a link in the chat is remembered for the session (only one files:read returned in this run).
handle("changes:opened", async (sessionId, p) => {
  knownSession(sessionId);
  if (typeof p !== "string" || !readablePaths.has(p)) throw new Error("This file was not opened in the preview");
  records.addOpened(sessionId, p);
});
handle("changes:forget-opened", async (sessionId, p) => {
  records.removeOpened(knownSession(sessionId), p);
});

// The file on show in the preview; a change makes the renderer read it again (files:read decides what it may see).
const fileWatcher = createFileWatcher({ onChange: (p) => send("files:changed", p) });
handle("files:watch", async (p) => {
  if (p == null) return fileWatcher.set(null);
  if (typeof p !== "string" || !readablePaths.has(p)) throw new Error("This file was not opened in the preview");
  fileWatcher.set(p);
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

// ---------- scheduled scripts ----------

const jobNotifications = new Set(); // referenced until closed or clicked, or GC can drop the click handler
const JOB_ICONS = { success: "✓", timeout: "⏱" };

function sendToWindow(channel, payload) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
}

function openJobRun(payload) {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    sendToWindow("jobs:openRun", payload);
  } else {
    createWindow(); // macOS: the app keeps running with no window
    win.webContents.once("did-finish-load", () => sendToWindow("jobs:openRun", payload));
  }
}

function startScheduler() {
  scheduler = new JobScheduler({
    dir: app.getPath("userData"),
    secrets: {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (s) => safeStorage.encryptString(s).toString("base64"),
      decrypt: (b) => safeStorage.decryptString(Buffer.from(b, "base64")),
    },
    onChanged: () => sendToWindow("jobs:changed"),
    onRunFinished: (run, job, notify) => {
      const payload = { jobId: job.id, runId: run.id, status: run.status };
      sendToWindow("jobs:runFinished", payload);
      if (!notify || !Notification.isSupported()) return;
      const icon = JOB_ICONS[run.status] ?? "✗";
      const n = new Notification({ title: `${icon} ${job.name}`, body: run.summary });
      jobNotifications.add(n);
      n.on("click", () => {
        jobNotifications.delete(n);
        openJobRun({ jobId: job.id, runId: run.id });
      });
      n.on("close", () => jobNotifications.delete(n));
      n.show();
    },
  });
  scheduler.start();
}

handle("jobs:list", () => scheduler.list());
handle("jobs:save", (input) => scheduler.save(input));
handle("jobs:delete", (id) => scheduler.remove(id));
handle("jobs:setEnabled", (id, on) => scheduler.setEnabled(id, on));
handle("jobs:runNow", (id) => scheduler.runNow(id));
handle("jobs:runs", (jobId) => scheduler.runs(jobId));
handle("jobs:run", (jobId, runId) => scheduler.run(jobId, runId));
handle("jobs:previewSchedule", (expr) => scheduleInfo(expr, new Date(), 3));

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
  win.on("focus", () => quota.get().catch(() => {}));
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
  win.on("close", (e) => {
    if (!confirmLeavingChildren()) e.preventDefault();
  });
  win.on("closed", () => (win = null));
}

// Quitting kills every Copilot process, so a child that has not reported would be lost. The close and before-quit
// events come in either order (macOS: before-quit first), so the answer is remembered for the rest of the quit.
let leavingConfirmed = false;
function confirmLeavingChildren() {
  if (leavingConfirmed) return true;
  const count = unreportedChildren(open.values()).length;
  if (count === 0) return true;
  const options = {
    type: "warning",
    buttons: ["Quit", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: `${count} ${count === 1 ? "sub-session has" : "sub-sessions have"} not reported yet.`,
    detail: "Quitting stops their work.",
  };
  const parent = win && !win.isDestroyed() ? win : null;
  const choice = parent ? dialog.showMessageBoxSync(parent, options) : dialog.showMessageBoxSync(options);
  leavingConfirmed = choice === 0;
  return leavingConfirmed;
}

// After a reload the views are gone but main keeps every process: a child's permission card would be lost for good
// and Close all sub-sessions would not reach it. So its work is stopped first, with the user's consent. Reopen cards
// of sessions that stay open come back when their view is opened again (sessions:open).
let windowReloads = 0; // a reload takes every card with it: a request answered across one cannot be kept (delegation:answer)
async function confirmedReload(reload) {
  const parent = win && !win.isDestroyed() ? win : null;
  if (!parent) return;
  const children = [...open].filter(([, e]) => e.parentSessionId).map(([id]) => id);
  if (children.length || pendingRequests.size) {
    const reopens = [...reopenCards.values()].filter((c) => children.includes(c.sessionId)).length;
    const choice = dialog.showMessageBoxSync(parent, { type: "warning", buttons: ["Reload", "Cancel"], defaultId: 1, cancelId: 1, ...reloadWarning(children.length, pendingRequests.size, reopens) });
    if (choice !== 0) return;
    // counted before the children are closed: a start that fails during that wait must already see the reload
    windowReloads++;
    await Promise.all(children.map((id) => closeEntry(id).catch(() => {})));
    pendingRequests.clear();
    keeper.replan(); // the parents' cards are gone
  } else windowReloads++;
  if (!parent.isDestroyed()) reload(parent.webContents);
}

function notifyIfUnfocused(title, body) {
  if (win && !win.isDestroyed() && win.isFocused()) return;
  if (!Notification.isSupported()) return;
  new Notification({ title, body }).show();
}

// The Copilot CLI of the quota query: quitting waits for it to be gone. Every killAll() adds its stopAll() to the
// pending one (a second call finds nothing left to stop and would settle at once), and runtimeStopPending stays set
// until the combined promise settles (the runtime's size() is already 0 while the stop is still running).
let runtimeStopping = Promise.resolve();
let runtimeStopPending = false;
function killAll() {
  runtimeStopPending = true;
  const stopping = (runtimeStopping = Promise.all([runtimeStopping, runtime.stopAll()]).catch(() => {}));
  stopping.then(() => {
    if (runtimeStopping === stopping) runtimeStopPending = false;
  });
  for (const [sessionId, { conn, relay }] of open) {
    relay?.stop();
    conn.kill();
    keeper.closed(sessionId);
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
  try {
    const migrated = migratePromptDefault(loadSettings());
    if (migrated) saveSettings(migrated);
  } catch (e) {
    console.warn(`[session-prompts] could not migrate the default part: ${e.message}`);
  }
  try {
    clearPromptDirs(promptRoot); // the folders of processes an earlier run did not see exit (before any connect)
  } catch (e) {
    console.warn(`[session-prompts] could not clear ${promptRoot}: ${e.message}`);
  }
  app.whenReady().then(() => {
    // the default menu without its zoom items: Ctrl + +/-/0 belong to the chat text size (see the renderer)
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
        { role: "fileMenu" },
        { role: "editMenu" },
        {
          label: "View",
          submenu: [
            { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => confirmedReload((wc) => wc.reload()) },
            { label: "Force Reload", accelerator: "Shift+CmdOrCtrl+R", click: () => confirmedReload((wc) => wc.reloadIgnoringCache()) },
            { role: "toggleDevTools" },
            { type: "separator" },
            { role: "togglefullscreen" },
          ],
        },
        { role: "windowMenu" },
      ]),
    );
    purging = purgeDeleted().catch(() => {}); // what an earlier delete could not remove
    createWindow();
    refreshLinks(); // a broker that is not up yet: the first registration fetches them again
    try {
      startScheduler();
    } catch (e) {
      console.error("Scheduled jobs could not start:", e); // the Schedules page shows the error via jobs:list
    }
    app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
  });
  app.on("window-all-closed", () => {
    killAll();
    if (process.platform !== "darwin") {
      scheduler?.abortAllSync();
      app.quit();
    }
    else leavingConfirmed = false; // the app keeps running and everything was stopped: the next quit asks afresh
  });
  // the killed processes take their prompt folders with them as they exit: quitting waits a moment for that, so
  // none is left behind (one that does not exit in time leaves its folder to the next start)
  let promptsAwaited = false;
  app.on("will-quit", (e) => {
    const live = [...promptProcs].filter((c) => !c.exited);
    if (promptsAwaited || (!live.length && !runtimeStopPending)) return;
    promptsAwaited = true;
    e.preventDefault();
    Promise.all([runtimeStopping, ...live.map((c) => exited(c, 3500))]).then(() => app.quit());
  });
  app.on("before-quit", (e) => {
    if (confirmLeavingChildren()) {
      killAll();
      scheduler?.abortAllSync();
    } else e.preventDefault();
  });
}
