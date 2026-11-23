// Replies from a session's direct children wait for the user's approval in the parent. Two small pieces for the
// main process: the per-session switch (default on, only "off" is stored) and the cache of marked messages that
// are not yet acknowledged to the broker, so a window that reopens a session can show them again.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Per-session hold switch in a small JSON file ({ [sessionId]: false }); no entry means on.
 *  `set` throws when the file can't be written; `copy` and `delete` are bookkeeping after a fork / delete that
 *  already succeeded, so a failed write there is only logged. */
export function createHoldStore(file) {
  const read = () => {
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    } catch {
      return {};
    }
  };
  const write = (data) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
    renameSync(`${file}.tmp`, file);
  };
  const put = (id, on) => {
    const data = read();
    if (on === false) data[id] = false;
    else if (id in data) delete data[id];
    else return;
    write(data);
  };
  const bestEffort = (fn) => {
    try {
      fn();
    } catch (e) {
      console.warn(`[held-replies] could not write ${file}: ${e.message}`);
    }
  };
  return {
    get: (id) => read()[id] !== false,
    set: put,
    delete: (id) => bestEffort(() => put(id, true)),
    copy: (fromId, toId) => bestEffort(() => put(toId, read()[fromId] !== false)),
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
