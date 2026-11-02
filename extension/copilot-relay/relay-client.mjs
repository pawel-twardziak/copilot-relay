// Broker client used by the copilot-relay extension. No dependencies (Node >= 18).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export class RelayClient {
  /**
   * @param {object} o
   * @param {string} o.url        broker base URL, e.g. http://127.0.0.1:7777
   * @param {string} o.key        stable peer key (Copilot sessionId)
   * @param {string} o.cwd
   * @param {string} [o.name]     preferred name
   * @param {string} [o.alias]    extra ID the broker maps to `key` (MCP `?peer=` token used by the desktop app)
   * @param {string} [o.brokerScript] path to server.mjs – auto-started if the broker is down
   * @param {string} [o.nodePath]  Node executable used to start the broker
   * @param {(m:{from:string,text:string,prompt:string})=>void} o.onMessage
   * @param {(name:string)=>void} [o.onRegistered]
   * @param {(name:string)=>void} [o.onRenamed]   renamed elsewhere (GUI)
   * @param {(msg:string)=>void} [o.log]
   */
  constructor(o) {
    Object.assign(this, o);
    this.name = o.name ?? null;
    // explicitly requested name (env) is sent only on the first connection; afterwards the broker's
    // persistent store is the source of truth (so a rename from the GUI survives reconnects)
    this.requestedName = o.name ?? null;
    this.log ??= () => {};
    this.stopped = false;
    this.connected = false;
    this.autostarted = false;
  }

  start() {
    this.#loop();
  }

  stop() {
    this.stopped = true;
    this.abort?.abort();
  }

  async list() {
    const r = await this.#fetch(`/api/peer/list?key=${encodeURIComponent(this.key)}`);
    return r.json();
  }

  async send(to, text) {
    const r = await this.#post("/api/peer/send", { key: this.key, to, text });
    return (await r.json()).result;
  }

  async rename(name, role) {
    this.selfRenaming = true; // the broker echoes a "renamed" event back to us; don't report it twice
    const r = await this.#post("/api/peer/rename", { key: this.key, name, role }).finally(() => (this.selfRenaming = false));
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? r.statusText);
    this.name = j.name; // set before any late "renamed" echo arrives → it is ignored as unchanged
    return j.name;
  }

  async human() {
    await this.#post("/api/peer/human", { key: this.key }).catch(() => {});
  }

  #fetch(p, init) {
    return fetch(this.url + p, init);
  }
  #post(p, body) {
    return this.#fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  async #loop() {
    let delay = 1000;
    while (!this.stopped) {
      try {
        await this.#connectOnce();
        delay = 1000;
      } catch (e) {
        if (this.stopped) return;
        if (this.connected) this.log(`relay: disconnected (${e.message})`);
        this.connected = false;
        if (!this.autostarted && this.brokerScript && /ECONNREFUSED|fetch failed/.test(String(e.cause ?? e.message))) {
          this.#autostart();
        }
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 15_000);
    }
  }

  #autostart() {
    this.autostarted = true;
    if (!existsSync(this.brokerScript)) return this.log(`relay: broker script not found: ${this.brokerScript}`);
    // inside Copilot, process.execPath is the copilot binary – use the recorded Node (or `node` from PATH)
    const node = this.nodePath || "node";
    const child = spawn(node, [this.brokerScript], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      cwd: path.dirname(this.brokerScript),
    });
    child.on("error", (e) => this.log(`relay: could not start the broker with ${node}: ${e.message}`));
    child.unref();
    this.log("relay: broker was not running — started it in the background");
  }

  async #connectOnce() {
    this.abort = new AbortController();
    const qs = new URLSearchParams({ key: this.key, cwd: this.cwd ?? "" });
    if (this.requestedName) qs.set("name", this.requestedName);
    if (this.alias) qs.set("alias", this.alias);
    const res = await this.#fetch(`/api/peer/stream?${qs}`, { signal: this.abort.signal, headers: { accept: "text/event-stream" } });
    if (!res.ok || !res.body) throw new Error(`broker answered ${res.status}`);
    this.connected = true;

    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = "message";
        let data = "";
        for (const line of raw.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("data: ")) data += line.slice(6);
        }
        if (!data) continue;
        const payload = JSON.parse(data);
        if (event === "registered") {
          this.name = payload.name;
          this.requestedName = null;
          this.onRegistered?.(payload.name);
        } else if (event === "renamed") {
          const changed = payload.name !== this.name;
          this.name = payload.name;
          if (changed && !this.selfRenaming) this.onRenamed?.(payload.name);
        } else if (event === "message") {
          this.onMessage(payload);
        }
      }
    }
    throw new Error("stream ended");
  }
}
