// The UI checks run by scripts/ui-check/run.mjs: { name, scenario?, modes?, run(app) }, each throwing on failure.
// app is a driver (driver.mjs) launched with the check's scenario (default panel-scenario.mjs), its mode already set.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LATE_TEXT } from "../../electron/test/fixtures/acp/late-group-scenario.mjs";
import { PARTS } from "../../electron/test/fixtures/acp/panel-scroll-scenario.mjs";
import { RUNNING_TITLE } from "../../electron/test/fixtures/acp/tool-split-scenario.mjs";
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
const SPLIT_SCENARIO = path.join(FIXTURES, "tool-split-scenario.mjs");
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
    if (v.activityBtn.hidden !== !entries.length) errors.push("the Activity button's hidden is " + v.activityBtn.hidden + " with " + entries.length + " entries");
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
/** A recorded history (the scripted agent's .scripted-agent.json updates) of n turns, each a question, a work group
 *  (a thought, a tool), a sync task with its subagent's message (a subagent group) and a two-paragraph answer. */
function longHistory(n) {
  const para = words(3, "The answer goes on about the folder, its files and what each of them holds.");
  return Array.from({ length: n }, (_, i) => {
    const agentId = `66666666-6666-4666-8666-${String(i).padStart(12, "0")}`;
    const text = (messageId, t, meta) => ({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: t }, ...meta });
    return [
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: `Question ${i}` } },
      { sessionUpdate: "agent_thought_chunk", messageId: `th${i}`, content: { type: "text", text: `Thinking ${i}` } },
      { sessionUpdate: "tool_call", toolCallId: `ls${i}`, title: "ls", kind: "execute", status: "completed", rawInput: { command: "ls" } },
      {
        sessionUpdate: "tool_call",
        toolCallId: `task${i}`,
        title: "Explain the files",
        kind: "other",
        status: "pending",
        rawInput: { agent_type: "explore", name: `explain-${i}`, description: "Explain the files", prompt: "Explain the files.", mode: "sync" },
      },
      text(`s${i}`, `Subagent ${i}. ${para}`, { _meta: { "github.com/copilot": { agentId } } }),
      { sessionUpdate: "tool_call_update", toolCallId: `task${i}`, status: "completed", content: [{ type: "content", content: { type: "text", text: "Explained." } }], rawOutput: { content: "Explained." } },
      text(`m${i}`, `Answer ${i}. ${para}\n\n${para}`),
    ];
  }).flat();
}
const words = (n, line) => Array.from({ length: n }, () => line).join(" ");
/** Opens the subagent's entry as a mode switch carries an open group over: not a click, which stops the follow. */
const openSubEntry = (app) => app.ev(`${SUB_GROUP}._entry.open = true`);
/** In a panel mode (the subagent's body is in the panel): its entry open, the panel scrolled to its end, following. */
async function followingPanel(app) {
  await openSubEntry(app);
  await frames(app);
  await scrollTo(app, PANEL, `${PANEL}.scrollHeight`);
  assert.equal(await app.ev(`${V}.panelFollow`), true, "the panel follows");
}

// --- width, collapse and the narrow drawer (Task 5)
// a folder that does not exist: the broker-restart check restarts nothing
const NO_BROKER_REPO = path.join(os.tmpdir(), "copilot-relay-ui-check-no-such-repo");
const LONG_WAIT_SCENARIO = path.join(FIXTURES, "panel-long-wait-scenario.mjs");
/** The view's panel as you see it: its width in real pixels, 0 when it is not shown. */
const panelWidth = (app, v = V) => app.ev(`(() => { const p = ${v}.panel; return p.checkVisibility() ? Math.round(p.getBoundingClientRect().width) : 0; })()`);
const shown = (app, el) => app.ev(`${el}.checkVisibility()`);
/** Drags the view's handle dx px (negative: left) with the pointer, as you would; then waits for the layout. */
async function dragHandle(app, dx, v = V) {
  await app.ev(`(() => {
    const h = ${v}.panelHandle, r = h.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const ev = (type, clientX) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1, clientX, clientY: y });
    h.dispatchEvent(ev("pointerdown", x));
    const dx = ${dx};
    document.elementFromPoint(x + dx / 2, y)?.dispatchEvent(ev("pointermove", x + dx / 2));
    document.body.dispatchEvent(ev("pointermove", x + dx));
    document.body.dispatchEvent(ev("pointerup", x + dx));
  })()`);
  await frames(app);
}
const panelButton = (v = V) => `${v}.panel.querySelector(".panel-head button")`;
/** Clicks the panel head's button (collapse, or close the drawer). */
async function panelHeadButton(app, v = V) {
  await app.ev(`${panelButton(v)}.click()`);
  await frames(app);
}
async function activityButton(app, v = V) {
  assert.equal(await shown(app, `${v}.activityBtn`), true, "the Activity button shows");
  await app.ev(`${v}.activityBtn.click()`);
  await frames(app);
}
/** Clicks the first in-panel group's header in the chat. */
async function headerClick(app, v = V) {
  await app.ev(`${v}.log.querySelector(":scope > .group.in-panel > summary").click()`);
  await frames(app);
}
/** The first prompt of panel-scenario in the view. */
async function firstTurn(app) {
  await app.newSession();
  await app.send("Look around.");
  await app.idle();
}
/** A second session (in the launch's folder) that has played panel-scenario's first prompt; it is the active view. */
async function secondView(app) {
  const id = await app.ev(`(async () => {
    await newSession(${V}.cwd.replace(/\\/[^/]+$/, ""));
    return [...views.keys()].find((id) => id !== "scripted-work") ?? null;
  })()`);
  assert.ok(id, "a second view");
  const v = `views.get(${JSON.stringify(id)})`;
  await app.ev(`(() => { const v = ${v}; v.input.value = "Look around."; v.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
  await app.check(`(() => { const v = ${v}; return !v.busy && !!v.panelBody.firstElementChild && Date.now() - (v.lastUpdate ?? 0) > 300; })()`, "the second view's turn");
  await frames(app);
  return { id, v };
}
const activate = async (app, id) => {
  await app.ev(`activate(${JSON.stringify(id)})`);
  await frames(app);
};
/** Closes the app, keeping its folder, and launches it again there with the view of scripted-work open. */
async function relaunch(app, width = 1280) {
  await app.close({ keep: true });
  const again = await launch({ scenario: PANEL_SCENARIO, dir: app.dir, width });
  try {
    await again.ev(`openSession({ sessionId: "scripted-work", cwd: ${JSON.stringify(path.join(app.dir, "work"))} })`, "the session to reopen");
    await again.check(`(() => { const v = ${V}; return v && !v.busy && !v.resuming && !!v.panelBody.firstElementChild && Date.now() - (v.lastUpdate ?? 0) > 300; })()`, "the replay");
    await frames(again);
  } catch (e) {
    await again.close();
    throw e;
  }
  return again;
}
/** In the narrow layout: the drawer's state as you see it. */
const drawerState = (app) => app.ev(`(() => {
  const v = ${V};
  return { narrow: v.row.classList.contains("narrow"), shown: v.panel.checkVisibility(), hidden: v.panel.hidden, logWidth: v.log.offsetWidth, rowWidth: v.row.clientWidth };
})()`);
const storedUi = (app) => app.ev("localStorage.getItem(UI_KEY)");

// --- edit mode, a dead view, Stop, a view switched while hidden, the turn marks (Task 6)
/** What breaks "a panel entry is dimmed exactly when its group in the log comes after the message being edited" (none
 *  while not editing), one message each; with the number of entries dimmed and not. */
const dimState = (app) => app.ev(`(() => {
  const v = ${V}, from = v.edit?.el ?? null, errors = [];
  let dimmed = 0, clear = 0;
  [...v.log.querySelectorAll(":scope > .group")].forEach((g, i) => {
    if (!g._entry) return;
    const after = !!from && !!(from.compareDocumentPosition(g) & Node.DOCUMENT_POSITION_FOLLOWING);
    const dim = g._entry.classList.contains("dim");
    if (dim !== after) errors.push("group " + i + " (" + g._info.kind + "): dim " + dim + ", after the edited message " + after);
    if (!g.classList.contains("in-panel")) return;
    const opacity = getComputedStyle(g._entry).opacity;
    if (opacity !== (after ? "0.45" : "1")) errors.push("group " + i + ": its entry's opacity is " + opacity);
    if (after) dimmed++;
    else clear++;
  });
  return { errors, dimmed, clear };
})()`);
/** The scripted session has no Copilot history to count (its id is no UUID): startEdit's own code, its one history
 *  call (api.countFrom, for the banner) answered in the page. */
async function stubEditCount(app) {
  const ok = await app.ev(`(() => {
    const src = SessionView.prototype.startEdit.toString();
    if (src.split("api.countFrom(").length !== 2) return false;
    window.__countFrom = async () => ({ removedUserMessages: 2, removedEvents: 0 });
    SessionView.prototype.startEdit = (0, eval)("({ " + src.replace("api.countFrom(", "__countFrom(") + " })").startEdit;
    return true;
  })()`);
  assert.equal(ok, true, "startEdit calls api.countFrom once");
}
/** The pids of the scripted agents running in the launch's work folder (the session's Copilot processes). */
function agentPids(app) {
  const work = path.join(app.dir, "work");
  return readdirSync("/proc")
    .filter((p) => /^\d+$/.test(p))
    .filter((p) => {
      try {
        return readlinkSync(`/proc/${p}/cwd`) === work && readFileSync(`/proc/${p}/cmdline`, "utf8").includes("scripted-agent.mjs");
      } catch {
        return false; // gone, or not ours
      }
    })
    .map(Number);
}
/** Every group's mark: in the chat, and in its entry when its body is in the panel (else null). */
const groupMarks = (app) => app.ev(`[...${V}.log.querySelectorAll(":scope > .group")].map((g) => ({
  kind: g._info.kind,
  chat: g.querySelector(":scope > summary .mark").textContent,
  entry: g.classList.contains("in-panel") ? g._entry.querySelector(":scope > summary .mark").textContent : null,
}))`);
/** For each turn (from its user message to the next one): how many of its other log children have Fork and Delete;
 *  and the children with more than one Fork. */
const turnActs = (app) => app.ev(`(() => {
  const counts = [], doubles = [];
  [...${V}.log.children].forEach((e, i) => {
    if (e.classList.contains("msg") && (e.classList.contains("user") || e.classList.contains("relay"))) return counts.push(0);
    if (!counts.length) return;
    const labels = [...e.querySelectorAll(".acts button.act")].map((b) => b.textContent);
    const forks = labels.filter((l) => l === "Fork").length;
    if (forks > 1) doubles.push(i);
    if (forks && labels.includes("Delete")) counts[counts.length - 1]++;
  });
  return { counts, doubles };
})()`);
/** The marks of panel-wait-scenario's groups after a Stop halfway through the sync subagent, as mode off shows them:
 *  the two work groups (before and after the plan) ✓, their tools ended; the subagent ⊘, stopped before its task
 *  ended. */
/** Every work group's header as shown: the leading mark and its class, the title's text and tooltip, the classes of
 *  the marks inside the title; the same for its panel entry (null when its body is not in the panel). */
const workHeaders = (app) => app.ev(`[...${V}.log.querySelectorAll(":scope > .group.work")].map((g) => {
  const head = (s) => {
    const title = s.querySelector(".title");
    return { mark: s.querySelector(".mark").textContent, cls: s.querySelector(".mark").className, text: title.textContent, tip: title.title, inner: [...title.querySelectorAll(".mark")].map((m) => m.className) };
  };
  return { chat: head(g.querySelector(":scope > summary")), entry: g.classList.contains("in-panel") ? head(g._entry.querySelector(":scope > summary")) : null };
})`);
const STOP_MARKS = [
  { kind: "work", chat: "✓" },
  { kind: "work", chat: "✓" },
  { kind: "subagent", chat: "⊘" },
];

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
    // an in-panel group's header in the chat shows its entry; both headers say the same, ⏸ included; the card does not
    // take the focus out of the panel
    name: "header-shows",
    modes: PANEL_MODES,
    async run(app) {
      await app.newSession();
      await app.send("Look around.");
      await app.idle();
      // the focus in the panel (wide layout): an arriving permission card leaves it there
      await app.ev(`${V}.panel.querySelector(".panel-entry > summary").focus()`);
      await app.send("Run both checks.");
      await app.check(`!!${V}.el.querySelector(".perm:not(.done)")`, "a permission card");
      assert.equal(await app.ev(`${V}.panel.contains(document.activeElement)`), true, "the focus still in the panel after the card arrived");
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
      // the panel resized, collapsed and expanded
      const width = await panelWidth(app);
      await dragHandle(app, -60);
      assert.equal(await panelWidth(app), width + 60, "the panel dragged wider");
      for (const [what, act] of [["the drag", () => {}], ["collapsing", () => panelHeadButton(app)], ["expanding", () => activityButton(app)]]) {
        await act();
        await frames(app);
        assert.equal(await app.ev(`${V}.follow`), true, `the log follows after ${what}`);
        await assertAtBottom(app, LOG, `the log after ${what}`);
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
      await dragHandle(app, -60);
      await place("after the panel was dragged wider");
      await panelHeadButton(app);
      assert.equal(await panelWidth(app), 0, "the panel collapsed");
      await place("after the panel collapsed");
      await activityButton(app);
      await place("after the panel expanded");
    },
  },
  {
    // the handle's drag sets the width in real pixels, clamped to [280, row − 480] at every chat scale; every view
    // has it, and it is kept after a relaunch (a window 1600 wide: the row is 1300, the maximum 820)
    name: "panel-width",
    modes: ["all"],
    async run(app) {
      await app.resize(1600, 800);
      await firstTurn(app);
      assert.equal(await app.ev(`${V}.row.clientWidth`), 1300, "the row of a window 1600 wide");
      assert.equal(await panelWidth(app), 420, "the default width");
      await dragHandle(app, -100);
      assert.equal(await panelWidth(app), 520, "dragged 100 px left");
      for (const scale of [1, 0.7, 2]) {
        await app.ev(`(() => { ui.chatScale = ${scale}; applyChatScale(); })()`);
        await frames(app);
        await dragHandle(app, -2000);
        assert.equal(await panelWidth(app), 1300 - 480, `dragged far left at chat scale ${scale}`);
        await dragHandle(app, 2000);
        assert.equal(await panelWidth(app), 280, `dragged far right at chat scale ${scale}`);
      }
      await app.ev(`(() => { ui.chatScale = 1; applyChatScale(); })()`);
      await dragHandle(app, -220);
      assert.equal(await panelWidth(app), 500, "dragged back to 500");
      const { v } = await secondView(app);
      assert.equal(await panelWidth(app, v), 500, "the second view's width");
      await activate(app, "scripted-work");
      assert.equal(await panelWidth(app), 500, "the first view shown again");
      const again = await relaunch(app, 1600);
      try {
        assert.equal(await again.ev("ui.panelWidth"), 500, "the stored width after a relaunch");
        assert.equal(await panelWidth(again), 500, "the width after a relaunch");
      } finally {
        await again.close();
      }
    },
  },
  {
    // the panel head's button collapses the panel in every view, kept after a relaunch; "Activity" and a header
    // click in the chat bring it back
    name: "panel-collapse",
    modes: ["all"],
    async run(app) {
      await firstTurn(app);
      const { id, v } = await secondView(app);
      await activate(app, "scripted-work");
      assert.equal(await panelWidth(app), 420, "the panel shows");
      await panelHeadButton(app);
      assert.equal(await panelWidth(app), 0, "collapsed by its head's button");
      assert.equal(await app.ev(`${V}.log.offsetWidth === ${V}.row.clientWidth`), true, "the log takes the row");
      assert.equal(await app.ev(`${V}.panel.hidden`), false, "panel.hidden: the view still has entries");
      await activate(app, id);
      assert.equal(await panelWidth(app, v), 0, "collapsed in the second view");
      await activate(app, "scripted-work");
      const again = await relaunch(app);
      try {
        assert.equal(await panelWidth(again), 0, "still collapsed after a relaunch");
        await activityButton(again);
        assert.equal(await panelWidth(again), 420, "Activity brings it back");
        assert.equal(await again.ev("ui.panelCollapsed"), false, "stored: not collapsed");
        await panelHeadButton(again);
        assert.equal(await panelWidth(again), 0, "collapsed again");
        await headerClick(again);
        assert.equal(await panelWidth(again), 420, "a header click in the chat brings it back");
        assert.equal(await again.ev(`${V}.log.querySelector(":scope > .group.in-panel")._entry.open`), true, "its entry open");
      } finally {
        await again.close();
      }
    },
  },
  {
    // a view below 760 px (window 900: view 600): the panel is a drawer over the log, closed until shown; crossing
    // between the layouts writes nothing and opens nothing
    name: "drawer",
    modes: ["all"],
    async run(app) {
      await app.resize(900, 800);
      await firstTurn(app);
      const closed = await drawerState(app);
      assert.deepStrictEqual(closed, { narrow: true, shown: false, hidden: false, logWidth: 600, rowWidth: 600 }, "the narrow layout, drawer closed");
      assert.equal(await shown(app, `${V}.activityBtn`), true, "the Activity button shows");
      await headerClick(app);
      const open = await drawerState(app);
      assert.deepStrictEqual(open, { ...closed, shown: true }, "a header click opens the drawer, the log keeps its width");
      const over = await app.ev(`(() => {
        const v = ${V}, p = v.panel.getBoundingClientRect(), r = v.row.getBoundingClientRect();
        return { position: getComputedStyle(v.panel).position, right: p.right === r.right, top: p.top === r.top, bottom: p.bottom === r.bottom, width: Math.round(p.width) };
      })()`);
      assert.deepStrictEqual(over, { position: "absolute", right: true, top: true, bottom: true, width: 420 }, "the drawer over the log's right side");
      await panelHeadButton(app);
      assert.deepStrictEqual(await drawerState(app), closed, "its button closes it");
      await activityButton(app);
      assert.deepStrictEqual(await drawerState(app), open, "Activity opens it");
      await activityButton(app);
      assert.deepStrictEqual(await drawerState(app), closed, "Activity closes it");
      // crossing to the wide layout and back
      const stored = await storedUi(app);
      await app.resize(1280, 800);
      await frames(app);
      assert.equal(await panelWidth(app), 420, "the wide layout shows the panel");
      await app.resize(900, 800);
      await frames(app);
      assert.deepStrictEqual(await drawerState(app), closed, "back in the narrow layout: the drawer stays closed");
      assert.equal(await storedUi(app), stored, "nothing stored by the crossing");
      // collapsed in the wide layout: the narrow one does not open the drawer, the wide one keeps it collapsed
      await app.resize(1280, 800);
      await frames(app);
      await panelHeadButton(app);
      assert.equal(await panelWidth(app), 0, "collapsed");
      const collapsed = await storedUi(app);
      await app.resize(900, 800);
      await frames(app);
      assert.deepStrictEqual(await drawerState(app), closed, "collapsed, then narrow: the drawer closed");
      await app.resize(1280, 800);
      await frames(app);
      assert.equal(await panelWidth(app), 0, "wide again: still collapsed");
      assert.equal(await storedUi(app), collapsed, "nothing stored by the crossings");
    },
  },
  {
    // Esc with the drawer open while a turn runs: inside the drawer it closes the drawer (the turn runs on), in the
    // message box it stops the turn (the drawer stays)
    name: "drawer-esc",
    modes: ["all"],
    scenario: LONG_WAIT_SCENARIO,
    async run(app) {
      await app.resize(900, 800);
      await app.newSession();
      await app.send("Look around.");
      await app.check(`${V}.busy && !!${V}.log.querySelector(":scope > .group.subagent.in-panel")`, "the turn's groups");
      await app.ev(`(() => { const v = ${V}, stop = v.cancel; window.__stops = 0; v.cancel = function () { __stops++; return stop.call(this); }; })()`);
      const esc = (target) => app.ev(`(() => { const t = ${target}; t.focus(); t.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); })()`);
      const state = () => app.ev(`({ open: ${V}.panel.checkVisibility(), busy: ${V}.busy, stops: __stops })`);
      await headerClick(app);
      assert.deepStrictEqual(await state(), { open: true, busy: true, stops: 0 }, "the drawer open while the turn runs");
      await esc(`${V}.panel.querySelector(".panel-entry > summary")`);
      await frames(app);
      assert.deepStrictEqual(await state(), { open: false, busy: true, stops: 0 }, "Esc inside the drawer closes it, the turn runs on");
      assert.equal(await app.ev(`document.activeElement === ${V}.activityBtn`), true, "the focus back on the Activity button");
      // a double Esc: the second one lands where the focus went, and must not stop the turn
      await esc("document.activeElement");
      await frames(app);
      assert.deepStrictEqual(await state(), { open: false, busy: true, stops: 0 }, "a second Esc after the drawer closed");
      // a held Esc: its repeated keydowns inside the open drawer do nothing
      await activityButton(app);
      await app.ev(`(() => { const t = ${V}.panel.querySelector(".panel-entry > summary"); t.focus(); t.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", repeat: true, bubbles: true, cancelable: true })); })()`);
      await frames(app);
      assert.deepStrictEqual(await state(), { open: true, busy: true, stops: 0 }, "a repeated Esc inside the drawer");
      await esc(`${V}.input`);
      await app.check(`!${V}.busy`, "the turn to stop"); // the scripted agent ends its prompt on session/cancel
      await frames(app);
      assert.deepStrictEqual(await state(), { open: true, busy: false, stops: 1 }, "Esc in the message box stops the turn, the drawer stays");
    },
  },
  {
    // a permission card arriving under an open drawer closes it: the question must be visible
    name: "drawer-permission",
    modes: ["all"],
    async run(app) {
      await app.resize(900, 800);
      await firstTurn(app);
      await headerClick(app);
      assert.equal(await shown(app, `${V}.panel`), true, "the drawer open");
      await app.send("Run both checks.");
      await app.check(`!!${V}.el.querySelector(".perm:not(.done)")`, "a permission card");
      await frames(app);
      assert.equal(await shown(app, `${V}.panel`), false, "the card closed the drawer");
      assert.equal(await shown(app, `${V}.el.querySelector(".perm:not(.done)")`), true, "the card shows");
      await app.answerPermission();
      await app.idle();
      // a delegation card ("New session requested") closes it too (as main would send one: no session is created)
      await headerClick(app);
      assert.equal(await shown(app, `${V}.panel`), true, "the drawer open again");
      await app.ev(`${V}.delegationCard({ requestId: "ui-check", name: "child", task: "A task.", agent: "", model: "", cwd: ${V}.cwd })`);
      await frames(app);
      assert.equal(await shown(app, `${V}.panel`), false, "the delegation card closed the drawer");
      assert.equal(await shown(app, `${V}.el.querySelector(".perm.delegation")`), true, "the delegation card shows");
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
  ...[
    ["replay-ends-at-bottom", PANEL_SCENARIO],
    ["failed-replay-ends-at-bottom", path.join(FIXTURES, "failing-load-scenario.mjs")],
  ].map(([name, scenario]) => ({
    // a long history opened (a replay, nothing scrolls during it): the log, and in a panel mode the panel, end at
    // their bottoms and follow; also when the load fails after the replay (the dead view's error line is the last)
    name,
    scenario,
    async run(app) {
      const panel = (await savedMode(app)) !== "off";
      await app.resize(1280, 500);
      await app.newSession();
      writeFileSync(path.join(app.dir, "work", ".scripted-agent.json"), JSON.stringify({ sessionId: "scripted-work", updates: longHistory(30) }));
      await app.reload();
      await frames(app);
      const failed = scenario !== PANEL_SCENARIO;
      assert.equal(await app.ev(`${V}.dead`), failed, failed ? "the load failed" : "the load succeeded");
      if (failed) assert.equal(await app.ev(`${LOG}.lastElementChild.className`), "msg error", "the error line is the last");
      assert.deepStrictEqual(await app.ev(`({ follow: ${V}.follow, panelFollow: ${V}.panelFollow })`), { follow: true, panelFollow: true }, "both follow");
      assert.ok((await assertAtBottom(app, LOG, "the log after the replay")).over > 100, "the log overflows");
      if (panel) assert.ok((await assertAtBottom(app, PANEL, "the panel after the replay")).over > 100, "the panel overflows");
    },
  })),
  {
    // editing the second message dims the panel entries of the groups after it, as the log dims those groups; a
    // group created meanwhile is dimmed, a mode switch keeps the rule, cancelling the edit undims everything
    name: "edit-dim",
    modes: ["all"],
    scenario: path.join(FIXTURES, "late-group-scenario.mjs"),
    async run(app) {
      const groups = `${V}.log.querySelectorAll(":scope > .group").length`;
      await playScenario(app);
      await stubEditCount(app);
      assert.deepStrictEqual((await dimState(app)).errors, [], "before the edit");
      const before = await app.ev(groups);
      await app.ev(`${V}.log.querySelectorAll(":scope > .msg.user")[1]._editAct.click()`);
      await app.check(`!!${V}.edit`, "the edit to start");
      await frames(app);
      const editing = await dimState(app);
      assert.deepStrictEqual(editing.errors, [], "editing the second message");
      assert.ok(editing.dimmed > 0 && editing.clear > 0, `entries dimmed and not (${editing.dimmed}, ${editing.clear})`);
      assert.equal(await app.ev(groups), before, "the late group not there yet");
      await app.check(`${groups} > ${before}`, "the late group");
      await frames(app);
      assert.deepStrictEqual((await dimState(app)).errors, [], "after a group was created during the edit");
      assert.equal(await app.ev(`[...${V}.log.querySelectorAll(":scope > .group")].find((g) => g._body.textContent.includes(${JSON.stringify(LATE_TEXT)}))._entry.classList.contains("dim")`), true, "the late group's entry dimmed");
      for (const mode of ["subagents", "off", "all"]) {
        await app.setMode(mode);
        await frames(app);
        assert.equal(await app.ev(`!!${V}.edit`), true, `still editing after the switch to ${mode}`);
        assert.deepStrictEqual((await dimState(app)).errors, [], `after the switch to ${mode}`);
      }
      await app.ev(`${V}.editBar.querySelector("button").click()`);
      await frames(app);
      assert.equal(await app.ev(`!!${V}.edit`), false, "the edit cancelled");
      const cancelled = await dimState(app);
      assert.deepStrictEqual([cancelled.errors, cancelled.dimmed], [[], 0], "after the cancel: no entry dimmed");
    },
  },
  {
    // the agent process killed while a subagent runs: no ● left in the chat or the panel, a mode switch on the dead
    // view keeps the placement, resuming builds the view and its panel again from the replay
    name: "dead-view",
    modes: ["all"],
    scenario: WAIT_SCENARIO,
    async run(app) {
      await untilHalfway(app);
      assert.ok(await app.ev(`!!${V}.panelBody.querySelector(".mark.running")`), "a ● entry in the panel");
      const pids = agentPids(app);
      assert.equal(pids.length, 1, "one agent process for the session");
      process.kill(pids[0], "SIGKILL");
      await app.check(`${V}.dead`, "the view to be dead");
      await frames(app);
      assert.deepStrictEqual(
        await app.ev(`({ chat: ${V}.log.querySelectorAll(".mark.running").length, panel: ${V}.panelBody.querySelectorAll(".mark.running").length, bg: ${V}.bgEl.hidden })`),
        { chat: 0, panel: 0, bg: true },
        "no ● in the dead view",
      );
      await assertPlacement(app, "all", "in the dead view");
      await app.setMode("subagents");
      await assertPlacement(app, "subagents", "after a switch on the dead view");
      await app.setMode("all");
      await assertPlacement(app, "all", "after a switch back on the dead view");
      await app.ev(`window.__dead = ${V}`);
      await app.ev(`openSession({ sessionId: "scripted-work", cwd: ${JSON.stringify(path.join(app.dir, "work"))} })`, "the session to resume");
      await app.idle();
      assert.equal(await app.ev(`${V} !== __dead && !${V}.dead && !__dead.el.isConnected`), true, "a new view");
      assert.ok(await app.ev(`${V}.panelBody.childElementCount`) > 0, "the new view's panel has entries");
      await assertPlacement(app, "all", "after resuming");
    },
  },
  {
    // Stop while a sync subagent streams: the group's header in the chat and its entry in the panel show the marks
    // of mode off
    name: "stop-marks",
    scenario: WAIT_SCENARIO,
    async run(app) {
      const mode = await savedMode(app);
      await untilHalfway(app);
      await app.ev(`${V}.stopBtn.click()`);
      await app.idle();
      const marks = await groupMarks(app);
      assert.deepStrictEqual(marks.map(({ kind, chat }) => ({ kind, chat })), STOP_MARKS, "the marks in the chat");
      for (const m of marks) if (m.entry !== null) assert.equal(m.entry, m.chat, `the ${m.kind} entry's mark`);
      await assertPlacement(app, mode, "after the Stop");
    },
  },
  {
    // the mode switched while another view is active: shown again, the view has its groups where the new mode says
    // and its following log and panel at their bottoms
    name: "inactive-view",
    modes: ["all"],
    scenario: SCROLL_SCENARIO,
    async run(app) {
      await app.resize(1280, 500);
      await app.newSession();
      const other = await app.ev(`(async () => {
        await newSession(${V}.cwd.replace(/\\/[^/]+$/, "")); // a second session, in the launch's folder
        return [...views.keys()].find((id) => id !== "scripted-work") ?? null;
      })()`);
      assert.ok(other, "a second view");
      await activate(app, "scripted-work");
      await app.send("Explain the files.");
      await app.idle();
      await followingPanel(app);
      for (const mode of ["subagents", "off", "all"]) {
        await activate(app, other);
        await app.setMode(mode);
        assert.equal(await app.ev(`${V}.el.classList.contains("active")`), false, `the view hidden while the mode switched to ${mode}`);
        await activate(app, "scripted-work");
        await assertPlacement(app, mode, `shown again after the switch to ${mode}`);
        assert.equal(await app.ev(`${V}.follow`), true, `the log follows after the switch to ${mode}`);
        assert.ok((await assertAtBottom(app, LOG, `the log shown again after the switch to ${mode}`)).over > 100, "the log overflows");
        if (mode !== "off") assert.ok((await assertAtBottom(app, PANEL, `the panel shown again after the switch to ${mode}`)).over > 100, "the panel overflows");
      }
    },
  },
  {
    // every turn has exactly one Fork/Delete outside its user message, live and after a replay
    name: "one-acts-per-turn",
    async run(app) {
      await playScenario(app);
      assert.deepStrictEqual(await turnActs(app), { counts: [1, 1, 1], doubles: [] }, "live");
      await app.reload();
      assert.deepStrictEqual(await turnActs(app), { counts: [1, 1, 1], doubles: [] }, "after the replay");
    },
  },
  {
    // a work group whose tools ended in different ways shows a count per outcome, each after the first with its own
    // coloured mark; while a tool runs, and when all ended the same way, one mark and "N tools"; the same after a replay
    name: "split-header",
    scenario: SPLIT_SCENARIO,
    async run(app) {
      const tip = "2 · ✗ 1 · ○ 1 · 1 thought";
      const split = { mark: "✓", cls: "mark completed", text: tip, tip, inner: ["mark failed", "mark quiet"] };
      const plain = { mark: "✓", cls: "mark completed", text: "2 tools", tip: "2 tools", inner: [] };
      const all = (await app.ev(`api.getSettings().then((s) => s.activityPanel)`)) === "all"; // the work groups are in the panel
      const assertHeaders = async (what) => {
        const headers = await workHeaders(app);
        assert.deepStrictEqual(headers.map((h) => h.chat), [split, plain], `the two work groups' headers (${what})`);
        for (const h of headers) assert.deepStrictEqual(h.entry, all ? h.chat : null, `the entry's header (${what})`);
      };
      await app.newSession();
      await app.send("Edit both.");
      await app.check(`${V}.log.querySelector(":scope > .group.work > summary .title")?.textContent.includes(${JSON.stringify(RUNNING_TITLE)})`, "the last tool to run");
      const running = `4 tools · 1 thought · ${RUNNING_TITLE}`;
      assert.deepStrictEqual((await workHeaders(app))[0].chat, { mark: "●", cls: "mark running", text: running, tip: running, inner: [] }, "no split while a tool runs");
      await app.idle();
      await app.send("Check them.");
      await app.idle();
      await assertHeaders("live");
      await app.reload();
      await assertHeaders("after the replay");
    },
  },
  {
    // Settings > Relay broker: the question before a restart, and the run's rows. The repository folder does not
    // exist (or, last, the field is empty), so the run stops at its first step: the button is never clicked with a
    // real folder in the field.
    name: "broker-restart",
    modes: ["off"],
    scenario: LONG_WAIT_SCENARIO,
    settings: { brokerRepo: NO_BROKER_REPO },
    async run(app) {
      const rows = () => app.ev(`[...document.querySelectorAll("#broker-steps li")].map((li) => ({ cls: li.className, text: li.textContent }))`);
      const openSettings = async () => {
        await app.ev(`document.querySelector("#btn-settings").click()`);
        await app.check(`document.querySelector("#settings").open`, "the Settings dialog");
        await app.check(`document.querySelector("#set-broker-repo").value !== ""`, "the repository field");
        // safety: nothing below clicks the button unless the field holds the folder that does not exist
        assert.equal(await app.ev(`document.querySelector("#set-broker-repo").value`), NO_BROKER_REPO, "the repository field");
      };
      await app.newSession();
      await openSettings();
      assert.equal(await app.ev(`document.querySelector("#broker-restart").disabled`), false, "the button enabled");
      assert.deepStrictEqual(await rows(), [], "no steps before a run");
      await app.ev(`document.querySelector("#settings").close()`);
      // a working session: the question comes first, and "no" starts nothing
      await app.send("Look around.");
      await app.check(`${V}.busy`, "the turn to run");
      await openSettings();
      await app.ev(`(() => { window.confirm = (m) => ((window.__q = m), false); document.querySelector("#broker-restart").click(); })()`);
      await app.check(`!!window.__q`, "the question");
      assert.match(await app.ev(`window.__q`), /^1 session is working/, "the question");
      assert.deepStrictEqual(await rows(), [], "no step after No");
      await app.ev(`document.querySelector("#settings").close()`);
      await app.ev(`${V}.cancel()`);
      await app.idle();
      // no turn: no question, the run stops at Check
      await openSettings();
      await app.ev(`(() => { window.__q = null; window.confirm = (m) => ((window.__q = m), false); document.querySelector("#broker-restart").click(); })()`);
      await app.check(`document.querySelectorAll("#broker-steps li").length === 6 && !document.querySelector("#broker-restart").disabled`, "the run to stop");
      assert.equal(await app.ev(`window.__q`), null, "no question without working sessions");
      const stopped = await rows();
      assert.equal(stopped[0].cls, "failed");
      assert.ok(stopped[0].text.includes("Check: Not a copilot-relay folder:"), stopped[0].text);
      assert.deepStrictEqual(stopped.slice(1).map((r) => r.cls), ["pending", "pending", "pending", "pending", "pending"]);
      assert.equal(await app.ev(`document.querySelector("#broker-summary").textContent`), "Stopped at Check. The broker was not restarted.");
      // reopened: the same rows and summary
      await app.ev(`document.querySelector("#settings").close()`);
      await openSettings();
      assert.deepStrictEqual(await rows(), stopped, "the rows after reopening");
      assert.equal(await app.ev(`document.querySelector("#broker-summary").textContent`), "Stopped at Check. The broker was not restarted.");
      // an emptied field is refused by Check: no fallback to the default folder
      const emptied = "Check: Set the copilot-relay repository folder first (an absolute path).";
      await app.ev(`document.querySelector("#set-broker-repo").value = ""`);
      // safety: the only other state in which the button is clicked is an empty field
      assert.equal(await app.ev(`document.querySelector("#set-broker-repo").value`), "", "the emptied repository field");
      await app.ev(`(() => { window.confirm = () => false; document.querySelector("#broker-restart").click(); })()`);
      await app.check(`(() => { const li = document.querySelector("#broker-steps li"); return !!li && li.textContent.includes(${JSON.stringify(emptied)}) && !document.querySelector("#broker-restart").disabled; })()`, "the run on an empty field to stop");
      const refused = await rows();
      assert.equal(refused[0].cls, "failed");
      assert.ok(refused[0].text.includes(emptied), refused[0].text);
      assert.deepStrictEqual(refused.slice(1).map((r) => r.cls), ["pending", "pending", "pending", "pending", "pending"]);
      assert.equal(await app.ev(`document.querySelector("#broker-summary").textContent`), "Stopped at Check. The broker was not restarted.");
    },
  },
];
