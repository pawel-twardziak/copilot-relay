// Runs the real app under xvfb against the scripted ACP agent and drives its window over the Chrome DevTools
// Protocol (scripts/ui-check/run.mjs). Each launch gets a fresh config dir and work folder in the system temp dir;
// close() stops every process it started and removes them. With broker: true a relay broker of its own (this repo's
// server.mjs on the launch's relay port, its state files in the launch's folder) runs for the app.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ELECTRON = path.join(ROOT, "electron", "node_modules", ".bin", "electron");
const AGENT = path.join(ROOT, "electron", "test", "fixtures", "acp", "scripted-agent.mjs");
const SERVER = path.join(ROOT, "server.mjs");
const TIMEOUT_MS = 20_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Polls fn until it returns a truthy value (a throw counts as not yet). */
export async function until(fn, what, ms = TIMEOUT_MS) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** Whether pid still runs. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Stops a process that is not a child of this one: SIGTERM, then SIGKILL after 5 s; resolves once it is gone. */
async function stopPid(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  const end = Date.now() + 5000;
  while (alive(pid) && Date.now() < end) await sleep(50);
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
  while (alive(pid)) await sleep(50);
}

/** Stops a child process (SIGTERM, then SIGKILL after 5 s); resolves once it has exited. */
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  if (await Promise.race([exited.then(() => true), sleep(5000).then(() => false)])) return;
  child.kill("SIGKILL");
  await exited;
}

/** The processes running `script` (an argument ending with it) with this launch's names file in their environment.
 *  Linux (/proc), like xvfb-run. */
function launchProcesses(namesFile, script) {
  const pids = [];
  for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      if (!readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").some((a) => a.endsWith(script))) continue;
      if (readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`COPILOT_RELAY_NAMES_FILE=${namesFile}`)) pids.push(Number(pid));
    } catch {} // gone meanwhile, or not ours to read
  }
  return pids;
}

/** Brokers (server.mjs) of this launch: the driver's, and those the app started by itself (RelayClient's #autostart,
 *  detached: outside the app's process group). */
const brokersOf = (namesFile) => launchProcesses(namesFile, "server.mjs");

/** The scripted agents of this launch. Each leads a process group of its own (AcpConnection starts it detached), so
 *  the kill of the app's group does not reach one the app left running. Only the agent matches, not the shell that
 *  started it (`sh -c '…scripted-agent.mjs' --acp --stdio`); the shell exits with it. */
const agentsOf = (namesFile) => launchProcesses(namesFile, "scripted-agent.mjs");

/** Starts this repo's server.mjs with env (port and state files in it) and a config file that does not exist;
 *  resolves its process once it listens. */
function startBroker(env, config) {
  const proc = spawn(process.execPath, [SERVER, config], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  proc.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
  const exited = new Promise((resolve) => proc.once("exit", resolve));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`timed out after ${TIMEOUT_MS / 1000} s waiting for the broker to listen`));
    }, TIMEOUT_MS);
    createInterface({ input: proc.stdout }).on("line", (line) => {
      if (!line.includes("copilot-relay broker:")) return;
      clearTimeout(timer);
      resolve(proc);
    });
    exited.then((code) => {
      clearTimeout(timer);
      reject(new Error(`the broker exited with ${code}${err ? `: ${err.trim()}` : ""}`));
    });
  });
}

/** A CDP connection to the app's page. */
async function attach(port) {
  const page = await until(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(2000) })).json();
    return targets.find((t) => t.type === "page" && !t.url.startsWith("devtools"));
  }, "the app's page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${TIMEOUT_MS / 1000} s attaching to the page`)), TIMEOUT_MS);
    ws.addEventListener("open", () => resolve(clearTimeout(timer)), { once: true });
    ws.addEventListener("error", () => reject(new Error("could not attach to the page")), { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  /** A CDP call; what names it in the error when no answer comes within TIMEOUT_MS. */
  const cdp = (method, params = {}, what = method) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      const timer = setTimeout(() => {
        pending.delete(i);
        reject(new Error(`timed out after ${TIMEOUT_MS / 1000} s: ${what}`));
      }, TIMEOUT_MS);
      pending.set(i, (m) => {
        clearTimeout(timer);
        if (m.error) reject(new Error(`${what}: ${m.error.message}`));
        else resolve(m.result);
      });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  return { ws, cdp };
}

/**
 * Starts the app. scenario: the scripted agent's scenario module (path); settings: more fields for settings.json;
 * sessionId: the id the scripted agent gives its session instead of scripted-work (a UUID: the app reads Copilot's
 * history files only for those; they go in <dir>/copilot-home/session-state/<id>/). broker: start a broker on the
 * app's relay port first (the app reaches it only with settings.relay true); without it nothing listens there.
 * env: more variables for the app's environment.
 * @returns the driver; every method that waits throws after 20 s.
 */
export async function launch({ scenario, settings = {}, width = 1280, height = 800, dir = null, sessionId: scriptedId = null, broker = false, env: extraEnv = {} }) {
  // dir: the folder of an earlier launch kept with close({ keep: true }); this launch uses its settings and stored UI
  // state, and removes it
  const tmp = dir ?? mkdtempSync(path.join(os.tmpdir(), "ui-check-"));
  const config = path.join(tmp, "config");
  const work = path.join(tmp, "work"); // the session folder: the session id is scripted-work
  if (!dir) {
    mkdirSync(path.join(config, "copilot-relay-desktop"), { recursive: true });
    mkdirSync(work);
    mkdirSync(path.join(tmp, "copilot-home"));
    writeFileSync(
      path.join(config, "copilot-relay-desktop", "settings.json"),
      JSON.stringify({ copilotCommand: AGENT, relay: false, ...settings }, null, 2),
    );
  }
  const port = await freePort();
  const relayPort = await freePort(); // the app's relay URL points here (nothing listens without broker): never the real broker on 7777
  const { WAYLAND_DISPLAY, COPILOT_RELAY_URL, ...env } = process.env; // an inherited COPILOT_RELAY_URL would beat COPILOT_RELAY_PORT
  // the broker's state files, also in the app's environment: a broker the app starts by itself (RelayClient's
  // #autostart, when its connection is refused) inherits it and must never fall back to the real state files
  const namesFile = path.join(tmp, "relay-names.json");
  const relayEnv = { COPILOT_RELAY_PORT: String(relayPort), COPILOT_RELAY_NAMES_FILE: namesFile, COPILOT_RELAY_DELEGATIONS_FILE: path.join(tmp, "relay-delegations.json"), COPILOT_RELAY_COMMS_FILE: path.join(tmp, "relay-communications.jsonl"), COPILOT_RELAY_LOG_FILE: path.join(tmp, "relay-broker.log") };
  const brokerEnv = { ...env, ...relayEnv };
  const brokerConfig = path.join(tmp, "no-relay-config.json"); // does not exist: the broker's defaults, not relay.config.json
  let brokerProc = null;
  if (broker) {
    try {
      brokerProc = await startBroker(brokerEnv, brokerConfig);
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
  }
  // X11 only, so the window is on Xvfb's display even from a Wayland session (Electron would pick Wayland).
  // Its own process group: close() stops xvfb, Electron and the agents it started together.
  const proc = spawn("xvfb-run", ["-a", ELECTRON, "electron", "--ozone-platform=x11", `--remote-debugging-port=${port}`], {
    cwd: ROOT,
    env: { ...env, ...relayEnv, XDG_SESSION_TYPE: "x11", XDG_CONFIG_HOME: config, COPILOT_HOME: path.join(tmp, "copilot-home"), SCRIPTED_SCENARIO: path.resolve(scenario), ...extraEnv, ...(scriptedId ? { SCRIPTED_SESSION_ID: scriptedId } : {}) },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const keep = (d) => (output = (output + d).slice(-4000));
  proc.stdout.on("data", keep);
  proc.stderr.on("data", keep);
  const exited = new Promise((resolve) => proc.once("exit", resolve));

  let ws = null;
  let closed = false;
  async function close({ keep = false } = {}) {
    if (closed) return;
    closed = true;
    // kept for another launch: first the app quits as when you close its window, which writes its localStorage to
    // disk (killed, it loses what it wrote in the last seconds)
    if (keep && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ id: 0, method: "Runtime.evaluate", params: { expression: "window.close()" } }));
      await Promise.race([exited, sleep(5000)]);
    }
    ws?.close();
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {}
    const gone = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]);
    try {
      process.kill(-proc.pid, "SIGKILL"); // what is left of the group (Electron's helpers, the agents)
    } catch {}
    if (!gone) await exited;
    for (const pid of agentsOf(namesFile)) await stopPid(pid);
    // the driver's broker, and any the app started by itself: none outlives the launch
    if (brokerProc) await stopChild(brokerProc);
    for (const pid of brokersOf(namesFile)) await stopPid(pid);
    if (!keep) rmSync(tmp, { recursive: true, force: true });
  }

  try {
    const page = await attach(port);
    ws = page.ws;
    const { cdp } = page;

    /** Evaluates an expression in the page (promises awaited); returns its value, throws its exception, or throws
     *  after TIMEOUT_MS naming what (by default the expression). */
    async function ev(expr, what = `evaluating ${expr.replace(/\s+/g, " ").slice(0, 120)}`) {
      const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, what);
      if (r.exceptionDetails) throw new Error(`in the page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value;
    }
    const check = (expr, what) => until(() => ev(expr), what);

    async function resize(w, h) {
      await cdp("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }, `resizing to ${w}×${h}`);
    }

    let sessionId = null;
    const view = () => `views.get(${JSON.stringify(sessionId)})`;

    await check("document.readyState === 'complete' && typeof views === 'object' && typeof newSession === 'function'", "the app to load");
    await resize(width, height);

    return {
      /** The launch's folder: pass it as dir to launch again with the same settings (after close({ keep: true })). */
      dir: tmp,
      /** With broker: its URL, and restart(): the broker stops and a new one starts on the same port with the same
       *  state files (pending link requests, held in memory only, are gone). Without: null. */
      broker: broker ? {
        url: `http://127.0.0.1:${relayPort}`,
        async restart() {
          if (brokerProc) await stopChild(brokerProc);
          brokerProc = null;
          try {
            brokerProc = await startBroker(brokerEnv, brokerConfig);
          } catch (e) {
            // an app session that reconnected in the gap found the port free and started a broker itself: with the
            // app's environment, so on this port with these state files; close() stops it too
            if (!brokersOf(namesFile).length) throw e;
          }
        },
      } : null,
      ev,
      check,
      resize,
      /** A PNG of the window as it is now, written to file (for a look at a layout; no check compares it). */
      async screenshot(file) {
        const { data } = await cdp("Page.captureScreenshot", { format: "png" }, "taking a screenshot");
        writeFileSync(file, Buffer.from(data, "base64"));
      },
      /** The pid of the app's main process (Electron's, not a helper's), or null. */
      mainPid() {
        for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
          try {
            const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " "); // Electron joins its own arguments
            if (/\/dist\/electron /.test(cmd) && cmd.includes(` --remote-debugging-port=${port} `) && !cmd.includes(" --type=")) return Number(pid);
          } catch {} // gone meanwhile, or not ours to read
        }
        return null;
      },
      /** The scripted agents of this launch that still run. */
      agents: () => agentsOf(namesFile),
      /** A real Enter key press on the focused element (not a synthetic event: it takes the browser's own
       *  handling, such as a form's implicit submit). */
      async pressEnter({ ctrl = false } = {}) {
        const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: ctrl ? 2 : 0 };
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...key, text: "\r" }, "pressing Enter");
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...key }, "releasing Enter");
      },
      /** A real mouse click at the middle of the element selector names (a user activation, unlike el.click(): a modal
       *  dialog opened by it gets its own Escape, not one shared with a dialog opened before it without one). */
      async click(selector) {
        const [x, y] = await ev(`(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`);
        for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, `clicking ${selector}`);
      },
      /** A real Escape key press on the focused element (a modal dialog's own cancel handling). */
      async pressEscape() {
        const key = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...key }, "pressing Escape");
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...key }, "releasing Escape");
      },
      /** A new session in the work folder (scripted-work, or the launch's sessionId), with own as its own prompt
       *  part; later calls act on it. */
      async newSession({ own } = {}) {
        sessionId = scriptedId ?? `scripted-${path.basename(work)}`;
        await this.startSession(work, { own });
        await check(`${view()} && !${view()}.busy`, "the new session");
        return sessionId;
      },
      /** The page's newSession(cwd) through its prompt dialog: waits for #prompt-dialog, puts own (if given) into the
       *  editor's text area and presses Start; resolves once newSession has returned (the view is built). Later calls
       *  still act on the session of newSession(). */
      async startSession(cwd, { own } = {}) {
        await ev(`(window.__newSession = newSession(${JSON.stringify(cwd)}), true)`);
        await check(`document.querySelector("#prompt-dialog").open`, "the prompt dialog");
        if (own != null) {
          await ev(`(() => { const t = document.querySelector("#prompt-dialog .pe-own"); t.value = ${JSON.stringify(own)}; t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
        }
        await ev(`document.querySelector("#prompt-ok").click()`);
        await ev(`window.__newSession`, "newSession to return");
      },
      /** Types text into the message box and presses Enter; resolves once its message is in the log. */
      async send(text) {
        const mine = `${view()}.log.querySelectorAll(":scope > .msg.user").length`;
        const before = await ev(mine);
        await ev(`(() => { const v = ${view()}; v.input.value = ${JSON.stringify(text)}; v.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
        await check(`${mine} > ${before}`, "the message to be sent");
      },
      /** Waits for an open permission card and clicks its allow button. */
      async answerPermission() {
        await check(`!!${view()}.el.querySelector(".perm:not(.done) .opts button.primary")`, "a permission card");
        await ev(`${view()}.el.querySelector(".perm:not(.done) .opts button.primary").click()`);
        await check(`!${view()}.el.querySelector(".perm:not(.done)")`, "the permission to be answered");
      },
      /** Waits until no prompt runs and no update came for 300 ms, then for two frames (queued renders). */
      async idle() {
        await check(`(() => { const v = ${view()}; return v && !v.busy && !v.resuming && Date.now() - (v.lastUpdate ?? 0) > 300; })()`, "the session to be idle");
        await ev("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))", "two animation frames (is the window on Xvfb?)");
      },
      /** Closes the view and opens the session again (a replay through session/load). */
      async reload() {
        await ev(`closeView(${JSON.stringify(sessionId)})`);
        await check(`!views.has(${JSON.stringify(sessionId)})`, "the view to close");
        await ev(`openSession({ sessionId: ${JSON.stringify(sessionId)}, cwd: ${JSON.stringify(work)} })`, "the session to reopen");
        await this.idle();
      },
      /** Sets "Tool and subagent details" in the Settings dialog and saves. Without that select only "off" exists. */
      async setMode(mode) {
        if (!(await ev(`!!document.querySelector("#set-activity")`))) {
          if (mode === "off") return;
          throw new Error(`setMode(${JSON.stringify(mode)}): this build has no activity panel setting`);
        }
        await ev(`document.querySelector("#btn-settings").click()`);
        await check(`document.querySelector("#settings").open`, "the Settings dialog");
        await ev(`(() => { const s = document.querySelector("#set-activity"); s.value = ${JSON.stringify(mode)}; s.dispatchEvent(new Event("change", { bubbles: true })); document.querySelector("#set-save").click(); })()`);
        await check(`!document.querySelector("#settings").open`, "the Settings dialog to close");
        await check(`api.getSettings().then((s) => s.activityPanel === ${JSON.stringify(mode)})`, "the mode to be saved");
      },
      /** thread: what Copy thread builds, without its two header lines; log: one row per log child (date lines left out). */
      async dump() {
        return ev(`(() => {
          const v = ${view()};
          const rows = [...v.log.children].filter((e) => !e.classList.contains("day-sep"));
          const thread = rows.map((e) => e._md?.()?.trim()).filter(Boolean).join("\\n\\n");
          const log = rows.map((e) => [e.className.replace(/\\s*\\bin-panel\\b/, ""), e._turn ?? null, e._kind ?? null, !!e.querySelector(".acts")]);
          return { thread, log };
        })()`);
      },
      close,
    };
  } catch (e) {
    await close();
    e.message += output ? `\n--- app output ---\n${output}` : "";
    throw e;
  }
}
