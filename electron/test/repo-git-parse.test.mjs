// Tests for the parsers of git output.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommits, parseNameStatus, parseStatus } from "../repo-git.mjs";

test("status: states, rename, folder entry, odd names", () => {
  const text = [" M a b.txt", "A  new.txt", " D gone.txt", "?? zażółć.md", "R  to.txt", "from.txt", "?? nested/", "UU both.txt", "!! ignored.log", ""].join("\0");
  assert.deepEqual(parseStatus(text), [
    { path: "a b.txt", state: "M" }, { path: "new.txt", state: "A" }, { path: "gone.txt", state: "D" },
    { path: "zażółć.md", state: "?" }, { path: "to.txt", state: "R" }, { path: "both.txt", state: "M" },
  ]);
});
test("name-status: newest state wins, rename gives the new path", () => {
  const text = ["M", "a.txt", "R100", "old.txt", "b.txt", "A", "a.txt", "D", "c.txt", ""].join("\0");
  assert.deepEqual(parseNameStatus(text), [{ path: "a.txt", state: "M" }, { path: "b.txt", state: "R" }, { path: "c.txt", state: "D" }]);
});
test("commits", () => {
  const text = "aaa\x1ffix: x\x1f2026-11-22T10:00:00+01:00\x1fAnn\x1e\nbbb\x1ffeat: y, z\x1f2026-11-21T09:00:00+01:00\x1fBob\x1e\n";
  assert.deepEqual(parseCommits(text), [
    { sha: "aaa", subject: "fix: x", date: "2026-11-22T10:00:00+01:00", author: "Ann" },
    { sha: "bbb", subject: "feat: y, z", date: "2026-11-21T09:00:00+01:00", author: "Bob" },
  ]);
  assert.deepEqual(parseCommits(""), []);
});
