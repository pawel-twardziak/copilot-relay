// Delegated sessions: a parent session asks for a child, the child reports back. Links and undelivered
// reports/notices are durable (DelegationStore); delivery is at-least-once until the parent's app acknowledges.
import { randomUUID } from "node:crypto";
import { relayPrefix } from "./registry.mjs";

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
      prompt:
        `${relayPrefix(child.name, child.cwd)}${text}\n\n` +
        `(Relay note: ${child.name} cannot see your chat output — only your user can. ` +
        `If this message asks you something or expects an answer, reply with the relay send_message tool ` +
        `(relay_send_message), to: "${child.name}"; a summary in your chat does not reach them.)`,
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

  /** A peer registered: redeliver its unacknowledged items, restore its link, and check its children later. */
  attached(key) {
    const peer = this.registry.get(key);
    const parent = this.store.parentOf(key);
    if (peer && parent && !peer.parentKey) peer.parentKey = parent;
    if (peer && parent && peer.name !== this.store.nameOf(key)) this.store.link(key, parent, peer.name);
    for (const item of this.store.pending(key)) this.#deliver(item);
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
    const name = this.registry.get(childKey)?.name || this.store.nameOf(childKey) || "session";
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
