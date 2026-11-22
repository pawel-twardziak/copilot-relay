# Spec: Message times and day separators (desktop app)

## Intent

The chat in the desktop app (`electron/`) shows no time at all: neither when a message was sent nor on which day.
In a session that runs for days you can't tell when something was asked or answered. Each message gets its time and
the days are separated by a date line, live and after a session is reopened.

## Findings (Copilot CLI 1.0.115-6, `session/load` probed on a copy of a session)

- Every event in `session-state/<id>/events.jsonl` has an ISO `timestamp`. ACP carries none: replayed
  `user_message_chunk` updates have only `content`, replayed `agent_message_chunk` updates have `content` and
  `messageId`.
- A replayed agent chunk's `messageId` equals `data.messageId` of its `assistant.message` event (checked on a
  two-turn session, both ids matched).
- Replayed user messages have no id. They come in the order of the `user.message` events, which is what fork, delete
  and edit already rely on (`userIndex` in `electron/history.mjs`, turn ordinals in `markTurn`).
- Every `.msg` already has 56px of right padding for its Copy button (`style.css`), empty unless hovered.

## Goals

- A time, `HH:MM` (24-hour, local), on every top-level user message (the continue line included), relay message and
  agent message. Its tooltip is the full local date and time.
- The time sits inside the message at the top right, in the existing right padding. **It never overlaps the
  message's text.**
- A date line before the first timed message of each local day, the first day included.
- Live messages take the clock; messages replayed from the history take their recorded time.

## Non-goals

- Times on thoughts, tool cards, activity groups (and the messages inside them), plans, permission cards and
  system/error lines.
- Times in "Copy thread" and in the Copy button's text.
- Relative labels ("Today", "Yesterday"), a setting to turn times off, a 12-hour clock.

## Anti-goal

A wrong time. Where a replayed message can't be matched to its event it shows no time.

## Approaches

1. **One IPC that reads the times from `events.jsonl`, applied by the renderer after the replay (picked).** Main
   returns the `user.message` times in order and the `assistant.message` times by `messageId`; the renderer maps
   them onto the replayed messages in one pass when the replay ends. No change to the update stream; the replay stays
   as fast as it is (nothing per block).
2. **Main adds the time to each replayed update.** Main doesn't know where one replayed user message ends and the
   next starts: the chunks have no id and the renderer joins them. Rejected.
3. **The app keeps its own store of times.** Covers neither the history from before the feature nor sessions made
   in the CLI, and duplicates what Copilot records. Rejected.

## Design

- **Main**: `messageTimes(id)` in `history.mjs` returns `{ users: (ms|null)[], agents: { [messageId]: ms } }`,
  exposed as `api.messageTimes(sessionId)`. It never throws: no history, an unreadable file, a broken line or an
  invalid id give fewer or no times.
- **Matching** (pure, `electron/renderer/message-times.js`): agent messages by `messageId`; user messages by
  ordinal, and only when the number of replayed user messages equals the number of recorded ones. Otherwise none of
  the user messages gets a time.
- **Replay**: `openSession` fetches the times after the replay marker and the view stamps its top-level messages
  once. A hidden (empty) replayed prompt counts for the ordinal and gets no time.
- **Live**: a top-level user, relay or agent message is stamped with the clock when it is appended to the log (a
  queued message: when it is delivered; an agent message: at its first chunk). An agent block that arrives after the
  replay marker but is in the history takes its recorded time.
- **Look**: `span.time` is a child of the `.msg`, absolutely positioned in the right padding, muted, 11px, tabular
  digits, not selectable. The clock is formatted by hand (`HH:MM`), never by locale, so its width is fixed and it
  fits the padding. Where a message has a bare Copy button (no fork/delete bar), the time fades out while the
  message is hovered and the button takes its place. The date line is a top-level `.day-sep` element: the date
  between two rules, `toLocaleDateString` with short weekday, day, short month and year (`Sat, 21 Nov 2026`).
- **Nothing else changes**: `.msg` class names, turn ordinals, fork/delete/edit, Copy thread and the UI baselines
  stay as they are. The date line has no `_md`, `_turn` or `_kind`.

## Known limitations

- On agent blocks with a bare Copy button (every block but the first reply block of a turn) the time is hidden
  while the message is hovered, so its tooltip can't be reached there. The date line still gives the day.
- A live agent time is that of the first chunk; after a reopen it is the time Copilot recorded the finished
  message. The two can differ by the length of the answer's streaming.
- A replayed *user* message arriving after the replay marker (seen once, see `sendEdit`) would get the clock time.
- A CLI command typed in the app (`/context`) shows a time live and is gone after a reopen, like the message itself.

## Left to the builder

- The exact vertical offset of the time so it sits on the first text line of each message kind.
- Where the sentence about times goes in `electron/README.md`.
