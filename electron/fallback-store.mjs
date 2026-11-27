// The reply-fallback approval switch: whether the forward of a session's reply waits for the owner's approval. Stored per
// session as true / false; no entry (null) follows the Settings default.
import { jsonFileMap } from "./json-file-map.mjs";

/** Per-session approval switches in a small JSON file ({ [sessionId]: boolean }). `set` throws when the file can't be
 *  written; `copy` and `delete` are bookkeeping after a fork / delete that already succeeded, so a failed write there is
 *  only logged. */
export function createFallbackStore(file) {
  const { read, write, bestEffort } = jsonFileMap(file, "fallback-approval");
  const get = (id) => {
    const v = read()[id];
    return typeof v === "boolean" ? v : null;
  };
  const store = (id, on) => {
    const data = read();
    if (typeof on === "boolean") data[id] = on;
    else if (id in data) delete data[id];
    else return;
    write(data);
  };
  return {
    get,
    set: store,
    delete: (id) => bestEffort(() => store(id, null)),
    copy: (fromId, toId) => bestEffort(() => store(toId, get(fromId))),
  };
}
