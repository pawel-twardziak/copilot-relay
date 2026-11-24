# Broker shutdown answer: deferred findings

Source: the whole-branch review of `fix/broker-shutdown-flush` and the investigation of the test
"POST /api/shutdown answers with the pid and the broker exits" (`electron/test/broker-shutdown.test.mjs`), which fails
now and then on `windows-latest` with `fetch failed`. There is no spec; the fix is described in its commit messages.
Fixed on the branch and therefore not open: the broker answered before it had read the request and exited in the
write callback (`POST /api/shutdown` in `server.mjs`); a request cut off mid-body crashed the broker, because the
handler's `catch` used a non-numeric `e.code` as the HTTP status (this was true for every route that reads a body);
the test's name and the comment on the fallback timer said more than was true.

## A. Worth doing first (analysed below)

1. **The lost answer on Windows was not reproduced, so its cause is not confirmed.** Three runs on `windows-latest`
   with main's `server.mjs` gave no failure: 200 runs of the single test one after the other, 720 runs twelve at a
   time (no count printed: the counting script failed, the log shows no test failure), 240 runs of the whole test file
   six at a time. 120 runs on Linux gave none. It has failed only inside the full suite (`npm test`, test files in
   parallel), twice that we know of (2026-11-23, 2026-11-24 run 45442749378). What is known: the `fetch` of the POST
   itself rejected, so the caller did not get the response head. What the fix removes is one way to lose it (exit
   under the answer, with the request body unread); whether that was the way is open.
   *Proposal:* the test's `post` helper now puts the cause into the error (`fetch failed: <code>`). At the next
   failure read it: `ECONNRESET` or `UND_ERR_SOCKET` means the answer is still lost at exit (then let the exit wait
   for the caller's own close instead of the broker's); `ECONNREFUSED` means nothing listened on the port, which points
   at `freePort` in `electron/test/broker-helper.mjs` (a port found free and taken by another test file's broker before
   this one listens) rather than at the shutdown.
2. **A second test fails now and then on Windows:** "timeout kills the whole tree"
   (`electron/test/job-runner.test.mjs`, the test at line 29; `Missing expected exception` at line 36), seen on
   2026-11-24 in run 45449603251 on a commit that did not touch the job runner. Not analysed.
   *Proposal:* read how the test decides that the child tree is gone; if it checks once right after the timeout,
   wait for the condition instead (killing a tree on Windows is not instant).

## B. Window, wording

Nothing open.

## C. Small behaviour

3. **A caller that sends the head of the request and the body later** now waits for its answer until the body has
   arrived; before, the broker stopped at once. The app sends both together.
4. **Several shutdown requests at once:** one gets the answer, the others a reset connection. Very likely the same
   before the change; `stop` in `electron/broker-restart.mjs` treats a dropped answer as normal.
5. **`res.socket` being null** in the handler could not be produced; the handler uses `res.socket?.once` and the
   fallback timer (`SHUTDOWN_GRACE_MS`) covers a close that never fires.

## D. Tests and housekeeping

6. **The order "the connection is closed, then the process exits" is not proved by a test**: it cannot be seen from
   outside the process. The test bounds the time from the body to the exit (under 1.5 s), so a broker that only exits
   on the 2 s timer fails; a broker that reads the body, sends `Connection: close` and exits in the write callback
   would still pass.
7. **The fallback timer has no test** (nothing produces a close that never fires).
8. **Fixed waits** in `broker-shutdown.test.mjs`: 300 ms and 100 ms sleeps before assertions that nothing happened.
   A cost, not a source of flakes.

## Known limitations and open manual checks

- Windows socket behaviour at process exit (reset or clean close) was reasoned about, not observed.
- "Update and restart broker" in the desktop app (Electron's own `fetch`) was not run against the new handler; the
  unit tests of `electron/broker-restart.mjs` pass and `stop` tolerates a dropped answer.
- The broker change takes effect after "Update and restart broker"; the broker that is stopped by that first click is
  still the old one.
