// A small JSON object kept in one file, for the per-session stores of the main process (hold switches, keeper
// opt-out). A missing or unreadable file reads as {}; writes go through a temp file and a rename.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** `read()` → the stored object (or {}); `write(data)` throws when the file can't be written; `bestEffort(fn)` runs
 *  `fn` and only logs a failure, tagged `[tag]`. */
export function jsonFileMap(file, tag) {
  const read = () => {
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    } catch {
      return {};
    }
  };
  const write = (data) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
    renameSync(`${file}.tmp`, file);
  };
  const bestEffort = (fn) => {
    try {
      fn();
    } catch (e) {
      console.warn(`[${tag}] could not write ${file}: ${e.message}`);
    }
  };
  return { read, write, bestEffort };
}
