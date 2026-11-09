// Pure helpers for clickable file paths in chat text and the per-session recent files list (no DOM).
// Loaded as a classic <script> (sets globalThis.FileLinks) and via require() in tests.
"use strict";

const WELL_KNOWN_NAMES = new Set([
  "Makefile", "LICENSE", "Dockerfile", "README", "CHANGELOG", "NOTICE", "Gemfile", "Rakefile", "Procfile",
  "Jenkinsfile", "Vagrantfile", "Containerfile", ".gitignore", ".dockerignore", ".editorconfig", ".env",
]); // prettier-ignore

// `path:12`, `path:12:3`, `path:12:text` (grep output) and `path#L12`, `path#L12-L20`; the match is the path plus suffix
const SUFFIX_RE = /^(.+?)(?::(\d+)(?::\d+)?(?=:|$)|#L(\d+)(?:-L?\d+)?$)/;
const NAME_WITH_EXT = /^[^\s/\\:]+\.([A-Za-z0-9]{1,10})$/;
const LEADING = /^[([{<"'`]+/;
const TRAILING_CHARS = new Set(".,;:!?)]}>\"'`");
/** Drops trailing punctuation (a backward scan: a regex with $ is quadratic on a long run). */
const trimTrailing = (s) => {
  let end = s.length;
  while (end > 0 && TRAILING_CHARS.has(s[end - 1])) end--;
  return s.slice(0, end);
};

/** Splits a trailing line suffix off a path. raw is the path plus its suffix. */
function splitSuffix(token) {
  const m = SUFFIX_RE.exec(token);
  if (!m) return { raw: token, path: token, line: null };
  return { raw: m[0], path: m[1], line: Number(m[2] ?? m[3]) };
}

function splitPathSuffix(href) {
  const { path, line } = splitSuffix(String(href ?? ""));
  return { path, line };
}

/** Whether a string looks like a file path: a separator, a name with an extension, or a well-known name. */
function looksLikePath(p) {
  if (!/[A-Za-z0-9]/.test(p) || /:\/\//.test(p)) return false;
  if (/[/\\]/.test(p) || WELL_KNOWN_NAMES.has(p)) return true;
  const ext = NAME_WITH_EXT.exec(p)?.[1];
  return ext !== undefined && !/^\d+$/.test(ext);
}

/**
 * File path candidates in a text, in order. whole: the entire trimmed text is one candidate (spaces allowed).
 * max caps the number of unique paths; further occurrences of an accepted path are still returned.
 */
function pathCandidates(text, { whole = false, max = 500 } = {}) {
  const s = String(text ?? "");
  const out = [];
  if (whole) {
    const raw = s.trim();
    const c = splitSuffix(raw);
    if (looksLikePath(c.path))
      out.push({
        start: s.indexOf(raw),
        end: s.indexOf(raw) + c.raw.length,
        ...c,
      });
    return out;
  }
  const seen = new Set();
  for (const m of s.matchAll(/\S+/g)) {
    const lead = LEADING.exec(m[0])?.[0].length ?? 0;
    const token = trimTrailing(m[0].slice(lead));
    const c = splitSuffix(token);
    if (!looksLikePath(c.path)) continue;
    if (!seen.has(c.path)) {
      if (seen.size >= max) continue;
      seen.add(c.path);
    }
    const start = m.index + lead;
    out.push({ start, end: start + c.raw.length, ...c });
  }
  return out;
}

const FROM_LINE = /^\[from ([^\]\n]*)\]\n/;
const FOLDER_LINE = /^\[folder ("(?:[^"\\\n]|\\.)*")\](?:\n|$)/;
/** The header of a relayed message: `[from name]`, then optionally `[folder "<json string>"]`. display drops the folder line. */
function parseRelayHeader(text) {
  const s = String(text ?? "");
  const from = FROM_LINE.exec(s);
  if (!from) return { from: null, folder: null, display: s };
  const rest = s.slice(from[0].length);
  const f = FOLDER_LINE.exec(rest);
  let folder = null;
  try {
    if (f) folder = JSON.parse(f[1]);
  } catch {
    folder = null;
  }
  if (folder === null) return { from: from[1], folder: null, display: s };
  return {
    from: from[1],
    folder,
    display: s.slice(0, from[0].length) + rest.slice(f[0].length),
  };
}

/** Recent files stored as JSON { sessionId: [{ path, line }] }; anything malformed is dropped. */
function parseRecent(json) {
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    return {};
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, list]) => Array.isArray(list))
      .map(([id, list]) => [
        id,
        list
          .filter((e) => e && typeof e.path === "string")
          .map((e) => ({
            path: e.path,
            line: Number.isInteger(e.line) ? e.line : null,
          })),
      ]),
  );
}

/** The entry on top, any older entry for the same path removed, at most max kept. */
function recentAdd(list, entry, max = 20) {
  return [
    { path: entry.path, line: entry.line ?? null },
    ...list.filter((e) => e.path !== entry.path),
  ].slice(0, max);
}

function recentRemove(list, path) {
  return list.filter((e) => e.path !== path);
}

// highlight.js language names
const LANG_BY_NAME = {
  Makefile: "makefile",
  Dockerfile: "dockerfile",
  Containerfile: "dockerfile",
  Gemfile: "ruby",
  Rakefile: "ruby",
  Vagrantfile: "ruby",
  Jenkinsfile: "groovy",
  ".editorconfig": "ini",
  ".env": "bash",
};
const LANG_BY_EXT = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  json: "json", html: "xml", htm: "xml", xml: "xml", svg: "xml", css: "css", scss: "scss", less: "less", md: "markdown", markdown: "markdown",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp",
  php: "php", sh: "bash", bash: "bash", zsh: "bash", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", sql: "sql", lua: "lua", pl: "perl", r: "r",
  dart: "dart", scala: "scala", gradle: "groovy", dockerfile: "dockerfile", mk: "makefile", diff: "diff", patch: "diff", vue: "xml", graphql: "graphql",
}; // prettier-ignore
/** highlight.js language for a file name, or null when unknown. */
function previewLanguage(fileName) {
  const name = String(fileName ?? "")
    .split(/[/\\]/)
    .pop();
  if (Object.hasOwn(LANG_BY_NAME, name)) return LANG_BY_NAME[name];
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  return Object.hasOwn(LANG_BY_EXT, ext) ? LANG_BY_EXT[ext] : null;
}

const FileLinks = {
  pathCandidates,
  splitPathSuffix,
  parseRelayHeader,
  parseRecent,
  recentAdd,
  recentRemove,
  previewLanguage,
  WELL_KNOWN_NAMES,
};
globalThis.FileLinks = FileLinks;
if (typeof module !== "undefined") module.exports = FileLinks;
