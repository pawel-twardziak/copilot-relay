// passesAutomaticCheck: the automatic-check rule applied as files:check applies it, to every component and every
// link target on the way (the changes browser's trigger runs git where a path leads).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { allowsAutomaticCheck, passesAutomaticCheck } from "../file-access.mjs";

// <tmp>/home is trusted (as without a location table); <tmp>/nas, its sibling, is refused
async function folders(t) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "auto-check-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const nas = path.join(dir, "nas");
  await mkdir(path.join(home, "repo"), { recursive: true });
  await mkdir(path.join(nas, "repo"), { recursive: true });
  await writeFile(path.join(home, "repo", "a.txt"), "x");
  await writeFile(path.join(nas, "repo", "a.txt"), "x");
  const allow = (p) => allowsAutomaticCheck(p, { table: null, trustedRoots: [home] });
  return { home, nas, allow };
}

test("a path in an allowed folder passes", async (t) => {
  const { home, allow } = await folders(t);
  assert.equal(await passesAutomaticCheck(path.join(home, "repo", "a.txt"), allow), true);
});

test("a path in a refused folder does not pass", async (t) => {
  const { nas, allow } = await folders(t);
  assert.equal(await passesAutomaticCheck(path.join(nas, "repo", "a.txt"), allow), false);
});

test("a link in an allowed folder that leads into a refused one does not pass", { skip: process.platform === "win32" }, async (t) => {
  const { home, nas, allow } = await folders(t);
  await symlink(path.join(nas, "repo"), path.join(home, "link"));
  assert.equal(allow(path.join(home, "link", "a.txt")), true, "the path as text is allowed");
  assert.equal(await passesAutomaticCheck(path.join(home, "link", "a.txt"), allow), false);
  assert.equal(await passesAutomaticCheck(path.join(home, "link"), allow), false);
});

test("a path that does not exist yet in an allowed folder passes", async (t) => {
  const { home, allow } = await folders(t);
  assert.equal(await passesAutomaticCheck(path.join(home, "repo", "new", "notes.txt"), allow), true);
});
