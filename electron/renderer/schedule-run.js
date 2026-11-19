// A job run's summary: status line, the script's result (Markdown), notices, stdout/stderr tails and the job's history.
// Loaded as a classic <script> before schedules.js (sets globalThis.ScheduleRun); the pure helpers are also loaded via
// require() in tests. Nothing here touches the DOM, AppUi or window.api at load time.
"use strict";
(function () {
  const STATUS_ICON = { success: "✓", failed: "✗", aborted: "✗", timeout: "⏱", skipped: "⏭" };
  const TRIGGER = { schedule: "scheduled", manual: "run now" };
  const NO_RESULT = "The script wrote no result, showing the last stdout line.";
  const HELP_LINK = "How to report a result";
  const TRUNCATED = "Output was cut to the last 64 KB.";
  const GONE = "That run is no longer in the history.";

  // ---------------------------------------------------------------------------
  // pure helpers (tested in electron/test/schedules.test.mjs)

  /** `< 1 s` → `N ms`, `< 60 s` → `N.N s`, otherwise `M min S s`. */
  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "—";
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)} s`;
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)} min ${s % 60} s`;
  }

  /** The status line's parts: icon + status, trigger, start, duration and (when there is one) the exit code. */
  function runMeta(run, fmtDate = (iso) => new Date(iso).toLocaleString()) {
    return [
      `${STATUS_ICON[run.status] ?? "?"} ${run.status}`,
      TRIGGER[run.trigger] ?? run.trigger,
      run.startedAt ? fmtDate(run.startedAt) : "—",
      formatDuration(run.durationMs),
      ...(run.exitCode != null ? [`exit code ${run.exitCode}`] : []),
    ];
  }

  /**
   * Which notices and open blocks a run gets. A run that never started a process (skipped, or aborted by a quit) has
   * no stdout to fall back to, so it gets no no-result line.
   */
  function runNotices(run) {
    const noResult = !run.hasResult && run.status !== "skipped" && run.status !== "aborted";
    return {
      noResult,
      invalidJson: run.invalidJson ? `The result file is not valid JSON: ${run.invalidJson}` : null,
      stdout: { show: !!run.stdout, open: noResult, truncated: !!run.stdoutTruncated },
      stderr: { show: !!run.stderr, open: false, truncated: !!run.stderrTruncated },
    };
  }

  // ---------------------------------------------------------------------------
  // view

  /**
   * The run page's body. `opts`: { run, runs, open (Map name -> bool: blocks the user toggled), onHelp(), onOpenRun(id),
   * onLink(href) -> Promise }. Only `run.details` goes in as HTML (sanitized by AppUi.md); everything else is text.
   */
  function runView({ run, runs, open, onHelp, onOpenRun, onLink }) {
    const { h, md, copyBtn } = globalThis.AppUi;
    const n = runNotices(run);
    const status = h("p", { class: "sch-error", hidden: true });

    let details = null;
    if (run.details) {
      details = h("div", { class: "sch-details" });
      details.innerHTML = md(run.details);
      details.addEventListener("click", (e) => {
        const a = e.target.closest("a[href]");
        if (!a) return;
        e.preventDefault();
        Promise.resolve(onLink(a.getAttribute("href"))).catch((x) => Object.assign(status, { hidden: false, textContent: x.message }));
      });
    }

    const block = (name, text, info) => {
      if (!info.show) return null;
      const el = h(
        "details",
        { class: "sch-out", open: open.get(name) ?? info.open },
        h("summary", {}, name),
        info.truncated && h("p", { class: "hint" }, TRUNCATED),
        h("div", { class: "codewrap" }, h("pre", {}, text), copyBtn(() => text)),
      );
      el.addEventListener("toggle", () => open.set(name, el.open));
      return el;
    };

    const item = (r) =>
      h(
        "button",
        { class: "item sch-run" + (r.id === run.id ? " active" : ""), title: r.summary ?? "", onclick: () => onOpenRun(r.id) },
        h("span", { class: "sch-icon" }, STATUS_ICON[r.status] ?? "?"),
        h("span", { class: "sch-date" }, r.startedAt ? new Date(r.startedAt).toLocaleString() : "—"),
        h("span", { class: "sch-sum" }, r.summary ?? ""),
      );

    return [
      h("div", { class: "sch-run-head" },
        h("div", { class: `sch-meta sch-${run.status}` }, runMeta(run).map((t) => h("span", {}, t))),
        run.summary && h("p", { class: "sch-summary" }, h("b", {}, run.summary))),
      n.invalidJson && h("div", { class: "sch-banner" }, n.invalidJson),
      n.noResult && h("p", { class: "hint" }, NO_RESULT, " ", h("a", { class: "sch-link", onclick: onHelp }, HELP_LINK)),
      details,
      status,
      block("stdout", run.stdout, n.stdout),
      block("stderr", run.stderr, n.stderr),
      !n.stdout.show && !n.stderr.show && run.status !== "skipped" && h("p", { class: "hint" }, "No output."),
      h("h3", {}, "History"),
      runs.length ? h("div", { class: "sch-list" }, runs.map(item)) : h("p", { class: "hint" }, "No runs yet."),
    ];
  }

  const ScheduleRun = { STATUS_ICON, GONE, formatDuration, runMeta, runNotices, runView };
  globalThis.ScheduleRun = ScheduleRun;
  if (typeof module !== "undefined") module.exports = ScheduleRun;
})();
