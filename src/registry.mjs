// Peer registry + message routing for the relay broker.
//
// A peer is any Copilot session known to the broker:
//   kind "acp" – spawned by the broker (`copilot --acp`), delivery = new prompt via ACP
//   kind "cli" – a terminal/app session running the copilot-relay extension, delivery = push over SSE
//                (the extension injects it with session.send)
//   kind "mcp" – any MCP client (VS Code, other tools); delivery = mailbox (read_inbox / wait_for_message)
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
// "user" is how messages from a person (relay GUI) are labelled and "relay" is the broker itself;
// a session must not be able to pose as either
const RESERVED = new Set(["user", "relay"]);
export const isReservedName = (name) => RESERVED.has(sanitizeName(name));
const OFFLINE_GRACE_MS = Number(process.env.COPILOT_RELAY_OFFLINE_GRACE_MS ?? 30_000);

/** First lines of a relay prompt: the sender, and the sender's folder when it has one (relative paths resolve against it). */
export const relayPrefix = (name, cwd) => `[from ${name}]\n` + (cwd ? `[folder ${JSON.stringify(cwd)}]\n` : "");

/** The prompt a session gets for `text` sent by another session (`name`, folder `cwd`). */
export const relayPrompt = (name, cwd, text) =>
  `${relayPrefix(name, cwd)}${text}\n\n` +
  `(Relay note: ${name} cannot see your chat output — only your user can. ` +
  `If this message asks you something or expects an answer, reply with the relay send_message tool ` +
  `(relay_send_message), to: "${name}"; a summary in your chat does not reach them.)`;

export const BUDGET_EXHAUSTED = "Not delivered: the relay message budget is exhausted. Finish your work and report to the user.";

export function sanitizeName(s) {
  const n = String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|-+$/g, "")
    .slice(0, 32);
  return n || "session";
}

/** First `len` hex chars of SHA-256 of the peer key: the permanent part of a session's name. */
export const nameSuffix = (key, len = 6) => createHash("sha256").update(key).digest("hex").slice(0, len);

/**
 * Final name `<base>-<suffix>` for `key`: sanitised, an own suffix already present is stripped,
 * reserved bases get "-session", the base is cut so the whole name fits 32 chars.
 * The suffix is 6 hex chars, 8 when `taken(fullName)` reports a collision.
 */
export function uniqueName(wanted, key, taken) {
  let base = sanitizeName(wanted);
  for (const len of [8, 6]) {
    const tail = `-${nameSuffix(key, len)}`;
    if (base.endsWith(tail) && base.length > tail.length) {
      base = base.slice(0, -tail.length);
      break;
    }
  }
  if (RESERVED.has(base)) base = `${base}-session`;
  const build = (len) => `${base.slice(0, 32 - 1 - len).replace(/[-_]+$/, "") || "session"}-${nameSuffix(key, len)}`;
  const six = build(6);
  return taken(six) ? build(8) : six;
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
    /** Hook (fromKey, name, text) => string | null: answer for a message to a relative that is not online. */
    this.offlineRelative = null;
    /** Hook (toKey, prompt) => string: decorates prompts sent to a linked recipient. */
    this.decorate = null;
  }

  /** True when one of the two peers is the parent of the other. */
  isLinked(aKey, bKey) {
    return this.byKey.get(aKey)?.parentKey === bKey || this.byKey.get(bKey)?.parentKey === aKey;
  }

  /** Take one message from the linked pair's budget; false (nothing taken) when it is exhausted. */
  chargePair(parentKey, childKey) {
    const pairKey = `${parentKey}|${childKey}`;
    const remaining = this.pairBudgets.get(pairKey) ?? this.maxPairMessages;
    if (remaining <= 0) return false;
    this.pairBudgets.set(pairKey, remaining - 1);
    return true;
  }

  /** Permanent unique name for `key` based on `wanted`: `<base>-<6 hex of the key hash>` (see uniqueName). */
  freeName(wanted, key) {
    return uniqueName(wanted, key, (n) => this.byName.has(n) && this.byName.get(n).key !== key);
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
    const old = peer.name;
    this.byName.delete(old);
    peer.name = this.freeName(wantedClean, key);
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
    if (!to?.online) {
      // a closed parent/child is queued for the user's reopen approval; others keep today's answers
      const answer = this.offlineRelative?.(fromKey, toName, text);
      if (answer != null) return answer;
      if (!to) return `No session "${toName}". Call list_sessions to see who is online.`;
    }
    if (to === from) return "You cannot message yourself.";
    const linked = this.isLinked(from.key, to.key);
    const [parentKey, childKey] = from.parentKey === to.key ? [to.key, from.key] : [from.key, to.key];
    if (linked ? !this.chargePair(parentKey, childKey) : this.budget <= 0) {
      this.emit("system", { text: `Blocked ${from.name} → ${to.name}: message budget exhausted (waiting for a human prompt).` });
      return BUDGET_EXHAUSTED;
    }
    if (!linked) this.budget--;
    const budget = linked ? this.pairBudgets.get(`${parentKey}|${childKey}`) : this.budget;
    this.emit("message", { from: from.name, to: to.name, fromKey: from.key, toKey: to.key, text, budget });
    const prompt = relayPrompt(from.name, from.cwd, text);
    this.#deliver(to, {
      from: from.name,
      ...(from.cwd ? { fromCwd: from.cwd } : {}),
      human: false,
      text,
      prompt: linked && this.decorate ? this.decorate(to.key, prompt) : prompt,
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
