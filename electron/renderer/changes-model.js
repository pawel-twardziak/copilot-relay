// Pure list model of the changes browser: keys, selection, versions of a file, path location (no DOM).
// Loaded as a classic <script> (sets globalThis.ChangesModel) and via require() in tests.
"use strict";
(function () {

/** A file's key in the list: root null for a loose file (rel is then its absolute path). */
const key = (root, rel) => JSON.stringify([root, rel]);

/** The previous key when it is still listed, else the first file of the first repository with files, else the first loose file, else null. */
function pick(data, prevKey) {
  const repos = data?.repos ?? [];
  const loose = data?.loose ?? [];
  if (prevKey != null) {
    for (const r of repos) for (const f of r.files ?? []) if (key(r.root, f.path) === prevKey) return prevKey;
    for (const p of loose) if (key(null, p) === prevKey) return prevKey;
  }
  for (const r of repos) if (r.files?.length) return key(r.root, r.files[0].path);
  return loose.length ? key(null, loose[0]) : null;
}

/** The versions of a file to choose from: "Uncommitted" when it has uncommitted changes, then one per commit. */
function versions(file, commits) {
  const out = [];
  if (file?.uncommitted) out.push({ id: "uncommitted", label: "Uncommitted", title: "" });
  for (const c of commits ?? []) out.push({ id: c.sha, label: `${c.sha.slice(0, 7)} ${c.subject}`, title: `${c.author} · ${c.date}` });
  return out;
}

/** "electron/main.mjs" -> { dir: "electron/", name: "main.mjs" }. */
function splitName(rel) {
  const i = rel.lastIndexOf("/");
  return { dir: rel.slice(0, i + 1), name: rel.slice(i + 1) };
}

/** The repository of data that contains the absolute path (the longest root wins), with rel in forward slashes; else null. */
function locate(data, abs, platform) {
  const win = platform === "win32";
  const norm = (p) => (win ? p.replace(/\\/g, "/") : p);
  const cmp = (p) => (win ? p.toLowerCase() : p);
  const path = norm(String(abs ?? ""));
  let best = null;
  for (const r of data?.repos ?? []) {
    const root = norm(r.root).replace(/\/+$/, "");
    if (cmp(path).startsWith(cmp(root) + "/") && path.length > root.length + 1 && (!best || root.length > best.len)) {
      best = { root: r.root, rel: path.slice(root.length + 1), len: root.length };
    }
  }
  if (!best) return null;
  let rel = best.rel;
  if (win) {
    // the spelling the list holds, so key(root, rel) matches the list's key
    const files = data.repos.find((r) => r.root === best.root)?.files ?? [];
    const listed = files.find((f) => f.path.toLowerCase() === rel.toLowerCase());
    if (listed) rel = listed.path;
  }
  return { root: best.root, rel };
}

const ChangesModel = { key, pick, versions, splitName, locate };
globalThis.ChangesModel = ChangesModel;
if (typeof module !== "undefined") module.exports = ChangesModel;
})();
