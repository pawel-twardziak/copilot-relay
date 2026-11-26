// Held messages (from a child, the parent, another session, a person) wait for the user's approval. Small pieces for the
// main process: the per-session, per-kind switches (default on, only "off" is stored) and the cache of marked messages that
// are not yet acknowledged to the broker, so a window that reopens a session can show them again.
import { jsonFileMap } from "./json-file-map.mjs";

export const HELD_KINDS = ["child", "parent", "other", "user"];

/** The held kind of a delivered message: "child" for fromChild, a valid heldAs as itself, else null. */
export function heldKind(m) {
  if (m?.fromChild === true) return "child";
  return HELD_KINDS.includes(m?.heldAs) ? m.heldAs : null;
}

/** The kinds that are off in one stored entry: `false` (v0.22 to v0.24) is child off, an object lists the off kinds. */
const offKinds = (entry) => {
  if (entry === false) return new Set(["child"]);
  if (entry && typeof entry === "object" && !Array.isArray(entry)) return new Set(HELD_KINDS.filter((k) => entry[k] === false));
  return new Set();
};
/** The stored form of a set of off kinds: nothing, `false` for child alone (readable by older versions), or an object. */
const entryOf = (off) => {
  if (off.size === 0) return undefined;
  if (off.size === 1 && off.has("child")) return false;
  return Object.fromEntries(HELD_KINDS.filter((k) => off.has(k)).map((k) => [k, false]));
};

/** Per-session, per-kind hold switches in a small JSON file ({ [sessionId]: false | { [kind]: false } }); no entry
 *  means on. `set` throws on an unknown kind or when the file can't be written; `copy` and `delete` are bookkeeping
 *  after a fork / delete that already succeeded, so a failed write there is only logged. */
export function createHoldStore(file) {
  const { read, write, bestEffort } = jsonFileMap(file, "held-replies");
  const store = (id, off) => {
    const data = read();
    const entry = entryOf(off);
    if (entry === undefined) {
      if (!(id in data)) return;
      delete data[id];
    } else data[id] = entry;
    write(data);
  };
  return {
    get(id) {
      const off = offKinds(read()[id]);
      return Object.fromEntries(HELD_KINDS.map((k) => [k, !off.has(k)]));
    },
    set(id, kind, on) {
      if (!HELD_KINDS.includes(kind)) throw new Error(`unknown held kind: ${kind}`);
      const off = offKinds(read()[id]);
      if (on === false) off.add(kind);
      else off.delete(kind);
      store(id, off);
    },
    delete: (id) => bestEffort(() => store(id, new Set())),
    copy: (fromId, toId) => bestEffort(() => store(toId, offKinds(read()[fromId]))),
  };
}

/** Marked messages per session, in arrival order, until acknowledged or dropped. */
export function createHeldCache() {
  const bySession = new Map();
  return {
    /** false when a message with this deliveryId is already cached (the broker redelivered it) */
    add(sessionId, msg) {
      const list = bySession.get(sessionId) ?? [];
      if (list.some((m) => m.deliveryId === msg.deliveryId)) return false;
      bySession.set(sessionId, [...list, msg]);
      return true;
    },
    ack(sessionId, deliveryId) {
      const list = bySession.get(sessionId);
      if (list) bySession.set(sessionId, list.filter((m) => m.deliveryId !== deliveryId));
    },
    list: (sessionId) => [...(bySession.get(sessionId) ?? [])],
    drop: (sessionId) => void bySession.delete(sessionId),
  };
}
