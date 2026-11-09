import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  allowsAutomaticCheck,
  createLocationTable,
  isNetworkLocation,
  localRealpath,
  parseLinuxMounts,
  parseMacMounts,
  parseWinDrives,
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
