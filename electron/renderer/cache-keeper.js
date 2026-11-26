// Pure helpers for the cache keeper's window parts: the header chip text and the settings number fields.
(function () {
  /** m:ss of a number of milliseconds, rounded up to whole seconds, never negative. */
  function clock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  }

  /** The header chip for a runner state { phase, pingsSent, pings, compactAt }: { text, notNow } (notNow = the
   *  "Not now" button is offered), or null when the chip is hidden. */
  function chipView(state, now) {
    switch (state?.phase) {
      case "pinging": return { text: `♻ Keeping the cache warm (${state.pingsSent}/${state.pings})`, notNow: true };
      case "countdown": return { text: `⏳ Compacting in ${clock((state.compactAt ?? now) - now)}`, notNow: true };
      case "compacting": return { text: "⏳ Compacting…", notNow: false };
      default: return null;
    }
  }

  /** Settings fields -> the stored cacheKeeper: an empty pings field is 0; the minimum context is typed in k tokens. */
  function settingsOfForm({ enabled, pings, minContextK }) {
    const num = (v) => (Number.isFinite(Number(v)) && String(v).trim() !== "" ? Math.max(0, Number(v)) : 0);
    return { enabled: enabled === true, pings: Math.floor(num(pings)), minContext: Math.round(num(minContextK) * 1000) };
  }

  const CacheKeeper = { clock, chipView, settingsOfForm };
  globalThis.CacheKeeper = CacheKeeper;
  if (typeof module !== "undefined") module.exports = CacheKeeper;
})();
