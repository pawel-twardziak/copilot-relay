// Delegated sessions: a parent session asks for a child, the child reports back. Links and undelivered
// reports/notices are durable (DelegationStore); delivery is at-least-once until the parent's app acknowledges.
import { randomUUID } from "node:crypto";
import { BUDGET_EXHAUSTED, relayPrompt } from "./registry.mjs";

export class Delegation {
  #listeners = [];

  constructor({ registry, store, newId = randomUUID }) {
    this.registry = registry;
    this.store = store;
    this.newId = newId;
    for (const ev of ["peer_added", "peer_updated", "peer_removed"]) registry.on(ev, () => this.#changed());
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
        const first = (this.store.taskOf(k) || "").split("\n")[0];
        const task = !first ? "(task not recorded)" : first.length > 120 ? `${first.slice(0, 120)}…` : first;
        const n = this.store.childrenOf(k).length;
        lines.push(`- "${peer?.name || this.store.nameOf(k) || "session"}" — ${state.join(", ")} — task: ${task}${n ? ` [has ${n} children]` : ""}`);
      }
    }
    if (link?.parent) {
      const parent = this.registry.get(link.parent);
      const state = link.parentDeleted ? "deleted" : parent?.online ? "open" : "closed";
      lines.push(`Your parent: "${parent?.name || this.store.nameOf(link.parent) || "session"}" — ${state}`);
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
    const parentKey = this.store.parentOf(callerKey);
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
    const item = { id: this.newId(), toKey: parentKey, from: "relay", text, prompt: `[from relay]\n${text}` };
    if (kind === "created") {
      this.registry.pushTo(parentKey, { from: "relay", human: false, text, prompt: item.prompt, wake: false });
      return;
    }
    this.store.enqueue(item);
    this.#deliver(item);
  }

  /**
   * A message from `fromKey` to `name`, which is not online: when it names the sender's parent or a direct child,
   * queue it until the user approves reopening that session (one request per pair). Null when no relative matches.
   */
  messageClosed(fromKey, name, text) {
    const from = this.registry.get(fromKey);
    if (!from) return null;
    const wanted = String(name).trim().toLowerCase();
    const parent = this.store.parentOf(fromKey);
    const targetKey = [...(parent ? [parent] : []), ...this.store.childrenOf(fromKey)].find(
      (k) => !this.registry.get(k)?.online && [this.registry.get(k)?.name, this.store.nameOf(k)].some((n) => n && n.toLowerCase() === wanted),
    );
    if (!targetKey) return null;
    const targetName = this.#nameOf(targetKey);
    const noApp = `Session "${targetName}" is closed and you have no app connection to ask the user to reopen it.`;
    if (!from.control) return noApp;
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
      if (reason === "missing") this.store.forget(reopen.targetKey);
      const text = `The user did not reopen "${targetName}"; your message was not delivered.`;
      const item = { id: this.newId(), toKey: fromKey, from: "relay", text, prompt: `[from relay]\n${text}` };
      this.store.enqueue(item);
      this.#deliver(item);
    }
    this.store.removeReopen(requestId);
    this.#changed();
    return true;
  }

  /** Emit the reopen card for `reopen` on its sender's control stream; false when that is not possible. */
  #askReopen({ requestId, fromKey, targetKey }) {
    const from = this.registry.get(fromKey);
    if (!from?.control) return false;
    const previews = this.store.awaitingFor(requestId).map((i) => (i.text.length > 200 ? `${i.text.slice(0, 200)}…` : i.text));
    try {
      from.control("reopen_request", { requestId, targetKey, targetName: this.#nameOf(targetKey), fromName: from.name, previews });
      return true;
    } catch {
      return false;
    }
  }

  #nameOf(key) {
    return this.registry.get(key)?.name || this.store.nameOf(key) || "session";
  }

  /** A peer registered: redeliver its unacknowledged items, restore its link, re-ask its pending reopen requests. */
  attached(key) {
    const peer = this.registry.get(key);
    const parent = this.store.parentOf(key);
    if (peer && parent && !peer.parentKey) peer.parentKey = parent;
    if (peer && parent && peer.name !== this.store.nameOf(key)) this.store.link(key, parent, peer.name);
    for (const item of this.store.pending(key)) this.#deliver(item);
    for (const reopen of this.store.reopensFrom(key)) this.#askReopen(reopen);
    this.#changed();
  }

  ack(key, id) {
    if (!this.store.pending(key).some((i) => i.id === id)) return false;
    return this.store.remove(id);
  }

  /** The child's session ended for good (decided by the caller): notify the parent once, unless it reported. */
  died(childKey) {
    if (this.store.isReported(childKey)) return;
    this.#endedNotice(childKey);
  }

  #endedNotice(childKey) {
    const parentKey = this.store.parentOf(childKey);
    if (!parentKey || !this.store.markEndedNotice(childKey)) return;
    const name = this.#nameOf(childKey);
    const text = `Session "${name}" ended without reporting a result. You can ask the user to reopen it.`;
    const item = { id: this.newId(), toKey: parentKey, from: "relay", text, prompt: `[from relay]\n${text}` };
    this.store.enqueue(item);
    this.#deliver(item);
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
