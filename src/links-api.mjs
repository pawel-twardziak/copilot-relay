// Route logic for the sub-session tree API. Each handler takes the parsed JSON body and returns { status, json? }.
const bad = (error) => ({ status: 400, json: { error } });
const done = { status: 204 };
const isKey = (k) => typeof k === "string" && k !== "";

export function linksRoutes({ delegation, log = console.log }) {
  const forgetKeys = (what) => ({ keys } = {}) => {
    if (!Array.isArray(keys) || !keys.every((k) => typeof k === "string")) return bad("keys must be an array of strings");
    const cli = keys.filter((k) => k.startsWith("cli:"));
    for (const k of cli) delegation.forget(k);
    // pruning is the app's guess from Copilot's session list: leave a trace of what it removed
    if (what && cli.length) log(`links: forgot ${cli.length} ${what} session(s): ${cli.join(", ")}`);
    return done;
  };
  const withKey = (fn) => (body = {}) => (isKey(body.key) ? fn(body) : bad("key required"));

  return {
    "GET /api/links": () => ({ status: 200, json: { links: delegation.snapshot() } }),
    "POST /api/links/forget": forgetKeys(null),
    "POST /api/links/missing": forgetKeys("missing"),
    "POST /api/peer/task": withKey(({ key, task }) =>
      typeof task === "string" ? { status: 200, json: { ok: delegation.setTask(key, task) } } : bad("task must be a string")),
    "POST /api/peer/state": withKey(({ key, busy }) => (delegation.setBusy(key, busy), done)),
    "POST /api/peer/died": withKey(({ key }) => (delegation.died(key), done)),
    "POST /api/peer/reopen-answer": withKey(({ key, requestId, approved, reason }) =>
      typeof requestId !== "string"
        ? bad("requestId required")
        : delegation.answerReopen(key, requestId, approved === true, reason)
          ? done
          : { status: 404, json: { error: "This reopen request is not pending." } }),
    "POST /api/peer/link-answer": withKey(({ key, requestId, approved }) => {
      if (typeof requestId !== "string") return bad("requestId required");
      const out = delegation.answerLink(key, requestId, approved === true);
      return out ? { status: 200, json: out } : { status: 404, json: { error: "This link request is not pending." } };
    }),
  };
}
