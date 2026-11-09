// Network-location rules and safe path resolution, without importing electron so tests can load it.
// Text written by an agent must never make the main process touch a network location (a mapped drive, an NFS or
// SMB mount, an automount) without a click: the guard runs on the path text before anything is lstat()ed.
import { lstat, open, readlink, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isInside, lexicalPath } from "./paths.mjs";

const LINUX_NETWORK_TYPES = new Set("nfs nfs4 cifs smb3 smbfs ncpfs 9p ceph glusterfs lustre afs autofs".split(" "));
const LINUX_FUSE_NETWORK = new Set("sshfs rclone s3fs smbnetfs davfs".split(" "));
const MAC_NETWORK_TYPES = new Set("nfs smbfs afpfs webdav autofs".split(" "));

/** Mount points of network file systems in /proc/self/mountinfo. */
export function parseLinuxMounts(text) {
  const mounts = [];
  for (const line of String(text ?? "").split("\n")) {
    const [head, tail] = line.split(" - ");
    if (!head || !tail) continue;
    const type = tail.split(" ")[0];
    const network = LINUX_NETWORK_TYPES.has(type) || (type.startsWith("fuse.") && LINUX_FUSE_NETWORK.has(type.slice(5)));
    const point = head.split(" ")[4];
    // mountinfo writes spaces and the like as octal escapes (\040)
    if (network && point) mounts.push(point.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))));
  }
  return mounts;
}

/** Mount points of network file systems in `mount` output on macOS. */
export function parseMacMounts(text) {
  const mounts = [];
  for (const line of String(text ?? "").split("\n")) {
    const m = /^.+? on (.+) \(([^,)]+)/.exec(line);
    if (m && MAC_NETWORK_TYPES.has(m[2])) mounts.push(m[1]);
  }
  return mounts;
}

/** Fixed local drives ("C:") from Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,DriveType | ConvertTo-Json. */
export function parseWinDrives(json) {
  const data = JSON.parse(json);
  return (Array.isArray(data) ? data : [data]).filter((d) => d?.DriveType === 3).map((d) => String(d.DeviceID).toUpperCase());
}

/** Is `abs` the mount point or below it? A real path boundary: "/mnt/nfs/..x" is inside, "/mnt/nfsx" is not. */
function underMount(abs, mount, platform) {
  const win = platform === "win32";
  const p = win ? path.win32 : path.posix;
  const fold = (x) => (win || platform === "darwin" ? x.toLowerCase() : x);
  const rel = p.relative(fold(mount), fold(abs));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel));
}

/** An unresolved ".." (and anything unknown) counts as network: the caller must hand over resolved paths. */
export function isNetworkLocation(abs, table, platform = process.platform) {
  if (/(^|[\\/])\.\.([\\/]|$)/.test(abs)) return true;
  if (platform === "win32") {
    const drive = /^([a-z]:)/i.exec(abs)?.[1].toUpperCase();
    return !drive || !table.fixedDrives.includes(drive); // UNC and anything without a known fixed drive
  }
  return table.mounts.some((m) => underMount(abs, m, platform));
}

/**
 * Without a table (it could not be read) only the trusted roots pass, compared by text. Their strict ancestors pass
 * too: the walk to a file inside a root lstat()s every component on the way ("/home", "/tmp"); siblings still fail.
 */
export function allowsAutomaticCheck(abs, { table, trustedRoots, platform = process.platform }) {
  if (!table) return trustedRoots.some((r) => isInside(abs, r, platform) || isInside(r, abs, platform));
  return !isNetworkLocation(abs, table, platform);
}

const WIN_DRIVES_COMMAND = "Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,DriveType | ConvertTo-Json";

/**
 * Cached view of the network locations. readFile(path) and exec(file, args) return text asynchronously.
 * get() resolves null when the source cannot be read, the platform is unknown or it takes longer than timeoutMs
 * (a `mount` stuck on a dead server may never return, whatever the process is told).
 */
export function createLocationTable({ platform, readFile, exec, ttlMs = 30000, now = Date.now, timeoutMs = 5000 }) {
  let cached = null;
  let at = 0;
  const load = () => {
    let timer;
    const deadline = new Promise((resolve) => (timer = setTimeout(resolve, timeoutMs, null)));
    return Promise.race([read(), deadline]).finally(() => clearTimeout(timer));
  };
  const read = async () => {
    try {
      if (platform === "linux") return { mounts: parseLinuxMounts(await readFile("/proc/self/mountinfo")) };
      if (platform === "darwin") return { mounts: parseMacMounts(await exec("mount", [])) };
      if (platform === "win32") {
        return { fixedDrives: parseWinDrives(await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN_DRIVES_COMMAND])) };
      }
    } catch {}
    return null;
  };
  return {
    get() {
      if (!cached || now() - at >= ttlMs) {
        cached = load();
        at = now();
      }
      return cached;
    },
  };
}

/** UNC paths and file://host URLs would make Windows contact a remote SMB server (and send the user's NTLM hash). */
export function isRemote(p) {
  return /^(\\\\|\/\/)/.test(p);
}

/** "~/x" and "~\\x" mean the home folder, as in a shell. */
export const expandHome = (p) => (p === "~" ? os.homedir() : /^~[\\/]/.test(p) ? path.join(os.homedir(), p.slice(2)) : p);

/** Resolve a link target from agent output to an existing local path: file:// URL, absolute or relative to the session folder. */
export async function resolveTarget(cwd, target) {
  const raw = String(target ?? "").trim();
  let candidates;
  if (/^file:/i.test(raw)) {
    const url = new URL(raw);
    if (url.host && url.host !== "localhost") throw new Error(`Remote file links are not opened: ${raw}`);
    url.hash = "";
    candidates = [fileURLToPath(url)]; // decodes %xx once
  } else {
    // Markdown links come percent-encoded (marked encodes spaces and non-ASCII); plain paths may contain a
    // literal '%' or '#'. Try the text as is and decoded, each with and without an editor-style line suffix.
    const noLine = (x) => x.replace(/#L\d+(-L?\d+)?$/, "").replace(/(:\d+){1,2}$/, "");
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {}
    // "README.md#usage": strip a "#anchor" after "name.ext", except a bare number ("v1.2#3"); tried after the literal
    // name, so "C#note.md" still opens
    const noFragment = (x) => x.replace(/(\.[A-Za-z0-9]+)#(?!\d+$)[^\s\\/#]+$/u, "$1");
    candidates = [...new Set([raw, noLine(raw), decoded, noLine(decoded), noFragment(decoded), noFragment(noLine(decoded))])];
  }
  const abs = candidates.map((c) => path.resolve(cwd || os.homedir(), expandHome(c)));
  if (candidates.some(isRemote) || abs.some(isRemote)) throw new Error(`Network paths are not opened: ${raw}`);
  for (const c of abs) {
    const real = await localRealpath(c);
    if (real) return real;
  }
  throw new Error(`File not found: ${abs[0]}`); // the path as clicked
}

/**
 * realpath that never touches the network: every symlink (or Windows junction) on the way is read with readlink
 * and refused if it points to a UNC / network path, before anything follows it. (fs.realpath or existsSync would
 * already open the SMB connection, which leaks the user's NTLM hash on Windows.) Returns null if the path doesn't exist.
 * allow(path) is asked about the starting path and about each symlink target before it is lstat()ed; false throws.
 */
export function localRealpath(p, { allow = () => true } = {}) {
  return realpathGuarded(p, allow, 0);
}

async function realpathGuarded(p, allow, depth) {
  if (depth > 32) throw new Error(`Too many symbolic links: ${p}`);
  if (!allow(p)) throw new Error(`Network paths are not opened: ${p}`);
  const { root } = path.parse(p);
  let cur = root;
  for (const part of p.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    const next = path.join(cur, part);
    // every component is checked as text before it is lstat()ed: a link to an ancestor of a mount leads into it
    if (!allow(next)) throw new Error(`Network paths are not opened: ${next}`);
    let st;
    try {
      st = await lstat(next); // async: a slow mount must not freeze the main process
    } catch {
      return null;
    }
    if (!st.isSymbolicLink()) {
      cur = next;
      continue;
    }
    let target = await readlink(next);
    if (/^\\\\\?\\UNC\\/i.test(target)) throw new Error(`Network paths are not opened: ${next} → ${target}`);
    target = target.replace(/^\\\\\?\\/, ""); // \\?\C:\x (Windows long-path form) is local
    const resolved = path.resolve(cur, target);
    if (isRemote(target) || isRemote(resolved)) throw new Error(`Network paths are not opened: ${next} → ${target}`);
    cur = await realpathGuarded(resolved, allow, depth + 1);
    if (!cur) return null;
  }
  return cur;
}

const MAX_CONCURRENT_CHECKS = 16;
const SNIFF_BYTES = 64 * 1024;
const HIGHLIGHT_MAX = 2 * 1024 * 1024;
const PLAIN_MAX = 20 * 1024 * 1024;

/** Does a relative candidate need a base to mean anything? "file:", "~" and absolute paths do not. */
function isSelfContained(c, platform) {
  const t = String(c ?? "").trim();
  return /^file:/i.test(t) || t === "~" || /^~[\\/]/.test(t) || (platform === "win32" ? path.win32 : path.posix).isAbsolute(t);
}

/**
 * Which of the candidate paths (from message text) are existing regular files? Decided from the text first
 * (relative ones need a base; allow() is asked about every step of the walk before it is lstat()ed), so an unchecked
 * candidate never touches the disk. Returns the accepted candidates as written, in order.
 */
export async function checkCandidates(candidates, { base, home, allow, platform = process.platform }) {
  const accepted = new Array(candidates.length).fill(false);
  const one = async (c) => {
    if (base == null && !isSelfContained(c, platform)) return false;
    const abs = lexicalPath(c, base ?? home, home, platform, { decode: false });
    if (!abs) return false;
    try {
      const real = await localRealpath(abs, { allow });
      return !!real && (await stat(real)).isFile();
    } catch {
      return false; // refused by allow(), unreadable or gone
    }
  };
  let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const i = next++;
      accepted[i] = await one(candidates[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_CHECKS, candidates.length) }, worker));
  return candidates.filter((_, i) => accepted[i]);
}

/** Read a file for the preview pane. Binary (a NUL in the first 64 KB) is decided before size, and a too-large file is never read whole. */
export async function readPreview(realPath) {
  const fh = await open(realPath, "r");
  try {
    const { size, mtimeMs } = await fh.stat();
    const head = Buffer.alloc(Math.min(size, SNIFF_BYTES));
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    if (head.subarray(0, bytesRead).includes(0)) return { tier: "binary", size, mtimeMs };
    if (size > PLAIN_MAX) return { tier: "too-large", size, mtimeMs };
    const buf = await fh.readFile();
    // TextDecoder replaces invalid UTF-8 and drops a leading BOM
    return { tier: size > HIGHLIGHT_MAX ? "plain" : "highlight", text: new TextDecoder("utf-8").decode(buf), size, mtimeMs };
  } finally {
    await fh.close();
  }
}

/**
 * The text of a clicked link for the preview. Outside the viewing session's folder (compared by real paths) nothing
 * is read until confirmed; the folder the link was written against (baseCwd) never lifts that.
 */
export async function resolvePreview({ baseCwd, target, viewingCwd, confirmed }, { isNetwork }) {
  const t = String(target ?? "").trim();
  // web and other URI schemes: "main.mjs:42" (file:line) and "C:\x" (drive) are paths, not schemes
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(t) && !/^file:/i.test(t) && !/^[a-z]:[\\/]/i.test(t)) return { notText: true };
  const real = await resolveTarget(baseCwd, t);
  if (await isNetwork(real)) return { notText: true };
  if (!(await stat(real)).isFile()) return { notText: true };
  if (!confirmed) {
    const root = viewingCwd ? await localRealpath(path.resolve(viewingCwd)).catch(() => null) : null;
    if (!root || !isInside(real, root)) return { outside: true, path: real };
  }
  const r = await readPreview(real);
  if (r.tier === "binary") return { notText: true };
  return { path: real, name: path.basename(real), ...r };
}
