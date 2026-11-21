// Tests for the activity panel setting (electron/activity-panel.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizePanelMode } from "../activity-panel.mjs";

test("normalizePanelMode keeps the three modes and turns anything else into off", () => {
  for (const m of ["off", "subagents", "all"]) assert.equal(normalizePanelMode(m), m);
  for (const v of [undefined, null, "", "ALL", "panel", true, 1, {}]) assert.equal(normalizePanelMode(v), "off");
});
