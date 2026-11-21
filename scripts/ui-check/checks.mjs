// The UI checks run by scripts/ui-check/run.mjs: { name, scenario?, modes?, run(app) }, each throwing on failure.
// app is a driver (driver.mjs) launched with the check's scenario (default panel-scenario.mjs), its mode already set.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES = path.join(ROOT, "electron", "test", "fixtures", "acp");
export const PANEL_SCENARIO = path.join(FIXTURES, "panel-scenario.mjs");
const BASELINE_DIR = path.join(ROOT, "electron", "test", "fixtures", "ui-baseline");

let recording = false;
/** run.mjs --record: the baseline checks write their file instead of comparing with it. */
export const setRecording = (on) => (recording = on);

/** The dump equals electron/test/fixtures/ui-baseline/<name>.json (the v0.15.0 chat), or is recorded there. */
function baseline(name, dump) {
  const file = path.join(BASELINE_DIR, `${name}.json`);
  if (recording) return writeFileSync(file, JSON.stringify(dump, null, 2) + "\n");
  if (!existsSync(file)) throw new Error(`no baseline ${path.relative(ROOT, file)}: run node scripts/ui-check/run.mjs --record`);
  assert.deepStrictEqual(dump, readBaseline(name));
}
const readBaseline = (name) => JSON.parse(readFileSync(path.join(BASELINE_DIR, `${name}.json`), "utf8"));

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
  {
    // the load replays the whole history, then fails: the dead view shows all of it, settled (the answer must not
    // end the replay before the last update); a few times, as the order of the two used to vary
    name: "failed-load-settles",
    scenario: path.join(FIXTURES, "failing-load-scenario.mjs"),
    async run(app) {
      await playScenario(app);
      const { thread } = readBaseline("replay");
      for (let i = 1; i <= 6; i++) {
        await app.reload();
        const v = `views.get("scripted-work")`;
        const state = await app.ev(`({ dead: ${v}.dead, running: ${v}.log.querySelectorAll(".mark.running").length, bg: ${v}.bgEl.hidden ? "" : ${v}.bgEl.textContent })`);
        assert.deepStrictEqual(state, { dead: true, running: 0, bg: "" }, `failed load ${i}`);
        const dump = await app.dump();
        assert.equal(dump.thread, thread, `failed load ${i}: the replayed thread`);
        assert.deepStrictEqual(dump.log.at(-1), ["msg error", null, null, false], `failed load ${i}: the error line`);
      }
    },
  },
  {
    // closed while it resumes and opened again: the second view ends its replay (the first open's end must not
    // take the second one's wait, nor end it early)
    name: "reopen-while-resuming",
    scenario: path.join(FIXTURES, "slow-load-scenario.mjs"),
    async run(app) {
      await playScenario(app);
      const id = JSON.stringify("scripted-work");
      await app.ev(`(async () => {
        window.confirm = () => true; // "still working, close?": yes
        const cwd = views.get(${id}).cwd;
        await closeView(${id});
        openSession({ sessionId: ${id}, cwd });
        await new Promise((r) => setTimeout(r, 500));
        await closeView(${id});
        openSession({ sessionId: ${id}, cwd });
      })()`);
      await app.idle();
      assert.equal(await app.ev(`views.get(${id}).statusEl.textContent === "Resuming session…"`), false);
      assert.deepStrictEqual(await app.dump(), readBaseline("replay"));
    },
  },
];
