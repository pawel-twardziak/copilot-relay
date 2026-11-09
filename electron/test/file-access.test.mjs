import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  allowsAutomaticCheck,
  checkCandidates,
  createLocationTable,
  isNetworkLocation,
  localRealpath,
  parseLinuxMounts,
  parseMacMounts,
  parseWinDrives,
  readPreview,
  resolvePreview,
  resolveTarget,
} from "../file-access.mjs";

test("linux table keeps only network mounts", () => {
  const t = "36 25 0:32 / /mnt/nfs rw - nfs4 srv:/x rw\n37 25 8:1 / / rw - ext4 /dev/sda1 rw\n38 25 0:40 / /net rw - autofs auto rw\n39 25 0:41 / /mnt/s rw - fuse.sshfs h:/ rw\n";
  assert.deepEqual(parseLinuxMounts(t), ["/mnt/nfs", "/net", "/mnt/s"]);
});
test("mac table", () => assert.deepEqual(parseMacMounts("/dev/disk1 on / (apfs, local)\n//u@h/s on /Volumes/s (smbfs, nodev)\n"), ["/Volumes/s"]));
test("windows drives accept object and array", () => {
  assert.deepEqual(parseWinDrives('{"DeviceID":"C:","DriveType":3}'), ["C:"]);
  assert.deepEqual(parseWinDrives('[{"DeviceID":"c:","DriveType":3},{"DeviceID":"Z:","DriveType":4}]'), ["C:"]);
});
test("network location is a path boundary match", () => {
  const t = { mounts: ["/mnt/nfs"] };
  assert.equal(isNetworkLocation("/mnt/nfs/a", t, "linux"), true);
  assert.equal(isNetworkLocation("/mnt/nfsx/a", t, "linux"), false);
});
test("windows counts only fixed drives", () => {
  const t = { fixedDrives: ["C:"] };
  assert.equal(isNetworkLocation("c:\\a", t, "win32"), false);
  assert.equal(isNetworkLocation("Z:\\a", t, "win32"), true);
});
test("no table fails closed", () => {
  const o = { table: null, trustedRoots: ["/home/u", "/p"], platform: "linux" };
  assert.equal(allowsAutomaticCheck("/p/a", o), true);
  assert.equal(allowsAutomaticCheck("/etc/hosts", o), false);
});
test("a table decides when present", () => {
  const o = { table: { mounts: ["/mnt/nfs"] }, trustedRoots: [], platform: "linux" };
  assert.equal(allowsAutomaticCheck("/etc/hosts", o), true);
  assert.equal(allowsAutomaticCheck("/mnt/nfs/a", o), false);
});
test("table is cached until ttl", async () => {
  let calls = 0;
  let t = 1000;
  const table = createLocationTable({
    platform: "darwin",
    exec: async () => (calls++, "//h/s on /Volumes/s (smbfs, nodev)\n"),
    ttlMs: 500,
    now: () => t,
  });
  assert.deepEqual(await table.get(), { mounts: ["/Volumes/s"] });
  t = 1400;
  await table.get();
  assert.equal(calls, 1);
  t = 1600;
  await table.get();
  assert.equal(calls, 2);
});
test("linux table reads mountinfo", async () => {
  const table = createLocationTable({ platform: "linux", readFile: async () => "36 25 0:32 / /mnt/nfs rw - nfs4 srv:/x rw\n" });
  assert.deepEqual(await table.get(), { mounts: ["/mnt/nfs"] });
});
test("a failing table source gives null", async () => {
  const table = createLocationTable({ platform: "linux", readFile: async () => Promise.reject(new Error("nope")) });
  assert.equal(await table.get(), null);
});
test("guard refuses before lstat of the starting path", async () => {
  const seen = [];
  await assert.rejects(localRealpath("/definitely/missing/path", { allow: (p) => (seen.push(p), false) }), /Network paths/);
  assert.deepEqual(seen, ["/definitely/missing/path"]);
});
test("default allow keeps a missing path as null", async () => {
  assert.equal(await localRealpath("/definitely/missing/path"), null);
});
test("guard refuses a symlink into a network location", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fa-"));
  try {
    await mkdir(path.join(dir, "net"));
    await writeFile(path.join(dir, "net", "f.txt"), "x");
    await symlink(path.join(dir, "net"), path.join(dir, "link"));
    const allow = (p) => !p.startsWith(path.join(dir, "net"));
    await assert.rejects(localRealpath(path.join(dir, "link", "f.txt"), { allow }), /Network paths/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("resolveTarget still finds relative, :line and #L targets", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fa-"));
  try {
    const real = await localRealpath(dir);
    await writeFile(path.join(dir, "a b.txt"), "x");
    assert.equal(await resolveTarget(dir, "a b.txt"), path.join(real, "a b.txt"));
    assert.equal(await resolveTarget(dir, "a%20b.txt:12:3"), path.join(real, "a b.txt"));
    assert.equal(await resolveTarget(dir, "a b.txt#L5-L9"), path.join(real, "a b.txt"));
    await assert.rejects(resolveTarget(dir, "nope.txt"), /File not found/);
    await assert.rejects(resolveTarget(dir, "//host/share/x"), /Network paths/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("dot-prefixed names under a mount are inside it", () => {
  const o = { table: { mounts: ["/mnt/nfs"] }, trustedRoots: [], platform: "linux" };
  assert.equal(allowsAutomaticCheck("/mnt/nfs/..x/y", o), false);
  assert.equal(allowsAutomaticCheck("/mnt/nfs/...", o), false);
  assert.equal(allowsAutomaticCheck("/mnt/nfsx/..x", o), true);
});
test("darwin compares mounts case-insensitively", () => {
  assert.equal(isNetworkLocation("/volumes/S/a", { mounts: ["/Volumes/s"] }, "darwin"), true);
  assert.equal(isNetworkLocation("/volumes/S/a", { mounts: ["/Volumes/s"] }, "linux"), false);
});
test("an unresolved .. counts as network", () => {
  const o = { table: { mounts: ["/mnt/nfs"] }, trustedRoots: [], platform: "linux" };
  assert.equal(allowsAutomaticCheck("/mnt/nfs/sub/../a", o), false);
  assert.equal(allowsAutomaticCheck("/home/../mnt/nfs/a", o), false);
});
test("guard refuses a link to an ancestor followed by the mount", async () => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "fa-")));
  try {
    await mkdir(path.join(dir, "net"));
    await writeFile(path.join(dir, "net", "f.txt"), "x");
    await symlink(dir, path.join(dir, "link"));
    const table = { mounts: [path.join(dir, "net")] };
    const allow = (p) => !isNetworkLocation(p, table, "linux");
    await assert.rejects(localRealpath(path.join(dir, "link", "net", "f.txt"), { allow }), /Network paths/);
    assert.equal(await localRealpath(path.join(dir, "link"), { allow }), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Run fn with a fresh temp folder (real path). */
async function withDir(fn) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "fa-")));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const MB = 1024 * 1024;
/** A text file whose first 64 KB are ordinary text, extended (sparse) to `size` bytes. */
async function textFileOfSize(file, size) {
  await writeFile(file, "hello\n".repeat(11000)); // 66,000 bytes: the whole 64 KB sniff window is text
  await truncate(file, size);
}
const never = async () => {
  throw new Error("isNetwork must not be asked");
};
const notNetwork = async () => false;

test("only existing files are returned", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "a.txt"), "x");
    await mkdir(path.join(dir, "dir"));
    const got = await checkCandidates(["a.txt", "dir", "missing.txt"], { base: dir, home: dir, allow: () => true, platform: "linux" });
    assert.deepEqual(got, ["a.txt"]);
  });
});
test("relative candidates need a base", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "a.txt"), "x");
    const abs = path.join(dir, "a.txt");
    const got = await checkCandidates(["a.txt", abs], { base: null, home: dir, allow: () => true, platform: "linux" });
    assert.deepEqual(got, [abs]);
  });
});
test("allow is consulted before the disk", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "a.txt"), "x");
    const asked = [];
    const allow = (p) => (asked.push(p), false);
    const got = await checkCandidates([path.join(dir, "a.txt")], { base: null, home: dir, allow, platform: "linux" });
    assert.deepEqual(got, []);
    assert.deepEqual(asked, [path.join(dir, "a.txt")]); // refused at the first question: nothing was lstat()ed
  });
});
test("allow guards every step of the walk", async () => {
  await withDir(async (dir) => {
    await mkdir(path.join(dir, "net"));
    await writeFile(path.join(dir, "net", "f.txt"), "x");
    await symlink(dir, path.join(dir, "link"));
    const allow = (p) => !p.startsWith(path.join(dir, "net"));
    const got = await checkCandidates([path.join(dir, "link", "net", "f.txt")], { base: null, home: dir, allow, platform: "linux" });
    assert.deepEqual(got, []);
  });
});
test("at most 16 lookups run at once", async () => {
  await withDir(async (dir) => {
    for (let i = 0; i < 40; i++) await writeFile(path.join(dir, `f${i}.txt`), "x");
    // allow() is asked about a candidate's full path first (walk start) and again for its last component, just
    // before its lstat(): between the two the lookup counts as running
    const seen = new Set();
    let running = 0;
    let peak = 0;
    const allow = (p) => {
      if (!/f\d+\.txt$/.test(p)) return true;
      if (seen.has(p)) running--;
      else {
        seen.add(p);
        peak = Math.max(peak, ++running);
      }
      return true;
    };
    const names = Array.from({ length: 40 }, (_, i) => `f${i}.txt`);
    const got = await checkCandidates(names, { base: dir, home: dir, allow, platform: "linux" });
    assert.equal(got.length, 40);
    assert.ok(peak > 1 && peak <= 16, `peak ${peak}`);
  });
});

test("preview tiers", async () => {
  await withDir(async (dir) => {
    const tier = async (name, size) => {
      const f = path.join(dir, name);
      await textFileOfSize(f, size);
      const r = await readPreview(f);
      assert.equal(r.size, size);
      return r;
    };
    assert.equal((await tier("a", 2 * MB)).tier, "highlight");
    assert.equal((await tier("b", 2 * MB + 1)).tier, "plain");
    assert.equal((await tier("c", 20 * MB)).tier, "plain");
    const big = await tier("d", 20 * MB + 1);
    assert.equal(big.tier, "too-large");
    assert.equal(big.text, undefined);
    assert.ok(Number.isFinite(big.mtimeMs));
  });
});
test("a large binary is binary, not too-large", async () => {
  await withDir(async (dir) => {
    const f = path.join(dir, "big.bin");
    await writeFile(f, ""); // all NUL after extending
    await truncate(f, 21 * MB);
    assert.equal((await readPreview(f)).tier, "binary");
  });
});
test("NUL in the first 64 KB is binary", async () => {
  await withDir(async (dir) => {
    const inside = Buffer.alloc(100, 0x61);
    inside[99] = 0;
    await writeFile(path.join(dir, "in"), inside);
    assert.equal((await readPreview(path.join(dir, "in"))).tier, "binary");
    const beyond = Buffer.alloc(64 * 1024 + 10, 0x61);
    beyond[64 * 1024 + 5] = 0;
    await writeFile(path.join(dir, "out"), beyond);
    const r = await readPreview(path.join(dir, "out"));
    assert.equal(r.tier, "highlight");
    assert.equal(r.text.length, beyond.length);
  });
});
test("BOM is removed and an empty file is text", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "bom"), "\uFEFFabc");
    assert.equal((await readPreview(path.join(dir, "bom"))).text, "abc");
    await writeFile(path.join(dir, "empty"), "");
    const r = await readPreview(path.join(dir, "empty"));
    assert.equal(r.tier, "highlight");
    assert.equal(r.text, "");
    assert.equal(r.size, 0);
  });
});
test("invalid UTF-8 is replaced", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "bad"), Buffer.from([0xff, 0x41]));
    const r = await readPreview(path.join(dir, "bad"));
    assert.equal(r.text, "\uFFFDA");
  });
});

test("inside the viewing folder opens without confirmation", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "a.txt"), "hi");
    const r = await resolvePreview({ baseCwd: dir, target: "a.txt", viewingCwd: dir }, { isNetwork: notNetwork });
    assert.equal(r.text, "hi");
    assert.equal(r.path, path.join(dir, "a.txt"));
    assert.equal(r.name, "a.txt");
    assert.equal(r.tier, "highlight");
    assert.equal(r.size, 2);
  });
});
test("outside needs confirmation", async () => {
  await withDir(async (dir) => {
    await mkdir(path.join(dir, "view"));
    await writeFile(path.join(dir, "o.txt"), "secret");
    const args = { baseCwd: dir, target: "o.txt", viewingCwd: path.join(dir, "view") };
    assert.deepEqual(await resolvePreview(args, { isNetwork: notNetwork }), { outside: true, path: path.join(dir, "o.txt") });
    const r = await resolvePreview({ ...args, confirmed: true }, { isNetwork: notNetwork });
    assert.equal(r.text, "secret");
  });
});
test("a folder that only shares a name prefix is outside", async () => {
  await withDir(async (dir) => {
    await mkdir(path.join(dir, "view"));
    await mkdir(path.join(dir, "view2"));
    await writeFile(path.join(dir, "view2", "o.txt"), "x");
    const r = await resolvePreview({ baseCwd: dir, target: "view2/o.txt", viewingCwd: path.join(dir, "view") }, { isNetwork: notNetwork });
    assert.equal(r.outside, true);
  });
});
test("symlink pointing outside needs confirmation", async () => {
  await withDir(async (dir) => {
    await mkdir(path.join(dir, "view"));
    await writeFile(path.join(dir, "o.txt"), "secret");
    await symlink(path.join(dir, "o.txt"), path.join(dir, "view", "link.txt"));
    const args = { baseCwd: path.join(dir, "view"), target: "link.txt", viewingCwd: path.join(dir, "view") };
    assert.deepEqual(await resolvePreview(args, { isNetwork: notNetwork }), { outside: true, path: path.join(dir, "o.txt") });
  });
});
test("a symlinked viewing folder is compared by real paths", async () => {
  await withDir(async (dir) => {
    await mkdir(path.join(dir, "real"));
    await writeFile(path.join(dir, "real", "a.txt"), "hi");
    await symlink(path.join(dir, "real"), path.join(dir, "alias"));
    const r = await resolvePreview({ baseCwd: dir, target: "real/a.txt", viewingCwd: path.join(dir, "alias") }, { isNetwork: notNetwork });
    assert.equal(r.text, "hi");
  });
});
test("relay base does not lift confirmation", async () => {
  await withDir(async (dir) => {
    await mkdir(path.join(dir, "relay"));
    await mkdir(path.join(dir, "view"));
    await writeFile(path.join(dir, "relay", "r.txt"), "x");
    const r = await resolvePreview({ baseCwd: path.join(dir, "relay"), target: "r.txt", viewingCwd: path.join(dir, "view") }, { isNetwork: notNetwork });
    assert.deepEqual(r, { outside: true, path: path.join(dir, "relay", "r.txt") });
  });
});
test("directory, binary and network targets are not text", async () => {
  await withDir(async (dir) => {
    await mkdir(path.join(dir, "sub"));
    await writeFile(path.join(dir, "b.bin"), Buffer.from([1, 0, 2]));
    await writeFile(path.join(dir, "n.txt"), "x");
    const base = { baseCwd: dir, viewingCwd: dir };
    assert.deepEqual(await resolvePreview({ ...base, target: "sub" }, { isNetwork: notNetwork }), { notText: true });
    assert.deepEqual(await resolvePreview({ ...base, target: "b.bin" }, { isNetwork: notNetwork }), { notText: true });
    assert.deepEqual(await resolvePreview({ ...base, target: "n.txt", confirmed: true }, { isNetwork: async () => true }), { notText: true });
  });
});
test("web links are not text", async () => {
  for (const target of ["https://x", "mailto:a@b.c", "ftp://h/f"]) {
    assert.deepEqual(await resolvePreview({ baseCwd: "/", target, viewingCwd: "/" }, { isNetwork: never }), { notText: true });
  }
});
test("a deleted file rejects with File not found", async () => {
  await withDir(async (dir) => {
    await assert.rejects(resolvePreview({ baseCwd: dir, target: "gone.txt", viewingCwd: dir }, { isNetwork: notNetwork }), /File not found/);
  });
});

test("without a location table only trusted roots (and the way to them) are checked", async () => {
  await withDir(async (dir) => {
    await mkdir(path.join(dir, "root"));
    await mkdir(path.join(dir, "sibling"));
    await writeFile(path.join(dir, "root", "a.txt"), "x");
    await writeFile(path.join(dir, "sibling", "b.txt"), "x");
    const trustedRoots = [path.join(dir, "root")];
    const allow = (p) => allowsAutomaticCheck(p, { table: null, trustedRoots, platform: "linux" });
    const inside = path.join(dir, "root", "a.txt");
    const sibling = path.join(dir, "sibling", "b.txt");
    const got = await checkCandidates([inside, sibling, "/etc/hostname"], { base: null, home: dir, allow, platform: "linux" });
    assert.deepEqual(got, [inside]);
  });
});
test("a location table that hangs yields null at the deadline", async () => {
  const table = createLocationTable({ platform: "darwin", readFile: async () => "", exec: () => new Promise(() => {}), timeoutMs: 20 });
  assert.equal(await table.get(), null);
});
