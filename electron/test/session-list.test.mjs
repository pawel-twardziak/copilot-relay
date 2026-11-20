// Tests for Copilot's paged session/list loop (electron/session-list.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_PAGES, listAllPages } from "../session-list.mjs";

/** A fake session/list: `pages` answers in order, each { sessions, nextCursor }; records the params asked with. */
function lister(pages) {
  const asked = [];
  const request = async (method, params) => {
    assert.equal(method, "session/list");
    asked.push(params);
    return pages[asked.length - 1] ?? { sessions: [] };
  };
  return { request, asked };
}

test("follows cursors to the last page and is complete", async () => {
  const { request, asked } = lister([{ sessions: [{ sessionId: "a" }], nextCursor: "c1" }, { sessions: [{ sessionId: "b" }] }]);
  const res = await listAllPages(request);
  assert.deepEqual(res, { sessions: [{ sessionId: "a" }, { sessionId: "b" }], complete: true });
  assert.deepEqual(asked, [{}, { cursor: "c1" }]);
});

test("stops at the page cap with a cursor left: complete is false", async () => {
  const pages = Array.from({ length: MAX_PAGES + 5 }, (_, i) => ({ sessions: [{ sessionId: `s${i}` }], nextCursor: `c${i}` }));
  const { request, asked } = lister(pages);
  const res = await listAllPages(request);
  assert.equal(MAX_PAGES, 50);
  assert.equal(asked.length, MAX_PAGES);
  assert.equal(res.sessions.length, MAX_PAGES);
  assert.equal(res.complete, false);
});

test("a page without sessions counts; onPage sees every page's sessions", async () => {
  const seen = [];
  const { request } = lister([{ nextCursor: "c1" }, { sessions: [{ sessionId: "x", cwd: "/w" }] }]);
  const res = await listAllPages(request, { onPage: (list) => seen.push(list.length) });
  assert.deepEqual(seen, [0, 1]);
  assert.equal(res.complete, true);
});
