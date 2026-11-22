// The UI checks run by scripts/ui-check/run.mjs: { name, scenario?, modes?, run(app) }, each throwing on failure.
// app is a driver (driver.mjs) launched with the check's scenario (default panel-scenario.mjs), its mode already set.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./driver.mjs";

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

const V = `views.get("scripted-work")`; // the view of the scenario's session (driver.mjs: newSession)
const WAIT_SCENARIO = path.join(FIXTURES, "panel-wait-scenario.mjs");
const PANEL_MODES = ["subagents", "all"];
const savedMode = (app) => app.ev(`api.getSettings().then((s) => s.activityPanel)`);

/** What breaks "every group's body is where the mode says" in the page, one message each (none: it holds): inline
 *  the body is inside its group, in a panel mode inside the group's entry in panelBody; the entries are those of the
 *  log's panel groups, in log order; the panel is hidden exactly when it has no entry. */
function placementErrors(app, mode) {
  return app.ev(`(() => {
    const v = ${V}, mode = ${JSON.stringify(mode)}, errors = [];
    const groups = [...v.log.querySelectorAll(":scope > .group")];
    const inPanel = (g) => mode === "all" || (mode === "subagents" && g._info.kind === "subagent");
    groups.forEach((g, i) => {
      const name = "group " + i + " (" + g._info.kind + ", " + JSON.stringify(g._info.title) + ")";
      if (inPanel(g)) {
        if (!g._entry || g._body.parentNode !== g._entry || g._entry.parentNode !== v.panelBody) errors.push(name + ": its body is not in its entry in the panel");
        if (!g.classList.contains("in-panel")) errors.push(name + ": no class in-panel");
      } else {
        if (g._body.parentNode !== g) errors.push(name + ": its body is not inside it");
        if (g.classList.contains("in-panel")) errors.push(name + ": class in-panel");
        if (g._entry?.isConnected) errors.push(name + ": its entry is in the page");
      }
    });
    const entries = [...v.panelBody.children];
    const expected = groups.filter(inPanel).map((g) => g._entry);
    if (entries.length !== expected.length || entries.some((e, i) => e !== expected[i])) errors.push("the panel's entries are not those of the log's panel groups in log order");
    if (v.panel.hidden !== !entries.length) errors.push("panel.hidden is " + v.panel.hidden + " with " + entries.length + " entries");
    return errors;
  })()`);
}
const assertPlacement = async (app, mode, when) => assert.deepStrictEqual(await placementErrors(app, mode), [], `placement in mode ${mode} ${when}`);

/** The sync subagent's last message block in panel-wait-scenario (null before its first half arrived). */
const HALF_BLOCK = `([...${V}.log.querySelectorAll(":scope > .group.subagent")].flatMap((g) => [...g._body.querySelectorAll(".msg.agent")]).find((b) => b.textContent.includes("a.txt has")) ?? null)`;
/** The first prompt of panel-wait-scenario until its subagent stops halfway through its last message. */
async function untilHalfway(app) {
  await app.newSession();
  await app.send("Look around.");
  await app.check(`!!${HALF_BLOCK}`, "the subagent's message to stop halfway");
  assert.equal(await app.ev(`${HALF_BLOCK}._md().trim()`), "a.txt has", "the pause of panel-wait-scenario");
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
    modes: ["off"],
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
    modes: ["off"],
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
  {
    // Save without touching the select keeps the mode, in the page and on disk (a relaunch reads it back)
    name: "save-keeps-mode",
    modes: ["all"],
    async run(app) {
      await app.ev(`document.querySelector("#btn-settings").click()`);
      await app.check(`document.querySelector("#settings").open`, "the Settings dialog");
      await app.ev(`document.querySelector("#set-save").click()`);
      await app.check(`!document.querySelector("#settings").open`, "the Settings dialog to close");
      assert.equal(await app.ev(`api.getSettings().then((s) => s.activityPanel)`), "all");
      await app.close({ keep: true });
      const again = await launch({ scenario: PANEL_SCENARIO, dir: app.dir });
      try {
        assert.equal(await again.ev(`api.getSettings().then((s) => s.activityPanel)`), "all");
        await again.ev(`document.querySelector("#btn-settings").click()`);
        await again.check(`document.querySelector("#settings").open`, "the Settings dialog");
        assert.equal(await again.ev(`document.querySelector("#set-activity").value`), "all");
      } finally {
        await again.close();
      }
    },
  },
  {
    // every group's body is where the mode says, live and after a replay
    name: "panel-placement",
    async run(app) {
      const mode = await savedMode(app);
      await playScenario(app);
      await assertPlacement(app, mode, "live");
      await app.reload();
      await assertPlacement(app, mode, "after the replay");
    },
  },
  {
    // an in-panel group's header in the chat shows its entry; both headers say the same, ⏸ included
    name: "header-shows",
    modes: PANEL_MODES,
    async run(app) {
      await app.newSession();
      await app.send("Look around.");
      await app.idle();
      await app.send("Run both checks.");
      await app.check(`!!${V}.el.querySelector(".perm:not(.done)")`, "a permission card");
      const waiting = await app.ev(`[...${V}.log.querySelectorAll(":scope > .group")]
        .filter((g) => g.querySelector(":scope > summary .title").textContent.includes("⏸"))
        .map((g) => ({ inPanel: g.classList.contains("in-panel"), entry: g._entry?.querySelector(":scope > summary .title").textContent ?? null }))`);
      assert.equal(waiting.length, 1, "one group header with ⏸ in the chat");
      assert.equal(waiting[0].inPanel, true, "the waiting group is in the panel");
      assert.match(waiting[0].entry ?? "", /⏸/, "its entry's header shows ⏸");
      await app.answerPermission();
      await app.idle();
      await app.send("Anything else?");
      await app.idle();
      const headers = await app.ev(`[...${V}.log.querySelectorAll(":scope > .group.in-panel")].map((g) => {
        const head = (s) => [s.querySelector(".mark").textContent, s.querySelector(".title").textContent];
        return [head(g.querySelector(":scope > summary")), head(g._entry.querySelector(":scope > summary"))];
      })`);
      assert.ok(headers.length > 0, "groups in the panel");
      for (const [chat, entry] of headers) assert.deepStrictEqual(entry, chat, "the entry's header equals the group's header");
      const shown = await app.ev(`(() => {
        const g = ${V}.log.querySelector(":scope > .group.in-panel");
        window.__shown = g;
        g.querySelector(":scope > summary").click();
        return { groupOpen: g.open, entryOpen: g._entry.open, flash: g._entry.classList.contains("flash") };
      })()`);
      assert.deepStrictEqual(shown, { groupOpen: false, entryOpen: true, flash: true });
      await app.check(`!__shown._entry.classList.contains("flash")`, "the highlight to end");
    },
  },
  {
    // all six transitions after the scenario: placement, the chat (baseline), one Fork/Delete bar per group at most,
    // and every open state carried over (one more group opened where it is after each step)
    name: "mode-transitions",
    modes: ["off"],
    async run(app) {
      await playScenario(app);
      const live = readBaseline("live");
      await app.ev(`(() => {
        const v = ${V};
        window.__opened = [v.log.querySelector(":scope > .group.work"), v.log.querySelector(":scope > .group.subagent")];
        for (const g of __opened) g.open = true;
      })()`);
      for (const mode of ["subagents", "all", "off", "all", "subagents", "off"]) {
        const when = `after the switch to ${mode}`;
        await app.setMode(mode);
        await assertPlacement(app, mode, when);
        assert.deepStrictEqual(await app.dump(), live, `the chat ${when}`);
        assert.equal(await app.ev(`[...${V}.el.querySelectorAll(".group")].filter((g) => g.querySelectorAll(".acts").length > 1).length`), 0, `groups with two .acts ${when}`);
        const wrong = await app.ev(`(() => {
          const v = ${V};
          const groups = [...v.log.querySelectorAll(":scope > .group")];
          const wrong = groups.filter((g) => {
            const holder = g._body.parentNode;
            return holder.open !== __opened.includes(g) || (holder !== g && g.open);
          }).map((g) => groups.indexOf(g));
          const next = groups.find((g) => !__opened.includes(g));
          if (next) {
            next._body.parentNode.open = true;
            __opened.push(next);
          }
          return wrong;
        })()`);
        assert.deepStrictEqual(wrong, [], `groups whose open state did not follow their body ${when}`);
      }
    },
  },
  {
    // parallel sync subagents merge while their bodies are in the panel: the source and its entry go, the target's
    // entry takes the open state
    name: "merge-in-panel",
    modes: PANEL_MODES,
    scenario: WAIT_SCENARIO,
    async run(app) {
      const mode = await savedMode(app);
      const tests = `[...${V}.log.querySelectorAll(":scope > .group.subagent")].filter((g) => g._body.textContent.includes("Tests: all pass."))`;
      await app.newSession();
      await app.send("Look around.");
      await app.idle();
      await app.send("Run both checks.");
      await app.check(`${tests}.length === 1 && !!${V}.panelBody && ${tests}[0]._entry?.parentNode === ${V}.panelBody`, "the standalone group's entry");
      assert.equal(await app.ev(`(() => {
        window.__from = ${tests}[0];
        __from._entry.querySelector(":scope > summary").click();
        return __from._entry.open && __from.isConnected;
      })()`), true, "the standalone entry open before the merge");
      await app.answerPermission();
      await app.idle();
      const after = await app.ev(`(() => {
        const v = ${V};
        const groups = [...v.log.querySelectorAll(":scope > .group")];
        const g = ${tests};
        return {
          groups: g.length,
          title: g[0]?._info.title,
          entryOpen: !!g[0]?._entry?.open,
          fromGone: !__from.isConnected && !__from._entry.isConnected,
          detached: [...v.panelBody.children].filter((e) => !groups.some((x) => x._entry === e)).length,
        };
      })()`);
      assert.deepStrictEqual(after, { groups: 1, title: "Check the tests", entryOpen: true, fromGone: true, detached: 0 });
      await assertPlacement(app, mode, "after the merge");
    },
  },
  {
    // the mode switches while a subagent streams: its block moves with the body and gets the rest of its text once
    name: "switch-while-streaming",
    modes: ["off"],
    scenario: WAIT_SCENARIO,
    async run(app) {
      await untilHalfway(app);
      await app.ev(`window.__block = ${HALF_BLOCK}`);
      await app.setMode("all");
      assert.deepStrictEqual(
        await app.ev(`({ same: ${HALF_BLOCK} === __block, text: __block._md().trim(), inPanel: ${V}.panelBody.contains(__block) })`),
        { same: true, text: "a.txt has", inPanel: true },
        "the block in the panel while the subagent still streams",
      );
      await app.idle();
      const blocks = await app.ev(`[...${V}.log.querySelectorAll(":scope > .group.subagent")].flatMap((g) => [...g._body.querySelectorAll(".msg.agent")]).filter((b) => b.textContent.includes("a.txt has")).map((b) => ({ same: b === __block, text: b._md().trim() }))`);
      assert.deepStrictEqual(blocks, [{ same: true, text: "a.txt has two lines." }]);
      await assertPlacement(app, "all", "after the turn");
    },
  },
  {
    // the link and path handler works inside the panel: click and middle click
    name: "panel-links",
    modes: ["all"],
    async run(app) {
      await playScenario(app);
      const calls = await app.ev(`(() => {
        const v = ${V};
        const calls = [];
        v.openLink = (href) => calls.push(href);
        const body = v.log.querySelector(":scope > .group.in-panel")._body;
        const a = document.createElement("a");
        a.setAttribute("href", "https://example.com/doc");
        a.addEventListener("click", (e) => e.preventDefault()); // never navigate the page, whatever the app does
        const p = document.createElement("span");
        p.dataset.path = "a.txt";
        body.append(a, p);
        const ev = (type, button) => new MouseEvent(type, { bubbles: true, cancelable: true, button });
        a.dispatchEvent(ev("click", 0));
        a.dispatchEvent(ev("auxclick", 1));
        p.dispatchEvent(ev("click", 0));
        return calls;
      })()`);
      assert.deepStrictEqual(calls, ["https://example.com/doc", "https://example.com/doc", "a.txt"]);
    },
  },
  {
    // "N subagents running" shows the first running subagent's entry
    name: "running-button",
    modes: ["subagents"],
    scenario: WAIT_SCENARIO,
    async run(app) {
      await untilHalfway(app);
      const shown = await app.ev(`(() => {
        const v = ${V};
        const g = ${HALF_BLOCK}.closest(".panel-entry, .group");
        if (v.bgEl.hidden) return "no running button";
        v.bgEl.click();
        const group = [...v.log.querySelectorAll(":scope > .group")].find((x) => x._entry === g);
        return { entry: g.classList.contains("panel-entry"), entryOpen: g.open, groupOpen: group?.open ?? null };
      })()`);
      assert.deepStrictEqual(shown, { entry: true, entryOpen: true, groupOpen: false });
      await app.idle();
    },
  },
];
