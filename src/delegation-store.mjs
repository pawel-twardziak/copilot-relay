// Durable parent-child links and the outbox of reports/notices, in $XDG_STATE_HOME/copilot-relay/delegations.json.
// Separate from NameStore, which prunes to 1000 entries: a link or an unacknowledged report must not be pruned.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stateFile } from "./name-store.mjs";

export class DelegationStore {
  constructor(file = process.env.COPILOT_RELAY_DELEGATIONS_FILE ?? stateFile("delegations.json")) {
    this.file = file;
    this.data = { links: {}, outbox: {} };
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
        this.data = { links: d.links ?? {}, outbox: d.outbox ?? {} };
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
    };
    this.#save();
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

  pending(parentKey) {
    return Object.values(this.data.outbox).filter((i) => i.parentKey === parentKey);
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
