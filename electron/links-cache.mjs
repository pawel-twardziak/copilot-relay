// The app's read cache of the broker's link tree (GET /api/links), so the sidebar can show the tree before the
// broker answers. The broker stays the source of truth: a fresh snapshot always replaces the cache.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);

/** The cached { links, held, heldByKind }; empty when the file is missing or unreadable. An old file is a bare links
 *  array or has no heldByKind. */
export function readLinksCache(file) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (Array.isArray(data)) return { links: data, held: {}, heldByKind: {} };
    return {
      links: Array.isArray(data?.links) ? data.links : [],
      held: isObject(data?.held) ? data.held : {},
      heldByKind: isObject(data?.heldByKind) ? data.heldByKind : {},
    };
  } catch {
    return { links: [], held: {}, heldByKind: {} };
  }
}

/** Replace the cache (write to a temp file, then rename, so a crash never leaves half a file). */
export function writeLinksCache(file, { links, held, heldByKind }) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ links, held, heldByKind: heldByKind ?? {} }));
  renameSync(tmp, file);
}
