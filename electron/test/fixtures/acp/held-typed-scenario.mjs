// The scenario of the UI checks held-typed and held-typed-queue (scripts/ui-check/checks.mjs): every prompt asks a
// permission and waits for its answer (a turn runs as long as the check needs), and session/load fails after the
// replay (the view of a reopen is dead).
import wait from "./permission-wait-scenario.mjs";

export default { ...wait, load: { error: "scripted load failure" } };
