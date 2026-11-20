// Route logic for the sub-session tree API. Each handler takes the parsed JSON body and returns { status, json? }.
const bad = (error) => ({ status: 400, json: { error } });
const done = { status: 204 };
const isKey = (k) => typeof k === "string" && k !== "";

export function linksRoutes({ delegation }) {
  const forgetKeys = ({ keys } = {}) => {
    if (!Array.isArray(keys) || !keys.every((k) => typeof k === "string")) return bad("keys must be an array of strings");
    for (const k of keys) if (k.startsWith("cli:")) delegation.forget(k);
    return done;
  };
  const withKey = (fn) => (body = {}) => (isKey(body.key) ? fn(body) : bad("key required"));

  return {
    "GET /api/links": () => ({ status: 200, json: { links: delegation.snapshot() } }),
    "POST /api/links/forget": forgetKeys,
    "POST /api/links/missing": forgetKeys,
    "POST /api/peer/task": withKey(({ key, task }) =>
      typeof task === "string" ? { status: 200, json: { ok: delegation.setTask(key, task) } } : bad("task must be a string")),
    "POST /api/peer/state": withKey(({ key, busy }) => (delegation.setBusy(key, busy), done)),
    "POST /api/peer/died": withKey(({ key }) => (delegation.died(key), done)),
    "POST /api/peer/reopen-answer": withKey(({ key, requestId, approved, reason }) =>
      typeof requestId === "string" ? (delegation.answerReopen(key, requestId, approved === true, reason), done) : bad("requestId required")),
  };
}
