// The app's read cache of the broker's link tree (GET /api/links), so the sidebar can show the tree before the
// broker answers. The broker stays the source of truth: a fresh snapshot always replaces the cache.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The cached links; [] when the file is missing, unreadable or not an array. */
export function readLinksCache(file) {
  try {
    const links = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(links) ? links : [];
  } catch {
    return [];
  }
}

/** Replace the cache (write to a temp file, then rename, so a crash never leaves half a file). */
export function writeLinksCache(file, links) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(links));
  renameSync(tmp, file);
}
