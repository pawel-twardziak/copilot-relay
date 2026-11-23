// A small JSON-file store of what the changes browser knows per session: the repositories the session worked in
// (with the start point each was first seen at), the loose files it touched outside any repository and the files
// opened from links in the chat.
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

const OPENED_LIMIT = 200;

/** Whether two file paths are the same file: equal text, lower-cased on win32. */
const sameFile = (a, b, platform) => (platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

const clone = (x) => JSON.parse(JSON.stringify(x));

/** The string members of an array; [] for anything else. */
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

/** The stored data as { [sessionId]: { repos, loose, opened } }; {} when the file is missing, unreadable or malformed. */
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
      repos: Array.isArray(entry.repos)
        ? entry.repos
            .filter((r) => r && typeof r.root === "string")
            .map((r) => ({ ...r, dirtyAtStart: strings(r.dirtyAtStart), touched: strings(r.touched) }))
        : [],
      loose: strings(entry.loose),
      opened: strings(entry.opened),
    };
  }
  return data;
}

/** The store over `file`: read once here, the whole file rewritten (temp file, then rename) on every change. */
export function createRecordStore(file) {
  const data = load(file);

  // Memory is the truth: a failed write is reported and the next successful save writes the whole state.
  const save = () => {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(data));
      renameSync(tmp, file);
    } catch (err) {
      console.warn(`[changes] could not save the repository records: ${err?.message ?? err}`);
    }
  };
  const find = (sessionId, root) => data[sessionId]?.repos.find((r) => sameRoot(r.root, root));
  const entry = (sessionId) => (data[sessionId] ??= { repos: [], loose: [], opened: [] });

  return {
    session(sessionId) {
      return clone(data[sessionId] ?? { repos: [], loose: [], opened: [] });
    },
    repo(sessionId, root) {
      const r = find(sessionId, root);
      return r ? clone(r) : null;
    },
    addRepo(sessionId, record) {
      if (typeof record?.root !== "string" || !record.root || find(sessionId, record.root)) return false;
      const r = clone(record);
      entry(sessionId).repos.push({ ...r, dirtyAtStart: strings(r.dirtyAtStart), touched: strings(r.touched) });
      save();
      return true;
    },
    touch(sessionId, root, rel) {
      const r = find(sessionId, root);
      if (!r) return;
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
    addOpened(sessionId, abs, platform = process.platform) {
      if (typeof abs !== "string" || !abs) return;
      const e = entry(sessionId);
      e.opened = [abs, ...e.opened.filter((p) => !sameFile(p, abs, platform))].slice(0, OPENED_LIMIT);
      save();
    },
    removeOpened(sessionId, abs, platform = process.platform) {
      const e = data[sessionId];
      if (!e || typeof abs !== "string") return false;
      const left = e.opened.filter((p) => !sameFile(p, abs, platform));
      if (left.length === e.opened.length) return false;
      e.opened = left;
      save();
      return true;
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
