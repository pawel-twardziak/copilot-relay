// Tests for the pure sub-session tree model in electron/renderer/session-tree.js.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const SessionTree = createRequire(import.meta.url)("../renderer/session-tree.js");
const { index, descendants, closeOrder, relation, pruneCandidates } = SessionTree;

const L = (id, parent = null, createdAt = 0, extra = {}) => ({
  key: `cli:${id}`,
  parent: parent && `cli:${parent}`,
  createdAt,
  parentDeleted: false,
  ...extra,
});
const S = (sessionId) => ({ sessionId });

test("index maps parents and children by createdAt, ignoring non-cli keys", () => {
  const idx = index([L("b", "p", 2), L("a", "p", 1), { key: "other:x", parent: "cli:p", createdAt: 0 }]);
  assert.deepEqual(idx.childrenOf.get("p"), ["a", "b"]);
  assert.equal(idx.parentOf.get("a"), "p");
  assert.equal(idx.parentOf.get("p") ?? null, null);
  assert.ok(!idx.link.has("x"));
});

test("a parentDeleted link has no parent", () => {
  const idx = index([L("a", "gone", 1, { parentDeleted: true })]);
  assert.equal(idx.parentOf.get("a"), null);
  assert.equal(idx.childrenOf.has("gone"), false);
});

test("descendants terminates on a cycle", () => {
  const idx = index([L("a", "b", 1), L("b", "a", 2), L("c", "c", 3), L("d", "c", 4)]);
  assert.deepEqual(descendants(idx, "a").sort(), ["b"]);
  assert.deepEqual(descendants(idx, "c"), ["d"]);
});

test("descendants is depth-first", () => {
  const idx = index([L("a", "p", 1), L("b", "p", 3), L("c", "a", 2)]);
  assert.deepEqual(descendants(idx, "p"), ["a", "c", "b"]);
});

test("closeOrder lists open descendants deepest first", () => {
  const idx = index([L("a", "p", 1), L("b", "p", 3), L("c", "a", 2), L("d", "c", 4)]);
  assert.deepEqual(closeOrder(idx, "p", () => true), ["d", "c", "a", "b"]);
  assert.deepEqual(closeOrder(idx, "p", (id) => id !== "c"), ["d", "a", "b"]);
});

test("relation gives parent, orphan flag and grandchild counts", () => {
  const idx = index([L("a", "p", 1), L("b", "p", 2), L("c", "a", 3), L("o", "gone", 4, { parentDeleted: true })]);
  assert.deepEqual(relation(idx, "p"), {
    parent: null,
    parentDeleted: false,
    children: [{ id: "a", grandchildren: 1 }, { id: "b", grandchildren: 0 }],
  });
  assert.equal(relation(idx, "a").parent, "p");
  assert.deepEqual(relation(idx, "o"), { parent: null, parentDeleted: true, children: [] });
});

test("pruneCandidates is empty when the list is not ok", () => {
  assert.deepEqual(pruneCandidates([L("a")], [], { listOk: false }), []);
});

test("pruneCandidates returns only cli keys missing from the list", () => {
  const links = [L("a"), L("b"), { key: "other:z", parent: null }];
  assert.deepEqual(pruneCandidates(links, [S("a")], { listOk: true }), ["cli:b"]);
});

test("a link that names itself as parent is not its own child", () => {
  const idx = index([L("c", "c", 1), L("d", "c", 2)]);
  assert.deepEqual(idx.childrenOf.get("c"), ["d"]);
  assert.deepEqual(relation(idx, "c").children, [{ id: "d", grandchildren: 0 }]);
});

test("pruneCandidates skips excluded sessions", () => {
  const links = [L("a"), L("b"), L("c")];
  assert.deepEqual(pruneCandidates(links, [S("x")], { listOk: true, exclude: new Set(["a", "c"]) }), ["cli:b"]);
});

test("pruneCandidates includes a missing parent once, but not the parent of an orphan", () => {
  const links = [L("a", "p", 1), L("b", "p", 2), L("o", "gone", 3, { parentDeleted: true })];
  assert.deepEqual(pruneCandidates(links, [S("a"), S("b"), S("o")], { listOk: true }), ["cli:p"]);
  assert.deepEqual(pruneCandidates(links, [S("a"), S("b"), S("o")], { listOk: true, exclude: new Set(["p"]) }), []);
});

test("pruneCandidates never reports an online link, also not as a parent", () => {
  const links = [L("c", null, 1, { online: true }), L("g", "m", 2), L("m", null, 3, { online: true })];
  assert.deepEqual(pruneCandidates(links, [S("g")], { listOk: true }), []);
});

test("pruneCandidates prunes nothing when the list is empty while links exist", () => {
  assert.deepEqual(pruneCandidates([L("a"), L("b", "a")], [], { listOk: true }), []);
});

test("pruneCandidates prunes nothing when more than half of the known cli keys would go", () => {
  const links = [L("a"), L("b"), L("c"), L("d")];
  assert.deepEqual(pruneCandidates(links, [S("a"), S("b")], { listOk: true }).sort(), ["cli:c", "cli:d"]); // half: ok
  assert.deepEqual(pruneCandidates(links, [S("a")], { listOk: true }), []); // 3 of 4: suspicious list
  // parents count as known keys too
  assert.deepEqual(pruneCandidates([L("k", "p")], [S("k")], { listOk: true }), ["cli:p"]); // 1 of 2 (k and its parent p)
  assert.deepEqual(pruneCandidates([L("k", "p")], [S("x")], { listOk: true }), []); // 2 of 2
});
