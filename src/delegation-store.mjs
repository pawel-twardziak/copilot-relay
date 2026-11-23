// Durable parent-child links and the outbox of reports/notices, in $XDG_STATE_HOME/copilot-relay/delegations.json.
// Separate from NameStore, which prunes to 1000 entries: a link or an unacknowledged report must not be pruned.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stateFile } from "./name-store.mjs";

export class DelegationStore {
  constructor(file = process.env.COPILOT_RELAY_DELEGATIONS_FILE ?? stateFile("delegations.json")) {
    this.file = file;
    this.data = { links: {}, outbox: {}, reopens: {} };
    let raw;
    try {
      raw = readFileSync(file, "utf8");
    } catch (e) {
      // only a missing file means "start empty"; any other error must not lead to overwriting unread data
      if (e?.code !== "ENOENT") throw e;
    }
    if (raw !== undefined) {
      try {
        const d = JSON.parse(raw);
        this.data = { links: d.links ?? {}, outbox: d.outbox ?? {}, reopens: d.reopens ?? {} };
        // older files keyed the recipient as parentKey
        for (const i of Object.values(this.data.outbox)) if (i.toKey === undefined) i.toKey = i.parentKey;
      } catch (e) {
        const aside = `${file}.corrupt-${Date.now()}`;
        renameSync(file, aside);
        console.error(`delegation store ${file} is unreadable (${e.message}); kept as ${aside}, starting empty`);
      }
    }
  }

  /** Link a child to its parent; `name` is the child's last known name (for notices after it is gone). */
  link(child, parent, name) {
    const prev = this.data.links[child];
    this.data.links[child] = {
      parent,
      name: name || prev?.name || "",
      reported: prev?.parent === parent ? prev.reported : false,
      ended: prev?.parent === parent ? prev.ended : false,
      createdAt: prev?.createdAt ?? Date.now(),
      ...(prev?.task ? { task: prev.task } : {}),
      ...(prev?.parentDeleted && prev.parent === parent ? { parentDeleted: true } : {}),
      ...(prev?.adopted && prev.parent === parent ? { adopted: true } : {}),
    };
    this.#save();
  }

  /** Write a fresh link made by the user's approval; any previous link of `child` (task, date, flags) is replaced whole. */
  adopt(child, parent, name) {
    this.data.links[child] = { parent, name, reported: false, ended: false, createdAt: Date.now(), adopted: true };
    this.#save();
  }

  /** Delete the child's link only (not its children's links, not queued reports); false when it has none. */
  unlink(child) {
    if (!this.data.links[child]) return false;
    delete this.data.links[child];
    this.#save();
    return true;
  }

  isAdopted(child) {
    return this.data.links[child]?.adopted === true;
  }

  /** Set the task once; false when there is no link or a task is already set. */
  setTask(child, task) {
    const l = this.data.links[child];
    if (!l || l.task) return false;
    l.task = task;
    this.#save();
    return true;
  }

  taskOf(child) {
    return this.data.links[child]?.task ?? "";
  }

  linkOf(child) {
    return this.data.links[child] ?? null;
  }

  allLinks() {
    return Object.entries(this.data.links);
  }

  /** All transitive children, depth-first, siblings by createdAt; cycle-safe; never includes `key`. */
  descendantsOf(key) {
    const seen = new Set([key]);
    const out = [];
    const walk = (k) => {
      const kids = this.allLinks()
        .filter(([, l]) => l.parent === k)
        .sort(([, a], [, b]) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
        .map(([c]) => c);
      for (const c of kids) {
        if (seen.has(c)) continue;
        seen.add(c);
        out.push(c);
        walk(c);
      }
    };
    walk(key);
    return out;
  }

  parentOf(child) {
    return this.data.links[child]?.parent ?? null;
  }

  nameOf(child) {
    return this.data.links[child]?.name ?? "";
  }

  childrenOf(parent) {
    return Object.entries(this.data.links).filter(([, l]) => l.parent === parent).map(([k]) => k);
  }

  markReported(child) {
    const l = this.data.links[child];
    if (!l || l.reported) return;
    l.reported = true;
    this.#save();
  }

  isReported(child) {
    return this.data.links[child]?.reported === true;
  }

  /** True the first time only, so an ended-without-report notice is produced once per child. */
  markEndedNotice(child) {
    const l = this.data.links[child];
    if (!l || l.ended) return false;
    l.ended = true;
    this.#save();
    return true;
  }

  enqueue(item) {
    this.data.outbox[item.id] = item;
    this.#save();
  }

  pending(toKey) {
    return Object.values(this.data.outbox).filter((i) => i.toKey === toKey && !i.awaiting);
  }

  awaitingFor(requestId) {
    return Object.values(this.data.outbox).filter((i) => i.awaiting === requestId);
  }

  /** The user approved the reopen: the held items become deliverable. */
  release(requestId) {
    const items = this.awaitingFor(requestId);
    if (!items.length) return;
    for (const i of items) delete i.awaiting;
    this.#save();
  }

  /** The user rejected the reopen: remove and return the held items. */
  dropAwaiting(requestId) {
    const items = this.awaitingFor(requestId);
    if (!items.length) return [];
    for (const i of items) delete this.data.outbox[i.id];
    this.#save();
    return items;
  }

  addReopen({ requestId, fromKey, targetKey }) {
    this.data.reopens[requestId] = { requestId, fromKey, targetKey };
    this.#save();
  }

  reopensFrom(fromKey) {
    return Object.values(this.data.reopens).filter((r) => r.fromKey === fromKey);
  }

  reopenFor(fromKey, targetKey) {
    return Object.values(this.data.reopens).find((r) => r.fromKey === fromKey && r.targetKey === targetKey) ?? null;
  }

  removeReopen(requestId) {
    if (!this.data.reopens[requestId]) return;
    delete this.data.reopens[requestId];
    this.#save();
  }

  /**
   * The session is gone for good: drop its link, queued items and reopen requests; its children keep `parent` but are
   * orphans. Returns the dropped reopen requests of other senders that targeted it (their senders must be told).
   */
  forget(key) {
    const targeting = [];
    delete this.data.links[key];
    for (const [id, i] of Object.entries(this.data.outbox)) if (i.toKey === key) delete this.data.outbox[id];
    for (const [id, r] of Object.entries(this.data.reopens)) {
      if (r.fromKey !== key && r.targetKey !== key) continue;
      if (r.fromKey !== key) targeting.push(r);
      delete this.data.reopens[id];
    }
    for (const l of Object.values(this.data.links)) if (l.parent === key) l.parentDeleted = true;
    this.#save();
    return targeting;
  }

  remove(id) {
    if (!this.data.outbox[id]) return false;
    delete this.data.outbox[id];
    this.#save();
    return true;
  }

  #save() {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    renameSync(tmp, this.file);
  }
}
