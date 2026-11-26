// Route logic for the sub-session tree API. Each handler takes the parsed JSON body and returns { status, json? }.
const bad = (error) => ({ status: 400, json: { error } });
const done = { status: 204 };
const isKey = (k) => typeof k === "string" && k !== "";

export function linksRoutes({ delegation, comms, registry, log = console.log }) {
  const forgetKeys = (what) => ({ keys } = {}) => {
    if (!Array.isArray(keys) || !keys.every((k) => typeof k === "string")) return bad("keys must be an array of strings");
    const cli = keys.filter((k) => k.startsWith("cli:"));
    for (const k of cli) delegation.forget(k);
    // pruning is the app's guess from Copilot's session list: leave a trace of what it removed
    if (what && cli.length) log(`links: forgot ${cli.length} ${what} session(s): ${cli.join(", ")}`);
    return done;
  };
  // The tree's top: follow the parents up; stop on a cycle, a missing parent or a deleted one (an orphan is its own root).
  const rootOf = (key) => {
    const seen = new Set([key]);
    let k = key;
    for (let link = delegation.store.linkOf(k); link?.parent && !link.parentDeleted && !seen.has(link.parent); link = delegation.store.linkOf(k)) {
      k = link.parent;
      seen.add(k);
    }
    return k;
  };
  const peerInfo = (key) => {
    const p = registry?.get(key);
    return { name: p?.name || delegation.store.nameOf(key) || delegation.nameOf(key) || "", online: !!p?.online, busy: p?.busy === true, kind: p?.kind ?? "cli" };
  };
  const withKey = (fn) => (body = {}) => (isKey(body.key) ? fn(body) : bad("key required"));

  return {
    "GET /api/links": () => ({ status: 200, json: { links: delegation.snapshot(), held: delegation.heldCounts(), heldByKind: delegation.heldByKind() } }),
    "GET /api/comms": ({ key } = {}) => {
      if (!isKey(key)) return bad("key required");
      const root = rootOf(key);
      const linked = [root, ...delegation.store.descendantsOf(root)];
      const keys = linked.includes(key) ? linked : [key]; // an unknown key is a tree of its own
      const events = comms ? comms.eventsOf(keys) : []; // a broker running without its log: an empty one, not "older broker"
      const peers = {};
      for (const k of new Set([...keys, ...events.flatMap((e) => [e.fromKey, e.toKey])]))
        if (isKey(k) && (k !== key || events.length || delegation.store.linkOf(k) || registry?.get(k))) peers[k] = peerInfo(k);
      return { status: 200, json: { root: keys.includes(root) ? root : key, keys, events, peers } };
    },
    "GET /api/comms/text": ({ id } = {}) => {
      let text = null;
      try {
        text = isKey(id) ? comms?.text(id) ?? null : null;
      } catch {
        /* a missing file or a stale offset reads as an unknown id */
      }
      return text === null ? { status: 404, json: { error: "unknown event" } } : { status: 200, json: { text } };
    },
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
