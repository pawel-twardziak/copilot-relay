// Network-location rules and safe path resolution, without importing electron so tests can load it.
// Text written by an agent must never make the main process touch a network location (a mapped drive, an NFS or
// SMB mount, an automount) without a click: the guard runs on the path text before anything is lstat()ed.
import { lstat, readlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isInside } from "./paths.mjs";

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

/** Without a table (it could not be read) only the trusted roots pass, compared by text. */
export function allowsAutomaticCheck(abs, { table, trustedRoots, platform = process.platform }) {
  if (!table) return trustedRoots.some((r) => isInside(abs, r, platform));
  return !isNetworkLocation(abs, table, platform);
}

const WIN_DRIVES_COMMAND = "Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,DriveType | ConvertTo-Json";

/**
 * Cached view of the network locations. readFile(path) and exec(file, args) return text asynchronously.
 * get() resolves null when the source cannot be read or the platform is unknown.
 */
export function createLocationTable({ platform, readFile, exec, ttlMs = 30000, now = Date.now }) {
  let cached = null;
  let at = 0;
  const load = async () => {
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
