// Runs the real app under xvfb against the scripted ACP agent and drives its window over the Chrome DevTools
// Protocol (scripts/ui-check/run.mjs). Each launch gets a fresh config dir and work folder in the system temp dir;
// close() stops every process it started and removes them.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ELECTRON = path.join(ROOT, "electron", "node_modules", ".bin", "electron");
const AGENT = path.join(ROOT, "electron", "test", "fixtures", "acp", "scripted-agent.mjs");
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

/** Polls fn until it returns a truthy value. */
async function until(fn, what, ms = TIMEOUT_MS) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
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
 * Starts the app. scenario: the scripted agent's scenario module (path); settings: more fields for settings.json.
 * @returns the driver; every method that waits throws after 20 s.
 */
export async function launch({ scenario, settings = {}, width = 1280, height = 800 }) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ui-check-"));
  const config = path.join(tmp, "config");
  const work = path.join(tmp, "work"); // the session folder: the session id is scripted-work
  mkdirSync(path.join(config, "copilot-relay-desktop"), { recursive: true });
  mkdirSync(work);
  mkdirSync(path.join(tmp, "copilot-home"));
  writeFileSync(
    path.join(config, "copilot-relay-desktop", "settings.json"),
    JSON.stringify({ copilotCommand: AGENT, relay: false, ...settings }, null, 2),
  );
  const port = await freePort();
  // X11 only, so the window is on Xvfb's display even from a Wayland session (Electron would pick Wayland).
  // Its own process group: close() stops xvfb, Electron and the agents it started together.
  const { WAYLAND_DISPLAY, ...env } = process.env;
  const proc = spawn("xvfb-run", ["-a", ELECTRON, "electron", "--ozone-platform=x11", `--remote-debugging-port=${port}`], {
    cwd: ROOT,
    env: { ...env, XDG_SESSION_TYPE: "x11", XDG_CONFIG_HOME: config, COPILOT_HOME: path.join(tmp, "copilot-home"), SCRIPTED_SCENARIO: path.resolve(scenario) },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const keep = (d) => (output = (output + d).slice(-4000));
  proc.stdout.on("data", keep);
  proc.stderr.on("data", keep);
  const exited = new Promise((resolve) => proc.once("exit", resolve));

  let ws = null;
  async function close() {
    ws?.close();
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {}
    const gone = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]);
    try {
      process.kill(-proc.pid, "SIGKILL"); // what is left of the group (Electron's helpers, the agents)
    } catch {}
    if (!gone) await exited;
    rmSync(tmp, { recursive: true, force: true });
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
      ev,
      resize,
      /** A new session in the work folder (scripted-work); later calls act on it. */
      async newSession() {
        sessionId = `scripted-${path.basename(work)}`;
        await ev(`newSession(${JSON.stringify(work)})`);
        await check(`${view()} && !${view()}.busy`, "the new session");
        return sessionId;
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
      /** thread: what Copy thread builds, without its two header lines; log: one row per log child. */
      async dump() {
        return ev(`(() => {
          const v = ${view()};
          const thread = [...v.log.children].map((e) => e._md?.()?.trim()).filter(Boolean).join("\\n\\n");
          const log = [...v.log.children].map((e) => [e.className.replace(/\\s*\\bin-panel\\b/, ""), e._turn ?? null, e._kind ?? null, !!e.querySelector(".acts")]);
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
