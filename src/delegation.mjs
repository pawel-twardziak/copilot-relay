// Delegated sessions: a parent session asks for a child, the child reports back. Links and undelivered
// reports/notices are durable (DelegationStore); delivery is at-least-once until the parent's app acknowledges.
import { randomUUID } from "node:crypto";

export class Delegation {
  constructor({ registry, store, sweepDelayMs = 30_000, newId = randomUUID }) {
    this.registry = registry;
    this.store = store;
    this.sweepDelayMs = sweepDelayMs;
    this.newId = newId;
  }

  link(childKey, parentKey) {
    const peer = this.registry.get(childKey);
    this.store.link(childKey, parentKey, peer?.name);
    if (peer) peer.parentKey = parentKey;
  }

  requestCreate(callerKey, { name, task, agent, model }) {
    const peer = this.registry.get(callerKey);
    if (!peer) return "You are not registered with the relay broker.";
    if (peer.parentKey || this.store.parentOf(callerKey)) return "A delegated session cannot create sessions.";
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
      parentKey,
      from: child.name,
      text,
      prompt:
        `[from ${child.name}]\n${text}\n\n` +
        `(Relay note: ${child.name} cannot see your chat output — only your user can. ` +
        `If this message asks you something or expects an answer, reply with the relay send_message tool ` +
        `(relay_send_message), to: "${child.name}"; a summary in your chat does not reach them.)`,
    };
    this.store.enqueue(item); // on disk before any delivery attempt
    this.store.markReported(callerKey);
    this.#deliver(item);
    try {
      child.control?.("reported", {});
    } catch {
      /* the report is stored either way */
    }
    return "Report delivered to your parent session.";
  }

  outcome(parentKey, { kind, text }) {
    const item = { id: this.newId(), parentKey, from: "relay", text, prompt: `[from relay]\n${text}` };
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
    if (!this.store.childrenOf(key).length) return;
    setTimeout(() => this.#sweep(key), this.sweepDelayMs).unref();
  }

  ack(key, id) {
    if (!this.store.pending(key).some((i) => i.id === id)) return false;
    return this.store.remove(id);
  }

  childGone(childKey) {
    if (this.store.isReported(childKey)) return;
    this.#endedNotice(childKey);
  }

  #sweep(parentKey) {
    for (const child of this.store.childrenOf(parentKey)) {
      if (this.store.isReported(child) || this.registry.get(child)?.online) continue;
      this.#endedNotice(child);
    }
  }

  #endedNotice(childKey) {
    const parentKey = this.store.parentOf(childKey);
    if (!parentKey || !this.store.markEndedNotice(childKey)) return;
    const name = this.registry.get(childKey)?.name || this.store.nameOf(childKey) || "session";
    const text = `Session "${name}" ended without reporting a result. You can ask the user to reopen it.`;
    const item = { id: this.newId(), parentKey, from: "relay", text, prompt: `[from relay]\n${text}` };
    this.store.enqueue(item);
    this.#deliver(item);
  }

  #deliver(item) {
    // pushTo, not Registry.send: reports and notices are charged to no budget
    this.registry.pushTo(item.parentKey, {
      from: item.from,
      human: false,
      text: item.text,
      prompt: item.prompt,
      deliveryId: item.id,
      wake: true,
    });
  }
}
