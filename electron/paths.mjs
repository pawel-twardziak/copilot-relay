// Path helpers without side effects (no file system access), shared by main.mjs and tests.
import path from "node:path";

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
