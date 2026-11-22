// Read-only git calls for the changes browser: parsers of git output (the git calls themselves come later).

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
    if (x === "R" || x === "C") i++; // the old path of a rename or copy
    if (x === "!" && y === "!") continue;
    if (path.endsWith("/")) continue;
    let state = "M";
    if (x === "?" && y === "?") state = "?";
    else if (x === "D" || y === "D") state = "D";
    else if (x === "R") state = "R";
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
    if (path == null || path === "" || seen.has(path)) continue;
    seen.add(path);
    out.push({ path, state: kind === "C" ? "A" : kind });
  }
  return out;
}

export const COMMIT_FORMAT = "%H%x1f%s%x1f%cI%x1f%an%x1e";

export function parseCommits(text) {
  return text.split("\x1e").map((r) => r.replace(/^\n/, "")).filter((r) => r !== "").map((r) => {
    const [sha, subject, date, author] = r.split("\x1f");
    return { sha, subject, date, author };
  });
}
