// Tests for the pure sub-session tree model in electron/renderer/session-tree.js.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const SessionTree = createRequire(import.meta.url)("../renderer/session-tree.js");
const { index, descendants, closeOrder, nest, relation, pruneCandidates } = SessionTree;

const L = (id, parent = null, createdAt = 0, extra = {}) => ({
  key: `cli:${id}`,
  parent: parent && `cli:${parent}`,
  createdAt,
  parentDeleted: false,
  ...extra,
});
const S = (sessionId) => ({ sessionId });
const flat = (list) => list.map(({ s, depth }) => `${s.sessionId}:${depth}`);

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

test("nest puts children under their parent within a group", () => {
  const idx = index([L("a", "p", 1), L("b", "p", 3), L("c", "a", 2)]);
  assert.deepEqual(flat(nest([S("p"), S("b"), S("c"), S("a")], idx)), ["p:0", "a:1", "c:2", "b:1"]);
});

test("a child whose parent is in another group stays at depth 0", () => {
  const idx = index([L("a", "p", 1)]);
  assert.deepEqual(flat(nest([S("a"), S("z")], idx)), ["a:0", "z:0"]);
});

test("nest and descendants terminate on a cycle, emitting each session once", () => {
  const idx = index([L("a", "b", 1), L("b", "a", 2), L("c", "c", 3), L("d", "c", 4)]);
  const out = flat(nest([S("a"), S("b"), S("c"), S("d")], idx));
  assert.equal(out.length, 4);
  assert.deepEqual(out.map((x) => x.split(":")[0]).sort(), ["a", "b", "c", "d"]);
  assert.deepEqual(descendants(idx, "a").sort(), ["b"]);
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
