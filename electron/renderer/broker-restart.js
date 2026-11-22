// Pure helpers for the Settings "Relay broker" section: the confirmation question and one row per restart step.
(function () {
  const MARKS = { pending: "○", running: "…", done: "✓", failed: "✗", skipped: "–" };

  /** The question to ask before restarting, or null when nothing would be disturbed. */
  function restartQuestion({ working, acpSessions }) {
    const parts = [];
    if (working > 0) parts.push(working === 1 ? "1 session is working; its relay tools will not answer for a few seconds." : `${working} sessions are working; their relay tools will not answer for a few seconds.`);
    if (acpSessions > 0) parts.push(acpSessions === 1 ? "1 session started from the broker's web page will end." : `${acpSessions} sessions started from the broker's web page will end.`);
    return parts.length ? `${parts.join(" ")} Restart the broker now?` : null;
  }

  /** { mark, text, cls } of one step of a restart snapshot. */
  function stepRow(step) {
    const warning = step.status === "done" && step.warning;
    return {
      mark: warning ? "!" : (MARKS[step.status] ?? "○"),
      text: step.detail ? `${step.label}: ${step.detail}` : step.label,
      cls: warning ? "warning" : step.status,
    };
  }

  const BrokerRestart = { restartQuestion, stepRow };
  globalThis.BrokerRestart = BrokerRestart;
  if (typeof module !== "undefined") module.exports = BrokerRestart;
})();
