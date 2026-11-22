// The UI checks run by scripts/ui-check/run.mjs: { name, scenario?, modes?, run(app) }, each throwing on failure.
// app is a driver (driver.mjs) launched with the check's scenario (default panel-scenario.mjs), its mode already set.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PARTS } from "../../electron/test/fixtures/acp/panel-scroll-scenario.mjs";
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

// --- scrolling (panel-scroll-scenario.mjs, in a window 500 px high so that the log and the panel overflow)
const SCROLL_SCENARIO = path.join(FIXTURES, "panel-scroll-scenario.mjs");
const LOG = `${V}.log`;
const PANEL = `${V}.panelBody`;
const FIRST_GROUP = `${V}.log.querySelector(":scope > .group")`; // the work group (the thought and the tool)
const SUB_GROUP = `${V}.log.querySelector(":scope > .group.subagent")`;
/** The subagent's message block (null before it exists). */
const SUB_BLOCK = `(${SUB_GROUP}?._body.querySelector(".msg.agent") ?? null)`;
/** dist: how far (px) the scroller is from its bottom; over: how much its content is taller than it; top: scrollTop. */
const scrollState = (app, el) => app.ev(`(() => { const e = ${el}; return { top: e.scrollTop, dist: e.scrollHeight - e.scrollTop - e.clientHeight, over: e.scrollHeight - e.clientHeight }; })()`);
const frames = (app) => app.ev("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
/** Scrolls el as you would (the app sees only the scroll event), then waits for that event to have been handled. */
async function scrollTo(app, el, top) {
  await app.ev(`${el}.scrollTop = ${top}`);
  await frames(app);
}
const untilPart = (app, k) => app.check(`!!${SUB_BLOCK}?.textContent.includes("Part ${k}.")`, `the subagent's part ${k}`);
async function assertAtBottom(app, el, what) {
  const s = await scrollState(app, el);
  assert.ok(s.dist <= 2, `${what}: ${s.dist} px from the bottom`);
  return s;
}
/** The first prompt of panel-scroll-scenario in the short window, until the subagent's group exists. */
async function untilSubagent(app) {
  await app.resize(1280, 500);
  await app.newSession();
  await app.send("Explain the files.");
  await app.check(`!!${SUB_GROUP}`, "the subagent's group");
}
/** Opens the subagent's entry as a mode switch carries an open group over: not a click, which stops the follow. */
const openSubEntry = (app) => app.ev(`${SUB_GROUP}._entry.open = true`);
/** In a panel mode (the subagent's body is in the panel): its entry open, the panel scrolled to its end, following. */
async function followingPanel(app) {
  await openSubEntry(app);
  await frames(app);
  await scrollTo(app, PANEL, `${PANEL}.scrollHeight`);
  assert.equal(await app.ev(`${V}.panelFollow`), true, "the panel follows");
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
  {
    // a following panel stays at its bottom while a subagent streams into an open entry
    name: "panel-follows",
    modes: ["all"],
    scenario: SCROLL_SCENARIO,
    async run(app) {
      await untilSubagent(app);
      await openSubEntry(app);
      let s;
      for (let k = 1; k <= PARTS; k++) {
        await untilPart(app, k);
        s = await assertAtBottom(app, PANEL, `the panel after part ${k}`);
      }
      assert.ok(s.over > 100, `the panel overflows (${s.over} px)`);
      await app.idle();
    },
  },
  {
    // a group shown from the chat stops the panel's follow (its own scroll does not turn it back on); scrolling to
    // the end follows again; opening an entry by its own header stops it too
    name: "panel-stops-after-show",
    modes: ["all"],
    scenario: SCROLL_SCENARIO,
    async run(app) {
      await untilSubagent(app);
      await openSubEntry(app);
      await untilPart(app, 4);
      const before = await assertAtBottom(app, PANEL, "the panel after part 4");
      assert.ok(before.over > 0, `the panel overflows after part 4 (${before.over} px)`);
      const top = await app.ev(`(() => { ${FIRST_GROUP}.querySelector(":scope > summary").click(); return ${PANEL}.scrollTop; })()`);
      assert.ok(top < before.top, "the shown entry scrolled into view");
      for (const k of [5, 6]) {
        await untilPart(app, k);
        assert.deepStrictEqual(await app.ev(`({ top: ${PANEL}.scrollTop, follow: ${V}.panelFollow })`), { top, follow: false }, `the panel after part ${k}`);
      }
      await scrollTo(app, PANEL, `${PANEL}.scrollHeight`);
      await untilPart(app, 7);
      await assertAtBottom(app, PANEL, "the panel after part 7, scrolled to its end");
      // the work entry's own header: a click closes it, the next one opens it
      await app.ev(`${FIRST_GROUP}._entry.querySelector(":scope > summary").click()`);
      await frames(app);
      const opened = await app.ev(`(() => { ${FIRST_GROUP}._entry.querySelector(":scope > summary").click(); return { top: ${PANEL}.scrollTop, open: ${FIRST_GROUP}._entry.open }; })()`);
      assert.equal(opened.open, true, "the entry opened by its header");
      await untilPart(app, 9);
      assert.deepStrictEqual(await app.ev(`({ top: ${PANEL}.scrollTop, follow: ${V}.panelFollow })`), { top: opened.top, follow: false }, "the panel after part 9");
      await app.idle();
    },
  },
  {
    // a following log keeps its bottom when the panel first shows (the log gets narrower) and through mode switches
    name: "log-keeps-bottom",
    modes: ["subagents"],
    scenario: SCROLL_SCENARIO,
    async run(app) {
      await untilSubagent(app);
      assert.equal(await app.ev(`${V}.panel.hidden`), false, "the panel shows");
      const s = await assertAtBottom(app, LOG, "the log when the first subagent group appears");
      assert.ok(s.over > 100, `the log overflows (${s.over} px)`);
      await app.idle();
      for (const mode of ["off", "subagents"]) {
        await app.setMode(mode);
        await frames(app);
        assert.equal(await app.ev(`${V}.follow`), true, `the log follows after the switch to ${mode}`);
        await assertAtBottom(app, LOG, `the log after the switch to ${mode}`);
      }
    },
  },
  {
    // a scrolled-up log stays put while groups are created, a header shows its group and the mode switches
    name: "log-keeps-place",
    modes: ["all"],
    scenario: SCROLL_SCENARIO,
    async run(app) {
      await app.resize(1280, 500);
      await app.newSession();
      await app.send("Explain the files.");
      await app.check(`${LOG}.scrollHeight - ${LOG}.clientHeight > 100`, "the long answer");
      await scrollTo(app, LOG, 0);
      const place = (when) => app.ev(`({ top: ${LOG}.scrollTop, follow: ${V}.follow })`).then((s) => assert.deepStrictEqual(s, { top: 0, follow: false }, `the log ${when}`));
      await place("scrolled to the top");
      await app.check(`!!${SUB_GROUP}`, "the subagent's group");
      await place("when the groups appear");
      await app.ev(`${FIRST_GROUP}.querySelector(":scope > summary").click()`);
      await frames(app);
      await place("after a header showed its group");
      await app.idle();
      await place("after the turn");
      for (const mode of ["subagents", "off", "all"]) {
        await app.setMode(mode);
        await frames(app);
        await place(`after the switch to ${mode}`);
      }
    },
  },
  {
    // a size change alone (nothing appended): a following log, and a following panel with an open entry, keep their
    // bottoms when the window gets narrower (the log's text reflows) and lower
    name: "resize-keeps-bottom",
    scenario: SCROLL_SCENARIO,
    async run(app) {
      const panel = (await savedMode(app)) !== "off";
      await untilSubagent(app);
      await app.idle();
      if (panel) await followingPanel(app);
      assert.equal(await app.ev(`${V}.follow`), true, "the log follows");
      assert.ok((await assertAtBottom(app, LOG, "the log before the resize")).over > 100, "the log overflows");
      if (panel) assert.ok((await assertAtBottom(app, PANEL, "the panel before the resize")).over > 100, "the panel overflows");
      await app.resize(1000, 500);
      await frames(app);
      await assertAtBottom(app, LOG, "the log in a narrower window");
      await app.resize(1000, 400);
      await frames(app);
      await assertAtBottom(app, LOG, "the log in a lower window");
      if (panel) await assertAtBottom(app, PANEL, "the panel in a lower window");
    },
  },
  {
    // the view streams while another view is active: shown again, its following log and panel are at their bottoms
    name: "switch-keeps-bottom",
    scenario: SCROLL_SCENARIO,
    async run(app) {
      const panel = (await savedMode(app)) !== "off";
      await app.resize(1280, 500);
      await app.newSession();
      const other = await app.ev(`(async () => {
        await newSession(${V}.cwd.replace(/\\/[^/]+$/, "")); // a second session, in the launch's folder
        return [...views.keys()].find((id) => id !== "scripted-work") ?? null;
      })()`);
      assert.ok(other, "a second view");
      await app.ev(`activate("scripted-work")`);
      await app.send("Explain the files.");
      await app.check(`!!${SUB_GROUP}`, "the subagent's group");
      if (panel) await followingPanel(app);
      await app.ev(`activate(${JSON.stringify(other)})`);
      await app.idle();
      assert.equal(await app.ev(`${V}.el.classList.contains("active")`), false, "the view streamed while hidden");
      await app.ev(`activate("scripted-work")`);
      await frames(app);
      assert.ok((await assertAtBottom(app, LOG, "the log shown again")).over > 100, "the log overflows");
      if (panel) assert.ok((await assertAtBottom(app, PANEL, "the panel shown again")).over > 100, "the panel overflows");
    },
  },
  {
    // sending and the end of a replay take the log and the panel to their bottoms
    name: "forced-scroll",
    modes: ["all"],
    scenario: SCROLL_SCENARIO,
    async run(app) {
      await untilSubagent(app);
      await app.idle();
      await openSubEntry(app);
      await frames(app);
      assert.ok((await scrollState(app, PANEL)).over > 100, "the panel overflows");
      await scrollTo(app, PANEL, 0);
      await scrollTo(app, LOG, 0);
      await app.send("Again.");
      await assertAtBottom(app, LOG, "the log after sending");
      await assertAtBottom(app, PANEL, "the panel after sending");
      await app.idle();
      await app.reload();
      await frames(app);
      assert.ok((await scrollState(app, LOG)).over > 100, "the replayed log overflows");
      await assertAtBottom(app, LOG, "the log after the replay");
      await assertAtBottom(app, PANEL, "the panel after the replay");
    },
  },
];
