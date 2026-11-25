// The cache keeper's runner: one timer per open session, armed from the rules in cache-keeper.mjs, and the actions
// (keep-alive ping, countdown, compaction) it fires. Every effect is injected (settings, facts, the expiry reader,
// `run`, `emit`, the clock and the timers), so main wires it and the tests drive it with fake timers. Also the
// per-session opt-out store.
import { jsonFileMap } from "./json-file-map.mjs";
import { COMPACT_LEAD_MS, compactText, initialState, keepAliveText, next, reduce } from "./cache-keeper.mjs";

const STOPPED_NOTICE = "Keep-alive stopped: the agent started working.";
const compactedNotice = (text) => {
  const n = /removed (\d+) messages/.exec(String(text ?? ""))?.[1];
  return `Compacted automatically before the prompt cache expired${n ? ` (−${n} messages)` : ""}`;
};

/**
 * @param {object} deps
 * @param {() => { enabled: boolean, pings: number, minContext: number }} deps.settings
 * @param {(id: string) => boolean} deps.optedOut
 * @param {(id: string) => { busy: boolean, replaying: boolean, contextUsed: number, modelId: string | null, parent: boolean }} deps.facts
 * @param {(id: string, modelId: string | null) => Promise<{ expiresAt: number | null, checkpointId: string | null } | null>} deps.readExpiry
 * @param {(id: string, text: string, kind: "ping" | "compact") => Promise<{ text: string, toolCalled: boolean, error: string | null }>} deps.run
 * @param {(channel: "keeper:state" | "acp:notice", payload: object) => void} deps.emit
 * @param {() => number} deps.now
 * @param {(fn: () => void, ms: number) => unknown} deps.setTimer
 * @param {(handle: unknown) => void} deps.clearTimer
 * @param {{ ping?: number, countdown?: number, compact?: number, late?: number }} [deps.leads]
 * @param {{ tries?: number, ms?: number }} [deps.retry] re-reads of the expiry after a turn (default 3 × 1 s)
 */
export function createKeeperRunner(deps) {
  const retry = { tries: 3, ms: 1000, ...deps.retry };
  const compactLead = deps.leads?.compact ?? COMPACT_LEAD_MS;
  /** id → { state, timer, wait, acting: "ping" | "compact" | null, held, gen, lastCheckpoint, started, shown } */
  const sessions = new Map();
  /** id → the settling of a running `run`. Outlives `closed`: a session reopened under the same id waits for it. */
  const inFlight = new Map();

  const entryOf = (id) => {
    let e = sessions.get(id);
    if (!e) {
      e = { state: initialState(), timer: null, wait: null, acting: null, held: false, gen: 0, lastCheckpoint: undefined, started: null, shown: null };
      sessions.set(id, e);
    }
    return e;
  };
  const isOpen = (id, e) => sessions.get(id) === e;

  const clearTimer = (e) => {
    if (e.timer != null) deps.clearTimer(e.timer);
    e.timer = null;
  };
  /** A retry gap that a reset or a close cuts short (the waiting loop then sees it is stale and stops). */
  const sleep = (e, ms) =>
    new Promise((resolve) => {
      const w = {
        resolve() {
          if (e.wait === w) e.wait = null;
          resolve();
        },
      };
      w.handle = deps.setTimer(w.resolve, ms);
      e.wait = w;
    });
  const cancelWait = (e) => {
    if (!e.wait) return;
    deps.clearTimer(e.wait.handle);
    e.wait.resolve();
  };
  /** Forget the current pause: stale async steps of it (re-reads, an action's result) are dropped. */
  const reset = (e) => {
    e.gen += 1;
    cancelWait(e);
    clearTimer(e);
    e.state = reduce(e.state, { type: "activity" });
  };

  const phaseOf = (e) => {
    if (e.acting === "ping") return "pinging";
    if (e.acting === "compact") return "compacting";
    if (e.state.phase === "done") return "done";
    if (e.timer == null) return "off";
    if (e.state.phase === "countdown") return "countdown";
    return e.state.pingsSent > 0 ? "pinging" : "idle";
  };
  const view = (e) => {
    const phase = e ? phaseOf(e) : "off";
    return {
      phase,
      pingsSent: e?.state.pingsSent ?? 0,
      pings: deps.settings().pings,
      compactAt: phase === "countdown" ? e.state.expiresAt - compactLead : null,
    };
  };
  /** Emits keeper:state when the phase, a count or compactAt changed since the last one sent for this session
   *  (nothing sent yet counts as "off"). */
  const publish = (id, e) => {
    const v = view(e);
    const was = e.shown ?? { ...view(null), pings: v.pings };
    if (["phase", "pingsSent", "pings", "compactAt"].every((k) => v[k] === was[k])) return;
    e.shown = v;
    deps.emit("keeper:state", { sessionId: id, ...v });
  };

  const decide = (id, e) => {
    const f = deps.facts(id) ?? {};
    const s = deps.settings();
    const facts = {
      enabled: Boolean(s.enabled) && !deps.optedOut(id),
      busy: Boolean(f.busy) || e.acting != null || inFlight.has(id),
      held: e.held,
      replaying: Boolean(f.replaying),
      contextUsed: f.contextUsed,
    };
    return next({ state: e.state, now: deps.now(), settings: s, facts, leads: deps.leads });
  };

  /** Arms the one timer of a session from `next`, or none; never while an action of this id runs. */
  const plan = (id, e) => {
    clearTimer(e);
    if (!e.acting && !inFlight.has(id)) {
      const r = decide(id, e);
      if (r.action !== "none") e.timer = deps.setTimer(() => fire(id, e), Math.max(0, r.at - deps.now()));
    }
    publish(id, e);
  };

  /** Re-checks with fresh facts when the timer fires: a busy session or a changed plan acts on what `next` says now. */
  const fire = (id, e) => {
    if (!isOpen(id, e)) return;
    e.timer = null;
    const r = decide(id, e);
    if (r.action === "none") return publish(id, e);
    if (r.at > deps.now()) return plan(id, e);
    if (r.action === "countdown") {
      e.state = { ...e.state, phase: "countdown" };
      return plan(id, e);
    }
    act(id, e, r.action);
  };

  /** The expiry of a checkpoint other than the last one seen (the baseline of `turnStarted`, the one a turn or ping
   *  gave), re-read up to `retry.tries` times; null when none
   *  arrives or the pause went stale meanwhile. */
  const readNewExpiry = async (id, e, gen) => {
    const current = () => isOpen(id, e) && e.gen === gen;
    for (let i = 0; i < retry.tries; i += 1) {
      if (i > 0) {
        await sleep(e, retry.ms);
      }
      if (!current()) return null;
      let r = null;
      try {
        r = await deps.readExpiry(id, deps.facts(id)?.modelId ?? null);
      } catch {
        r = null;
      }
      if (!current()) return null;
      if (r && r.checkpointId !== e.lastCheckpoint) {
        e.lastCheckpoint = r.checkpointId;
        return r.expiresAt ?? null;
      }
    }
    return null;
  };

  const runSafely = async (id, text, kind) => {
    try {
      return await deps.run(id, text, kind);
    } catch (err) {
      return { text: "", toolCalled: false, error: err?.message ?? String(err) };
    }
  };

  const act = async (id, e, kind) => {
    const gen = e.gen;
    const current = () => isOpen(id, e) && e.gen === gen;
    const text = kind === "ping" ? keepAliveText() : compactText({ parent: Boolean(deps.facts(id)?.parent) });
    e.acting = kind;
    publish(id, e);
    const running = runSafely(id, text, kind);
    // registered before the await below, so it is cleared before this action's own ending runs
    const settled = running.then(() => {
      if (inFlight.get(id) === settled) inFlight.delete(id);
    });
    inFlight.set(id, settled);
    const res = await running;
    try {
      if (!isOpen(id, e)) return;
      if (kind === "compact") {
        deps.emit("acp:notice", { sessionId: id, text: res.error ? `Automatic compaction failed: ${res.error}` : compactedNotice(res.text) });
        if (current()) e.state = reduce(e.state, { type: "compactEnded" });
        return;
      }
      if (res.toolCalled) deps.emit("acp:notice", { sessionId: id, text: STOPPED_NOTICE });
      if (!current()) return;
      if (res.toolCalled || res.error) {
        e.state = reduce(e.state, { type: "notNow" });
        return;
      }
      const expiresAt = await readNewExpiry(id, e, gen);
      if (!current()) return;
      e.state = expiresAt == null ? reduce(e.state, { type: "activity" }) : reduce(e.state, { type: "pingEnded", expiresAt });
    } finally {
      e.acting = null;
      const now = sessions.get(id); // this entry, or one created after a close, which could not arm until now
      if (now) plan(id, now);
    }
  };

  return {
    /** A turn that is not the keeper's own starts: its checkpoint is the baseline the end of the turn must differ
     *  from. Always overwrites, also a baseline a cut-short ping re-read left behind. */
    turnStarted(id) {
      const e = entryOf(id);
      const reading = (async () => {
        let r = null;
        try {
          r = await deps.readExpiry(id, deps.facts(id)?.modelId ?? null);
        } catch {
          r = null;
        }
        if (isOpen(id, e) && e.started === reading) e.lastCheckpoint = r?.checkpointId ?? null;
      })();
      e.started = reading;
      return reading;
    },
    /** A turn of the user or the relay ended: a new pause starts with the expiry of the checkpoint that turn wrote. */
    async turnEnded(id) {
      const e = entryOf(id);
      reset(e);
      publish(id, e);
      const gen = e.gen;
      if (e.started) await e.started; // a short turn can end before its baseline is read
      const expiresAt = await readNewExpiry(id, e, gen);
      if (!isOpen(id, e) || e.gen !== gen) return;
      e.state = reduce(e.state, { type: "turnEnded", expiresAt });
      plan(id, e);
    },
    /** Anything that is not the keeper's own action (also a config change): the pause ends until the next turn. */
    activity(id) {
      const e = sessions.get(id);
      if (!e) return;
      reset(e);
      publish(id, e);
    },
    /** The window's queue or message box is (not) empty. */
    setHeld(id, held) {
      const e = entryOf(id);
      e.held = Boolean(held);
      plan(id, e);
    },
    /** No pings and no compaction for the rest of this pause. */
    notNow(id) {
      const e = sessions.get(id);
      if (!e) return;
      e.state = reduce(e.state, { type: "notNow" });
      plan(id, e);
    },
    /** Settings or an opt-out changed: re-plan one session, or all without an id. */
    replan(id) {
      for (const [sid, e] of sessions) if (id === undefined || sid === id) plan(sid, e);
    },
    /** The session closed or its connection exited: no timer, no state; a running action's result is dropped, but
     *  `whenIdle` still waits for it and a reopened session does not act before it settles. */
    closed(id) {
      const e = sessions.get(id);
      if (!e) return;
      e.gen += 1;
      cancelWait(e);
      clearTimer(e);
      sessions.delete(id);
      if (e.shown && e.shown.phase !== "off") deps.emit("keeper:state", { sessionId: id, ...view(null) });
    },
    /** Resolves when no ping or compaction of this session is in flight. */
    whenIdle(id) {
      return inFlight.get(id) ?? Promise.resolve();
    },
    state(id) {
      return view(sessions.get(id) ?? null);
    },
  };
}

/** Per-session opt-out of the keeper in a small JSON file ({ [sessionId]: true }); no entry means kept. `set` throws
 *  when the file can't be written; `copy` and `delete` are bookkeeping after a fork / delete that already succeeded,
 *  so a failed write there is only logged. */
export function createKeeperOptOut(file) {
  const { read, write, bestEffort } = jsonFileMap(file, "cache-keeper");
  const store = (id, off) => {
    const data = read();
    if (off) data[id] = true;
    else {
      if (!(id in data)) return;
      delete data[id];
    }
    write(data);
  };
  return {
    get: (id) => read()[id] === true,
    set: (id, off) => store(id, off === true),
    copy: (fromId, toId) => bestEffort(() => store(toId, read()[fromId] === true)),
    delete: (id) => bestEffort(() => store(id, false)),
  };
}
