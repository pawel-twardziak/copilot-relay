// A small JSON-file store of what the changes browser knows per session: the repositories the session worked in
// (with the start point each was first seen at) and the loose files it touched outside any repository.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Whether two repository roots are the same folder: resolved text compare, case-insensitive on win32. */
export function sameRoot(a, b, platform = process.platform) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const p = platform === "win32" ? path.win32 : path.posix;
  const norm = (x) => {
    const r = p.resolve(x);
    return platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

const clone = (x) => JSON.parse(JSON.stringify(x));

/** The stored data as { [sessionId]: { repos, loose } }; {} when the file is missing, unreadable or malformed. */
function load(file) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const data = {};
  for (const [id, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object") continue;
    data[id] = {
      repos: Array.isArray(entry.repos) ? entry.repos.filter((r) => r && typeof r.root === "string") : [],
      loose: Array.isArray(entry.loose) ? entry.loose.filter((x) => typeof x === "string") : [],
    };
  }
  return data;
}

/** The store over `file`: read once here, the whole file rewritten (temp file, then rename) on every change. */
export function createRecordStore(file) {
  const data = load(file);

  const save = () => {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, file);
  };
  const find = (sessionId, root) => data[sessionId]?.repos.find((r) => sameRoot(r.root, root));
  const entry = (sessionId) => (data[sessionId] ??= { repos: [], loose: [] });

  return {
    session(sessionId) {
      return clone(data[sessionId] ?? { repos: [], loose: [] });
    },
    repo(sessionId, root) {
      const r = find(sessionId, root);
      return r ? clone(r) : null;
    },
    addRepo(sessionId, record) {
      if (find(sessionId, record.root)) return false;
      entry(sessionId).repos.push(clone(record));
      save();
      return true;
    },
    touch(sessionId, root, rel) {
      const r = find(sessionId, root);
      if (!r) return;
      r.touched ??= [];
      if (r.touched.includes(rel)) return;
      r.touched.push(rel);
      save();
    },
    addLoose(sessionId, abs) {
      const e = entry(sessionId);
      if (e.loose.includes(abs)) return;
      e.loose.push(abs);
      save();
    },
    removeRepo(sessionId, root) {
      const repos = data[sessionId]?.repos;
      const i = repos ? repos.findIndex((r) => sameRoot(r.root, root)) : -1;
      if (i === -1) return false;
      repos.splice(i, 1);
      save();
      return true;
    },
    forget(sessionId) {
      if (!(sessionId in data)) return;
      delete data[sessionId];
      save();
    },
  };
}
