// Peer registry + message routing for the relay broker.
//
// A peer is any Copilot session known to the broker:
//   kind "acp" – spawned by the broker (`copilot --acp`), delivery = new prompt via ACP
//   kind "cli" – a terminal/app session running the copilot-relay extension, delivery = push over SSE
//                (the extension injects it with session.send)
//   kind "mcp" – any MCP client (VS Code, other tools); delivery = mailbox (read_inbox / wait_for_message)
import { EventEmitter } from "node:events";

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
// "user" is how messages from a person (relay GUI) are labelled and "relay" is the broker itself;
// a session must not be able to pose as either
const RESERVED = new Set(["user", "relay"]);
export const isReservedName = (name) => RESERVED.has(sanitizeName(name));
const OFFLINE_GRACE_MS = Number(process.env.COPILOT_RELAY_OFFLINE_GRACE_MS ?? 30_000);

/** First lines of a relay prompt: the sender, and the sender's folder when it has one (relative paths resolve against it). */
export const relayPrefix = (name, cwd) => `[from ${name}]\n` + (cwd ? `[folder ${JSON.stringify(cwd)}]\n` : "");

export function sanitizeName(s) {
  const n = String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|-+$/g, "")
    .slice(0, 32);
  return n || "session";
}

export class Registry extends EventEmitter {
  constructor({ maxAgentMessages = 12, maxPairMessages = 12 } = {}) {
    super();
    this.byKey = new Map();
    this.byName = new Map();
    this.aliases = new Map(); // alias -> peer key (MCP URL token chosen before the Copilot session ID is known)
    this.maxAgentMessages = maxAgentMessages;
    this.budget = maxAgentMessages;
    this.maxPairMessages = maxPairMessages;
    this.pairBudgets = new Map(); // `${parentKey}|${childKey}` -> remaining messages for a linked pair
  }

  /** True when one of the two peers is the parent of the other. */
  isLinked(aKey, bKey) {
    return this.byKey.get(aKey)?.parentKey === bKey || this.byKey.get(bKey)?.parentKey === aKey;
  }

  #pairKey(aKey, bKey) {
    return this.byKey.get(aKey)?.parentKey === bKey ? `${bKey}|${aKey}` : `${aKey}|${bKey}`;
  }

  /** Pick a free name based on `wanted` (adds -2, -3… on collision). */
  freeName(wanted, key) {
    let base = sanitizeName(wanted);
    if (RESERVED.has(base)) base = `${base}-session`;
    let name = base;
    for (let i = 2; this.byName.has(name) && this.byName.get(name).key !== key; i++) name = `${base.slice(0, 28)}-${i}`;
    return name;
  }

  /**
   * Add or re-attach a peer. Re-attaching (same key) keeps the name and flushes the inbox.
   * @returns peer
   */
  upsert({ key, name, kind, cwd = "", role = "", model = "", push = null, parentKey = null, control = null }) {
    let peer = this.byKey.get(key);
    if (peer) {
      clearTimeout(peer.offlineTimer);
      peer.online = true;
      peer.push = push ?? peer.push;
      peer.parentKey = parentKey ?? peer.parentKey;
      peer.control = control ?? peer.control;
      Object.assign(peer, { cwd: cwd || peer.cwd });
      this.emit("peer_updated", this.describe(peer));
      this.#flush(peer);
      return peer;
    }
    if (name && !NAME_RE.test(name)) name = sanitizeName(name);
    peer = { key, name: this.freeName(name, key), kind, cwd, role, model, push, parentKey, control, inbox: [], waiters: [], online: true };
    this.byKey.set(key, peer);
    this.byName.set(peer.name, peer);
    this.emit("peer_added", this.describe(peer));
    return peer;
  }

  rename(key, wanted) {
    const peer = this.byKey.get(key);
    if (!peer) throw new Error("unknown peer");
    const wantedClean = sanitizeName(wanted);
    if (RESERVED.has(wantedClean)) throw new Error(`Name "${wantedClean}" is reserved.`);
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
    peer.control = null;
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

  setAlias(alias, key) {
    this.aliases.set(alias, key);
  }
  /** Map an MCP `?peer=` value to a peer key (aliases are used by the desktop app). */
  resolve(keyOrAlias) {
    return this.aliases.get(keyOrAlias) ?? keyOrAlias;
  }
  getByName(name) {
    return this.byName.get(name);
  }

  describe(p) {
    return { key: p.key, name: p.name, kind: p.kind, cwd: p.cwd, role: p.role, model: p.model, online: p.online, parentKey: p.parentKey ?? null };
  }
  list() {
    return [...this.byKey.values()].map((p) => this.describe(p));
  }

  /** A human typed something (in session `key`, if known) → agents may talk again; linked pairs containing `key` are refilled too. */
  humanPrompt(key) {
    this.budget = this.maxAgentMessages;
    if (key == null) return;
    for (const p of this.byKey.values()) {
      if (p.parentKey && (p.key === key || p.parentKey === key)) this.pairBudgets.set(`${p.parentKey}|${p.key}`, this.maxPairMessages);
    }
  }

  /** Push a message to an online peer. True only if it was actually pushed. */
  pushTo(key, msg) {
    const peer = this.byKey.get(key);
    if (!peer?.push || !peer.online) return false;
    try {
      return peer.push(msg) !== false;
    } catch {
      return false;
    }
  }

  /** Agent-to-agent message. Returns a human-readable result for the calling tool. */
  send(fromKey, toName, text) {
    const from = this.byKey.get(fromKey);
    if (!from) return "You are not registered with the relay broker.";
    const to = this.byName.get(String(toName).trim().toLowerCase());
    if (!to) return `No session "${toName}". Call list_sessions to see who is online.`;
    if (to === from) return "You cannot message yourself.";
    const linked = this.isLinked(from.key, to.key);
    const pairKey = linked ? this.#pairKey(from.key, to.key) : null;
    const remaining = linked ? (this.pairBudgets.get(pairKey) ?? this.maxPairMessages) : this.budget;
    if (remaining <= 0) {
      this.emit("system", { text: `Blocked ${from.name} → ${to.name}: message budget exhausted (waiting for a human prompt).` });
      return "Not delivered: the relay message budget is exhausted. Finish your work and report to the user.";
    }
    if (linked) this.pairBudgets.set(pairKey, remaining - 1);
    else this.budget--;
    this.emit("message", { from: from.name, to: to.name, fromKey: from.key, toKey: to.key, text, budget: linked ? remaining - 1 : this.budget });
    this.#deliver(to, {
      from: from.name,
      ...(from.cwd ? { fromCwd: from.cwd } : {}),
      human: false,
      text,
      prompt:
        `${relayPrefix(from.name, from.cwd)}${text}\n\n` +
        `(Relay note: ${from.name} cannot see your chat output — only your user can. ` +
        `If this message asks you something or expects an answer, reply with the relay send_message tool ` +
        `(relay_send_message), to: "${from.name}"; a summary in your chat does not reach them.)`,
    });
    const how = to.kind === "mcp" ? "placed in their inbox" : to.online ? "delivered" : "queued (recipient briefly offline)";
    return `Message to ${to.name} ${how}. Their reply will arrive as a new message — do not wait for it.`;
  }

  /** Human message (from GUI) to a peer. */
  sendFromUser(toName, text) {
    const to = this.byName.get(toName);
    if (!to) return false;
    this.humanPrompt(to.key);
    this.emit("message", { from: "user", to: to.name, toKey: to.key, text });
    this.#deliver(to, { from: "user", human: true, text, prompt: text });
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
    peer.inbox.push({ from: msg.from, fromCwd: msg.fromCwd, human: msg.human === true, text: msg.text, prompt: msg.prompt, ts: Date.now() });
    this.emit("peer_updated", this.describe(peer));
    for (const w of peer.waiters.splice(0)) w();
  }

  #flush(peer) {
    if (!peer.push || peer.kind === "mcp") return;
    for (const m of peer.inbox.splice(0)) peer.push(m);
  }
}
