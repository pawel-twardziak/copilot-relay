// The UI checks run by scripts/ui-check/run.mjs: { name, modes?, run(app) }, each throwing on failure. app is a
// launched driver (driver.mjs) with the check's mode already set.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PANEL_SCENARIO = path.join(ROOT, "electron", "test", "fixtures", "acp", "panel-scenario.mjs");
const BASELINE_DIR = path.join(ROOT, "electron", "test", "fixtures", "ui-baseline");

let recording = false;
/** run.mjs --record: the baseline checks write their file instead of comparing with it. */
export const setRecording = (on) => (recording = on);

/** The dump equals electron/test/fixtures/ui-baseline/<name>.json (the v0.15.0 chat), or is recorded there. */
function baseline(name, dump) {
  const file = path.join(BASELINE_DIR, `${name}.json`);
  if (recording) return writeFileSync(file, JSON.stringify(dump, null, 2) + "\n");
  if (!existsSync(file)) throw new Error(`no baseline ${path.relative(ROOT, file)}: run node scripts/ui-check/run.mjs --record`);
  assert.deepStrictEqual(dump, JSON.parse(readFileSync(file, "utf8")));
}

/** The three prompts of panel-scenario.mjs, the second one's permission answered. */
async function playScenario(app) {
  await app.newSession();
  await app.send("Look around.");
  await app.idle();
  await app.send("Run both checks.");
  await app.answerPermission();
  await app.idle();
  await app.send("Anything else?");
  await app.idle();
}

export const checks = [
  {
    name: "baseline-live",
    async run(app) {
      await playScenario(app);
      baseline("live", await app.dump());
    },
  },
  {
    name: "baseline-replay",
    async run(app) {
      await playScenario(app);
      await app.reload();
      baseline("replay", await app.dump());
    },
  },
];
