// Scheduled scripts: job/secret/history stores and the tick loop. No Electron imports: main.mjs passes
// safeStorage-backed `secrets` and turns `onRunFinished` into a notification.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { checkStoredJob, finishRun, isDue, scheduleInfo, shouldNotify, validateJob } from "./jobs.mjs";
import { startRun as realStartRun } from "./job-runner.mjs";

const HISTORY = 20;
const NO_KEYCHAIN = "Secrets can't be saved: the system keychain is not available.";
const message = (e) => (e instanceof Error ? e.message : String(e));

// A record for a run that never started a process (skipped, aborted on quit).
const blankRun = (fields) => ({
  exitCode: null, details: null, hasResult: false, notifyOverride: null, invalidJson: null,
  stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, ...fields,
});

export class JobScheduler {
  #dir; #secrets; #onRunFinished; #onChanged; #now; #tickMs; #startRun;
  #loaded = false;
  #jobs = [];
  #secretStore = {};
  #history = {};
  #loadError = null;
  #active = new Map(); // jobId -> { runId, trigger, startedAt, handle, secretValues }
  #lastChecked = new Map(); // jobId -> ms
  #timer = null;

  constructor({ dir, secrets, onRunFinished, onChanged, now = Date.now, tickMs = 30_000, startRun = realStartRun }) {
    this.#dir = dir;
    this.#secrets = secrets;
    this.#onRunFinished = onRunFinished ?? (() => {});
    this.#onChanged = onChanged ?? (() => {});
    this.#now = now;
    this.#tickMs = tickMs;
    this.#startRun = startRun;
  }

  start() {
    this.#ensure();
    const t = this.#now();
    for (const job of this.#jobs) this.#lastChecked.set(job.id, t);
    if (!this.#timer) {
      this.#timer = setInterval(() => this.tick(), this.#tickMs);
      this.#timer.unref?.();
    }
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  tick() {
    this.#ensure();
    const t = this.#now();
    for (const job of this.#jobs) {
      if (!job.enabled) continue;
      try {
        if (!isDue(job.schedule?.expr, this.#lastChecked.get(job.id) ?? t, t)) continue;
        if (this.#active.has(job.id)) {
          this.#record(blankRun({
            id: randomUUID(), jobId: job.id, trigger: "schedule", startedAt: new Date(t).toISOString(),
            durationMs: 0, status: "skipped", summary: "Skipped: the previous run is still going",
          }));
          this.#changed();
        } else {
          this.#launch(job, "schedule");
        }
      } catch (e) {
        console.error(`Scheduled job "${job.name}" (${job.id}):`, message(e));
      }
    }
    for (const job of this.#jobs) this.#lastChecked.set(job.id, t);
  }

  list() {
    this.#ensure();
    return {
      jobs: this.#jobs.map((j) => this.#view(j)),
      loadError: this.#loadError,
      secretsAvailable: Boolean(this.#secrets.available()),
    };
  }

  save(input) {
    this.#ensure();
    if (input?.id != null && input.id !== "" && !this.#jobs.some((j) => j.id === input.id)) throw new Error("Job not found");
    const job = validateJob(input);
    let isDir = false;
    try { isDir = fs.statSync(job.cwd).isDirectory(); } catch { /* missing */ }
    if (!isDir) throw new Error(`Folder does not exist: ${job.cwd}`);

    const old = this.#secretStore[job.id] ?? {};
    const kept = {};
    for (const e of job.env) {
      if (!e.secret) continue;
      if (e.value !== undefined) {
        if (!this.#secrets.available()) throw new Error(NO_KEYCHAIN);
        kept[e.name] = this.#secrets.encrypt(e.value);
      } else if (old[e.name] !== undefined) {
        kept[e.name] = old[e.name];
      }
    }
    const stored = { ...job, env: job.env.map((e) => (e.secret ? { name: e.name, secret: true } : e)) };

    if (Object.keys(kept).length) this.#secretStore[job.id] = kept;
    else delete this.#secretStore[job.id];
    const i = this.#jobs.findIndex((j) => j.id === job.id);
    if (i >= 0) this.#jobs[i] = stored;
    else this.#jobs.push(stored);
    this.#write("job-secrets.json", this.#secretStore);
    this.#writeJobs();
    this.#lastChecked.set(job.id, this.#now());
    this.#changed();
    return this.#view(stored);
  }

  remove(id) {
    this.#find(id);
    const entry = this.#active.get(id);
    this.#active.delete(id); // before abort, so the run's `done` is ignored
    try { entry?.handle.abort(); } catch (e) { console.error("Aborting a scheduled job:", message(e)); }
    this.#jobs = this.#jobs.filter((j) => j.id !== id);
    delete this.#secretStore[id];
    delete this.#history[id];
    this.#lastChecked.delete(id);
    this.#write("job-secrets.json", this.#secretStore);
    this.#write("job-runs.json", this.#history);
    this.#writeJobs();
    this.#changed();
  }

  setEnabled(id, enabled) {
    const job = this.#find(id);
    job.enabled = Boolean(enabled);
    this.#lastChecked.set(id, this.#now());
    this.#writeJobs();
    this.#changed();
  }

  runNow(id) {
    const job = this.#find(id);
    if (this.#active.has(id)) throw new Error("Already running");
    return this.#launch(job, "manual");
  }

  runs(jobId) {
    this.#ensure();
    return [...(this.#history[jobId] ?? [])];
  }

  run(jobId, runId) {
    return this.runs(jobId).find((r) => r.id === runId) ?? null;
  }

  abortAllSync() {
    this.stop();
    const t = this.#now();
    const entries = [...this.#active];
    this.#active.clear();
    for (const [jobId, e] of entries) {
      try { e.handle.abort({ force: true }); } catch (err) { console.error("Aborting a scheduled job:", message(err)); }
      this.#push(blankRun({
        id: e.runId, jobId, trigger: e.trigger, startedAt: e.startedAt,
        durationMs: Math.max(0, t - Date.parse(e.startedAt)), status: "aborted", summary: "Stopped because the app quit",
      }));
    }
    if (entries.length) this.#write("job-runs.json", this.#history);
  }

  // ---- internals ----

  #launch(job, trigger) {
    const runId = randomUUID();
    const startedAt = new Date(this.#now()).toISOString();
    const ctx = { jobId: job.id, runId, trigger, startedAt, timeoutMinutes: job.timeoutMinutes, secrets: [] };
    let handle;
    try {
      const env = {};
      for (const e of job.env) {
        if (!e.secret) { env[e.name] = e.value; continue; }
        const enc = this.#secretStore[job.id]?.[e.name];
        if (enc === undefined) continue;
        env[e.name] = this.#secrets.decrypt(enc);
        ctx.secrets.push(env[e.name]);
      }
      handle = this.#startRun({ command: job.command, cwd: job.cwd, env, timeoutMs: job.timeoutMinutes * 60_000, jobName: job.name, runId });
    } catch (e) {
      const raw = { reason: "exit", exitCode: null, error: message(e), stdout: "", stderr: "", durationMs: 0 };
      this.#finish(finishRun(raw, ctx), job);
      return runId;
    }
    const entry = { runId, trigger, startedAt, handle };
    this.#active.set(job.id, entry);
    handle.done.then((raw) => {
      if (this.#active.get(job.id) !== entry) return; // removed or aborted on quit
      this.#active.delete(job.id);
      this.#finish(finishRun(raw, ctx), this.#jobs.find((j) => j.id === job.id) ?? job);
    }).catch((e) => console.error(`Scheduled job "${job.name}" (${job.id}):`, message(e)));
    this.#changed();
    return runId;
  }

  #finish(run, job) {
    try { this.#record(run); } catch (e) { console.error("Saving the run history:", message(e)); }
    try {
      this.#onRunFinished(run, job, shouldNotify(job.notify, run.status, run.hasResult, run.notifyOverride));
    } catch (e) {
      console.error("onRunFinished:", message(e));
    }
    this.#changed();
  }

  #changed() {
    try { this.#onChanged(); } catch (e) { console.error("onChanged:", message(e)); }
  }

  #push(run) {
    this.#history[run.jobId] = [run, ...(this.#history[run.jobId] ?? [])].slice(0, HISTORY);
  }

  #record(run) {
    this.#push(run);
    this.#write("job-runs.json", this.#history);
  }

  #view(job) {
    const stored = this.#secretStore[job.id] ?? {};
    const info = job.enabled ? scheduleInfo(job.schedule?.expr, new Date(this.#now()), 1) : null;
    const last = this.#history[job.id]?.[0];
    return {
      ...job,
      env: job.env.map((e) => (e.secret ? { name: e.name, secret: true, set: stored[e.name] !== undefined } : { ...e })),
      running: this.#active.has(job.id),
      nextRunAt: info?.ok ? info.next[0] ?? null : null,
      lastRun: last ? { id: last.id, status: last.status, startedAt: last.startedAt, summary: last.summary } : null,
    };
  }

  #find(id) {
    this.#ensure();
    const job = this.#jobs.find((j) => j.id === id);
    if (!job) throw new Error("Job not found");
    return job;
  }

  #ensure() {
    if (this.#loaded) return;
    // All three reads must succeed before any state is set, so a failed read (EACCES, EISDIR, ...) throws again
    // on the next call instead of letting a write replace the stores with empty data.
    fs.mkdirSync(this.#dir, { recursive: true });
    const jobs = this.#read("jobs.json", (d) => Array.isArray(d?.jobs));
    if (jobs.error) this.#loadError = `jobs.json could not be read (${jobs.error}). It was kept as ${jobs.keptAs}.`;
    const isMap = (d) => d != null && typeof d === "object" && !Array.isArray(d);
    const secrets = this.#read("job-secrets.json", isMap);
    const history = this.#read("job-runs.json", isMap);
    this.#jobs = [];
    const skipped = [];
    const ids = new Set();
    for (const job of jobs.data?.jobs ?? []) {
      try {
        checkStoredJob(job);
        if (ids.has(job.id)) throw new Error("its id is listed twice");
        ids.add(job.id);
        this.#jobs.push(job);
      } catch (e) {
        skipped.push(`${typeof job?.name === "string" ? JSON.stringify(job.name) : "a job"}: ${message(e)}`);
      }
    }
    if (skipped.length) {
      this.#loadError = `${skipped.length === 1 ? "1 saved job was" : `${skipped.length} saved jobs were`} invalid and ` +
        `${skipped.length === 1 ? "was" : "were"} skipped: ${skipped.join("; ")}.`;
      console.warn(this.#loadError);
    }
    this.#secretStore = secrets.data ?? {};
    this.#history = history.data ?? {};
    this.#loaded = true;
  }

  // Reads a store. A missing file is empty; an unreadable one is renamed aside.
  #read(name, valid) {
    const file = path.join(this.#dir, name);
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch (e) {
      if (e?.code === "ENOENT") return { data: null };
      throw e;
    }
    let error;
    try {
      const data = JSON.parse(text);
      if (valid(data)) return { data };
      error = "unexpected content";
    } catch (e) {
      error = message(e);
    }
    const keptAs = `${name}.corrupt-${this.#now()}`;
    fs.renameSync(file, path.join(this.#dir, keptAs));
    console.warn(`${name} could not be read (${error}); kept as ${keptAs}`);
    return { data: null, error, keptAs };
  }

  #writeJobs() {
    this.#write("jobs.json", { version: 1, jobs: this.#jobs });
  }

  #write(name, data) {
    const file = path.join(this.#dir, name);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  }
}
