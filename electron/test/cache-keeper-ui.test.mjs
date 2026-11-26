// Tests for the pure helpers of the cache keeper's window parts in electron/renderer/cache-keeper.js.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const { clock, chipView, settingsOfForm } = createRequire(import.meta.url)("../renderer/cache-keeper.js");

test("clock", () => {
  assert.equal(clock(42_000), "0:42");
  assert.equal(clock(41_100), "0:42"); // rounded up
  assert.equal(clock(125_000), "2:05");
  assert.equal(clock(-5), "0:00");
});

test("chipView", () => {
  assert.deepEqual(chipView({ phase: "pinging", pingsSent: 3, pings: 6 }, 0), { text: "♻ Keeping the cache warm (3/6)", notNow: true });
  assert.deepEqual(chipView({ phase: "countdown", compactAt: 100_000 }, 58_000), { text: "⏳ Compacting in 0:42", notNow: true });
  assert.deepEqual(chipView({ phase: "compacting" }, 0), { text: "⏳ Compacting…", notNow: false });
  for (const phase of ["off", "idle", "done"]) assert.equal(chipView({ phase }, 0), null);
  assert.equal(chipView(null, 0), null);
});

test("settingsOfForm", () => {
  assert.deepEqual(settingsOfForm({ enabled: true, pings: "6", minContextK: "50" }), { enabled: true, pings: 6, minContext: 50_000 });
  assert.deepEqual(settingsOfForm({ enabled: false, pings: "", minContextK: "12.5" }), { enabled: false, pings: 0, minContext: 12_500 });
  assert.deepEqual(settingsOfForm({ enabled: true, pings: "x", minContextK: "" }), { enabled: true, pings: 0, minContext: "" });
  assert.equal(settingsOfForm({ enabled: true, pings: "600", minContextK: "50" }).pings, 20);
});
