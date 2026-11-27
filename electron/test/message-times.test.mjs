// Tests for the pure helpers behind message times (electron/renderer/message-times.js).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const MT = createRequire(import.meta.url)("../renderer/message-times.js");
const at = (y, mo, d, h, mi, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime(); // local: holds in any time zone

test("clock: HH:MM, 24-hour, zero-padded, never locale-formatted", () => {
  assert.equal(MT.clock(at(2026, 11, 21, 20, 22, 59)), "20:22");
  assert.equal(MT.clock(at(2026, 11, 21, 0, 5)), "00:05");
  assert.equal(MT.clock(at(2026, 11, 21, 9, 0)), "09:00");
});

test("dayKey and newDay: local calendar days", () => {
  assert.equal(MT.dayKey(at(2026, 11, 21, 23, 59)), "2026-11-21");
  assert.equal(MT.dayKey(at(2026, 1, 5, 0, 0)), "2026-01-05");
  assert.equal(MT.newDay(null, at(2026, 11, 21, 10, 0)), true);
  assert.equal(MT.newDay(at(2026, 11, 21, 23, 59), at(2026, 11, 22, 0, 0)), true);
  assert.equal(MT.newDay(at(2026, 11, 21, 0, 0), at(2026, 11, 21, 23, 59)), false);
});

test("dayLabel: short weekday, day, short month, year", () => {
  assert.match(MT.dayLabel(at(2026, 11, 21, 12, 0), "en-GB"), /^Sat,? 21 Nov 2026$/);
});

test("dayLabel: en-GB when no locale is given, whatever the system locale", () => {
  assert.match(MT.dayLabel(at(2026, 11, 21, 12, 0)), /^Sat,? 21 Nov 2026$/);
});

test("full: the local date and time, in en-GB", () => {
  const ms = at(2026, 11, 21, 20, 22, 59);
  assert.equal(MT.full(ms), "21/11/2026, 20:22:59");
});

test("assign: users by ordinal, agents by messageId", () => {
  const times = { users: [1, 2], agents: { a: 10, b: 20 } };
  const items = [{ kind: "user" }, { kind: "agent", messageId: "a" }, { kind: "agent" }, { kind: "user" }, { kind: "agent", messageId: "zz" }, { kind: "agent", messageId: "b" }];
  assert.deepEqual(MT.assign(times, items), [1, 10, null, 2, null, 20]);
});

test("assign: a different number of user messages gives none of them a time", () => {
  assert.deepEqual(MT.assign({ users: [1], agents: { a: 10 } }, [{ kind: "user" }, { kind: "agent", messageId: "a" }, { kind: "user" }]), [null, 10, null]);
  assert.deepEqual(MT.assign({ users: [1, 2, 3], agents: {} }, [{ kind: "user" }]), [null]);
});

test("assign: an unread user time stays null; no times at all; no inherited keys", () => {
  assert.deepEqual(MT.assign({ users: [null, 2], agents: {} }, [{ kind: "user" }, { kind: "user" }]), [null, 2]);
  assert.deepEqual(MT.assign(null, [{ kind: "user" }, { kind: "agent", messageId: "a" }]), [null, null]);
  assert.deepEqual(MT.assign({ users: [], agents: {} }, [{ kind: "agent", messageId: "toString" }, { kind: "agent", messageId: undefined }]), [null, null]);
});
