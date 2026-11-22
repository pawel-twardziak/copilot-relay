// Brings the broker's git repository to the latest main, stashing local changes first. Main process only.
export const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };

// Only the stash carries an identity: a machine that just runs the broker may have none, and a stash does not leave
// its author in the work tree.
const STASH_IDENTITY = ["-c", "user.name=Copilot Sessions", "-c", "user.email=copilot-sessions@localhost"];

export async function updateRepo({ repo, run, now = () => new Date(), timeoutMs = 60_000 }) {
  const git = async (...args) => (await run("git", args, { cwd: repo, env: GIT_ENV, timeoutMs })).stdout.trim();

  const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
  const before = await git("rev-parse", "--short", "HEAD");
  let stash = null;
  try {
    if (await git("status", "--porcelain")) {
      const message = `copilot-sessions restart ${now().toISOString()}`;
      await git(...STASH_IDENTITY, "stash", "push", "--include-untracked", "-m", message);
      stash = { branch, message };
    }
    if (branch !== "main") await git("checkout", "main");
    await git("pull", "--ff-only", "origin", "main");
    const after = await git("rev-parse", "--short", "HEAD");
    return { before, after, stash };
  } catch (err) {
    if (stash) err.stash = stash;
    throw err;
  }
}

export function describeUpdate({ before, after, stash }) {
  const head = before === after ? `already up to date (${after})` : `${before} → ${after}`;
  return stash ? `${head}; changes stashed from ${stash.branch}` : head;
}
