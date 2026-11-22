# Update and restart broker (v0.17.0): deferred findings

Source: task reviews and the final whole-branch review of `feat/broker-restart` (merged as v0.17.0, `4fa5892`).
Spec: `docs/superpowers/specs/2026-11-22-broker-restart-design.md`. None of these blocked the release. Line numbers
are left out on purpose: the fix waves moved them; the symbol or test name is given instead.

## A. Worth doing first (analysed below)

1. **A slow broker is taken for no broker, and the run can report success over old code.** A `/health` read that
   gets no answer within 2 s counts as "absent". Stop is then skipped, the spawned broker exits on a taken port,
   and Start accepts the old process when it answers again ("Broker running: pid <old>, commit <new>").
2. **A broker that crashes at start leaves no reason.** `realEffects().spawnBroker` uses `stdio: "ignore"`, so the
   only message is "The broker did not answer within 15 s."
3. **Start's checks on a foreign answer are loose.** An unreadable answer during Start ends after 15 s with "No
   broker is running", which is untrue; and any JSON object with another pid is accepted without `app ===
   "copilot-relay"` (it then fails only on `root`).
4. **The UI check's empty-field click has one guard only.** It is safe because the `broker:restart` handler in
   `electron/main.mjs` has no fallback to the default folder. Under the check that default is the developer's
   checkout: a re-added fallback would make the check run stash, checkout and pull there.
5. **Reconnect drops sessions that are already back.** `reconnectClients` calls `reconnectNow()` on every client,
   also on those already registered with the new broker: a needless disconnect with a small chance of losing a
   message in flight.

## B. Window, wording

6. The button stays enabled during the status read and the question; a second click asks again (main still allows
   one run only).
7. `openSettings` waits for `brokerStatus()` before `showModal()`: Settings can open up to 2 s late when the broker
   address accepts but does not answer (the stop/start gap of a run).
8. Detached `HEAD` with local changes reads "changes stashed from HEAD" and "Your changes from HEAD".
9. An `npm` that was not found (nothing deleted) also gets "Dependencies may now be incomplete."
10. A deliberate `reconnectNow()` on a live stream logs "relay: disconnected (This operation was aborted)" in the
    session's relay tooltip until the next registration.
11. After `createRestarter`'s rejection handler a step that was `running` stays `running` in the snapshot beside
    `running: false` (not reachable in practice).

## C. Behaviour, small

12. Submodule-only changes: `git status` lists the submodule, `git stash` ignores it and exits 0 with "No local
    changes to save", so a stash is claimed that does not exist (the repo has no `.gitmodules` today).
13. A broker that comes up after Start's 15 s limit is running although the run said none is; `spawnBroker` hands
    no pid back, so nothing can report or stop it.
14. `runProgram`: the 1 s grace after `exit` can cut the output short when the event loop is blocked for longer;
    the process-group sweep on every close was not asked for and has no test.
15. `reconnectNow()` on a client that was built but not started pends until `start()` and leaves the skip-wait flag
    set (no caller does this).
16. An `async` `onStep` that rejects is unhandled in `runRestart` (the contract and the only caller are sync).
17. `runRestart`'s summary for "another folder" is chosen by `detail.startsWith(...)`; the `{ other: true }` flag
    on the error is not read.
18. Dead code and placement: the `"::1"` entry in the loopback list (`URL.hostname` gives `[::1]`); `#timer` in
    `relay-client.mjs` needs no field; `STARTED_AT` in `server.mjs` sits under the ACP sessions header.

## D. Tests and housekeeping (no behaviour impact)

- `broker-shutdown.test.mjs`: `startedAt` is only checked to be recent and `acpSessions` to be 0; a second `/health`
  read with an equal `startedAt` would pin "taken once at start".
- `broker-shutdown.test.mjs`, "POST /api/shutdown answers with the pid and the broker exits": flaky on Windows.
  Seen on 2026-11-22 on `windows-latest` in both "Test" runs of v0.18.0 (`main` and the tag): the `post(b)` call
  rejected with `TypeError: fetch failed`. A rerun of each passed, Ubuntu passed, and so had the three Windows runs
  since v0.17.0; the v0.18.0 change touched neither `server.mjs` nor this test. Likely cause, not verified:
  `server.mjs` answers with `res.end(body, shutdown)` and `shutdown` calls `process.exit(0)`, so on Windows the
  connection can be reset before the client has read the answer. The app is not affected: the Stop step in
  `electron/broker-restart.mjs` catches a dropped answer and lets its `/health` polling decide. Proposal: either
  the test does the same (a rejected POST is allowed; exit code 0 and an unreachable `/health` still asserted, the
  answer's body only when it arrived), or the broker exits only after the request's socket has closed.
- `broker-helper.mjs`: `startBroker` waits without a limit for the "copilot-relay broker:" line; a stand-in script
  that does not print it hangs until the runner's timeout.
- `relay-client.test.mjs`: the stub's teardown lacks `server.closeAllConnections()` (the file lingers about 3 s);
  untested: several pending `reconnectNow()` calls resolving together, a call during an attempt in flight, the wait
  after a failed `reconnectNow()` attempt being `retryMs`.
- `run-program.test.mjs`: the stdout fallback and the 400-character tail of an `EXIT` message have no test.
- `broker-git.test.mjs`: one `git status` in the nested-worktree test goes through `runProgram` with
  `isolatedEnv()` (which `runProgram` merges over `process.env`, so the isolation is lost: use `isolatedRun`); the
  nested-only test does not write or assert files inside `nested/wt`.
- `broker-restart.test.mjs`: failure tests without a summary or status assertion (git top level, URL, something
  else, old broker); the restarter test leaves a run in flight and checks `notes.length > 2`; the symlink case
  returns silently on `EPERM` (use `t.skip`); `reconnectClients`' bounded wait has no upper bound; the rejection
  handler of `createRestarter` is not driven by a test.
- `broker-restart-e2e.test.mjs`: `stateDir` is a second temp folder; a failed explicit link removal is swallowed;
  the kill fallback is silent (add `t.diagnostic`) and is skipped when `/health` answers with a non-JSON body; the
  60 s test timeout is below the run's worst case.
- `scripts/ui-check/checks.mjs` (`broker-restart`): "no step after No" should be asserted again after the next
  `openSettings`; the first-row assertion uses `includes` where `startsWith("✗Check: …")` would cover the mark;
  `NO_BROKER_REPO` is declared under an unrelated header.
- Spec: two lines exceed the wrap width; `startedAt` is reported by `/health` and read by nothing (see A1).
- CI: `actions/checkout@v4` and `actions/setup-node@v4` target Node 20, which the runners deprecate (annotation on
  every run).

---

## Analysis and proposed solutions for A1–A5

### A1. Slow broker taken for no broker

**Today** (`electron/broker-restart.mjs`, the `/health` read): three results. A rejected fetch of any kind is
"absent", because on Windows a refused loopback connect is reported only after 1–2 s and cannot be told from the
2 s abort. Stop's first read: absent → skipped. Start: when nothing was stopped, any broker object with a matching
`root` is accepted.

**Proposal:** keep the read as it is; make Start strict instead. Remember `fx.now()` when the run begins. When Stop
was skipped, Start accepts a broker only if its `startedAt` is not older than that moment (minus a second of
slack); an older one fails the step with a new text, e.g. "The broker that was running did not answer in time and
is still the old one. Press the button again." A broker without `startedAt` cannot pass the `root` check anyway.
Tests: skipped Stop + old `startedAt` → failed; skipped Stop + fresh `startedAt` → done; the "port taken by another
starter" case stays green.

### A2. No reason for a broker that crashes at start

**Proposal:** `spawnBroker` opens a file in the temp folder (`copilot-relay-broker-<time>.log`) and passes it as
stderr (stdout stays ignored; a detached child may hold a file handle, not a pipe). When Start times out, the step
detail gets the last 400 characters of that file; the file is removed on success. Tests: with a script that throws
at start, the detail quotes its message (end-to-end style, temp script).

### A3. Start's checks on a foreign answer

**Proposal:** in Start's polling, a broker object must have `app === "copilot-relay"`; any other HTTP answer
(unreadable, or an object without it) that is still there when the limit ends fails with the existing "Something
else answers at <url>; it is not a copilot-relay broker." and the summary "Stopped at Start. A different broker is
running." Tests: one per case.

### A4. Second guard for the UI check

**Proposal:** two cheap layers. (1) The app honours `COPILOT_RELAY_NO_DEFAULT_REPO=1` (set by the UI-check driver)
by returning an empty `brokerRepoDefault`; the check asserts the placeholder is empty before the empty-field click.
(2) A unit-level guard: a test that reads `electron/main.mjs` and fails if the `broker:restart` handler mentions
`defaultBrokerRepo`. Either alone is enough; (2) costs five lines.

### A5. Reconnect only what is not back

**Proposal:** `reconnectClients` first waits a short moment (one poll, 200 ms) and then calls `reconnectNow()` only
on clients whose `connected` is false; connected ones count as back. Risk to weigh: a client that has not yet
noticed its old stream ended still says `connected: true`; it would be counted as back and reconnect on its own a
second later. Acceptable, since the step is a convenience and not a guarantee. Tests: mixed list of connected and
disconnected fake clients.

**Effort:** A1 small, A2 small to medium (file handle on three systems), A3 small, A4 small, A5 small. Suggested
order: A1 → A4 → A3 → A2 → A5, as v0.17.1.
