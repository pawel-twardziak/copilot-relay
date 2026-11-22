// Brings the broker's git repository to the latest main, stashing local changes first. Main process only.
export const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };

// Only the stash carries an identity: a machine that just runs the broker may have none, and a stash does not leave
// its author in the work tree.
const STASH_IDENTITY = ["-c", "user.name=Copilot Sessions", "-c", "user.email=copilot-sessions@localhost"];

export async function updateRepo({ repo, run, now = () => new Date(), timeoutMs = 60_000 }) {
  const call = async (args, { raw = false, ...extra } = {}) => {
    const { stdout } = await run("git", args, { cwd: repo, env: GIT_ENV, timeoutMs, ...extra });
    return raw ? stdout : stdout.trim();
  };
  const git = (...args) => call(args);
  // Stash leaves nested repositories and linked worktrees alone (untracked entries ending in "/"), and with only those
  // left it would still create an empty stash entry. So only the other entries count as local changes.
  const hasStashable = async () => {
    const status = await call(["status", "--porcelain", "-z", "--untracked-files=all"], { raw: true });
    return status.split("\0").some((entry) => entry !== "" && !(entry.startsWith("?? ") && entry.endsWith("/")));
  };

  const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
  const before = await git("rev-parse", "--short", "HEAD");
  let stash = null;
  try {
    if (await hasStashable()) {
      const message = `copilot-sessions restart ${now().toISOString()}`;
      try {
        await call([...STASH_IDENTITY, "stash", "push", "--include-untracked", "-m", message], { label: "git stash" });
      } catch (err) {
        // `stash push -u` stores the entry before it cleans and resets the work tree, so a failure (a file it cannot
        // remove, the timeout) can come after the work is already in the stash: name it when it is there.
        const top = await git("log", "-1", "--format=%s", "refs/stash").catch(() => "");
        if (top.includes(message)) {
          stash = { branch, message };
          err.message += " The work tree may be partly cleaned.";
        }
        throw err;
      }
      stash = { branch, message };
    }
    let from = null;
    if (branch !== "main") {
      await git("checkout", "main");
      from = branch === "HEAD" ? "a detached HEAD" : branch;
    }
    await git("pull", "--ff-only", "--no-rebase", "origin", "main");
    const after = await git("rev-parse", "--short", "HEAD");
    return { before, after, stash, from };
  } catch (err) {
    if (stash) err.stash = stash;
    throw err;
  }
}

export function describeUpdate({ before, after, stash, from = null }) {
  const hashes = before === after ? `already up to date (${after})` : `${before} → ${after}`;
  const head = from ? `${hashes} (was on ${from})` : hashes;
  return stash ? `${head}; changes stashed from ${stash.branch}` : head;
}
