// Runs the UI checks against the real app (xvfb, the scripted agent): node scripts/ui-check/run.mjs [name…]
// runs all checks or the named ones, each in every mode it lists, one line per check; exit code 1 if any failed.
// --record writes the baseline files (electron/test/fixtures/ui-baseline) from the code as it is, in mode "off".
import { checks, PANEL_SCENARIO, setRecording } from "./checks.mjs";
import { launch } from "./driver.mjs";

const DEFAULT_MODES = ["off", "subagents", "all"];

const args = process.argv.slice(2);
const record = args.includes("--record");
const names = args.filter((a) => !a.startsWith("--"));
const unknown = names.filter((n) => !checks.some((c) => c.name === n));
if (unknown.length) {
  console.error(`unknown check(s): ${unknown.join(", ")}. Checks: ${checks.map((c) => c.name).join(", ")}`);
  process.exit(2);
}
setRecording(record);

const failures = [];
// recording runs in mode "off" only, so only the checks that run in "off"
const modesOf = (c) => c.modes ?? DEFAULT_MODES;
for (const check of checks.filter((c) => (!names.length || names.includes(c.name)) && (!record || modesOf(c).includes("off")))) {
  for (const mode of record ? ["off"] : modesOf(check)) {
    const label = `${check.name} [${mode}]`;
    const started = Date.now();
    let app = null;
    try {
      app = await launch({ scenario: check.scenario ?? PANEL_SCENARIO, settings: check.settings, sessionId: check.sessionId, broker: check.broker });
      await app.setMode(mode);
      await check.run(app);
      console.log(`ok    ${label}${record ? " (recorded)" : ""} ${Date.now() - started} ms`);
    } catch (e) {
      failures.push([label, e]);
      console.log(`FAIL  ${label}: ${String(e?.message ?? e).split("\n")[0]}`);
    } finally {
      await app?.close();
    }
  }
}
for (const [label, e] of failures) console.error(`\n--- ${label}\n${e?.stack ?? e}`);
process.exit(failures.length ? 1 : 0);
