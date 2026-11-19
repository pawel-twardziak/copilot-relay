// Pure helpers for the Schedules form: presets <-> cron, descriptions, notify labels, relative times.
(function () {  const EVERY_MINUTES = [1, 2, 5, 10, 15, 30];
  const EVERY_HOURS = [1, 2, 3, 4, 6, 8, 12];
  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const NOTIFY_LABELS = {
    always: "Always",
    result: "When there is a result or an error",
    failure: "Failure only",
    never: "Never",
  };

  const pad = (n) => String(n).padStart(2, "0");
  const norm = (expr) => String(expr).trim().split(/\s+/).join(" ");

  function presetToCron(p) {
    switch (p.kind) {
      case "minutes": return p.n === 1 ? "* * * * *" : `*/${p.n} * * * *`;
      case "hours": return p.n === 1 ? "0 * * * *" : `0 */${p.n} * * *`;
      case "daily": return `${p.mm} ${p.hh} * * *`;
      case "weekdays": {
        const days = [...new Set(p.days)].sort((a, b) => a - b);
        if (!days.length) throw new Error("Pick at least one day.");
        return `${p.mm} ${p.hh} * * ${days.join(",")}`;
      }
      default: return p.expr;
    }
  }

  function cronToPreset(expr) {
    const e = norm(expr);
    const custom = { kind: "custom", expr: e };
    const f = e.split(" ");
    if (f.length !== 5) return custom;
    const [min, hour, dom, mon, dow] = f;
    const int = (s) => (/^\d{1,2}$/.test(s) ? Number(s) : NaN);
    if (dom !== "*" || mon !== "*") return custom;
    if (e === "* * * * *") return { kind: "minutes", n: 1 };
    if (hour === "*" && dow === "*" && min !== "0") {
      const m = /^\*\/(\d+)$/.exec(min);
      if (m && EVERY_MINUTES.includes(Number(m[1])) && Number(m[1]) !== 1) return { kind: "minutes", n: Number(m[1]) };
      return custom;
    }
    if (min === "0" && dow === "*") {
      if (hour === "*") return { kind: "hours", n: 1 };
      const m = /^\*\/(\d+)$/.exec(hour);
      if (m && EVERY_HOURS.includes(Number(m[1])) && Number(m[1]) !== 1) return { kind: "hours", n: Number(m[1]) };
    }
    const mm = int(min);
    const hh = int(hour);
    if (!(mm >= 0 && mm <= 59 && hh >= 0 && hh <= 23)) return custom;
    if (dow === "*") return { kind: "daily", hh, mm };
    if (dow === "1-5") return { kind: "weekdays", days: [1, 2, 3, 4, 5], hh, mm };
    if (/^\d(,\d)*$/.test(dow)) {
      const days = dow.split(",").map(Number);
      const sorted = [...new Set(days)].sort((a, b) => a - b);
      if (sorted.every((d) => d <= 6) && sorted.length === days.length && sorted.join(",") === dow) {
        return { kind: "weekdays", days: sorted, hh, mm };
      }
    }
    return custom;
  }

  function describeSchedule(expr) {
    const p = cronToPreset(expr);
    const time = (q) => `${pad(q.hh)}:${pad(q.mm)}`;
    switch (p.kind) {
      case "minutes": return p.n === 1 ? "every minute" : `every ${p.n} minutes`;
      case "hours": return p.n === 1 ? "every hour" : `every ${p.n} hours`;
      case "daily": return `daily at ${time(p)}`;
      case "weekdays":
        return p.days.join(",") === "1,2,3,4,5"
          ? `weekdays at ${time(p)}`
          : `${p.days.map((d) => DAY_NAMES[d]).join(", ")} at ${time(p)}`;
      default: return p.expr;
    }
  }

  function ago(iso, now) {
    const s = Math.floor((now - Date.parse(iso)) / 1000);
    if (!(s >= 60)) return "just now";
    const min = Math.floor(s / 60);
    if (min < 60) return `${min} min ago`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} h ago`;
    return `${Math.floor(h / 24)} d ago`;
  }

  const ScheduleForm = { EVERY_MINUTES, EVERY_HOURS, NOTIFY_LABELS, presetToCron, cronToPreset, describeSchedule, ago };
  globalThis.ScheduleForm = ScheduleForm;
  if (typeof module !== "undefined") module.exports = ScheduleForm;
})();
