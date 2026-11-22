// What the changes window shows for a session: the changed files per repository, a file's commits and one diff,
// plus adding and removing a repository by hand. Reads the recorded repositories (repo-records) through repo-git.
import path from "node:path";

export const FILE_LIMIT = 2000;
const NOT_LISTED = "This repository is not listed for this session.";
const NOBASE_NOTE = "The start point of this session no longer exists in this repository. Only uncommitted changes are shown.";

/** `rel` when it is a non-empty relative path without ".." segments; throws Error("Invalid path") otherwise. */
export function checkRel(rel) {
  const bad = typeof rel !== "string" || !rel || path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel)
    || rel.includes("\0") || rel.split(/[\\/]/).includes("..");
  if (bad) throw new Error("Invalid path");
  return rel;
}

const folderName = (root) => path.basename(root.replace(/[\\/]+$/, "")) || root;

export function createChanges({ store, git, createdAt, allow, now = () => new Date() }) {
  const record = (sessionId, root) => {
    const rec = store.repo(sessionId, root);
    if (!rec) throw new Error(NOT_LISTED);
    return rec;
  };

  async function view(rec) {
    const base = {
      root: rec.root, name: folderName(rec.root), source: rec.source, at: rec.at,
      noCommits: false, error: null, note: null, truncated: false, files: [],
    };
    try {
      const [head, status] = await Promise.all([git.head(rec.root), git.status(rec.root)]);
      let committed = [];
      let note = null;
      try {
        committed = await git.commitFiles(rec.root, rec.base);
      } catch (err) {
        if (err?.code !== "NOBASE") throw err;
        note = NOBASE_NOTE;
      }
      const dirty = new Map(status.map((f) => [f.path, f.state]));
      const done = new Map(committed.map((f) => [f.path, f.state]));
      const files = [...new Set([...dirty.keys(), ...done.keys()])].sort().map((p) => ({
        path: p,
        state: dirty.get(p) ?? done.get(p),
        uncommitted: dirty.has(p),
        committed: done.has(p),
        touched: rec.touched.includes(p),
        dirtyAtStart: rec.dirtyAtStart.includes(p),
      }));
      return {
        ...base, noCommits: head === null, note, truncated: files.length > FILE_LIMIT, files: files.slice(0, FILE_LIMIT),
      };
    } catch (err) {
      return { ...base, error: err?.message ?? String(err), files: [] };
    }
  }

  return {
    async list(sessionId) {
      const { repos, loose } = store.session(sessionId);
      return { repos: await Promise.all(repos.map(view)), loose };
    },

    async commits(sessionId, root, rel) {
      const rec = record(sessionId, root);
      return git.fileCommits(rec.root, rec.base, checkRel(rel));
    },

    async diff(sessionId, root, rel, version) {
      const rec = record(sessionId, root);
      checkRel(rel);
      let res;
      if (version === "uncommitted") {
        if ((await git.head(rec.root)) === null) return { added: true };
        res = await git.diffUncommitted(rec.root, rel);
      } else {
        const known = typeof version === "string" && (await git.fileCommits(rec.root, rec.base, rel)).some((c) => c.sha === version);
        if (!known) throw new Error("Unknown version");
        res = await git.diffCommit(rec.root, version, rel);
      }
      return res.tooLarge ? { tooLarge: true } : { text: res.text };
    },

    async add(sessionId, dir) {
      if (!(await allow(dir))) return { message: "Network folders are not read." };
      const found = await git.where(dir).catch(() => null);
      if (!found) return { message: `${dir} is not inside a git repository.` };
      const { root } = found;
      const created = createdAt(sessionId);
      const base = (created && (await git.headAt(root, created))) ?? (await git.head(root));
      const added = store.addRepo(sessionId, {
        root, source: "manual", base, at: now().toISOString(), dirtyAtStart: [], touched: [],
      });
      return added ? { root } : { message: `${folderName(root)} is already listed.` };
    },

    remove(sessionId, root) {
      record(sessionId, root);
      store.removeRepo(sessionId, root);
    },
  };
}
