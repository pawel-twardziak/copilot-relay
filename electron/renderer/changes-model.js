// Pure list model of the changes browser: keys, selection, versions of a file, path location and joining, the
// split's stored preferences (no DOM).
// Loaded as a classic <script> (sets globalThis.ChangesModel) and via require() in tests.
"use strict";
(function () {

/** A file's key in the list: root null for a loose file (rel is then its absolute path). */
const key = (root, rel) => JSON.stringify([root, rel]);

/** The view for a kind of row: "change" the stored view, "commit" the stored view but the diff for "file", "nodiff" (no diff exists) the file. */
function viewFor(prefView, kind) {
  if (kind === "nodiff") return "file";
  if (kind === "commit" && prefView === "file") return "diff";
  return prefView;
}

/** Equal paths: equal text; on win32 without case and with "/" equal to "\". */
function samePath(a, b, platform) {
  if (platform !== "win32") return a === b;
  const n = (p) => String(p).replace(/\\/g, "/").toLowerCase();
  return n(a) === n(b);
}

/** The opened paths (newest first) the changes list does not hold, the first `limit`. */
function openedShown(data, platform, limit = 20) {
  const out = [];
  for (const p of data?.opened ?? []) {
    const at = locate(data, p, platform);
    const inRepo = at && (data.repos.find((r) => r.root === at.root)?.files ?? []).some((f) => f.path === at.rel);
    if (inRepo || (data.loose ?? []).some((l) => samePath(l, p, platform))) continue;
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

/** An opened file's label: relative to cwd when inside it, else absolute; dir ends with its separator. */
function openedLabel(abs, cwd, platform) {
  const win = platform === "win32";
  const sep = win ? "\\" : "/";
  const norm = (p) => (win ? p.replace(/\\/g, "/").toLowerCase() : p);
  let shown = abs;
  if (cwd) {
    const root = norm(cwd).replace(/\/+$/, "");
    if (norm(abs).startsWith(root + "/") && abs.length > root.length + 1) shown = abs.slice(root.length + 1);
  }
  const i = shown.lastIndexOf(sep);
  return { dir: shown.slice(0, i + 1), name: shown.slice(i + 1) };
}

/** A commit's list text: "<sha7> <subject>" and the tooltip "<author> · <date>". */
function commitLabel(c) {
  return { label: `${c.sha.slice(0, 7)} ${c.subject}`, title: `${c.author} · ${c.date}` };
}

/** The selected version when `commits` still holds it, else "uncommitted". */
function keepVersion(version, commits) {
  return version !== "uncommitted" && (commits ?? []).some((c) => c.sha === version) ? version : "uncommitted";
}

/** The previous key when it is still listed (a changed file, a loose file or a shown opened file), else the first repository file, else the first loose file, else the first shown opened file, else null. */
function pick(data, prevKey, platform) {
  const repos = data?.repos ?? [];
  const loose = data?.loose ?? [];
  const opened = openedShown(data, platform);
  if (prevKey != null) {
    for (const r of repos) for (const f of r.files ?? []) if (key(r.root, f.path) === prevKey) return prevKey;
    for (const p of loose) if (key(null, p) === prevKey) return prevKey;
    for (const p of opened) if (key(null, p) === prevKey) return prevKey;
    // the file moved between the changes list and the opened files: follow it
    let prev = null;
    try {
      prev = JSON.parse(prevKey);
    } catch {}
    if (Array.isArray(prev) && typeof prev[1] === "string") {
      if (prev[0] === null) {
        const at = locate(data, prev[1], platform);
        if (at && (repos.find((r) => r.root === at.root)?.files ?? []).some((f) => f.path === at.rel)) return key(at.root, at.rel);
      } else {
        const path = abs(prev[0], prev[1], platform);
        const p = opened.find((o) => samePath(o, path, platform));
        if (p !== undefined) return key(null, p);
      }
    }
  }
  for (const r of repos) if (r.files?.length) return key(r.root, r.files[0].path);
  if (loose.length) return key(null, loose[0]);
  return opened.length ? key(null, opened[0]) : null;
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

/** A listed file's absolute path: root + rel (forward slashes) with the platform's separator; a loose file's path (root null) as is. */
function abs(root, rel, platform) {
  if (root == null) return rel;
  const p = `${root.replace(/[\\/]+$/, "")}/${rel}`;
  return platform === "win32" ? p.replace(/\//g, "\\") : p;
}

/** The diff pane's share of the split: a finite number clamped to 0.2–0.8, anything else 0.5. */
const clampRatio = (value) => (typeof value === "number" && Number.isFinite(value) ? Math.min(0.8, Math.max(0.2, value)) : 0.5);

/** The stored split (localStorage text): { showFile, ratio }, the defaults for missing or broken text. */
function parsePrefs(text) {
  let raw = null;
  try {
    raw = JSON.parse(text ?? "null");
  } catch {}
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) raw = {};
  return { showFile: raw.showFile === true, ratio: clampRatio(raw.ratio) };
}

const ChangesModel = { key, pick, viewFor, samePath, openedShown, openedLabel, commitLabel, keepVersion, versions, splitName, locate, abs, clampRatio, parsePrefs };
globalThis.ChangesModel = ChangesModel;
if (typeof module !== "undefined") module.exports = ChangesModel;
})();
