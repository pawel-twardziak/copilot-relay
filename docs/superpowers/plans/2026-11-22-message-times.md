# Message Times and Day Separators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every top-level user, relay and agent message in the desktop app's chat shows its time (`HH:MM`) at the
top right, and a date line separates the days, live and after a reopen.

**Architecture:** Main reads message times from the session's `events.jsonl` (`messageTimes` in `history.mjs`,
one new IPC). A new pure classic-script module `electron/renderer/message-times.js` formats times and maps recorded
times onto replayed messages. `SessionView` stamps live messages with the clock in `append` and replayed ones in one
pass at the end of the replay in `openSession`.

**Tech Stack:** Electron, vanilla JS renderer, `node:test`, the UI checks in `scripts/ui-check` (Xvfb).

**Spec:** `docs/superpowers/specs/2026-11-22-message-times-design.md`

## Global Constraints

- No new dependencies.
- Clock text is exactly `HH:MM`: 24-hour, zero-padded, local time, built from `getHours()`/`getMinutes()`. Never
  locale-formatted (its width must be fixed).
- Tooltip of a time: `new Date(ms).toLocaleString()`.
- Date line text: `new Date(ms).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric" })`, `locale` undefined in the app.
- Timed elements are the top-level log children `.msg.user` (the `.continue` line included), `.msg.relay` and
  `.msg.agent`. Nothing else gets a time: not `.msg.system`, `.msg.error`, thoughts, tools, groups or anything
  inside a group.
- `span.time` is a child of the `.msg`; the `.msg`'s class list does not change. `div.day-sep` is a top-level log
  child with no `_md`, `_turn`, `_kind`.
- The time never overlaps the message's text: it stays inside the `.msg`'s 56px right padding.
- A missing time is acceptable, a wrong one is not.
- `electron/test/fixtures/ui-baseline/*.json` are not re-recorded.
- Tests: `npm test` from the repo root. UI checks: `node scripts/ui-check/run.mjs <name…>`.
- Commits: `feat(desktop): …` / `test(desktop): …` / `docs: …`. No version tag in this plan (it goes on main's
  merge commit).

## Review Focus

1. **The number of replayed user messages differs from the recorded `user.message` events** (a broken line, a
   history Copilot replays differently). Expected: no user message shows a time, agent messages still do; never a
   shifted time. Task 2 `assign` test, Task 4 UI check.
2. **No or unreadable history** (`events.jsonl` missing, a line that is not JSON, an id that is not a session id).
   Expected: the session opens as before, without times. Task 1 tests.
3. **A session open across midnight.** Expected: the first message after midnight gets a new date line. Task 2
   `newDay` test, Task 3 UI check.
4. **Text under the time**: a one-word bubble, a long line that wraps, the continue line, a relay bubble with its
   `from` label, on a 12-hour system locale. Expected: the text ends before the time's left edge. Task 2 `clock`
   test (fixed format), Task 3 UI check (geometry).
5. **A hidden (empty) replayed prompt** between two visible ones. Expected: it counts for the ordinal, shows no time
   and gets no date line; the prompt after it shows its own time. Task 4 UI check.

---

### Task 1: Message times from the history (`history.mjs`, IPC)

**Files:**
- Modify: `electron/history.mjs` (next to `countUserMessages`, ~line 94)
- Modify: `electron/main.mjs` (import at line 13; handler next to `sessions:userMessages`, ~line 681)
- Modify: `electron/preload.cjs` (next to `userMessages`, ~line 27)
- Test: `electron/test/history.test.mjs`

**Interfaces:**
- Produces:
  - `export async function messageTimes(id: string): Promise<{ users: (number|null)[], agents: Record<string, number> }>`
    (ms since epoch).
  - IPC `sessions:messageTimes` and `api.messageTimes(sessionId) -> Promise<{ users, agents }>`.

- [ ] **Step 1: Write the failing tests** (in `history.test.mjs`; `home` is the file's temp `COPILOT_HOME`)

```js
const writeEvents = (id, lines) => {
  const dir = path.join(home, "session-state", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "events.jsonl"), lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
};
const T = (s) => Date.parse(s);

test("messageTimes: user times in order, agent times by messageId", async () => {
  const id = randomUUID();
  writeEvents(id, [
    { type: "session.start", data: {}, timestamp: "2026-11-21T19:00:00.000Z" },
    { type: "user.message", data: { content: "a" }, timestamp: "2026-11-21T19:22:58.000Z" },
    { type: "assistant.message", data: { messageId: "m1", content: "x" }, timestamp: "2026-11-21T19:23:05.000Z" },
    { type: "tool.execution_start", data: { note: 'mentions "user.message"' }, timestamp: "2026-11-21T19:23:06.000Z" },
    { type: "user.message", data: { content: "b" }, timestamp: "not a date" },
    { type: "assistant.message", data: { content: "no id" }, timestamp: "2026-11-21T19:24:00.000Z" },
    { type: "assistant.message", data: { messageId: "m1", content: "again" }, timestamp: "2026-11-21T19:30:00.000Z" },
    { type: "assistant.message", data: { messageId: "m2", content: "y" }, timestamp: "2026-11-22T08:05:00.000Z" },
  ]);
  assert.deepEqual(await messageTimes(id), {
    users: [T("2026-11-21T19:22:58.000Z"), null],
    agents: { m1: T("2026-11-21T19:23:05.000Z"), m2: T("2026-11-22T08:05:00.000Z") },
  });
});

test("messageTimes: no history, a broken line, an invalid id: fewer or no times, never a throw", async () => {
  const empty = { users: [], agents: {} };
  assert.deepEqual(await messageTimes(randomUUID()), empty);
  assert.deepEqual(await messageTimes("../outside"), empty);
  const id = randomUUID();
  writeEvents(id, [
    { type: "session.start", data: {}, timestamp: "2026-11-21T19:00:00.000Z" },
    '{"type":"user.message","data":{"content":"cut off',
    { type: "user.message", data: { content: "b" }, timestamp: "2026-11-21T19:22:58.000Z" },
  ]);
  assert.deepEqual(await messageTimes(id), { users: [T("2026-11-21T19:22:58.000Z")], agents: {} });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test electron/test/history.test.mjs`
Expected: FAIL, `messageTimes` is not exported.

- [ ] **Step 3: Implement `messageTimes(id)` in `electron/history.mjs`**

Read `path.join(sessionDir(id), "events.jsonl")` with `fs.promises.readFile` inside one `try` that returns
`{ users: [], agents: {} }` on any error (`sessionDir` throws on an invalid id). Do not use `readEvents` (it
throws on a format error). Per line: skip it unless it contains `"user.message"` or `"assistant.message"`, then
`JSON.parse` in a `try` (skip on failure) and compare `e.type` exactly. `user.message`: push
`Date.parse(e.timestamp)`, or `null` when that is not finite. `assistant.message`: when `data.messageId` is a
string, the time is finite and the id is not in `agents` yet, set it (first occurrence wins).

- [ ] **Step 4: Add the IPC and the preload entry**

`main.mjs`: add `messageTimes` to the `./history.mjs` import and
`handle("sessions:messageTimes", async (sessionId) => messageTimes(sessionId));` after `sessions:userMessages`.
`preload.cjs`: `messageTimes: (sessionId) => call("sessions:messageTimes", sessionId),` after `userMessages`, with
the comment `// times (ms) of the recorded messages: { users: in order, agents: by messageId }, see electron/history.mjs`.

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS, the two new tests included.

- [ ] **Step 6: Commit**

```bash
git add electron/history.mjs electron/main.mjs electron/preload.cjs electron/test/history.test.mjs
git commit -m "feat(desktop): message times read from the session history"
```

---

### Task 2: Pure helpers (`message-times.js`)

**Files:**
- Create: `electron/renderer/message-times.js`
- Modify: `electron/renderer/index.html` (`<script src="message-times.js"></script>` after `edit-message.js`, line 160)
- Test: `electron/test/message-times.test.mjs`

**Interfaces:**
- Produces (on `globalThis.MessageTimes` and `module.exports`, file header and export lines in the style of
  `edit-message.js`):
  - `clock(ms: number) -> string`: `"HH:MM"`.
  - `full(ms: number) -> string`: the tooltip (Global Constraints).
  - `dayKey(ms: number) -> string`: local `"YYYY-MM-DD"`.
  - `dayLabel(ms: number, locale?: string) -> string`: the date line text (Global Constraints).
  - `newDay(prevMs: number|null, ms: number) -> boolean`: true when there is no previous time or its `dayKey` differs.
  - `assign(times: { users: (number|null)[], agents: Record<string, number> } | null, items: { kind: "user"|"agent", messageId?: string }[]) -> (number|null)[]`:
    one time per item. `"agent"`: `times.agents[messageId]` when `messageId` is a string and the key is the map's
    own, else `null`. `"user"`: the item's ordinal among the `"user"` items indexes `times.users`, but only when
    the number of `"user"` items equals `times.users.length`; otherwise `null` for every user item. `times` null:
    all `null`.

- [ ] **Step 1: Write the failing tests**

```js
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

test("full: the local date and time", () => {
  const ms = at(2026, 11, 21, 20, 22, 59);
  assert.equal(MT.full(ms), new Date(ms).toLocaleString());
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
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test electron/test/message-times.test.mjs`
Expected: FAIL, cannot find module `../renderer/message-times.js`.

- [ ] **Step 3: Write `electron/renderer/message-times.js` and add the script tag**

The six functions of the Interfaces block; no DOM, no `require`.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/renderer/message-times.js electron/renderer/index.html electron/test/message-times.test.mjs
git commit -m "feat(desktop): message time helpers"
```

---

### Task 3: Live times, the date line and their look

**Files:**
- Modify: `electron/renderer/app.js` (`SessionView.append`, line 813; new method `stamp` after it)
- Modify: `electron/renderer/style.css` (after the copy-button block, ~line 290)
- Modify: `scripts/ui-check/driver.mjs` (`dump`, lines 213-219)
- Modify: `scripts/ui-check/checks.mjs` (new check after `baseline-replay`)

**Interfaces:**
- Consumes: `MessageTimes.clock`, `full`, `dayLabel`, `newDay` (Task 2).
- Produces:
  - `SessionView.prototype.stamp(el: HTMLElement, ms: number): void`. No-op when `el._time != null`. Sets
    `el._time = ms`, appends `<span class="time" title="{full(ms)}">{clock(ms)}</span>` to `el`, and when
    `MessageTimes.newDay(prev, ms)` holds, where `prev` is `_time` of the nearest previous sibling of `el` that has
    one (else `null`), inserts `<div class="day-sep"><span>{dayLabel(ms)}</span></div>` directly before `el`. `el`
    must already be in the log.
  - `isTimed(el) -> boolean` (module-level in `app.js`): `el` has class `msg` and one of `user`, `relay`, `agent`.
  - `SessionView.prototype.append` stamps a timed element with `Date.now()` right after `this.log.append(el)`,
    unless `this.resuming`.

- [ ] **Step 1: Write the failing UI check** (in `checks.mjs`, after `baseline-replay`)

```js
  {
    // every top-level user/relay/agent message shows HH:MM inside its right padding, clear of its text; one date line
    name: "message-times-live",
    modes: ["off"],
    async run(app) {
      await playScenario(app);
      const r = await app.ev(`(() => {
        const v = ${V};
        const rect = (e) => e.getBoundingClientRect();
        const timed = [...v.log.querySelectorAll(":scope > .msg.user, :scope > .msg.relay, :scope > .msg.agent")].filter((e) => !e.hidden);
        const seps = [...v.log.querySelectorAll(":scope > .day-sep")];
        const bad = (e) => {
          const t = e.querySelector(":scope > .time"), b = e.querySelector(":scope > .body, :scope > .md");
          return !t || !b || rect(t).left < rect(b).right || rect(t).right > rect(e).right || rect(t).top < rect(e).top || rect(t).width === 0;
        };
        return {
          timed: timed.length,
          clocks: timed.map((e) => e.querySelector(":scope > .time")?.textContent ?? null),
          bad: timed.filter(bad).length,
          seps: seps.length,
          sepFirst: seps[0]?.nextElementSibling === timed[0],
          sepText: seps[0]?.textContent === MessageTimes.dayLabel(Date.now()),
          elsewhere: v.el.querySelectorAll(".time").length - timed.length,
        };
      })()`);
      assert.ok(r.timed > 3, "the scenario's three prompts and their answers");
      assert.ok(r.clocks.every((c) => /^\d\d:\d\d$/.test(c ?? "")), JSON.stringify(r.clocks));
      assert.deepEqual({ bad: r.bad, seps: r.seps, sepFirst: r.sepFirst, sepText: r.sepText, elsewhere: r.elsewhere }, { bad: 0, seps: 1, sepFirst: true, sepText: true, elsewhere: 0 });
      // the first message of the next day gets its own date line
      const next = await app.ev(`(() => {
        const v = ${V};
        const el = bubble("user", "after midnight");
        v.log.append(el);
        const d = new Date();
        d.setDate(d.getDate() + 1);
        v.stamp(el, d.getTime());
        v.stamp(el, 0); // a second stamp changes nothing
        return { seps: v.log.querySelectorAll(":scope > .day-sep").length, before: el.previousElementSibling?.className, times: el.querySelectorAll(".time").length };
      })()`);
      assert.deepEqual(next, { seps: 2, before: "day-sep", times: 1 });
    },
  },
```


- [ ] **Step 2: Run it and see it fail**

Run: `node scripts/ui-check/run.mjs message-times-live`
Expected: FAIL on `r.clocks` (all `null`).

- [ ] **Step 3: Implement `isTimed`, `stamp` and the call in `append` (`app.js`)**

As in the Interfaces block. `append` becomes: `markTurn`, `log.append`, the stamp, `place` for groups,
`followBottom`.

- [ ] **Step 4: Add the styles (`style.css`)**

```css
/* ---------- message times ---------- */
/* in the right padding the Copy button reserves (56px), so a time never covers the message's text */
.msg > .time {
  position: absolute; top: 2px; right: 8px; font-size: 11px; line-height: 1.5; font-style: normal;
  color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; user-select: none; transition: opacity .1s;
}
.msg.user:not(.continue) > .time, .msg.relay > .time { top: 10px; }
/* a bare Copy button (no fork/delete bar) appears in the same corner: the time gives way while hovered */
.msg:has(> .copy):hover > .time { opacity: 0; }
.day-sep { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 11.5px; user-select: none; }
.day-sep::before, .day-sep::after { content: ""; flex: 1; border-top: 1px solid var(--border); }
```

Adjust the two `top` values so the time sits on the first text line of an agent message, the continue line and a
bubble (the UI check only requires it inside the message).

- [ ] **Step 5: Keep the date line out of the baseline dump (`driver.mjs`)**

In `dump()`, both `thread` and `log` iterate `[...v.log.children].filter((e) => !e.classList.contains("day-sep"))`.
Extend its doc comment: `log: one row per log child (date lines left out)`.

- [ ] **Step 6: Run the checks**

Run: `npm test && node scripts/ui-check/run.mjs message-times-live baseline-live baseline-replay`
Expected: all PASS, the baselines unchanged (`git status` shows no change under `electron/test/fixtures/ui-baseline`).

- [ ] **Step 7: Commit**

```bash
git add electron/renderer/app.js electron/renderer/style.css scripts/ui-check/driver.mjs scripts/ui-check/checks.mjs
git commit -m "feat(desktop): message times and a date line between days"
```

---

### Task 4: Times of replayed messages

**Files:**
- Modify: `electron/renderer/app.js` (`stream`, line 1327; `append`, line 813; new method `applyTimes` after
  `stamp`; `openSession`, lines 2502-2520)
- Modify: `scripts/ui-check/checks.mjs` (new check after `message-times-live`)
- Modify: `electron/README.md`

**Interfaces:**
- Consumes: `api.messageTimes` (Task 1), `MessageTimes.assign` (Task 2), `stamp`, `isTimed` (Task 3).
- Produces:
  - `stream()` sets `el._messageId = messageId` on the `.msg` element it creates, before it is appended.
  - `SessionView.prototype.applyTimes(times: { users, agents } | null): void`. Stores `this.historyTimes = times`.
    Takes the top-level timed elements of the log without a `_time`, in order, as items
    `{ kind: "agent" | "user", messageId: el._messageId }` (`relay` counts as `"user"`), calls
    `MessageTimes.assign` and stamps each element that got a time and is not `hidden`.
  - `append` stamps with `this.historyTimes?.agents?.[el._messageId] ?? Date.now()` (own key only for a string
    `_messageId`; otherwise `Date.now()`).

- [ ] **Step 1: Write the failing UI check** (in `checks.mjs`, after `message-times-live`)

```js
  {
    // replayed messages take the times of the history: users by ordinal, agents by messageId; never a shifted time
    name: "message-times-replay",
    modes: ["off"],
    async run(app) {
      await playScenario(app);
      await app.reload();
      const SETUP = `const v = ${V};
        const day = (d, h, m) => new Date(2026, 10, d, h, m).getTime();
        const users = [...v.log.querySelectorAll(":scope > .msg.user")];
        const agents = [...v.log.querySelectorAll(":scope > .msg.agent")].filter((e) => typeof e._messageId === "string");
        const clock = (e) => e.querySelector(":scope > .time")?.textContent ?? null;`;
      const r = await app.ev(`(() => {
        ${SETUP}
        const before = v.el.querySelectorAll(".time, .day-sep").length; // the scripted session has no events.jsonl
        users[1].hidden = true; // an empty replayed prompt: counted, not stamped
        const last = agents.at(-1);
        v.applyTimes({ users: [day(21, 20, 22), day(21, 20, 30), day(22, 9, 5)], agents: Object.fromEntries(agents.map((e) => [e._messageId, e === last ? day(22, 9, 6) : day(21, 20, 23)])) });
        const seps = [...v.log.querySelectorAll(":scope > .day-sep")];
        return {
          before, users: users.length, agents: agents.length > 1,
          userClocks: users.map(clock), agentClocks: [...new Set(agents.map(clock))],
          seps: seps.map((s) => [s.textContent === MessageTimes.dayLabel(day(21, 12, 0)), s.textContent === MessageTimes.dayLabel(day(22, 12, 0)), users.indexOf(s.nextElementSibling)]),
        };
      })()`);
      assert.deepEqual(r, {
        before: 0, users: 3, agents: true,
        userClocks: ["20:22", null, "09:05"], agentClocks: ["20:23", "09:06"],
        seps: [[true, false, 0], [false, true, 2]],
      });
      // one user time too few: no user message is stamped, the agent ones are; a late block of the history keeps its time
      await app.reload();
      const m = await app.ev(`(() => {
        ${SETUP}
        v.applyTimes({ users: [day(21, 20, 22), day(21, 20, 30)], agents: { ...Object.fromEntries(agents.map((e) => [e._messageId, day(21, 20, 23)])), "late-1": day(21, 20, 40) } });
        v.stream("agent", "late", "late-1");
        v.flush();
        const late = [...v.log.querySelectorAll(":scope > .msg.agent")].at(-1);
        return { userClocks: users.map(clock), agentClocks: [...new Set(agents.map(clock))], late: clock(late), seps: v.log.querySelectorAll(":scope > .day-sep").length };
      })()`);
      assert.deepEqual(m, { userClocks: [null, null, null], agentClocks: ["20:23"], late: "20:40", seps: 1 });
    },
  },
```


- [ ] **Step 2: Run it and see it fail**

Run: `node scripts/ui-check/run.mjs message-times-replay`
Expected: FAIL, `v.applyTimes is not a function`.

- [ ] **Step 3: Implement `_messageId`, `applyTimes` and the time source in `append` (`app.js`)**

As in the Interfaces block.

- [ ] **Step 4: Fetch and apply the times at the end of a replay (`openSession`)**

Both branches, after `await replayed` and before `v.resuming = false`:
`const times = await api.messageTimes(s.sessionId).catch(() => null);`. Success branch: `v.applyTimes(times)` right
after `v.flush()`. Failure branch: `v.flush(); v.applyTimes(times);` right after `v.resuming = false` (the dead view
shows the replayed history, with its times). The fetch must stay before `resuming` flips, so nothing is stamped
with the clock while it is pending.

- [ ] **Step 5: Run the checks**

Run: `npm test && node scripts/ui-check/run.mjs`
Expected: all PASS (about 4 minutes), no change under `electron/test/fixtures/ui-baseline`.

- [ ] **Step 6: README**

Add to `electron/README.md`, where the chat view is described: "Each message shows the time it was sent (`HH:MM`,
the full date in its tooltip) and a date line separates the days. For a reopened session the times come from
Copilot's `events.jsonl`; a message that can't be matched there shows none." In the "Checks" paragraph (line 312)
update the duration if it changed.

- [ ] **Step 7: Commit**

```bash
git add electron/renderer/app.js scripts/ui-check/checks.mjs electron/README.md
git commit -m "feat(desktop): replayed messages show their recorded time"
```

---

## Manual checks (real Copilot, not covered by the UI checks)

The scripted agent writes no `events.jsonl`, so these run against a real session:

- Reopen a session with messages on two or more days: each message's time equals its event's `timestamp` in
  `events.jsonl` (local time), one date line per day.
- Send a message, let it be answered, close and reopen: the times stay (the answer's may move by the streaming time).
- Delete, fork and edit a message: the rebuilt view shows times; fork/delete still hit the right message.
- A queued message delivered mid-turn and the continue line: both timed, nothing under the time.
- Hover a later agent block: the time gives way to Copy; hover a user bubble: the bar floats above, the time stays.
- Windows build: the same checks (not run here).

Whatever stays open of these goes to `docs/superpowers/backlog/2026-11-22-message-times-deferred.md` when the branch
is finished (repo rule).
