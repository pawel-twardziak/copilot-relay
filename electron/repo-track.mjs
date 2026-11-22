// The trigger of the changes browser: records a repository's start point for a session the first time the coding
// agent changes a file there (or, at its first tool call, the repository of the session folder).
import { stat } from "node:fs/promises";
import path from "node:path";

const EDIT_KINDS = new Set(["edit", "delete", "move"]);

const pathsOf = (items) => (Array.isArray(items) ? items.map((i) => i?.path).filter((p) => typeof p === "string" && p) : []);

/** The paths a tool call changes: its diff items, then, for an edit, delete or move, its locations. Unique, in order. */
export function editPaths({ kind, locations, content } = {}) {
  const diffs = Array.isArray(content) ? content.filter((c) => c?.type === "diff") : [];
  const out = pathsOf(diffs);
  if (EDIT_KINDS.has(kind)) out.push(...pathsOf(locations));
  return [...new Set(out)];
}

/** The nearest folder at or above the file's folder that exists; null when none does. */
export async function defaultNearestDir(abs) {
  let dir = path.dirname(abs);
  for (;;) {
    try {
      if ((await stat(dir)).isDirectory()) return dir;
    } catch {
      // not there yet: try the parent
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const slashes = (p) => p.split(path.sep).join("/");

/** The tracker over a record store and a git object. */
export function createRepoTracker({ store, git, allow, nearestDir = defaultNearestDir, now = () => new Date() }) {
  const chains = new Map(); // sessionId -> the tail of its promise chain
  const seen = new Map(); // sessionId -> Set of absolute paths already handled
  const folderDone = new Set(); // sessions whose session folder was looked at

  const enqueue = (sessionId, work) => {
    const next = (chains.get(sessionId) ?? Promise.resolve())
      .then(work)
      .catch((err) => console.warn(`[changes] could not record a change: ${err?.message ?? err}`));
    chains.set(sessionId, next);
    return next;
  };

  const newRecord = async (root, omit) => {
    const dirty = (await git.status(root)).map((e) => e.path).filter((p) => !omit.has(p));
    return { root, source: "auto", base: await git.head(root), at: now().toISOString(), dirtyAtStart: dirty, touched: [] };
  };

  async function handlePaths(sessionId, cwd, paths) {
    const done = seen.get(sessionId) ?? seen.set(sessionId, new Set()).get(sessionId);
    const call = [...new Set(paths.map((p) => path.resolve(cwd, p)))];
    for (const abs of call) {
      if (done.has(abs)) continue;
      if (!(await allow(abs))) continue;
      const dir = await nearestDir(abs);
      const where = dir ? await git.where(dir) : null;
      if (!where) {
        store.addLoose(sessionId, abs);
      } else {
        const { root, prefix } = where;
        if (!store.repo(sessionId, root)) {
          const omit = new Set();
          for (const other of call) {
            const rel = path.relative(root, other);
            if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) omit.add(slashes(rel));
          }
          store.addRepo(sessionId, await newRecord(root, omit));
        }
        store.touch(sessionId, root, prefix + slashes(path.relative(dir, abs)));
      }
      done.add(abs);
    }
  }

  async function handleSessionFolder(sessionId, cwd) {
    if (!(await allow(cwd))) return;
    const where = await git.where(cwd);
    if (!where || store.repo(sessionId, where.root)) return;
    store.addRepo(sessionId, await newRecord(where.root, new Set()));
  }

  return {
    update(sessionId, cwd, update) {
      const kind = update?.sessionUpdate;
      if (kind !== "tool_call" && kind !== "tool_call_update") return Promise.resolve();
      return enqueue(sessionId, async () => {
        await handlePaths(sessionId, cwd, editPaths(update));
        if (kind === "tool_call" && !folderDone.has(sessionId)) {
          folderDone.add(sessionId);
          await handleSessionFolder(sessionId, cwd);
        }
      });
    },
    permission(sessionId, cwd, toolCall) {
      if (!EDIT_KINDS.has(toolCall?.kind)) return Promise.resolve();
      return enqueue(sessionId, () => handlePaths(sessionId, cwd, pathsOf(toolCall.locations)));
    },
    closed(sessionId) {
      seen.delete(sessionId);
      folderDone.delete(sessionId);
    },
  };
}
