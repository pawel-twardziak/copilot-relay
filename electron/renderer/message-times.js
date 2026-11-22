// Pure helpers for message times and the date lines between days (no DOM).
// Loaded as a classic <script> (sets globalThis.MessageTimes) and via require() in tests.
"use strict";

const pad2 = (n) => String(n).padStart(2, "0");

/** "HH:MM", 24-hour, local. Built by hand, never by locale: its width is fixed, so it fits a message's padding. */
function clock(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** The local date and time, for a time's tooltip. */
function full(ms) {
  return new Date(ms).toLocaleString();
}

/** The local calendar day, "YYYY-MM-DD". */
function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** The text of a date line, e.g. "Sat, 21 Nov 2026" (locale: the system's when not given). */
function dayLabel(ms, locale) {
  return new Date(ms).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

/** Whether a message at ms starts a new day after the previous timed message (none: it does). */
function newDay(prevMs, ms) {
  return prevMs == null || dayKey(prevMs) !== dayKey(ms);
}

/** The recorded time of each replayed message, or null: one per item ({ kind: "user"|"agent", messageId? }).
 *  times: { users: (ms|null)[] in order, agents: { [messageId]: ms } } from the session history, or null.
 *  Agent messages are matched by messageId. User messages have no id: they are matched by their ordinal, and only
 *  when as many were replayed as recorded. Otherwise none of them gets a time (a missing time, never a shifted one). */
function assign(times, items) {
  if (!times) return items.map(() => null);
  const users = Array.isArray(times.users) ? times.users : [];
  const agents = times.agents ?? {};
  const byOrdinal = items.filter((i) => i.kind === "user").length === users.length;
  let n = 0;
  return items.map((item) => {
    if (item.kind === "user") {
      const t = users[n++];
      return byOrdinal ? (t ?? null) : null;
    }
    const id = item.messageId;
    return typeof id === "string" && Object.hasOwn(agents, id) ? agents[id] : null;
  });
}

const MessageTimes = { clock, full, dayKey, dayLabel, newDay, assign };
globalThis.MessageTimes = MessageTimes;
if (typeof module !== "undefined") module.exports = MessageTimes;
