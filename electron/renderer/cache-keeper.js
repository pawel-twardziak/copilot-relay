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

  const MAX_PINGS = 20; // as MAX_PINGS in electron/cache-keeper.mjs, which clamps again

  /** Settings fields -> the stored cacheKeeper: an empty pings field is 0, more than MAX_PINGS is MAX_PINGS; the
   *  minimum context is typed in k tokens and an empty or unreadable one is sent as "" so main uses its default. */
  function settingsOfForm({ enabled, pings, minContextK }) {
    const num = (v) => (String(v ?? "").trim() !== "" && Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : null);
    const min = num(minContextK);
    return { enabled: enabled === true, pings: Math.min(MAX_PINGS, Math.floor(num(pings) ?? 0)), minContext: min === null ? "" : Math.round(min * 1000) };
  }

  const CacheKeeper = { clock, chipView, settingsOfForm };
  globalThis.CacheKeeper = CacheKeeper;
  if (typeof module !== "undefined") module.exports = CacheKeeper;
})();
