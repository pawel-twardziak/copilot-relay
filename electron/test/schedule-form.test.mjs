// Tests for the pure schedule form helpers in electron/renderer/schedule-form.js.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const SF = createRequire(import.meta.url)("../renderer/schedule-form.js");
const { presetToCron, cronToPreset, describeSchedule, NOTIFY_LABELS, ago, EVERY_MINUTES, EVERY_HOURS } = SF;

test("constants", () => {
  assert.deepEqual(EVERY_MINUTES, [1, 2, 5, 10, 15, 30]);
  assert.deepEqual(EVERY_HOURS, [1, 2, 3, 4, 6, 8, 12]);
  assert.equal(NOTIFY_LABELS.result, "When there is a result or an error");
});

test("presetToCron shapes", () => {
  assert.equal(presetToCron({ kind: "minutes", n: 1 }), "* * * * *");
  assert.equal(presetToCron({ kind: "minutes", n: 5 }), "*/5 * * * *");
  assert.equal(presetToCron({ kind: "hours", n: 1 }), "0 * * * *");
  assert.equal(presetToCron({ kind: "hours", n: 2 }), "0 */2 * * *");
  assert.equal(presetToCron({ kind: "daily", hh: 8, mm: 5 }), "5 8 * * *");
  assert.equal(presetToCron({ kind: "weekdays", days: [5, 1, 3], hh: 8, mm: 0 }), "0 8 * * 1,3,5");
  assert.equal(presetToCron({ kind: "custom", expr: "1 2 3 4 5" }), "1 2 3 4 5");
});

test("round-trips every preset kind", () => {
  for (const p of [
    { kind: "minutes", n: 1 },
    { kind: "minutes", n: 15 },
    { kind: "hours", n: 1 },
    { kind: "hours", n: 6 },
    { kind: "daily", hh: 8, mm: 30 },
    { kind: "weekdays", days: [1, 3, 5], hh: 8, mm: 0 },
    { kind: "custom", expr: "0 0 1 * *" },
  ]) assert.deepEqual(cronToPreset(presetToCron(p)), p);
});

test("cronToPreset edge cases", () => {
  assert.equal(cronToPreset("*/7 * * * *").kind, "custom");
  assert.equal(cronToPreset("0 */5 * * *").kind, "custom");
  assert.equal(cronToPreset("60 8 * * *").kind, "custom");
  assert.equal(cronToPreset("0 24 * * *").kind, "custom");
  assert.deepEqual(cronToPreset("0 8 * * 1-5"), { kind: "weekdays", days: [1, 2, 3, 4, 5], hh: 8, mm: 0 });
  assert.deepEqual(cronToPreset("  0   8 * *  * "), { kind: "daily", hh: 8, mm: 0 });
  assert.deepEqual(cronToPreset(" 1  2 3 * * "), { kind: "custom", expr: "1 2 3 * *" });
});

test("describeSchedule", () => {
  assert.equal(describeSchedule("* * * * *"), "every minute");
  assert.equal(describeSchedule("*/5 * * * *"), "every 5 minutes");
  assert.equal(describeSchedule("0 * * * *"), "every hour");
  assert.equal(describeSchedule("0 */2 * * *"), "every 2 hours");
  assert.equal(describeSchedule("0 8 * * *"), "daily at 08:00");
  assert.equal(describeSchedule("0 8 * * 1-5"), "weekdays at 08:00");
  assert.equal(describeSchedule("0 8 * * 1,3,5"), "Mon, Wed, Fri at 08:00");
  assert.equal(describeSchedule("  1 2 3 * *  "), "1 2 3 * *");
});

test("ago boundaries", () => {
  const now = Date.parse("2026-11-19T12:00:00Z");
  const at = (ms) => new Date(now - ms).toISOString();
  assert.equal(ago(at(59_000), now), "just now");
  assert.equal(ago(at(60_000), now), "1 min ago");
  assert.equal(ago(at(59 * 60_000 + 59_000), now), "59 min ago");
  assert.equal(ago(at(60 * 60_000), now), "1 h ago");
  assert.equal(ago(at(24 * 3600_000 - 1000), now), "23 h ago");
  assert.equal(ago(at(24 * 3600_000), now), "1 d ago");
  assert.equal(ago(at(3 * 86400_000 + 5000), now), "3 d ago");
  assert.equal(ago(at(-5000), now), "just now");
});
