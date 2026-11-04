// Path helpers without side effects (no file system access), shared by main.mjs and tests.
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Is `child` the folder `parent` itself or somewhere below it? Both must already be absolute real paths (symlinks
 * resolved by the caller): this only compares text. Windows paths compare case-insensitively.
 */
export function isInside(child, parent, platform = process.platform) {
  if (!child || !parent) return false;
  const p = platform === "win32" ? path.win32 : path.posix;
  const norm = (x) => (platform === "win32" ? x.toLowerCase() : x);
  // an unresolved ".." is refused rather than normalised away: the caller should never pass one
  if (/(^|[\\/])\.\.([\\/]|$)/.test(child)) return false;
  const rel = p.relative(norm(parent), norm(child));
  return rel === "" || (!rel.startsWith("..") && !p.isAbsolute(rel));
}

/**
 * Where `src` (an image path from a message: relative to `cwd`, `~/…`, absolute or a file: URL) points, worked out
 * from the text alone, without touching the disk: a path in a relay message or an answer must be ruled out before
 * the main process lstat()s anything (a mapped drive or an automount would contact the remote host).
 * decode: also undo %xx escapes (Markdown links come percent-encoded). null for URLs and network paths.
 */
export function lexicalPath(src, cwd, home, platform = process.platform, { decode = true } = {}) {
  const p = platform === "win32" ? path.win32 : path.posix;
  let t = String(src ?? "").trim();
  if (!t) return null;
  if (/^file:/i.test(t)) {
    try {
      const url = new URL(t);
      if (url.host && url.host !== "localhost") return null;
      url.host = "";
      t = fileURLToPath(url, { windows: platform === "win32" });
    } catch {
      return null;
    }
  } else {
    if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[a-z]:[\\/]/i.test(t)) return null; // other schemes (not "C:\")
    if (decode) {
      try {
        t = decodeURIComponent(t);
      } catch {}
    }
  }
  if (/^(\\\\|\/\/)/.test(t)) return null; // UNC / network
  if (t === "~" || /^~[\\/]/.test(t)) t = p.join(home, t.slice(1));
  const abs = p.resolve(cwd, t);
  return /^(\\\\|\/\/)/.test(abs) ? null : abs;
}
