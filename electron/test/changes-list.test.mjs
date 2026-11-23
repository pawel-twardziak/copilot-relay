// Tests for the changes browser's list in electron/renderer/changes-list.js, drawn with a plain-object h.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ChangesModel = require("../renderer/changes-model.js"); // sets globalThis.ChangesModel for changes-list.js
const ChangesList = require("../renderer/changes-list.js");
const h = (tag, props, ...kids) => ({ tag, props: props ?? {}, kids: kids.flat(Infinity).filter((k) => k != null && k !== false && k !== "") });
const all = (n, cls, out = []) => {
  if (n && typeof n === "object") {
    if (String(n.props.class ?? "").split(" ").includes(cls)) out.push(n);
    n.kids.forEach((k) => all(k, cls, out));
  }
  return out;
};
const text = (n) => (typeof n === "string" ? n : n.kids.map(text).join(""));
const file = (p, extra = {}) => ({ path: p, state: "M", uncommitted: true, committed: false, touched: false, dirtyAtStart: false, ...extra });
const data = { repos: [{ root: "/r", name: "r", files: [file("a.txt", { committed: true }), file("b.txt")] }], loose: ["/tmp/l.txt"] };
const KA = ChangesModel.key("/r", "a.txt");
const commits = [{ sha: "a1b2c3d4", subject: "two", author: "Ann", date: "d2" }, { sha: "e5f6a7b8", subject: "one", author: "Bob", date: "d1" }];
const draw = (over = {}) => ({ tag: "root", props: {}, kids: ChangesList.render(data, { h, sel: null, isShut: () => false, isUnfolded: () => false, commitsOf: () => undefined, on: {}, ...over }) });

test("an arrow only for a file with commits; folded shows none of them", () => {
  const root = draw();
  assert.deepEqual(all(root, "fp-row").map((r) => text(all(r, "fp-arrow")[0])), ["▸", "", ""]);
  assert.equal(all(root, "fp-commit").length, 0);
});

test("an unfolded file lists its commits, newest first, and the selection marks one row", () => {
  const root = draw({ sel: { key: KA, version: "e5f6a7b8" }, isUnfolded: (k) => k === KA, commitsOf: () => commits });
  assert.deepEqual(all(root, "fp-commit").map(text), ["a1b2c3d two", "e5f6a7b one"]);
  assert.equal(all(root, "fp-commit")[1].props.title, "Bob · d1");
  assert.deepEqual(all(root, "active").map(text), ["e5f6a7b one"]);
  assert.equal(all(root, "current").length, 1); // its file row
  assert.equal(text(all(all(root, "fp-row")[0], "fp-arrow")[0]), "▾");
  const plain = draw({ sel: { key: KA, version: "uncommitted" } });
  assert.equal(all(plain, "active").length, 1);
  assert.equal(all(plain, "current").length, 0);
});

test("an unfolded file whose commits are loading, failed or none", () => {
  const notes = (value) => all(draw({ isUnfolded: (k) => k === KA, commitsOf: () => value }), "fp-commits")[0];
  assert.equal(text(notes("loading")), "Reading…");
  assert.equal(text(notes(undefined)), "Reading…");
  assert.equal(text(notes({ error: "git failed" })), "git failed");
  assert.equal(all(notes({ error: "git failed" }), "err").length, 1);
  assert.equal(text(notes([])), "No commits.");
});

test("the arrow unfolds without selecting; the row and a commit select", () => {
  const calls = [];
  const on = { select: (k) => calls.push(["select", k]), unfold: (k) => calls.push(["unfold", k]), commit: (k, sha) => calls.push(["commit", k, sha]) };
  const root = draw({ on, isUnfolded: (k) => k === KA, commitsOf: () => commits });
  let stopped = false;
  all(root, "fp-arrow")[0].props.onclick({ stopPropagation: () => (stopped = true) });
  all(root, "fp-row")[0].props.onclick({});
  all(root, "fp-commit")[0].props.onclick({});
  assert.equal(stopped, true);
  assert.deepEqual(calls, [["unfold", KA], ["select", KA], ["commit", KA, "a1b2c3d4"]]);
});
