# Sidebar last activity: deferred findings

Source: the final whole-branch review of `fix/sidebar-last-activity` (fable, medium) and the notes of the fix
itself. No spec or plan: a bug fix. The sidebar's "x min ago" and order used Copilot's `updatedAt` (`session/list`),
which is the modification time of `events.jsonl` and also moves on writes that are not messages. The list now
carries `lastActivityAt` (`electron/last-activity.mjs`). None of these blocked the merge. Line numbers were checked
at the fix round's commit and may drift.

Fixed in the fix round, so not listed below: a history over 64 MiB showed its creation time (now unknown, the
sidebar falls back to `updatedAt`); an unreadable result was remembered until `updatedAt` changed (an events file
that is there but cannot be read gives an unknown time, found by the re-review of the fix round (opus, high), and
unknown times are no longer remembered); the cache depended on `updatedAt` changing with every write (it is now keyed on the size
and modification time of `events.jsonl`, `activityStamp`); the whole-file and too-big steps had no test.

## A. Worth doing first (analysed below)

1. **Reading the whole file costs memory when several big histories need it at once**
   (`electron/last-activity.mjs`, `lastEventTimeOf`, `TAILS`, `readLines` in `electron/usage.mjs`). The
   whole file (up to 64 MiB) is read only when the last 2 MiB holds no `user.*`, `assistant.*` or `tool.*` event.
   The reviewer's synthetic run: one 60 MiB file takes 126 ms; eight in parallel take 715 ms and about 1.2 GB RSS
   in the main process. Real event lines reach 294 KB, so the 64 KiB step often misses but the 2 MiB step catches
   them; no real session needed the whole-file step.
   *Proposal:* scan backwards in chunks (stop at the first hit) instead of reading the whole file, or let only one
   whole-file read run at a time.

## B. Window and wording

2. **After a rewind (delete from a message) the session shows the older message's time and moves down the list**
   (`truncateSession` in `electron/history.mjs`). By design: the time is the last message that is still there.
   Before the fix the rewrite of `events.jsonl` moved it to the top.
3. **A history over 64 MiB with no activity in its last 2 MiB shows Copilot's `updatedAt` again**, with the old
   behaviour (it moves when the session is only opened). Item 1's backward scan would remove this.
4. **A session with no `events.jsonl` and no readable `created_at` shows Copilot's `updatedAt`.**

## C. Behaviour, small

5. **The sidebar's times refresh only when the list is fetched**: at startup, with the refresh button, after a
   fork, a delete or a settings save (`refresh` in `electron/renderer/app.js`). Unchanged by the fix; a session that
   is working keeps its last listed time until then.
6. **What counts as activity is a list of event type prefixes** (`ACTIVITY`, `isActivity` in
   `electron/last-activity.mjs`): `user.`, `assistant.`, `tool.`. A new Copilot event family that is real work
   (for example `subagent.` or `permission.` events) is not counted; on the 310 events of the local sessions the
   last counted event was always the true end of work, the later ones (`hook`, `model.*`, `permission`,
   `session.*`) trail it by milliseconds to seconds.

## D. Tests and housekeeping

7. **The last fix (an existing but unreadable `events.jsonl` gives unknown, `exists` in
   `electron/last-activity.mjs`) was not reviewed again**; it has a test.
8. **The "too big to search" test writes a 65 MiB file** (`electron/test/last-activity.test.mjs`): sparse on
   Linux, not on NTFS, so it may be slow on the Windows CI runner.
9. **Not run on Windows**: reading `events.jsonl` while Copilot writes it, a delete racing an open read handle,
   and the cost of the first list on the corporate PC (about 95 sessions). On Linux the first pass over 78 real
   session folders took 11 ms.
10. **Not checked in the running app on real sessions**: the UI checks (scripted agent) pass, but the sidebar with
   real Copilot sessions was not looked at after the fix.
11. **Which write moved `updatedAt` in the reported case is not known.** Reproduced locally (Copilot CLI
   1.0.115): `session/load` and `session/close` alone write nothing; `session/load`, then
   `session/set_config_option` with the model's current value, then close, appends `session.resume`,
   `session.model_change` and `session.shutdown`. In the report five sessions showed the same "11 min ago"; the last
   lines of one of their `events.jsonl` files on that PC would name the write.
12. **Where Copilot takes `updatedAt` from for sessions without `events.jsonl` is not known** (68 of 78 local
    session folders have none; probably `updated_at` of `workspace.yaml`). The cache no longer depends on it.
