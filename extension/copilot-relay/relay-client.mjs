// Broker client used by the copilot-relay extension. No dependencies (Node >= 18).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Delivery handler for the extension: injects each message once per process and acknowledges durable items
 * (`deliveryId`) when the injection has succeeded. A failed injection can be redelivered.
 */
export function onceDelivery({ send, ack, onError }) {
  const handled = new Set();
  return (m) => {
    if (m.deliveryId && handled.has(m.deliveryId)) return;
    if (m.deliveryId) handled.add(m.deliveryId);
    return send(m).then(
      () => m.deliveryId && ack(m.deliveryId),
      (e) => {
        handled.delete(m.deliveryId);
        onError(e);
      },
    );
  };
}

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
   * @param {string} [o.parentKey] key of the session that delegated this one (sent on the first connection only)
   * @param {(req:object)=>void} [o.onSessionRequest] the broker forwards a session_request from this peer
   * @param {(req:object)=>void} [o.onReopenRequest] the user must approve reopening a closed relative
   * @param {()=>void} [o.onLinksChanged] the broker's link tree changed (refetch with fetchLinks)
   * @param {string[]} [o.caps] stream capabilities this client supports, e.g. ["links"] (sent on every connection)
   * @param {(req:object)=>void} [o.onLinkRequest] the user must approve linking or releasing a session
   * @param {(p:{parentKey:?string,adopted:boolean})=>void} [o.onParentChanged] this session's parent changed
   * @param {(event:object)=>void} [o.onComms] a new communication event (preview, no text) in the broker's log
   * @param {()=>void} [o.onReported] this delegated session's report was stored
   * @param {(name:string, payload?:{parentKey:?string,reported:boolean,adopted:boolean})=>void} [o.onRegistered]
   * @param {(name:string)=>void} [o.onRenamed]   renamed elsewhere (GUI)
   * @param {(msg:string)=>void} [o.log]
   */
  constructor(o) {
    Object.assign(this, o);
    this.name = o.name ?? null;
    // explicitly requested name (env) is sent only on the first connection; afterwards the broker's
    // persistent store is the source of truth (so a rename from the GUI survives reconnects)
    this.requestedName = o.name ?? null;
    this.requestedParent = o.parentKey ?? null; // like requestedName: first connection only
    this.log ??= () => {};
    this.stopped = false;
    this.connected = false;
    this.autostarted = false;
    this.retryMs ??= 1000; // first wait after a failure; doubles up to retryMaxMs, and starts over after a registration
    this.retryMaxMs ??= 15_000;
    this.#delay = this.retryMs;
  }

  #delay;
  #skipWait = false; // reconnectNow(): the next loop pass connects without waiting
  #endWait = null; // ends the wait in progress
  #timer = null;
  #pending = []; // reconnectNow() callers waiting for the next registration

  start() {
    this.#loop();
  }

  stop() {
    this.stopped = true;
    this.abort?.abort();
    this.#endWait?.();
    this.#settle(false);
  }

  /**
   * Ends the current wait or the live stream, connects at once and makes the next wait `retryMs`. Resolves true at the
   * next `registered` event, false when the client is stopped (already, or before that event). Never restarts a
   * stopped client.
   */
  reconnectNow() {
    if (this.stopped) return Promise.resolve(false);
    return new Promise((resolve) => {
      this.#pending.push(resolve);
      this.#delay = this.retryMs;
      this.#skipWait = true;
      this.abort?.abort();
      this.#endWait?.();
    });
  }

  #settle(ok) {
    for (const resolve of this.#pending.splice(0)) resolve(ok);
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

  /** Acknowledge a delivery; `outcome` is "taken" (default) or "discarded" (the app dropped it). */
  async ack(id, outcome) {
    await this.#post("/api/peer/ack", { key: this.key, id, ...(outcome ? { outcome } : {}) }).catch(() => {});
  }

  /** Tell the broker what became of a session request: { requestId, kind, name, text }. */
  async outcome(o) {
    await this.#post("/api/peer/delegation-outcome", { key: this.key, ...o }).catch(() => {});
  }

  /** This (delegated) session's task text; false when it has no link. */
  async setTask(task) {
    try {
      return (await (await this.#post("/api/peer/task", { key: this.key, task })).json()).ok === true;
    } catch {
      return false;
    }
  }

  /** Forward this session's last reply to `to` (a peer key) as its report or message; `{ old: true }` from a broker without the route. */
  async fallback(to, text) {
    const r = await this.#post("/api/peer/fallback", { key: this.key, to, text });
    if (r.status === 404) return { old: true };
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
    return { result: (await r.json()).result };
  }

  /** Report whether the session is working (true) or idle (false). */
  async state(busy) {
    await this.#post("/api/peer/state", { key: this.key, busy }).catch(() => {});
  }

  /** The session ended for good; the broker notifies the parent unless it reported. */
  async died() {
    await this.#post("/api/peer/died", { key: this.key }).catch(() => {});
  }

  /** The user's answer to a reopen_request. Throws when it did not arrive; a refusal carries the HTTP `status`
   *  (404: the request is not pending any more). */
  async answerReopen(requestId, approved, reason) {
    const r = await this.#post("/api/peer/reopen-answer", { key: this.key, requestId, approved, reason });
    if (r.ok) return;
    const error = await r.json().then((j) => j?.error, () => null);
    throw Object.assign(new Error(error ?? `broker answered ${r.status}`), { status: r.status });
  }

  /** The user's answer to a link_request. Resolves with the broker's `{ result, text }`. Throws when it did not
   *  arrive; a refusal carries the HTTP `status` (404: the request is not pending any more). */
  async answerLink(requestId, approved) {
    const r = await this.#post("/api/peer/link-answer", { key: this.key, requestId, approved });
    if (r.ok) return r.json();
    const error = await r.json().then((j) => j?.error, () => null);
    throw Object.assign(new Error(error ?? `broker answered ${r.status}`), { status: r.status });
  }

  /** The communication log of `key`'s tree: { root, keys, events, peers }. Throws on a non-2xx answer (404: older broker). */
  async fetchComms(key = this.key) {
    const r = await this.#fetch(`/api/comms?${new URLSearchParams({ key })}`);
    if (!r.ok) throw Object.assign(new Error(`broker answered ${r.status}`), { status: r.status });
    return r.json();
  }

  /** The stored text of one communication event, or null when the broker does not know it. */
  async fetchCommsText(id) {
    const r = await this.#fetch(`/api/comms/text?${new URLSearchParams({ id })}`);
    return r.ok ? (await r.json()).text : null;
  }

  /** The broker's link tree (array of links). Throws on a non-2xx answer. */
  async fetchLinks() {
    const r = await this.#fetch("/api/links");
    if (!r.ok) throw new Error(`broker answered ${r.status}`);
    return (await r.json()).links;
  }

  /** The broker's link tree and, per parent key, the count of replies held for approval ({} from an older broker). */
  async fetchLinkState() {
    const r = await this.#fetch("/api/links");
    if (!r.ok) throw new Error(`broker answered ${r.status}`);
    const body = await r.json();
    const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
    return { links: body.links, held: obj(body.held), heldByKind: obj(body.heldByKind) };
  }

  #fetch(p, init) {
    return fetch(this.url + p, init);
  }
  #post(p, body) {
    return this.#fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  async #loop() {
    while (!this.stopped) {
      try {
        await this.#connectOnce();
      } catch (e) {
        if (this.stopped) return;
        if (this.connected) this.log(`relay: disconnected (${e.message})`);
        this.connected = false;
        if (!this.autostarted && this.brokerScript && /ECONNREFUSED|fetch failed/.test(String(e.cause ?? e.message))) {
          this.#autostart();
        }
      }
      if (!this.#skipWait) {
        await new Promise((r) => {
          this.#endWait = r;
          this.#timer = setTimeout(r, this.#delay);
        });
        clearTimeout(this.#timer);
        this.#endWait = null;
      }
      // reconnectNow() set the delay to its base and asked to connect now: no doubling for that pass
      if (this.#skipWait) this.#skipWait = false;
      else this.#delay = Math.min(this.#delay * 2, this.retryMaxMs);
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
    if (this.requestedParent) qs.set("parent", this.requestedParent);
    if (this.alias) qs.set("alias", this.alias);
    if (this.caps?.length) qs.set("caps", this.caps.join(","));
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
          this.requestedParent = null;
          this.#delay = this.retryMs;
          this.#settle(true);
          this.onRegistered?.(payload.name, payload);
        } else if (event === "renamed") {
          const changed = payload.name !== this.name;
          this.name = payload.name;
          if (changed && !this.selfRenaming) this.onRenamed?.(payload.name);
        } else if (event === "session_request") {
          this.onSessionRequest?.(payload);
        } else if (event === "reopen_request") {
          this.onReopenRequest?.(payload);
        } else if (event === "link_request") {
          this.onLinkRequest?.(payload);
        } else if (event === "parent_changed") {
          this.onParentChanged?.(payload);
        } else if (event === "links_changed") {
          this.onLinksChanged?.();
        } else if (event === "comms") {
          this.onComms?.(payload.event);
        } else if (event === "reported") {
          this.onReported?.();
        } else if (event === "message") {
          this.onMessage(payload);
        }
      }
    }
    throw new Error("stream ended");
  }
}
