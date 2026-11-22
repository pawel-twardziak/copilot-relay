// Read-only git calls for the changes browser, and the parsers of their output. Main process only, no electron import.
import path from "node:path";

// `status --porcelain=v1 -z` → [{ path, state }]; state is "?", "D", "R", "A" or "M".
export function parseStatus(text) {
  const parts = text.split("\0");
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    const path = entry.slice(3);
    if (x === "R" || x === "C" || y === "R" || y === "C") i++; // the old path of a rename or copy
    if (x === "!" && y === "!") continue;
    if (path.endsWith("/")) continue;
    let state = "M";
    if (x === "?" && y === "?") state = "?";
    else if (x === "D" || y === "D") state = "D";
    else if (x === "R" || y === "R") state = "R";
    else if (x === "A") state = "A";
    out.push({ path, state });
  }
  return out;
}

// `log --format= --name-status -z` → [{ path, state }], each path once with its first (newest) state.
export function parseNameStatus(text) {
  const parts = text.split("\0");
  const seen = new Set();
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (!code) continue;
    const kind = code[0];
    const twoPaths = kind === "R" || kind === "C";
    const path = twoPaths ? parts[i + 2] : parts[i + 1];
    i += twoPaths ? 2 : 1;
    if (kind === "R" && parts[i - 1]) seen.add(parts[i - 1]); // the file appears under its new name only
    if (path == null || path === "" || seen.has(path)) continue;
    seen.add(path);
    out.push({ path, state: kind === "C" ? "A" : kind });
  }
  return out;
}

export const COMMIT_FORMAT = "%H%x1f%s%x1f%cI%x1f%an%x1e";

// Only records ended by \x1e count: the piece after the last one is empty, or a record cut by the output limit.
export function parseCommits(text) {
  const out = [];
  for (const record of text.split("\x1e").slice(0, -1)) {
    const [sha, subject, date, author, ...extra] = record.replace(/^\n/, "").split("\x1f");
    if (author === undefined || extra.length > 0) continue;
    out.push({ sha, subject, date, author });
  }
  return out;
}

export const DIFF_LIMIT = 2 * 1024 * 1024;
const LIST_LIMIT = 8 * 1024 * 1024;

// On every call. core.fsmonitor=false: no fsmonitor hook program. diff.autoRefreshIndex=false: `diff` does not rewrite
// the index for a file whose time changed and whose content did not (GIT_OPTIONAL_LOCKS=0 alone does not stop that).
const CONFIG = ["-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "-c", "diff.autoRefreshIndex=false"];
// LC_ALL=C: git's messages in English, by which `where`, `head` and NOBASE are recognised (git translates them).
const ENV = { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
// On calls that produce a diff: no external diff or textconv program, no colour codes.
const NO_PROGRAMS = ["--no-ext-diff", "--no-textconv", "--no-color"];
const NOBASE = /bad revision|unknown revision|Invalid revision range|bad object/;

// A commit id goes in front of `--`, where a value starting with "-" would be read as an option (`--output=<file>`).
function checkSha(sha) {
  if (!/^[0-9a-f]{4,64}$/i.test(sha)) throw new Error(`Not a commit id: ${sha}`);
  return sha;
}

// When the output was cut, the text after its last NUL is half an entry.
const whole = ({ stdout, truncated }) => (truncated ? stdout.slice(0, stdout.lastIndexOf("\0") + 1) : stdout);

// run: (program, args, opts) => Promise<{ stdout, stderr, truncated }>, as runProgram.
export function createGit(run, { timeoutMs = 10_000 } = {}) {
  // root null: no -C, the caller passes `cwd`.
  const git = (root, args, extra = {}) => run(
    "git",
    ["--literal-pathspecs", ...(root == null ? [] : ["-C", root]), ...CONFIG, ...args],
    { env: ENV, timeoutMs, label: `git ${args[0]}`, ...extra },
  );
  const failedWith = (err, pattern) => err.code === "EXIT" && pattern.test(err.stderr ?? "");

  const head = async (root) => {
    try {
      return (await git(root, ["rev-parse", "--verify", "HEAD"])).stdout.trim();
    } catch (err) {
      if (failedWith(err, /Needed a single revision/)) return null; // no commit yet
      throw err;
    }
  };

  // `log` over the commits after `base` (all of HEAD's history for null); null when there is no commit yet.
  const logSince = async (root, base, args, paths = []) => {
    const range = base == null ? "HEAD" : `${checkSha(base)}..HEAD`;
    try {
      return await git(root, ["log", "--no-show-signature", ...args, range, "--", ...paths], { outputLimit: LIST_LIMIT, keep: "start" });
    } catch (err) {
      if (err.code !== "EXIT") throw err;
      if ((await head(root)) === null) return null;
      if (base != null && NOBASE.test(err.stderr ?? "")) err.code = "NOBASE";
      throw err;
    }
  };

  const diffText = async (root, args) => {
    const { stdout, truncated } = await git(root, args, { outputLimit: DIFF_LIMIT, keep: "start" });
    return truncated ? { text: "", tooLarge: true } : { text: stdout, tooLarge: false };
  };

  return {
    async where(dir) {
      try {
        const { stdout } = await git(null, ["rev-parse", "--show-toplevel", "--show-prefix"], { cwd: dir });
        const [top, prefix = ""] = stdout.split(/\r?\n/);
        return { root: path.resolve(top), prefix };
      } catch (err) {
        if (failedWith(err, /not a git repository/)) return null;
        throw err;
      }
    },
    head,
    async headAt(root, isoTime) {
      try {
        return (await git(root, ["rev-parse", "--verify", `HEAD@{${isoTime}}`])).stdout.trim();
      } catch (err) {
        if (err.code === "EXIT") return null; // no reflog entry, no commit, a time git cannot read
        throw err;
      }
    },
    async status(root) {
      const out = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { outputLimit: LIST_LIMIT, keep: "start" });
      return parseStatus(whole(out));
    },
    async commitFiles(root, base) {
      const out = await logSince(root, base, ["--format=", "--name-status", "-z", ...NO_PROGRAMS]);
      return out ? parseNameStatus(whole(out)) : [];
    },
    async fileCommits(root, base, rel) {
      const out = await logSince(root, base, [`--format=${COMMIT_FORMAT}`], [rel]);
      return out ? parseCommits(out.stdout) : [];
    },
    diffUncommitted: async (root, rel) => diffText(root, ["diff", ...NO_PROGRAMS, "HEAD", "--", rel]),
    diffCommit: async (root, sha, rel) => diffText(root, ["show", "--no-show-signature", "--format=", "--diff-merges=first-parent", ...NO_PROGRAMS, checkSha(sha), "--", rel]),
  };
}
