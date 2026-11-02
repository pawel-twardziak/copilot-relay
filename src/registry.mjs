// Peer registry + message routing for the relay broker.
//
// A peer is any Copilot session known to the broker:
//   kind "acp" – spawned by the broker (`copilot --acp`), delivery = new prompt via ACP
//   kind "cli" – a terminal/app session running the copilot-relay extension, delivery = push over SSE
//                (the extension injects it with session.send)
//   kind "mcp" – any MCP client (VS Code, other tools); delivery = mailbox (read_inbox / wait_for_message)
import { EventEmitter } from "node:events";

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const OFFLINE_GRACE_MS = Number(process.env.COPILOT_RELAY_OFFLINE_GRACE_MS ?? 30_000);

export function sanitizeName(s) {
  const n = String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|-+$/g, "")
    .slice(0, 32);
  return n || "session";
}

export class Registry extends EventEmitter {
  constructor({ maxAgentMessages = 12 } = {}) {
    super();
    this.byKey = new Map();
    this.byName = new Map();
    this.maxAgentMessages = maxAgentMessages;
    this.budget = maxAgentMessages;
  }

  /** Pick a free name based on `wanted` (adds -2, -3… on collision). */
  freeName(wanted, key) {
    const base = sanitizeName(wanted);
    let name = base;
    for (let i = 2; this.byName.has(name) && this.byName.get(name).key !== key; i++) name = `${base.slice(0, 28)}-${i}`;
    return name;
  }

  /**
   * Add or re-attach a peer. Re-attaching (same key) keeps the name and flushes the inbox.
   * @returns peer
   */
  upsert({ key, name, kind, cwd = "", role = "", model = "", push = null }) {
    let peer = this.byKey.get(key);
    if (peer) {
      clearTimeout(peer.offlineTimer);
      peer.online = true;
      peer.push = push ?? peer.push;
      Object.assign(peer, { cwd: cwd || peer.cwd });
      this.emit("peer_updated", this.describe(peer));
      this.#flush(peer);
      return peer;
    }
    if (name && !NAME_RE.test(name)) name = sanitizeName(name);
    peer = { key, name: this.freeName(name, key), kind, cwd, role, model, push, inbox: [], waiters: [], online: true };
    this.byKey.set(key, peer);
    this.byName.set(peer.name, peer);
    this.emit("peer_added", this.describe(peer));
    return peer;
  }

  rename(key, wanted) {
    const peer = this.byKey.get(key);
    if (!peer) throw new Error("unknown peer");
    const wantedClean = sanitizeName(wanted);
    if (this.byName.has(wantedClean) && this.byName.get(wantedClean) !== peer)
      throw new Error(`Name "${wantedClean}" is taken.`);
    const old = peer.name;
    this.byName.delete(old);
    peer.name = wantedClean;
    this.byName.set(peer.name, peer);
    this.emit("peer_renamed", { old, ...this.describe(peer) });
    return peer.name;
  }

  setRole(key, role) {
    const peer = this.byKey.get(key);
    if (!peer) return;
    peer.role = role;
    this.emit("peer_updated", this.describe(peer));
  }

  /** Mark a push-connected peer offline; it is removed if it doesn't come back within the grace period. */
  disconnect(key) {
    const peer = this.byKey.get(key);
    if (!peer) return;
    peer.online = false;
    peer.push = null;
    this.emit("peer_updated", this.describe(peer));
    peer.offlineTimer = setTimeout(() => this.remove(key, "timeout"), OFFLINE_GRACE_MS);
  }

  /** @param {"user"|"timeout"|"exited"|"closed"} [reason] */
  remove(key, reason = "closed") {
    const peer = this.byKey.get(key);
    if (!peer) return false;
    clearTimeout(peer.offlineTimer);
    this.byKey.delete(key);
    if (this.byName.get(peer.name) === peer) this.byName.delete(peer.name);
    for (const w of peer.waiters) w(null);
    this.emit("peer_removed", { name: peer.name, key, kind: peer.kind, reason });
    return true;
  }

  get(key) {
    return this.byKey.get(key);
  }
  getByName(name) {
    return this.byName.get(name);
  }

  describe(p) {
    return { key: p.key, name: p.name, kind: p.kind, cwd: p.cwd, role: p.role, model: p.model, online: p.online };
  }
  list() {
    return [...this.byKey.values()].map((p) => this.describe(p));
  }

  /** A human typed something somewhere → agents may talk again. */
  humanPrompt() {
    this.budget = this.maxAgentMessages;
  }

  /** Agent-to-agent message. Returns a human-readable result for the calling tool. */
  send(fromKey, toName, text) {
    const from = this.byKey.get(fromKey);
    if (!from) return "You are not registered with the relay broker.";
    const to = this.byName.get(String(toName).trim().toLowerCase());
    if (!to) return `No session "${toName}". Call list_sessions to see who is online.`;
    if (to === from) return "You cannot message yourself.";
    if (this.budget <= 0) {
      this.emit("system", { text: `Blocked ${from.name} → ${to.name}: message budget exhausted (waiting for a human prompt).` });
      return "Not delivered: the relay message budget is exhausted. Finish your work and report to the user.";
    }
    this.budget--;
    this.emit("message", { from: from.name, to: to.name, fromKey: from.key, toKey: to.key, text, budget: this.budget });
    this.#deliver(to, {
      from: from.name,
      text,
      prompt:
        `[from ${from.name}]\n${text}\n\n` +
        `(Relay note: ${from.name} cannot see your chat output. If a reply is needed, ` +
        `send it with the relay send_message tool (relay_send_message), to: "${from.name}".)`,
    });
    const how = to.kind === "mcp" ? "placed in their inbox" : to.online ? "delivered" : "queued (recipient briefly offline)";
    return `Message to ${to.name} ${how}. Their reply will arrive as a new message — do not wait for it.`;
  }

  /** Human message (from GUI) to a peer. */
  sendFromUser(toName, text) {
    const to = this.byName.get(toName);
    if (!to) return false;
    this.humanPrompt();
    this.emit("message", { from: "user", to: to.name, toKey: to.key, text });
    this.#deliver(to, { from: "user", text, prompt: text });
    return true;
  }

  /** Pop all inbox messages (for mcp peers). */
  drain(key) {
    const peer = this.byKey.get(key);
    if (!peer) return [];
    return peer.inbox.splice(0);
  }

  /** Resolve with inbox messages, waiting up to timeoutMs for the first one. */
  waitForMessages(key, timeoutMs) {
    const peer = this.byKey.get(key);
    if (!peer) return Promise.resolve([]);
    if (peer.inbox.length) return Promise.resolve(peer.inbox.splice(0));
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        peer.waiters = peer.waiters.filter((w) => w !== waiter);
        resolve(peer.inbox.splice(0));
      };
      const waiter = done;
      const t = setTimeout(done, timeoutMs);
      peer.waiters.push(waiter);
    });
  }

  #deliver(peer, msg) {
    if (peer.push && peer.online) {
      try {
        if (peer.push(msg) !== false) return;
      } catch {
        /* fall through to inbox */
      }
    }
    peer.inbox.push({ from: msg.from, text: msg.text, prompt: msg.prompt, ts: Date.now() });
    this.emit("peer_updated", this.describe(peer));
    for (const w of peer.waiters.splice(0)) w();
  }

  #flush(peer) {
    if (!peer.push || peer.kind === "mcp") return;
    for (const m of peer.inbox.splice(0)) peer.push(m);
  }
}
