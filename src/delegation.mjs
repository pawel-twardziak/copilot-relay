// Delegated sessions: a parent session asks for a child, the child reports back. Links and undelivered
// reports/notices are durable (DelegationStore); delivery is at-least-once until the parent's app acknowledges.
import { randomUUID } from "node:crypto";
import { BUDGET_EXHAUSTED, relayPrompt } from "./registry.mjs";

// replies of adopt_session / release_session and the notices of their outcome
const LINK = {
  sent: "The user was asked to approve it. The outcome arrives as a message from relay. Do not wait for it.",
  notRegistered: "You are not registered with the relay broker.",
  noApp: "Your app connection is not connected, so the user cannot be asked now.",
  oldApp: "The desktop app is older than the relay broker and cannot show the approval card. Update the app.",
  noTarget: (name) => `No open session "${name}". Call list_sessions to see who is online.`,
  self: "You cannot adopt yourself.",
  notApp: (name) => `"${name}" is not a desktop-app session, so it cannot be adopted.`,
  already: (name) => `"${name}" is already your child.`,
  hasParent: (name, parent) => `"${name}" already has a parent ("${parent}"). It must be released first.`,
  cycle: (name) => `"${name}" is one of your ancestors, so it cannot become your child.`,
  closedNow: (name) => `Session "${name}" is closed now. Open it and ask again.`,
  notChild: (name) => `"${name}" is not one of your children.`,
  linkedParent: (child) => `Session "${child}" is now your child. It can send you results with report_result.`,
  linkedChild: (parent) => `The user made this session a child of "${parent}". Send it results with the report_result tool.`,
  releasedParent: (child) => `Session "${child}" is no longer your child.`,
  releasedChild: (parent) => `The user ended the link to "${parent}". You no longer report to it.`,
  rejected: (kind, child) => `The user rejected the request to ${kind === "adopt" ? "link" : "release"} "${child}".`,
  reopenDropped: (target) => `The link to "${target}" was ended; your queued message was not delivered.`,
};

export class Delegation {
  #listeners = [];
  /** Link requests waiting for the user's answer, in memory only: requestId -> { requestId, kind, parentKey, childKey }. */
  #linkRequests = new Map();

  /** `nameOf`: last known name of a session that has no stored link name (e.g. a root parent), or undefined. */
  constructor({ registry, store, newId = randomUUID, nameOf = () => undefined }) {
    this.registry = registry;
    this.store = store;
    this.newId = newId;
    this.nameOf = nameOf;
    // a renamed child keeps its new name in the link, so it is shown under it once it is closed
    registry.on("peer_renamed", (ev) => {
      const link = ev?.key && ev.name ? this.store.linkOf(ev.key) : null;
      if (link && link.name !== ev.name) this.store.link(ev.key, link.parent, ev.name);
    });
    // a session that left the registry cannot be adopted any more (an unlinked delete is not reported as a forget);
    // a release request stays: its child may be closed and its parent may come back
    registry.on("peer_removed", (ev) => {
      if (ev?.key) this.#dropLinkRequests((r) => r.kind === "adopt" && (r.parentKey === ev.key || r.childKey === ev.key));
    });
    for (const ev of ["peer_added", "peer_updated", "peer_removed", "peer_renamed"]) registry.on(ev, () => this.#changed());
  }

  /** Register a listener called after any link/state change (throws are swallowed). */
  onChange(fn) {
    this.#listeners.push(fn);
  }

  #changed() {
    for (const fn of this.#listeners) {
      try {
        fn();
      } catch {
        /* a listener must not break the broker */
      }
    }
  }

  link(childKey, parentKey) {
    const peer = this.registry.get(childKey);
    this.store.link(childKey, parentKey, peer?.name);
    if (peer) peer.parentKey = parentKey;
    this.#changed();
  }

  setTask(childKey, task) {
    const ok = this.store.setTask(childKey, task);
    if (ok) this.#changed();
    return ok;
  }

  /** The session is gone for good: drop everything stored about it. */
  forget(key) {
    this.#forget(key);
    this.#changed();
  }

  /**
   * store.forget, and every other sender whose reopen request of `key` it drops is told its message was not delivered.
   * The pending link requests that name `key` are dropped.
   */
  #forget(key) {
    const name = this.#nameOf(key);
    this.#dropLinkRequests((r) => r.parentKey === key || r.childKey === key);
    for (const r of this.store.forget(key)) this.#notDelivered(r.fromKey, name);
  }

  #notDelivered(toKey, targetName) {
    this.#notice(toKey, `The user did not reopen "${targetName}"; your message was not delivered.`);
  }

  /** A durable notice from relay that wakes `toKey`: stored until acknowledged, delivered now if it is online. */
  #notice(toKey, text) {
    const item = { id: this.newId(), toKey, from: "relay", text, prompt: `[from relay]\n${text}` };
    this.store.enqueue(item);
    this.#deliver(item);
  }

  /** A notice from relay for an open session that does not wake it and is not stored. */
  #inform(toKey, text) {
    this.registry.pushTo(toKey, { from: "relay", human: false, text, prompt: this.decorate(toKey, `[from relay]\n${text}`), wake: false });
  }

  /** The parent key to deliver to, or null when there is none or it was deleted. */
  #liveParent(childKey) {
    const link = this.store.linkOf(childKey);
    return link?.parent && !link.parentDeleted ? link.parent : null;
  }

  setBusy(key, busy) {
    const peer = this.registry.get(key);
    if (!peer) return;
    peer.busy = !!busy;
    this.#changed();
  }

  isRelative(a, b) {
    return this.store.parentOf(a) === b || this.store.parentOf(b) === a;
  }

  snapshot() {
    return this.store.allLinks().map(([key, l]) => {
      const peer = this.registry.get(key);
      return {
        key,
        parent: l.parent,
        name: peer?.name ?? l.name ?? "",
        task: l.task ?? "",
        createdAt: l.createdAt,
        reported: !!l.reported,
        parentDeleted: !!l.parentDeleted,
        adopted: l.adopted === true,
        online: !!peer?.online,
        busy: peer?.busy === true,
      };
    });
  }

  /** The caller's children and parent, for the model. "" when it has no relatives. */
  familyBlock(key) {
    const kids = this.store.childrenOf(key);
    const link = this.store.linkOf(key);
    const lines = [];
    if (kids.length) {
      lines.push(`Your children (${kids.length}) — names are current; a closed child can still be messaged (the user is asked to reopen it):`);
      for (const k of kids) {
        const peer = this.registry.get(k);
        const open = !!peer?.online;
        const state = [open ? (peer.busy === true ? "open, working" : "open, idle") : "closed"];
        if (this.store.isReported(k)) state.push("reported");
        const first = (this.store.taskOf(k) || "").trim().split(/\r?\n/)[0];
        const task = !first ? (this.store.isAdopted(k) ? "adopted, no task" : "task: (task not recorded)") : `task: ${first.length > 120 ? `${first.slice(0, 120)}…` : first}`;
        const n = this.store.childrenOf(k).length;
        lines.push(`- "${this.#nameOf(k)}" — ${state.join(", ")} — ${task}${n ? ` [has ${n} children]` : ""}`);
      }
    }
    if (link?.parent) {
      const parent = this.registry.get(link.parent);
      const state = link.parentDeleted ? "deleted" : parent?.online ? "open" : "closed";
      lines.push(`Your parent: "${this.#nameOf(link.parent)}" — ${state}`);
    }
    return lines.join("\n");
  }

  decorate(toKey, prompt) {
    const block = this.familyBlock(toKey);
    return block ? `${prompt}\n\n${block}` : prompt;
  }

  requestCreate(callerKey, { name, task, agent, model }) {
    const peer = this.registry.get(callerKey);
    if (!peer) return "You are not registered with the relay broker.";
    if (!peer.control) return "Your app connection is not connected, so a session cannot be requested now.";
    const requestId = this.newId();
    try {
      peer.control("session_request", { requestId, name, task, agent, model });
    } catch {
      return "Your app connection is not connected, so a session cannot be requested now.";
    }
    return `Request ${requestId} sent; the user must approve it. The outcome arrives as a message from relay. Do not wait for it.`;
  }

  report(callerKey, text) {
    const child = this.registry.get(callerKey);
    if (child && this.store.linkOf(callerKey)?.parentDeleted) return "Your parent session was deleted, so there is no one to report to.";
    const parentKey = this.#liveParent(callerKey);
    if (!child || !parentKey) return "You are not a delegated session, so there is no one to report to.";
    if (this.store.isReported(callerKey)) return "You have already reported. Use send_message for further exchanges.";
    const item = {
      id: this.newId(),
      toKey: parentKey,
      from: child.name,
      ...(child.cwd ? { fromCwd: child.cwd } : {}),
      text,
      prompt: relayPrompt(child.name, child.cwd, text),
    };
    this.store.enqueue(item); // on disk before any delivery attempt
    this.store.markReported(callerKey);
    this.#changed();
    const delivered = this.#deliver(item);
    try {
      child.control?.("reported", {});
    } catch {
      /* the report is stored either way */
    }
    return delivered
      ? "Report delivered to your parent session."
      : "Report stored. Your parent session will receive it when it returns.";
  }

  outcome(parentKey, { kind, text }) {
    if (kind === "created") this.#inform(parentKey, text);
    else this.#notice(parentKey, text);
  }

  /**
   * A message from `fromKey` to `name`, which is not online: when it names the sender's parent or a direct child,
   * queue it until the user approves reopening that session (one request per pair). Null when no relative matches.
   */
  messageClosed(fromKey, name, text) {
    const from = this.registry.get(fromKey);
    if (!from) return null;
    const wanted = String(name).trim();
    // a deleted parent stays in the link (as an orphan marker) but cannot be reopened
    const parent = this.store.linkOf(fromKey)?.parentDeleted ? null : this.store.parentOf(fromKey);
    const targetKey = [...(parent ? [parent] : []), ...this.store.childrenOf(fromKey)].find(
      (k) => !this.registry.get(k)?.online && this.#answersTo(k, wanted),
    );
    if (!targetKey) return null;
    const targetName = this.#nameOf(targetKey);
    const noApp = `Session "${targetName}" is closed and you have no app connection to ask the user to reopen it.`;
    if (!from.control || !from.app) return noApp; // a Terminal (extension) stream cannot show the card
    const [parentKey, childKey] = targetKey === parent ? [targetKey, fromKey] : [fromKey, targetKey];
    if (!this.registry.chargePair(parentKey, childKey)) return BUDGET_EXHAUSTED;
    const existing = this.store.reopenFor(fromKey, targetKey);
    const reopen = existing ?? { requestId: this.newId(), fromKey, targetKey };
    const item = {
      id: this.newId(),
      toKey: targetKey,
      from: from.name,
      ...(from.cwd ? { fromCwd: from.cwd } : {}),
      text,
      prompt: relayPrompt(from.name, from.cwd, text),
      awaiting: reopen.requestId,
    };
    this.store.enqueue(item); // on disk before the user is asked
    if (!existing) this.store.addReopen(reopen);
    if (!this.#askReopen(reopen)) {
      this.store.remove(item.id);
      if (!existing) this.store.removeReopen(reopen.requestId);
      return noApp;
    }
    this.#changed();
    return `Session "${targetName}" is closed. The user was asked to reopen it; your message is queued and will be delivered if they approve. Do not wait for it.`;
  }

  /**
   * The user answered the sender's reopen request. Approved: the queued messages become deliverable (now, if the
   * target is already open). Rejected, or `reason: "missing"` (the target no longer exists; its link is forgotten):
   * the messages are dropped and the sender is told. False when the sender has no such request.
   */
  answerReopen(fromKey, requestId, approved, reason) {
    const reopen = this.store.reopensFrom(fromKey).find((r) => r.requestId === requestId);
    if (!reopen) return false;
    const targetName = this.#nameOf(reopen.targetKey);
    if (approved && reason !== "missing") {
      const items = this.store.awaitingFor(requestId);
      this.store.release(requestId);
      for (const item of items) this.#deliver(item);
    } else {
      this.store.dropAwaiting(requestId);
      this.store.removeReopen(requestId); // before a forget, which tells the other senders of the same target
      if (reason === "missing") this.#forget(reopen.targetKey);
      this.#notDelivered(fromKey, targetName);
    }
    this.store.removeReopen(requestId);
    this.#changed();
    return true;
  }

  /** Emit the reopen card for `reopen` on its sender's control stream; false when that is not possible. */
  #askReopen({ requestId, fromKey, targetKey }) {
    const from = this.registry.get(fromKey);
    if (!from?.control || !from.app) return false;
    const previews = this.store.awaitingFor(requestId).map((i) => (i.text.length > 200 ? `${i.text.slice(0, 200)}…` : i.text));
    try {
      from.control("reopen_request", { requestId, targetKey, targetName: this.#nameOf(targetKey), fromName: from.name, previews });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * adopt_session / release_session: `callerKey` asks to make the session `name` its child, or to end the link to its
   * direct child `name`. Nothing changes until the user answers the card emitted on the caller's control stream
   * (answerLink). Returns the reply for the model: a refusal, or that the user was asked. Never the requestId.
   */
  requestLink(callerKey, kind, name) {
    const wanted = String(name ?? "").trim();
    const childKey =
      kind === "adopt"
        ? this.registry.getByName(wanted.toLowerCase())?.key
        : this.store.childrenOf(callerKey).find((k) => this.#answersTo(k, wanted));
    const refusal = this.#linkRefusal(kind, callerKey, childKey, kind === "adopt" ? LINK.noTarget(wanted) : LINK.notChild(wanted));
    if (refusal) return refusal;
    const existing = [...this.#linkRequests.values()].find((r) => r.kind === kind && r.parentKey === callerKey && r.childKey === childKey);
    const request = existing ?? { requestId: this.newId(), kind, parentKey: callerKey, childKey };
    if (!this.#askLink(request)) return LINK.noApp;
    this.#linkRequests.set(request.requestId, request);
    return LINK.sent;
  }

  /**
   * The user answered the card of `parentKey`'s link request. Approved requests are validated again and only then
   * change the link. Null when `parentKey` has no such request; otherwise the request is gone and the parent was told.
   */
  answerLink(parentKey, requestId, approved) {
    const request = this.#linkRequests.get(requestId);
    if (!request || request.parentKey !== parentKey) return null;
    this.#linkRequests.delete(requestId);
    const { kind, childKey } = request;
    const childName = this.#nameOf(childKey);
    if (approved !== true) {
      const text = LINK.rejected(kind, childName);
      this.#notice(parentKey, text);
      return { result: "rejected", text };
    }
    const refusal = this.#linkRefusal(kind, parentKey, childKey, kind === "adopt" ? LINK.closedNow(childName) : LINK.notChild(childName));
    if (refusal) {
      this.#notice(parentKey, refusal);
      return { result: "refused", text: refusal };
    }
    return kind === "adopt" ? this.#adopt(parentKey, childKey) : this.#release(parentKey, childKey);
  }

  /**
   * Why `parentKey` cannot adopt or release `childKey` now, or null. Used when the tool is called and again when the
   * card is approved. `missing`: the refusal when `childKey` is not an open session (adopt) or not a direct child
   * (release); `childKey` is undefined when the tool's name matched nothing.
   */
  #linkRefusal(kind, parentKey, childKey, missing) {
    const parent = this.registry.get(parentKey);
    if (!parent) return LINK.notRegistered;
    if (!parent.control || !parent.app) return LINK.noApp; // a Terminal (extension) stream cannot show the card
    if (!parent.linkCards) return LINK.oldApp;
    if (kind === "release") {
      const link = this.store.linkOf(childKey);
      return link?.parent === parentKey && !link.parentDeleted ? null : missing;
    }
    const child = this.registry.get(childKey);
    if (!child?.online) return missing;
    if (childKey === parentKey) return LINK.self;
    if (!child.app) return LINK.notApp(child.name);
    const current = this.#liveParent(childKey); // an orphan (deleted parent) can be adopted
    if (current === parentKey) return LINK.already(child.name);
    if (current) return LINK.hasParent(child.name, this.#nameOf(current));
    if (this.#isAncestor(childKey, parentKey)) return LINK.cycle(child.name);
    return null;
  }

  /** True when `ancestor` is above `key` in the tree; the walk ends at a root or a deleted parent and is cycle-safe. */
  #isAncestor(ancestor, key) {
    const seen = new Set([key]);
    for (let link = this.store.linkOf(key); link && !link.parentDeleted && !seen.has(link.parent); link = this.store.linkOf(link.parent)) {
      if (link.parent === ancestor) return true;
      seen.add(link.parent);
    }
    return false;
  }

  /** Emit the link card for `request` on its parent's control stream; false when that is not possible. */
  #askLink({ requestId, kind, parentKey, childKey }) {
    const parent = this.registry.get(parentKey);
    if (!parent?.control || !parent.app || !parent.linkCards) return false;
    try {
      parent.control("link_request", {
        requestId,
        kind,
        childKey,
        childName: this.#nameOf(childKey),
        childCwd: this.registry.get(childKey)?.cwd ?? "",
        parentName: parent.name,
        task: kind === "release" ? this.store.taskOf(childKey) : "",
      });
      return true;
    } catch {
      return false;
    }
  }

  #dropLinkRequests(matches) {
    for (const [id, request] of this.#linkRequests) if (matches(request)) this.#linkRequests.delete(id);
  }

  /** The approved adopt: a fresh link, the child's stream follows, the parent is woken and the child only told. */
  #adopt(parentKey, childKey) {
    const child = this.registry.get(childKey); // online: checked by #linkRefusal
    this.store.adopt(childKey, parentKey, child.name);
    child.parentKey = parentKey;
    this.#emit(child, "parent_changed", { parentKey, adopted: true });
    this.#changed();
    const text = LINK.linkedParent(child.name);
    this.#notice(parentKey, text);
    this.#inform(childKey, LINK.linkedChild(this.#nameOf(parentKey)));
    return { result: "linked", text };
  }

  /**
   * The approved release: the child becomes a root and keeps its children and the reports it sent; the reopen
   * requests between the two are dropped (their senders are told), and so is the pair's budget.
   */
  #release(parentKey, childKey) {
    const childName = this.#nameOf(childKey); // before the link (and its stored name) is gone
    const parentName = this.#nameOf(parentKey);
    const dropped = [this.store.reopenFor(parentKey, childKey), this.store.reopenFor(childKey, parentKey)].filter(Boolean);
    for (const reopen of dropped) {
      this.store.dropAwaiting(reopen.requestId);
      this.store.removeReopen(reopen.requestId);
    }
    this.store.unlink(childKey);
    const child = this.registry.get(childKey);
    if (child) child.parentKey = null;
    this.registry.dropPair(parentKey, childKey);
    this.#emit(child, "parent_changed", { parentKey: null, adopted: false });
    this.#changed();
    for (const reopen of dropped) this.#notice(reopen.fromKey, LINK.reopenDropped(reopen.fromKey === parentKey ? childName : parentName));
    const text = LINK.releasedParent(childName);
    this.#notice(parentKey, text);
    this.#inform(childKey, LINK.releasedChild(parentName));
    return { result: "released", text };
  }

  /** A control event for `peer`'s stream, if it has one; a closed stream must not stop the change. */
  #emit(peer, event, payload) {
    try {
      peer?.control?.(event, payload);
    } catch {
      /* the change is made either way */
    }
  }

  /** True when `key`'s registry name, stored link name or last known name is `wanted` (case-insensitive). */
  #answersTo(key, wanted) {
    const w = wanted.toLowerCase();
    return [this.registry.get(key)?.name, this.store.nameOf(key), this.nameOf(key)].some((n) => n && n.toLowerCase() === w);
  }

  #nameOf(key) {
    return this.registry.get(key)?.name || this.store.nameOf(key) || this.nameOf(key) || "session";
  }

  /**
   * A peer registered: redeliver its unacknowledged items, restore its link, re-ask its pending reopen requests and
   * the link requests it is the parent of.
   */
  attached(key) {
    const peer = this.registry.get(key);
    const parent = this.store.parentOf(key);
    if (peer && parent && !peer.parentKey) peer.parentKey = parent;
    if (peer && parent && peer.name !== this.store.nameOf(key)) this.store.link(key, parent, peer.name);
    for (const item of this.store.pending(key)) this.#deliver(item);
    for (const reopen of this.store.reopensFrom(key)) this.#askReopen(reopen);
    for (const request of this.#linkRequests.values()) if (request.parentKey === key) this.#askLink(request);
    this.#changed();
  }

  ack(key, id) {
    if (!this.store.pending(key).some((i) => i.id === id)) return false;
    return this.store.remove(id);
  }

  /**
   * The child's session ended for good (decided by the caller): notify the parent once, unless it reported or was
   * adopted (an adopted child was given no task, so it owes no report).
   */
  died(childKey) {
    if (this.store.isReported(childKey) || this.store.isAdopted(childKey)) return;
    this.#endedNotice(childKey);
  }

  #endedNotice(childKey) {
    const parentKey = this.#liveParent(childKey); // nothing is queued for a deleted parent
    if (!parentKey || !this.store.markEndedNotice(childKey)) return;
    this.#notice(parentKey, `Session "${this.#nameOf(childKey)}" ended without reporting a result. You can ask the user to reopen it.`);
  }

  #deliver(item) {
    // pushTo, not Registry.send: reports and notices are charged to no budget
    return this.registry.pushTo(item.toKey, {
      from: item.from,
      ...(item.fromCwd ? { fromCwd: item.fromCwd } : {}),
      human: false,
      text: item.text,
      prompt: this.decorate(item.toKey, item.prompt),
      deliveryId: item.id,
      wake: true,
    });
  }
}
