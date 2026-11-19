// Schedules page: the job list, the job form with its result-contract help, and a run's summary (schedule-run.js).
// Loaded as a classic <script> after schedule-form.js and schedule-run.js, before app.js (sets globalThis.Schedules);
// the pure helpers are also loaded via require() in tests. Nothing here touches the DOM, AppUi or window.api at load time.
"use strict";
(function () {
  const SF = () => globalThis.ScheduleForm;
  const SR = () => globalThis.ScheduleRun;
  const STATUS_ICON = { success: "✓", failed: "✗", aborted: "✗", timeout: "⏱", skipped: "⏭" };
  const NO_KEYCHAIN = "Secrets can't be saved: the system keychain is not available.";
  const RESULT_HINT = "The script must write to $JOB_RESULT, otherwise it only notifies about errors.";
  const HELP_SUMMARY = "How a script reports its result";
  const EXAMPLES = [
    ["bash", 'echo "3 new PRs" > "$JOB_RESULT"'],
    ["PowerShell", `'{"summary":"3 new PRs","notify":true}' | Set-Content $env:JOB_RESULT`],
    ["Python", 'json.dump({"summary": "3 new PRs", "details": "- #12 …"}, open(os.environ["JOB_RESULT"], "w"))'],
  ];
  const KINDS = [
    ["minutes", "Every … minutes"],
    ["hours", "Every … hours"],
    ["daily", "Every day"],
    ["weekdays", "On some weekdays"],
    ["custom", "Custom (cron)"],
  ];
  const DAYS = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"]];
  const REFRESH_MS = 30_000;

  // ---------------------------------------------------------------------------
  // pure helpers (tested in electron/test/schedules.test.mjs)

  /** The schedule part of the form: every preset's fields at once, so switching presets keeps what was typed. */
  function schedFromExpr(expr) {
    const s = { kind: "daily", minutes: 5, hours: 1, hh: 9, mm: 0, days: [1, 2, 3, 4, 5], expr: "0 9 * * *" };
    if (expr == null) return s;
    const p = SF().cronToPreset(expr);
    s.kind = p.kind;
    if (p.kind === "minutes") s.minutes = p.n;
    if (p.kind === "hours") s.hours = p.n;
    if (p.hh != null) Object.assign(s, { hh: p.hh, mm: p.mm });
    if (p.days) s.days = p.days;
    s.expr = p.kind === "custom" ? p.expr : SF().presetToCron(p);
    return s;
  }

  /** The cron expression for the form's schedule part; throws (e.g. "Pick at least one day.") when it can't be built. */
  function schedToCron(s) {
    switch (s.kind) {
      case "minutes": return SF().presetToCron({ kind: "minutes", n: s.minutes });
      case "hours": return SF().presetToCron({ kind: "hours", n: s.hours });
      case "daily": return SF().presetToCron({ kind: "daily", hh: s.hh, mm: s.mm });
      case "weekdays": return SF().presetToCron({ kind: "weekdays", days: s.days, hh: s.hh, mm: s.mm });
      default: return String(s.expr ?? "").trim();
    }
  }

  /** JobView env -> editable rows. A stored secret's value never reaches the renderer; `set` says one is stored. */
  const envRowsFromJob = (env = []) =>
    env.map((e) => ({ name: e.name, value: e.secret ? "" : e.value, secret: e.secret, set: e.secret && e.set, origName: e.name, replace: false }));

  /** True while a row stands for its stored secret (`•••• (set)`); a replaced or renamed one needs a new value. */
  const showsStoredSecret = (r) => Boolean(r.secret && r.set && !r.replace && r.name.trim() === r.origName);

  /** A stored secret is kept (value omitted) unless it was replaced or renamed; otherwise the typed value is sent. */
  function envToInput(rows) {
    return rows
      .filter((r) => r.name.trim() !== "" || r.value !== "" || r.set)
      .map((r) => {
        const name = r.name.trim();
        if (!r.secret) return { name, secret: false, value: r.value };
        const keep = showsStoredSecret(r);
        return keep ? { name, secret: true } : { name, secret: true, value: r.value };
      });
  }

  /** The form state for a job (null: a new job). */
  function formFromJob(job) {
    if (!job) return { enabled: true, name: "", sched: schedFromExpr(null), command: "", cwd: "", timeout: "10", notify: "always", env: [] };
    return {
      id: job.id, enabled: job.enabled, name: job.name, sched: schedFromExpr(job.schedule.expr), command: job.command,
      cwd: job.cwd, timeout: String(job.timeoutMinutes), notify: job.notify, env: envRowsFromJob(job.env),
    };
  }

  /** The jobsSave input for a form state; throws when the schedule can't be built. */
  function buildPayload(f) {
    return {
      ...(f.id ? { id: f.id } : {}),
      name: f.name.trim(), enabled: f.enabled, schedule: { kind: "cron", expr: schedToCron(f.sched) },
      command: f.command, cwd: f.cwd.trim(), env: envToInput(f.env), timeoutMinutes: Number(f.timeout), notify: f.notify,
    };
  }

  /** The text of a list row's last-run cell. */
  function lastRunText(job, nowMs) {
    if (job.running) return "⏳ running";
    if (!job.lastRun) return "never run";
    return `${STATUS_ICON[job.lastRun.status] ?? "?"} ${SF().ago(job.lastRun.startedAt, nowMs)}`;
  }

  // ---------------------------------------------------------------------------
  // page

  // mode: "list" | "form" | "run". notice: a one-off message on the list. open: the run page's toggled output blocks.
  const st = {
    visible: false, mode: "list", jobId: null, runId: null, form: null, confirm: null, notice: null, open: new Map(),
    timer: null, seq: 0, secretsAvailable: true,
  };
  const ui = () => globalThis.AppUi;
  const api = () => globalThis.api;
  const root = () => document.getElementById("schedules");
  const when = (iso) => (iso ? new Date(iso).toLocaleString() : "—");

  function setVisible(on) {
    st.visible = on;
    root().hidden = !on;
    document.body.classList.toggle("schedules-open", on);
    document.getElementById("btn-schedules")?.classList.toggle("active", on);
    clearInterval(st.timer);
    st.timer = on ? setInterval(() => st.mode === "list" && render(), REFRESH_MS) : null; // the list's "… ago" times
  }

  /** Show the page; an open form stays open (with what was typed), anything else goes back to the list. */
  function show() {
    setVisible(true);
    st.notice = null;
    if (st.mode !== "form") st.mode = "list";
    render();
  }

  function hide() {
    if (st.visible) setVisible(false);
  }

  /** Show the page with a run's summary, from any state: an open form is discarded (a notification click lands here). */
  function openRun(jobId, runId) {
    Object.assign(st, { mode: "run", jobId, runId, form: null, confirm: null, notice: null, open: new Map() });
    setVisible(true);
    render();
  }

  function onChanged() {
    if (st.visible && st.mode !== "form") render();
  }

  /** Render the current mode. Async renders that lost the race to a newer one are dropped. */
  async function render() {
    const seq = ++st.seq;
    try {
      const el = st.mode === "form" ? renderForm() : st.mode === "run" ? await renderRun() : await renderList();
      if (seq === st.seq && el) root().replaceChildren(el);
    } catch (e) {
      if (seq === st.seq) root().replaceChildren(page("Schedules", null, ui().h("p", { class: "sch-error" }, e.message)));
    }
  }

  function page(title, actions, ...body) {
    const { h } = ui();
    return h("div", { class: "sch-page" }, h("div", { class: "sch-head" }, h("h2", {}, title), actions), ...body);
  }

  async function renderList() {
    const { h } = ui();
    const { jobs, loadError, secretsAvailable } = await api().jobsList();
    st.secretsAvailable = secretsAvailable;
    const status = h("p", { class: "sch-error", hidden: true });
    const fail = (e) => Object.assign(status, { hidden: false, textContent: e.message });
    const act = (fn) => () => fn().then(onChanged, fail);
    const now = Date.now();
    const row = (j) => {
      const confirming = st.confirm === j.id;
      const actions = confirming
        ? [
            h("span", {}, `Delete "${j.name}"?`),
            h("button", { class: "danger", onclick: act(() => ((st.confirm = null), api().jobsDelete(j.id))) }, "Delete"),
            h("button", { onclick: () => ((st.confirm = null), render()) }, "Cancel"),
          ]
        : [
            h("button", { disabled: j.running, onclick: act(() => api().jobsRunNow(j.id)) }, "▶ Run now"),
            h("button", { title: j.enabled ? "Pause this job" : "Enable this job", onclick: act(() => api().jobsSetEnabled(j.id, !j.enabled)) }, j.enabled ? "⏸" : "▶"),
            h("button", { onclick: () => openForm(j) }, "Edit"),
            h("button", { class: "danger", onclick: () => ((st.confirm = j.id), render()) }, "Delete"),
          ];
      return h(
        "div",
        { class: "sch-row" },
        h("span", { class: "dot" + (j.enabled ? "" : " off"), title: j.enabled ? "Enabled" : "Paused" }),
        h("div", { class: "sch-main" }, h("b", {}, j.name), h("div", { class: "m" }, SF().describeSchedule(j.schedule.expr))),
        h("div", { class: "sch-col" }, h("div", { class: "m" }, "Next run"), j.enabled ? when(j.nextRunAt) : "paused"),
        h(
          "div",
          { class: "sch-col" },
          h("div", { class: "m" }, "Last run"),
          j.lastRun && !j.running
            ? h("a", { class: "sch-link", title: j.lastRun.summary ?? "", onclick: () => openRun(j.id, j.lastRun.id) }, lastRunText(j, now))
            : lastRunText(j, now),
        ),
        h("div", { class: "sch-actions" }, actions),
      );
    };
    return page(
      "Schedules",
      h("button", { class: "primary", onclick: () => openForm(null) }, "+ New job"),
      loadError && h("div", { class: "sch-banner" }, loadError),
      st.notice && h("p", { class: "sch-notice" }, st.notice),
      status,
      jobs.length ? h("div", { class: "sch-list" }, jobs.map(row)) : h("p", { class: "hint" }, "No scheduled jobs yet."),
    );
  }

  /** The run summary; a job or run that is gone (deleted, or dropped from the 20-run history) falls back to the list. */
  async function renderRun() {
    const { h } = ui();
    const { jobId, runId } = st;
    const [{ jobs }, run, runs] = await Promise.all([api().jobsList(), api().jobsRun(jobId, runId), api().jobsRuns(jobId)]);
    const job = jobs.find((j) => j.id === jobId);
    if (!job || !run) {
      if (st.mode !== "run" || st.jobId !== jobId || st.runId !== runId) return null; // a newer render took over
      Object.assign(st, { mode: "list", notice: SR().GONE });
      return renderList();
    }
    const back = h("button", { onclick: () => ((st.mode = "list"), render()) }, "← Back");
    return page(job.name, back, ...SR().runView({
      run, runs, open: st.open,
      onHelp: () => openForm(job, { help: true }),
      onOpenRun: (id) => openRun(jobId, id),
      onLink: (href) => api().openLink(job.cwd, href),
    }));
  }

  // ---------------------------------------------------------------------------
  // form

  /** help: open the result-contract panel and scroll to it (the run page's "How to report a result" link). */
  function openForm(job, { help = false } = {}) {
    Object.assign(st, { mode: "form", form: { ...formFromJob(job), helpOpen: help }, confirm: null, notice: null });
    render();
    if (help) root().querySelector(".sch-help")?.scrollIntoView({ block: "start" });
  }

  function closeForm() {
    Object.assign(st, { mode: "list", form: null });
    render();
  }

  function renderForm() {
    const { h } = ui();
    const f = st.form;
    const err = h("p", { class: "sch-error", hidden: true });
    const showErr = (msg) => Object.assign(err, { hidden: !msg, textContent: msg ?? "" });
    const save = h("button", { class: "primary", type: "submit", disabled: true }, "Save");
    let schedOk = false;
    let saving = false;
    const syncSave = () => (save.disabled = !schedOk || saving);
    const field = (label, ...control) => h("label", {}, label, ...control);
    const bind = (el, key, ev = "input") => (el.addEventListener(ev, () => (f[key] = el.type === "checkbox" ? el.checked : el.value)), el);

    // schedule
    const preview = h("div", { class: "sch-preview hint" });
    const schedFields = h("div", { class: "sch-sched-fields" });
    let pseq = 0;
    async function updatePreview() {
      const seq = ++pseq;
      schedOk = false;
      syncSave();
      let res;
      try {
        res = await api().jobsPreview(schedToCron(f.sched));
      } catch (e) {
        res = { ok: false, error: e.message };
      }
      if (seq !== pseq) return;
      schedOk = res.ok;
      preview.classList.toggle("sch-error", !res.ok);
      preview.textContent = res.ok ? `Next runs: ${res.next.map((t) => new Date(t).toLocaleString()).join(" · ")}` : res.error;
      syncSave();
    }
    const select = (options, value, onchange) =>
      h("select", { onchange: (e) => onchange(e.target.value) }, options.map(([v, label]) => h("option", { value: v, selected: String(v) === String(value) }, label)));
    const timeInput = () => {
      const pad = (n) => String(n).padStart(2, "0");
      return h("input", {
        type: "time", value: `${pad(f.sched.hh)}:${pad(f.sched.mm)}`, required: true,
        oninput: (e) => {
          const [hh, mm] = e.target.value.split(":").map(Number);
          if (Number.isInteger(hh) && Number.isInteger(mm)) Object.assign(f.sched, { hh, mm });
          updatePreview();
        },
      });
    };
    function drawSched() {
      const s = f.sched;
      const n = (key, list, unit) => [select(list.map((x) => [x, String(x)]), s[key], (v) => ((s[key] = Number(v)), updatePreview())), unit];
      const parts = {
        minutes: () => n("minutes", SF().EVERY_MINUTES, "minutes"),
        hours: () => n("hours", SF().EVERY_HOURS, "hours"),
        daily: () => ["at", timeInput()],
        weekdays: () => [
          ...DAYS.map(([d, label]) =>
            h("label", { class: "sch-day" }, h("input", {
              type: "checkbox", checked: s.days.includes(d),
              onchange: (e) => ((s.days = e.target.checked ? [...s.days, d] : s.days.filter((x) => x !== d)), updatePreview()),
            }), label)),
          "at", timeInput(),
        ],
        custom: () => [h("input", { class: "sch-mono", value: s.expr, spellcheck: "false", placeholder: "min hour day month weekday", oninput: (e) => ((s.expr = e.target.value), updatePreview()) })],
      };
      schedFields.replaceChildren(...parts[s.kind]());
    }
    const kind = select(KINDS, f.sched.kind, (v) => {
      if (v === "custom") {
        try { f.sched.expr = schedToCron(f.sched); } catch { /* keep the last custom text */ }
      }
      f.sched.kind = v;
      drawSched();
      updatePreview();
    });
    drawSched();
    updatePreview();

    // folder, notify, help
    const cwd = bind(h("input", { value: f.cwd, required: true, spellcheck: "false", placeholder: "/path/to/folder" }), "cwd");
    const pick = h("button", { type: "button", onclick: async () => {
      try {
        const dir = await api().pickDir();
        if (dir) cwd.value = f.cwd = dir;
      } catch (e) { showErr(e.message); }
    } }, "Pick…");
    const help = helpPanel(f.helpOpen);
    help.addEventListener("toggle", () => (f.helpOpen = help.open));
    const resultHint = h("p", { class: "hint" }, RESULT_HINT, " ", h("a", { class: "sch-link", onclick: () => ((help.open = true), help.scrollIntoView({ block: "nearest" })) }, "How to report a result"));
    const notify = select(Object.entries(SF().NOTIFY_LABELS), f.notify, (v) => ((f.notify = v), (resultHint.hidden = v !== "result")));
    resultHint.hidden = f.notify !== "result";

    // environment
    const envList = h("div", { class: "sch-env" });
    function drawEnv() {
      envList.replaceChildren(...f.env.map((r, i) => {
        const value = showsStoredSecret(r)
          ? h("span", { class: "sch-set" }, "•••• (set)", h("button", { type: "button", onclick: () => ((r.replace = true), drawEnv(), envList.children[i]?.querySelector(".sch-val")?.focus()) }, "Replace"))
          : h("input", { class: "sch-val", type: r.secret ? "password" : "text", value: r.value, placeholder: r.set ? "new value" : "value", spellcheck: "false", oninput: (e) => (r.value = e.target.value) });
        const lock = !st.secretsAvailable && !r.secret;
        return h("div", { class: "sch-env-row" },
          h("input", { class: "sch-mono", value: r.name, placeholder: "NAME", spellcheck: "false", oninput: (e) => {
            const before = showsStoredSecret(r);
            r.name = e.target.value;
            if (showsStoredSecret(r) === before) return;
            const caret = e.target.selectionStart;
            drawEnv(); // a renamed secret needs a new value: show its input (or the stored one again)
            const name = envList.children[i]?.querySelector(".sch-mono");
            name?.focus();
            name?.setSelectionRange(caret, caret);
          } }),
          value,
          h("label", { class: "sch-day", title: lock ? NO_KEYCHAIN : "Store the value encrypted and never show it again" },
            h("input", { type: "checkbox", checked: r.secret, disabled: lock, onchange: (e) => ((r.secret = e.target.checked), drawEnv()) }), "secret"),
          h("button", { type: "button", title: "Remove", onclick: () => (f.env.splice(i, 1), drawEnv()) }, "✕"));
      }));
    }
    drawEnv();

    const form = h(
      "form",
      { class: "sch-form", onsubmit: async (e) => {
        e.preventDefault();
        let input;
        try { input = buildPayload(f); } catch (x) { return showErr(x.message); }
        saving = true;
        syncSave();
        showErr(null);
        try {
          await api().jobsSave(input);
          closeForm();
        } catch (x) {
          showErr(x.message);
        } finally {
          saving = false;
          syncSave();
        }
      } },
      field("Name", bind(h("input", { value: f.name, required: true }), "name")),
      h("label", { class: "sch-check" }, bind(h("input", { type: "checkbox", checked: f.enabled }), "enabled", "change"), "Enabled"),
      h("div", { class: "sch-field" }, h("span", {}, "Schedule"), h("div", { class: "sch-inline" }, kind, schedFields), preview),
      field("Command", bind(h("textarea", { class: "sch-mono", rows: 3, required: true, spellcheck: "false" }, f.command), "command")),
      h("div", { class: "sch-field" }, h("span", {}, "Folder"), h("div", { class: "sch-inline" }, cwd, pick)),
      field("Timeout (minutes)", bind(h("input", { type: "number", min: 1, max: 1440, step: 1, value: f.timeout, required: true }), "timeout")),
      h("div", { class: "sch-field" }, h("span", {}, "Notify"), notify, resultHint),
      h("div", { class: "sch-field" }, h("span", {}, "Environment variables"), envList,
        h("div", {}, h("button", { type: "button", onclick: () => (f.env.push({ name: "", value: "", secret: false, set: false, origName: "", replace: false }), drawEnv()) }, "+ Add variable")),
        !st.secretsAvailable && h("p", { class: "hint" }, NO_KEYCHAIN)),
      help,
      err,
      h("div", { class: "dialog-actions" }, h("button", { type: "button", onclick: closeForm }, "Cancel"), save),
    );
    return page(f.id ? `Edit "${f.name}"` : "New job", null, form);
  }

  function helpPanel(open) {
    const { h, copyBtn } = ui();
    const example = ([lang, code]) =>
      h("div", {}, h("div", { class: "m" }, lang), h("div", { class: "codewrap" }, h("pre", {}, h("code", {}, code)), copyBtn(() => code)));
    return h(
      "details",
      { class: "sch-help", open },
      h("summary", {}, HELP_SUMMARY),
      h("p", {}, "The app sets these variables for every run:"),
      h("ul", {},
        h("li", {}, h("code", {}, "JOB_RESULT"), " – the path of an empty file the script may write its result to"),
        h("li", {}, h("code", {}, "JOB_NAME"), " – the job's name"),
        h("li", {}, h("code", {}, "JOB_RUN_ID"), " – this run's id")),
      h("p", {}, "The result file can hold:"),
      h("ul", {},
        h("li", {}, h("b", {}, "Plain text"), ": the first non-empty line is the summary, the whole text the details."),
        h("li", {}, h("b", {}, "A JSON object"), " with ", h("code", {}, "summary"), " (string, shown in the notification), optional ",
          h("code", {}, "details"), " (string, Markdown) and optional ", h("code", {}, "notify"), " (true or false: notify about this run or not).")),
      h("p", {}, "The exit code decides success: 0 is a success, anything else a failure. The result file only provides the text. Without a result the summary is the last line of stdout."),
      EXAMPLES.map(example),
    );
  }

  /** Called by app.js once window.api is ready. */
  function init() {
    api().onJobsChanged(onChanged);
    api().onJobRunFinished(onChanged);
  }

  const Schedules = { show, hide, openRun, init, isOpen: () => st.visible, schedFromExpr, schedToCron, envRowsFromJob, envToInput, showsStoredSecret, formFromJob, buildPayload, lastRunText };
  globalThis.Schedules = Schedules;
  if (typeof module !== "undefined") module.exports = Schedules;
})();
